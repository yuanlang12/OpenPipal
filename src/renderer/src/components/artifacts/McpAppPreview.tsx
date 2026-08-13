import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, Mic, Camera, MapPin, Clipboard, Maximize, Minimize, Volume2 } from 'lucide-react'

/**
 * MCP Apps Extension 渲染器 — 把 server 返回的 HTML 在沙盒 iframe 中显示,
 * 通过 postMessage 实现 ui/initialize 握手 + tools/call 反向代理。
 *
 * 已实现:
 *  - ui/initialize 初始数据推送
 *  - tools/call 同 server 工具反向调用
 *  - permissions 申请与用户确认 → iframe allow 属性按需开启(microphone/camera/clipboard 等)
 *
 * 未实现:
 *  - ui/update 主动推送、ui/contextUpdate 回写 LLM context
 *  - CSP 细颗粒控制
 *
 * 协议参考: docs/claude/mcp-apps-protocol.md
 */

interface McpAppPayload {
  html: string
  resourceUri: string
  serverName: string
  /** Host-only opaque identity; not injected into the sandboxed iframe. */
  serverBinding: string
  toolName: string
  conversationId?: string
  args: Record<string, unknown>
  /** 旧版字符串结果(向后兼容) */
  result?: string
  /** ContentBlock 数组 — image/text/resource。push 到 iframe 时进 params.content */
  contentBlocks?: any[]
  /** typed 结构化数据 — push 到 iframe 时进 params.structuredContent。Budget/Map 等主要用 */
  structuredContent?: any
  permissions?: string[]
  csp?: Record<string, unknown> | null
}

interface McpAppPreviewProps {
  /** 直接传 McpAppPayload 对象(主路径,避免 stringify→parse 双跳) */
  payload?: McpAppPayload | null
  /** 兼容路径:JSON-serialized payload。Artifact 面板的持久化场景用(content 字段是字符串) */
  content?: string
}

/** MCP Apps 协议的 JSON-RPC 方法名 — 散落字面量集中到一处避免拼错 */
const MCP_METHODS = {
  UI_INITIALIZE: 'ui/initialize',
  UI_INITIALIZED: 'ui/notifications/initialized',
  TOOL_INPUT: 'ui/notifications/tool-input',
  TOOL_RESULT: 'ui/notifications/tool-result',
  SIZE_CHANGED: 'ui/notifications/size-changed',
  REQUEST_DISPLAY_MODE: 'ui/request-display-mode',
  UPDATE_MODEL_CONTEXT: 'ui/update-model-context',
  HOST_CONTEXT_CHANGED: 'ui/notifications/host-context-changed',
  TOOLS_CALL: 'tools/call',
} as const

// 与 main/mcp-app-permissions.ts 的 ALLOWED_CAPABILITIES 保持一致 — 任何不在此列的请求会被忽略
const KNOWN_CAPS = new Set([
  'microphone', 'camera', 'geolocation',
  'clipboard-read', 'clipboard-write',
  'fullscreen', 'autoplay'
])

const CAP_ICONS: Record<string, typeof Mic> = {
  'microphone': Mic,
  'camera': Camera,
  'geolocation': MapPin,
  'clipboard-read': Clipboard,
  'clipboard-write': Clipboard,
  'fullscreen': Maximize,
  'autoplay': Volume2,
}

function isMcpAppPayload(value: unknown): value is McpAppPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<McpAppPayload>
  return typeof candidate.html === 'string'
    && typeof candidate.serverName === 'string'
    && typeof candidate.serverBinding === 'string'
    && candidate.serverBinding.length > 0
    && candidate.serverBinding.length <= 128
    && typeof candidate.toolName === 'string'
    && typeof candidate.resourceUri === 'string'
    && !!candidate.args
    && typeof candidate.args === 'object'
    && !Array.isArray(candidate.args)
}

function parsePayload(content: string): McpAppPayload | null {
  try {
    const parsed = JSON.parse(content)
    return isMcpAppPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

function injectBootstrap(html: string, initData: Omit<McpAppPayload, 'html'>): string {
  const initJson = JSON.stringify({
    toolName: initData.toolName,
    serverName: initData.serverName,
    resourceUri: initData.resourceUri,
    args: initData.args,
    result: initData.result
  }).replace(/</g, '\\u003c')

  const bootstrap = `<script>(function(){
    var data = ${initJson};
    window.__mcpApp = data;
    try {
      window.localStorage.length;
    } catch (_) {
      try {
        var store = {};
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          value: {
            getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function(k, v) { store[k] = String(v); },
            removeItem: function(k) { delete store[k]; },
            clear: function() { store = {}; },
            key: function(i) { return Object.keys(store)[i] || null; },
            get length() { return Object.keys(store).length; }
          }
        });
      } catch (_) {}
    }
    window.addEventListener('message', function(ev){
      var m = ev.data;
      if (!m || typeof m !== 'object' || m.method !== 'ui/initialize' || m.id === undefined) return;
      parent.postMessage({ jsonrpc: '2.0', id: m.id, result: { capabilities: { toolCalls: true } } }, '*');
    });
    try { window.dispatchEvent(new CustomEvent('mcp:update', { detail: data })); } catch(_){}
  })();</script>`

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, m => m + bootstrap)
  }
  return bootstrap + html
}

/**
 * 权限确认门 — 列出 App 申请的能力,用户点 "允许" 才把 iframe 渲出来,
 * 决策按 server 维度持久化(下次同 server 的 App 不再问)
 */
function PermissionGate({
  serverName, requested, onApprove, onSkip
}: {
  serverName: string
  requested: string[]
  onApprove: () => void
  onSkip: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex items-center justify-center p-3 sm:p-6">
      <div className="w-full min-w-0 max-w-md rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-900/10 p-4 sm:p-5 space-y-3">
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">
              {t('artifacts.mcpApp.permission.title')}
            </h3>
            <p className="break-words text-[11px] text-amber-700/70 dark:text-amber-400/80">
              {t('artifacts.mcpApp.permission.descriptionBefore')}{' '}
              <code className="break-all px-1 rounded bg-amber-100 dark:bg-amber-900/40 font-mono">{serverName}</code>{' '}
              {t('artifacts.mcpApp.permission.descriptionAfter')}
            </p>
          </div>
        </div>

        <ul className="space-y-1.5 sm:pl-8">
          {requested.map(cap => {
            const Icon = CAP_ICONS[cap]
            if (!Icon) return null
            return (
              <li key={cap} className="flex min-w-0 items-start gap-2 text-[12px] text-amber-700 dark:text-amber-200">
                <Icon className="mt-0.5 w-3.5 h-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 break-words">
                  <span className="font-medium">{t(`artifacts.mcpApp.capabilities.${cap}.label`)}</span>{' '}
                  <span className="text-amber-600/70 dark:text-amber-400/70 text-[11px]">— {t(`artifacts.mcpApp.capabilities.${cap}.rationale`)}</span>
                </span>
              </li>
            )
          })}
        </ul>

        <p className="sm:pl-8 text-[10px] text-amber-700/60 dark:text-amber-400/70 leading-relaxed">
          {t('artifacts.mcpApp.permission.persistenceHint')}
        </p>

        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <button
            type="button"
            onClick={onApprove}
            className="flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 hover:bg-brand-600 text-ink-on-accent transition-colors"
          >
            {t('artifacts.mcpApp.permission.allow')}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors"
          >
            {t('artifacts.mcpApp.permission.deny')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function McpAppPreview({ payload: payloadProp, content, autoSize = true }: McpAppPreviewProps & { autoSize?: boolean }) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [displayMode, setDisplayMode] = useState<'inline' | 'fullscreen'>('inline')
  const displayModeRef = useRef<'inline' | 'fullscreen'>('inline')
  // 优先用对象 prop;回退到字符串 prop(artifact 面板路径)再 parse
  const payload = useMemo(
    () => {
      const candidate = payloadProp ?? (content ? parsePayload(content) : null)
      return isMcpAppPayload(candidate) ? candidate : null
    },
    [payloadProp, content]
  )
  const isFullscreen = displayMode === 'fullscreen'

  useEffect(() => {
    displayModeRef.current = displayMode
  }, [displayMode])

  const getContainerDimensions = useCallback((): { width: number; maxHeight: number } => {
    if (displayModeRef.current === 'fullscreen') {
      return {
        width: Math.max(320, window.innerWidth),
        maxHeight: Math.max(320, window.innerHeight - 28)
      }
    }
    const iframe = iframeRef.current
    return {
      width: iframe?.parentElement?.clientWidth || iframe?.clientWidth || 400,
      maxHeight: 600
    }
  }, [])

  const notifyHostContextChanged = useCallback((): void => {
    const iframe = iframeRef.current
    iframe?.contentWindow?.postMessage({
      jsonrpc: '2.0',
      method: MCP_METHODS.HOST_CONTEXT_CHANGED,
      params: {
        displayMode: displayModeRef.current,
        containerDimensions: getContainerDimensions()
      }
    }, '*')
  }, [getContainerDimensions])

  const setHostDisplayMode = useCallback((nextMode: 'inline' | 'fullscreen'): void => {
    displayModeRef.current = nextMode
    setDisplayMode(nextMode)
    notifyHostContextChanged()
  }, [notifyHostContextChanged])

  // SDK 会发 ui/notifications/size-changed,用它来动态调整 iframe 大小,避免大量空白
  const [iframeSize, setIframeSize] = useState<{ width?: number; height?: number }>({})

  // 权限状态机:loading → gate(需用户确认) → ready(可渲染 iframe)
  const [permState, setPermState] = useState<'loading' | 'gate' | 'ready'>('loading')
  // 当前已授权能力(经 main 持久化校验后过滤过的合法值)
  const [grantedCaps, setGrantedCaps] = useState<string[]>([])
  // App 请求里 KNOWN_CAPS 之外的(忽略,只用 known 的做 gate)
  const requestedKnown = useMemo(() => {
    if (!payload?.permissions) return []
    return payload.permissions.filter(p => KNOWN_CAPS.has(p))
  }, [payload])

  // 加载已有授权,决定是否需要弹 gate
  useEffect(() => {
    if (!payload) { setPermState('ready'); return }
    if (requestedKnown.length === 0) { setPermState('ready'); setGrantedCaps([]); return }

    let cancelled = false
    setPermState('loading')
    const api = (window as any).api
    const fetchPerms = api?.getMcpAppPerms
      ? api.getMcpAppPerms(payload.serverName, payload.serverBinding, payload.conversationId)
      : Promise.resolve([])
    fetchPerms.then((existing: string[]) => {
      if (cancelled) return
      const have = new Set(existing || [])
      const missing = requestedKnown.filter(p => !have.has(p))
      setGrantedCaps(Array.from(have).filter(p => requestedKnown.includes(p)))
      setPermState(missing.length > 0 ? 'gate' : 'ready')
    }).catch(() => { if (!cancelled) setPermState('ready') })
    return () => { cancelled = true }
  }, [payload, requestedKnown])

  const srcDoc = useMemo(() => {
    if (!payload) return ''
    return injectBootstrap(payload.html, payload)
  }, [payload])

  const handleApprove = useCallback(async () => {
    if (!payload) return
    const api = (window as any).api
    if (typeof api?.approveMcpAppPerms === 'function') {
      const updated = await api.approveMcpAppPerms(payload.serverName, payload.serverBinding, requestedKnown, payload.conversationId)
      setGrantedCaps((updated || []).filter((p: string) => requestedKnown.includes(p)))
    } else {
      setGrantedCaps(requestedKnown)
    }
    setPermState('ready')
  }, [payload, requestedKnown])

  const handleSkip = useCallback(() => {
    setGrantedCaps([])
    setPermState('ready')
  }, [])

  // postMessage 桥 — 实现 MCP Apps 协议(基于 @modelcontextprotocol/ext-apps@0.4.0)
  // 关键流程:
  //  1. iframe 加载完用 SDK 发 ui/initialize 请求 → host 响应 hostInfo + hostContext
  //  2. iframe 发 ui/notifications/initialized 通知
  //  3. host 主动推 ui/notifications/tool-result(包含 structuredContent)→ iframe 的 ontoolresult 触发渲染
  //  4. iframe 反向 tools/call → host 代理到同 server(三道安全门)
  useEffect(() => {
    if (!payload) return
    const appPayload = payload
    let toolResultSent = false
    let pendingAppCalls = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let maxTimer: ReturnType<typeof setTimeout> | null = null

    const clearSettleTimer = (): void => {
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    }

    const clearMaxTimer = (): void => {
      if (maxTimer) {
        clearTimeout(maxTimer)
        maxTimer = null
      }
    }

    const pushToolInput = (): void => {
      // 关键:say-server 这类双向流式 App 的 view 在 app.ontoolinput 回调里才初始化 audio context
      // 等服务端流。漏推这条 → audioContextRef 永不被设 → 点 play 静默 3s 超时返回。
      // 单向 App (qr / budget) 不依赖 ontoolinput 也能跑,所以之前没暴露问题。
      const iframe = iframeRef.current
      iframe?.contentWindow?.postMessage({
        jsonrpc: '2.0',
        method: MCP_METHODS.TOOL_INPUT,
        params: {
          arguments: appPayload.args
        }
      }, '*')
    }

    function scheduleToolResult(delayMs: number): void {
      if (toolResultSent) return
      clearSettleTimer()
      settleTimer = setTimeout(() => pushToolResult(false), delayMs)
    }

    function pushToolResult(force = false): void {
      if (toolResultSent) return
      if (!force && pendingAppCalls > 0) {
        scheduleToolResult(120)
        return
      }
      toolResultSent = true
      clearSettleTimer()
      clearMaxTimer()
      const iframe = iframeRef.current
      // 同时推 content + structuredContent — SDK 的 ontoolresult 回调能拿到完整 MCP tool result
      const content = (appPayload.contentBlocks && appPayload.contentBlocks.length > 0)
        ? appPayload.contentBlocks
        : (appPayload.result ? [{ type: 'text', text: appPayload.result }] : [])
      const params: Record<string, any> = { content }
      if (appPayload.structuredContent !== undefined) {
        params.structuredContent = appPayload.structuredContent
      }
      iframe?.contentWindow?.postMessage({
        jsonrpc: '2.0',
        method: MCP_METHODS.TOOL_RESULT,
        params
      }, '*')
    }

    const onMsg = async (e: MessageEvent): Promise<void> => {
      const iframe = iframeRef.current
      if (!iframe || e.source !== iframe.contentWindow) return
      const m = e.data
      if (!m || typeof m !== 'object') return

      // ui/initialize — iframe 用 SDK 发的握手请求
      // 精简响应:只填 SDK 必需字段(zod schema 通过),可选字段全省略,避免校验失败
      if (m.method === MCP_METHODS.UI_INITIALIZE && m.id !== undefined) {
        iframe.contentWindow?.postMessage({
          jsonrpc: '2.0', id: m.id,
          result: {
            protocolVersion: '2025-11-21',
            hostInfo: { name: 'OpenPipal', version: '1.0.0' },
            hostCapabilities: {},
            hostContext: {
              theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
              displayMode: displayModeRef.current,
              availableDisplayModes: ['inline', 'fullscreen'],
              containerDimensions: getContainerDimensions()
            }
          }
        }, '*')
        return
      }

      // iframe 完成初始化通知 → 顺序推 tool-input(让 view 知道调用上下文 + 启动流式 init)
      // → 然后推 tool-result(投递实际结果)。这两条对单向 App 等价于"双发同一信息",
      // 但对 say 这类需 ontoolinput 触发 audio context 创建的双向 App 是必需的
      if (m.method === MCP_METHODS.UI_INITIALIZED) {
        pushToolInput()
        // Some Apps do async setup inside ontoolinput before they can safely
        // consume the final result. Say's TTS view, for example, must create a
        // queue and enqueue text before tool-result closes the stream.
        scheduleToolResult(350)
        maxTimer = setTimeout(() => pushToolResult(true), 1800)
        return
      }

      // 反向 tools/call — iframe 借 host 代理调同 server 工具
      if (m.method === MCP_METHODS.TOOLS_CALL && m.id !== undefined) {
        const params = m.params || {}
        const toolName = typeof params.name === 'string' ? params.name : ''
        const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {}
        const api = (window as any).api
        if (typeof api?.callMcpFromApp !== 'function') {
          iframe.contentWindow?.postMessage({
            jsonrpc: '2.0', id: m.id,
            error: { code: -32603, message: 'Bridge unavailable' }
          }, '*')
          return
        }
        pendingAppCalls++
        try {
          const res = await api.callMcpFromApp(
            appPayload.serverName,
            appPayload.serverBinding,
            toolName,
            args,
            appPayload.conversationId
          )
          if (res?.ok) {
            // 把 content + structuredContent 双轨完整推回,让 SDK 的 callServerTool 解析两者
            const result: Record<string, any> = {
              content: res.content || (res.result ? [{ type: 'text', text: res.result }] : [])
            }
            if (res.structuredContent !== undefined) result.structuredContent = res.structuredContent
            iframe.contentWindow?.postMessage({
              jsonrpc: '2.0', id: m.id, result
            }, '*')
          } else {
            iframe.contentWindow?.postMessage({
              jsonrpc: '2.0', id: m.id,
              error: { code: -32000, message: res?.error || 'call failed' }
            }, '*')
          }
        } catch (err: any) {
          iframe.contentWindow?.postMessage({
            jsonrpc: '2.0', id: m.id,
            error: { code: -32603, message: err?.message || 'bridge error' }
          }, '*')
        } finally {
          pendingAppCalls = Math.max(0, pendingAppCalls - 1)
          scheduleToolResult(120)
        }
        return
      }

      if (m.method === MCP_METHODS.REQUEST_DISPLAY_MODE && m.id !== undefined) {
        const requestedMode = m.params?.mode === 'fullscreen' ? 'fullscreen' : 'inline'
        const nextMode = requestedMode
        displayModeRef.current = nextMode
        setDisplayMode(nextMode)
        iframe.contentWindow?.postMessage({
          jsonrpc: '2.0',
          id: m.id,
          result: { mode: nextMode }
        }, '*')
        notifyHostContextChanged()
        return
      }

      if (m.method === MCP_METHODS.UPDATE_MODEL_CONTEXT && m.id !== undefined) {
        // Some Apps (map/pdf) publish a compact state snapshot for future LLM
        // turns. OpenPipal does not thread this into chat context yet, but the
        // protocol request should still be acknowledged so Apps do not surface
        // false "method not implemented" errors while rendering.
        iframe.contentWindow?.postMessage({
          jsonrpc: '2.0',
          id: m.id,
          result: {}
        }, '*')
        return
      }

      // ui/notifications/size-changed — SDK 用 ResizeObserver 测 documentElement 大小后发的
      // 拿到后把 iframe 收缩到内容大小,避免固定高度造成大量空白
      if (m.method === MCP_METHODS.SIZE_CHANGED) {
        const w = m.params?.width
        const h = m.params?.height
        const nextW = typeof w === 'number' && w > 0 ? w : undefined
        const nextH = typeof h === 'number' && h > 0 ? h : undefined
        // 同尺寸不重设 state,防止 ResizeObserver 高频抖动 → 多余 re-render
        setIframeSize(prev => (prev.width === nextW && prev.height === nextH) ? prev : { width: nextW, height: nextH })
        return
      }
      // 其它 notifications/* — 暂忽略
      if (typeof m.method === 'string' && m.method.startsWith('ui/notifications/')) {
        return
      }

      // 其他未实现的 ui/* 请求 — 返回 method not found,iframe 该自适应
      if (typeof m.method === 'string' && m.method.startsWith('ui/') && m.id !== undefined) {
        iframe.contentWindow?.postMessage({
          jsonrpc: '2.0', id: m.id,
          error: { code: -32601, message: `Method not implemented: ${m.method}` }
        }, '*')
      }
    }
    window.addEventListener('message', onMsg)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || displayModeRef.current !== 'fullscreen') return
      setHostDisplayMode('inline')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      clearSettleTimer()
      clearMaxTimer()
      window.removeEventListener('message', onMsg)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [payload, getContainerDimensions, notifyHostContextChanged, setHostDisplayMode])

  if (!payload) {
    return (
      <div className="flex-1 flex items-center justify-center text-surface-400 text-xs">
        {t('artifacts.mcpApp.invalidPayload')}
      </div>
    )
  }

  // iframe allow 属性 — 只放已授权的合法能力,顺序无关,;空值时省略整个属性
  // 注意:必须在 mount 前确定,iframe 一旦渲染再修改 allow 不会重新协商权限
  const allowAttr = grantedCaps.length > 0 ? grantedCaps.join('; ') : undefined
  const frameHeight = isFullscreen
    ? 'calc(100vh - 28px)'
    : iframeSize.height ? `${Math.min(iframeSize.height, 600)}px` : '360px'

  return (
    <div className={
      isFullscreen
        ? 'fixed inset-0 z-[9999] flex flex-col min-h-0 bg-white dark:bg-surface-0'
        : 'flex-1 flex flex-col min-h-0 bg-white dark:bg-surface-0'
    }>
      <div className="shrink-0 h-7 px-3 flex items-center text-[10px] text-surface-400 border-b border-surface-100 bg-surface-50 dark:bg-surface-50/50 gap-2">
        <span className="shrink-0">{t('artifacts.mcpApp.title')}</span>
        <span className="shrink-0 text-surface-300">·</span>
        <span className="min-w-0 flex-1 truncate">{payload.serverName} / {payload.toolName}</span>
        {grantedCaps.length > 0 && (
          <>
            <span className="shrink-0 text-surface-300">·</span>
            <span
              className="shrink-0 text-brand-500"
              title={t('artifacts.mcpApp.grantedTitle', { capabilities: grantedCaps.join(', ') })}
            >
              {t('artifacts.mcpApp.permissionCount', { count: grantedCaps.length })}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => setHostDisplayMode(isFullscreen ? 'inline' : 'fullscreen')}
          className="ml-auto shrink-0 inline-flex h-5 w-5 items-center justify-center rounded text-surface-400 hover:text-surface-700 hover:bg-surface-100 transition-colors"
          title={isFullscreen ? t('artifacts.mcpApp.exitFullscreen') : t('artifacts.mcpApp.enterFullscreen')}
          aria-label={isFullscreen ? t('artifacts.mcpApp.exitFullscreen') : t('artifacts.mcpApp.enterFullscreen')}
        >
          {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
        </button>
      </div>

      {permState === 'loading' ? (
        <div className="flex-1 flex items-center justify-center text-surface-400 text-xs">
          {t('artifacts.mcpApp.loadingPermissions')}
        </div>
      ) : permState === 'gate' ? (
        <PermissionGate
          serverName={payload.serverName}
          requested={requestedKnown}
          onApprove={handleApprove}
          onSkip={handleSkip}
        />
      ) : (
        // autoSize=true(inline 场景):iframe 永远 100% 宽(等于聊天气泡宽度),高度跟随 SDK 报告自适应。
        // 不用 SDK 的宽度建议——很多 server 假设桌面宽度(600px+),OpenPipal 侧栏才 400px,
        // 强制 iframe 100% 宽逼 server 内部走响应式布局,避免横向裁剪。
        // 高度方向:用 SDK 的 height 上限收缩,首屏给个合理 360px(够看 QR / 一行文字)
        <iframe
          ref={iframeRef}
          title={`mcp-app-${payload.toolName}`}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          allow={allowAttr}
          className={autoSize && !isFullscreen ? 'w-full border-0 bg-white block' : 'flex-1 w-full border-0 bg-white'}
          style={autoSize || isFullscreen ? {
            height: frameHeight,
            transition: isFullscreen ? undefined : 'height 0.2s'
          } : undefined}
        />
      )}
    </div>
  )
}
