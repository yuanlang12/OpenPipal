/**
 * Web API Shim
 * 在浏览器环境中替代 Electron preload 的 window.api
 * 通过 HTTP/SSE 与桌面端通信
 */

import {
  isLocalePreference,
  type LocalePreference,
  type LocaleState
} from '../../shared/i18n/contract'
import {
  parseAppFollowingUpdateResult,
  parseAppListUpdateResult,
  parseAppSettingsState
} from '../../shared/app-following-contract'
import { rendererI18n } from './i18n'
import { APP_I18N_RESOURCES } from '../../shared/i18n/resources'
import { resolveSystemLocale } from '../../shared/i18n/contract'

type Callback = (...args: any[]) => void

function shimT(key: string, options?: Record<string, unknown>): string {
  if (rendererI18n.isInitialized) return String(rendererI18n.t(key, options))
  const languages = typeof navigator === 'undefined'
    ? []
    : navigator.languages?.length
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : []
  const locale = resolveSystemLocale(languages)
  const fallback = key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[segment]
  }, APP_I18N_RESOURCES[locale])
  if (typeof fallback !== 'string') return key
  return fallback.replace(/{{\s*([^}\s]+)\s*}}/g, (placeholder, name: string) => {
    const value = options?.[name]
    return value === undefined || value === null ? placeholder : String(value)
  })
}

export function installWebApiShim(): void {
  const API_BASE = window.location.origin
  const listeners: Record<string, Callback[]> = {}
  const nativeFetch = window.fetch.bind(window)
  const browserTokenHeader = 'X-OpenPipal-Browser-Token'
  let browserToken: string | null = null
  let trustedParentOrigin: string | null = null
  const tokenWaiters: Array<{ previous: string | null; resolve: (token: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

  function publishBrowserToken(token: string): void {
    const previousToken = browserToken
    browserToken = token
    if (previousToken && previousToken !== token) {
      window.dispatchEvent(new Event('openpipal-browser-session-rotated'))
    }
    for (let i = tokenWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = tokenWaiters[i]
      if (waiter.previous === token) continue
      tokenWaiters.splice(i, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(token)
    }
  }

  function waitForBrowserToken(previous: string | null = null): Promise<string> {
    if (browserToken && browserToken !== previous) return Promise.resolve(browserToken)
    return new Promise((resolve, reject) => {
      const waiter = {
        previous,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = tokenWaiters.indexOf(waiter)
          if (index >= 0) tokenWaiters.splice(index, 1)
          reject(new Error(shimT('runtimeChrome.browserShim.sessionUnavailable')))
        }, 10_000)
      }
      tokenWaiters.push(waiter)
    })
  }

  // All dynamic renderer calls pass through this in-memory capability. It is
  // delivered by the extension parent and is never stored, logged, or put in a
  // URL. A desktop restart rotates it; one authenticated retry asks the parent
  // to bootstrap the new process session.
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const token = await waitForBrowserToken()
    const headers = new Headers(init.headers || {})
    headers.set(browserTokenHeader, token)
    let response = await nativeFetch(input, { ...init, headers })
    if (response.status === 401) {
      window.parent.postMessage({ type: 'OPENPIPAL_BROWSER_SESSION_REQUEST' }, trustedParentOrigin || '*')
      const refreshed = await waitForBrowserToken(token)
      const retryHeaders = new Headers(init.headers || {})
      retryHeaders.set(browserTokenHeader, refreshed)
      response = await nativeFetch(input, { ...init, headers: retryHeaders })
    }
    return response
  }

  function on(event: string, cb: Callback): () => void {
    if (!listeners[event]) listeners[event] = []
    listeners[event].push(cb)
    return () => {
      listeners[event] = listeners[event].filter(f => f !== cb)
    }
  }

  function emit(event: string, ...args: any[]): void {
    (listeners[event] || []).forEach(cb => cb(...args))
  }

  function browserUnsupported(featureKey: string): { ok: false; error: string } {
    return {
      ok: false,
      error: shimT('runtimeChrome.browserShim.unsupported', {
        feature: shimT(featureKey)
      })
    }
  }

  function requestFailedError(requestKey: string, status: number): Error {
    return new Error(shimT('runtimeChrome.browserShim.requestFailed', {
      request: shimT(requestKey),
      status
    }))
  }

  async function readLocaleResponse(response: Response): Promise<LocaleState> {
    if (!response.ok) throw new Error(shimT('runtimeChrome.browserShim.requestFailed', {
      request: shimT('runtimeChrome.browserShim.requests.locale'),
      status: response.status
    }))
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(shimT('runtimeChrome.browserShim.invalidResponse', {
        request: shimT('runtimeChrome.browserShim.requests.locale')
      }))
    }
    const state = value as Partial<LocaleState>
    if (
      !isLocalePreference(state.preference) ||
      (state.locale !== 'zh-CN' && state.locale !== 'en')
    ) {
      throw new Error(shimT('runtimeChrome.browserShim.invalidResponse', {
        request: shimT('runtimeChrome.browserShim.requests.locale')
      }))
    }
    return state as LocaleState
  }

  let currentAbort: AbortController | null = null

  // 接收来自插件父窗口的页面上下文（postMessage）
  let browserContext: any = null
  window.addEventListener('message', (e) => {
    if (
      e.source === window.parent &&
      /^chrome-extension:\/\/[a-p]{32}$/.test(e.origin) &&
      e.data?.type === 'OPENPIPAL_BROWSER_SESSION' &&
      typeof e.data.token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(e.data.token)
    ) {
      trustedParentOrigin = e.origin
      publishBrowserToken(e.data.token)
      return
    }
    if (e.source !== window.parent || !trustedParentOrigin || e.origin !== trustedParentOrigin) return
    if (e.data?.type === 'PAGE_CONTEXT') {
      browserContext = e.data.context
    }
    // 右键菜单动作：从 sidepanel.js 转发
    if (e.data?.type === 'CONTEXT_MENU_ACTION') {
      window.dispatchEvent(new CustomEvent('openpipal-context-action', {
        detail: { action: e.data.action, text: e.data.text }
      }))
    }
  })

  // 解析 SSE 事件行并分发。ctx.onDone 在收到服务端 {type:done} 权威终止信号时回调。
  // ctx.lastError 记录流中途的 error 事件文本——stream-end 必须带上它，
  // 否则 failUnfinishedToolMessages 等断流收敛逻辑在扩展端永远不触发（桌面 IPC 路径已透传）。
  function dispatchSSELine(line: string, ctx: { onDone: (cid: string) => void; lastError?: string }): void {
    if (!line.startsWith('data: ')) return  // 心跳注释行(": ping")等非 data 行直接忽略
    try {
      const data = JSON.parse(line.slice(6))
      const cid = data.conversationId || ''
      switch (data.type) {
        case 'text': emit('stream-chunk', cid, data.content); break
        case 'text_flush': emit('text-flush', cid); break
        case 'thinking': emit('thinking', cid, data.content); break
        case 'thinking_end': emit('thinking-end', cid); break
        case 'stream_retry': emit('stream-retry', cid, data.attempt, data.maxRetries); break
        case 'tool_start': emit('tool-start', cid, data.name, data.toolCallId); break
        case 'tool_progress': emit('tool-progress', cid, data.name, data.chars); break
        case 'tool_end': emit('tool-end', cid, data.name, data.screenshot, data.searchResults, data.mcpResult, data.mcpArgs, data.visualizer, data.toolCallId, data.modelToolArgs); break
        case 'artifact': emit('artifact', cid, data.artifact, data.toolCallId); break
        case 'artifact_delta': emit('artifact-delta', cid, data); break
        case 'visualizer': emit('visualizer', cid, data.visualizer); break
        case 'visualizer_delta': emit('visualizer-delta', cid, data); break
        case 'ask_user': emit('ask-user', cid, data.question, data.options); break
        case 'questions_v2': emit('questions-v2', cid, data.title, data.questions); break
        case 'questions_v2_delta': emit('questions-v2-delta', cid, data); break
        // 上下文用量圆环——浏览器端事件已到位，UI 先不接（桌面端优先）
        case 'context_usage': emit('context-usage', cid, { promptTokens: data.promptTokens, contextWindow: data.contextWindow, budget: data.budget, compacted: data.compacted, usage: data.usage, segments: data.segments }); break
        case 'runtime_context': emit('runtime-context', cid, data.text); break
        // 浏览器写操作的权限确认气泡(与桌面 IPC permission:inline-request 对齐)。
        // data.request 即完整 PermissionRequestData(含 conversationId)。
        case 'permission': emit('permission-request-inline', data.request); break
        case 'error': ctx.lastError = data.content; emit('stream-chunk', cid, `\n\n[Error] ${data.content}`); break
        case 'done': ctx.onDone(cid); break  // 权威终止信号
      }
    } catch {
      // 忽略 JSON 解析错误
    }
  }

  ;(window as any).api = {
    // 签名对齐桌面 preload sendChat(messages, agentId, conversationConfig, conversationId, workspaceId)。
    // 历史上 shim 只收 messages,把 conversationId 丢了 → 服务端 SSE 事件一律打 cid:''、
    // 权限气泡也无法定位到当前会话流。这里至少透传 conversationId(服务端据此构造 overrides + 路由权限确认)。
    sendChat(messages: any[], _agentId?: string, conversationConfig?: any, conversationId?: string, _workspaceId?: string) {
      if (currentAbort) currentAbort.abort()
      const abort = new AbortController()
      currentAbort = abort

      // 发送前通知父窗口刷新上下文
      try { window.parent.postMessage({ type: '__OPENPIPAL_REFRESH_CONTEXT__' }, trustedParentOrigin || '*') } catch { /* parent unavailable */ }

      // {type:done} 是服务端唯一权威终止信号:只有收到它才算"干净结束"。
      // 若 XHR 在没收到 done 时就 onload/onerror(连接被中途掐断/响应提前关闭),按"中断"上报,
      // 而不是借 XHR 物理关闭伪装成完成 —— 否则 agent 仍在处理时 UI 会静默显示结束(Bug 复现点)。
      let sawDone = false
      const ctx: { onDone: (cid: string) => void; lastError?: string } = {
        onDone: (cid: string) => { sawDone = true; emit('stream-end', cid, ctx.lastError) }
      }

      // SSE 行缓冲：处理跨 chunk 的不完整行
      let sseBuffer = ''
      function processSSEChunk(text: string): void {
        sseBuffer += text
        const lines = sseBuffer.split('\n')
        // 最后一段可能不完整，留在 buffer 中
        sseBuffer = lines.pop() || ''
        for (const line of lines) {
          dispatchSSELine(line, ctx)
        }
      }
      function flushSSEBuffer(): void {
        if (sseBuffer) {
          dispatchSSELine(sseBuffer, ctx)
          sseBuffer = ''
        }
      }

      // fetch + ReadableStream 流式读取,替换原 XHR(onprogress 每次重读全量 responseText 再切片 → O(n²))。
      // 逐条对齐契约:
      // 1) body/header/凭证语义与原 XHR 一致 —— 同源请求,fetch 默认 credentials 行为等价于 XHR 自动带 cookie,
      //    这里显式写 'same-origin' 只为文档化,不改变实际发送内容。
      // 2) abort 改走 fetch 原生 { signal }(不再手动 xhr.abort()),中止走 catch 里的 AbortError 分支。
      // 3) 无 done 哨兵 ⇒ 上报“中断”而非“完成”:reader 正常读完(EOF)、fetch/reader 报错、abort 三条路径
      //    都各自对齐原 onload/onerror/onAbort 的文案与是否 flush 残留半行(abort 路径原逻辑不 flush,这里保留)。
      // 4) TextDecoder({stream:true}) 维护解码器内部状态,避免多字节 UTF-8 断在 chunk 边界产生乱码；
      //    循环结束后再 decode() 一次冲掉尾部残留字节。
      // 5) SSE 事件 payload 经 processSSEChunk → dispatchSSELine 原样透传,本层不解释/不重组任何字段。
      // 6) 非 2xx 状态码不做特判,和原 XHR onload 一样只看响应体内容——HTTP 错误码的错误面与现状一致。
      fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: abort.signal,
        body: JSON.stringify({
          messages,
          source: 'extension',
          conversationId,
          conversationConfig,
          context: browserContext
        })
      }).then(async (res) => {
        const reader = res.body?.getReader()
        if (!reader) {
          if (!sawDone) emit('stream-end', '', shimT('runtimeChrome.browserShim.connectionClosed'))
          return
        }
        const decoder = new TextDecoder('utf-8')
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          processSSEChunk(decoder.decode(value, { stream: true }))
        }
        processSSEChunk(decoder.decode())  // 冲掉解码器里残留的多字节序列
        flushSSEBuffer()
        // 没收到 done 就读完 = 服务端在生成器跑完前关了响应 → 中断,而非完成
        if (!sawDone) emit('stream-end', '', shimT('runtimeChrome.browserShim.connectionClosed'))
      }).catch((err: any) => {
        if (err?.name === 'AbortError') {
          // 用户主动停止:不算错误(不带 error 文案),且不 flush 残留半行 —— 与原 xhr.abort 路径一致
          if (!sawDone) emit('stream-end', '')
          return
        }
        flushSSEBuffer()
        if (!sawDone) emit('stream-end', '', shimT('runtimeChrome.browserShim.connectionError'))
      })
    },

    abortChat(_conversationId?: string) {
      // 浏览器扩展是单会话视图，忽略 cid，停掉当前 SSE 流即可
      if (currentAbort) {
        currentAbort.abort()
        currentAbort = null
      }
    },

    // 会话级 config 写入（roleBrief/initialAssets 等）。桌面端走 IPC 'conv:update-config'；
    // 浏览器端走 PATCH。缺这个方法时 chatStore.ensureConversation 里的调用会直接
    // TypeError → 首条消息静默丢失（preflow 选模板后发送无反应），且 taskType 永远进不了后端。
    async updateConversationConfig(conversationId: string, config: any) {
      try {
        const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config })
        })
        return res.ok
      } catch {
        return false
      }
    },

    // 空会话的角色由首次发送时的显式选择锁定；服务端只允许在消息落盘前更新。
    async updateConversationRole(conversationId: string, role: string) {
      try {
        const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role })
        })
        return res.ok
      } catch {
        return false
      }
    },

    // 插队能力在浏览器扩展暂未实现——返回 ok:false 让 renderer 降级为普通 sendChat
    steerChat: async (_cid: string, _text: string, _images?: string[]) => ({ ok: false }),
    queueChat: async (_cid: string, _text: string, _images?: string[]) => ({ ok: false }),

    onStreamChunk: (cb: Callback) => on('stream-chunk', cb),
    onStreamEnd: (cb: Callback) => on('stream-end', cb),
    onTextFlush: (cb: Callback) => on('text-flush', cb),
    onThinking: (cb: Callback) => on('thinking', cb),
    onThinkingEnd: (cb: Callback) => on('thinking-end', cb),
    onToolStart: (cb: Callback) => on('tool-start', cb),
    onStreamRetry: (cb: Callback) => on('stream-retry', cb),
    onToolProgress: (cb: Callback) => on('tool-progress', cb),
    onToolEnd: (cb: Callback) => on('tool-end', cb),
    onArtifact: (cb: Callback) => on('artifact', cb),
    onArtifactDelta: (cb: Callback) => on('artifact-delta', cb),
    onVisualizer: (cb: Callback) => on('visualizer', cb),
    onVisualizerDelta: (cb: Callback) => on('visualizer-delta', cb),
    onAskUser: (cb: Callback) => on('ask-user', cb),
    onQuestionsV2: (cb: Callback) => on('questions-v2', cb),
    onQuestionsV2Delta: (cb: Callback) => on('questions-v2-delta', cb),
    onContextUsage: (cb: Callback) => on('context-usage', cb),
    onRuntimeContext: (cb: Callback) => on('runtime-context', cb),
    getTodayUsage: async () => [],

    // 内联权限确认(浏览器写操作)。收:SSE 的 permission 事件 → 渲染层弹气泡;
    // 发:用户点允许/拒绝 → POST /api/permission,落到桌面同一个 resolver。
    onPermissionRequestInline: (cb: Callback) => on('permission-request-inline', cb),
    respondPermissionInline: (requestId: string, approved: boolean, sessionApprove?: boolean, executionId?: string, conversationId?: string) => {
      fetch(`${API_BASE}/api/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, approved, sessionApprove, executionId, conversationId })
      }).catch(() => {})
    },

    // 桌面端独有功能，浏览器中 no-op
    onTargetStatus: () => () => {},
    onAppChanged: () => () => {},
    pasteToTarget: async () => ({
      success: false,
      error: browserUnsupported('runtimeChrome.browserShim.features.pasteToTarget').error
    }),

    // Role API — HTTP 调用
    async getRoleInitState() {
      const res = await fetch(`${API_BASE}/role/init-state`)
      return res.json()
    },
    async getAllRoles() {
      const res = await fetch(`${API_BASE}/role/all`)
      return res.json()
    },
    async getCurrentRole() {
      const res = await fetch(`${API_BASE}/role/current`)
      return res.json()
    },
    async switchRole(roleName: string) {
      const res = await fetch(`${API_BASE}/role/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleName })
      })
      return res.json()
    },
    // 独立 Agent（workspace）列表 — /api/agents/list 返回 { builtins, agents }，这里只取 agents。
    // 缺这根线时 agentStore.loadWorkspaces 会拿到 undefined→[]，浏览器里独立 Agent 静默为空。
    async listAgentWorkspaces() {
      const res = await fetch(`${API_BASE}/api/agents/list`)
      const data = await res.json()
      return data.agents || []
    },
    async getAppSettings() {
      const res = await fetch(`${API_BASE}/settings/apps`)
      if (!res.ok) throw requestFailedError('runtimeChrome.browserShim.requests.appSettings', res.status)
      return parseAppSettingsState(await res.json())
    },
    async setAppFollowingEnabled(enabled: boolean) {
      const res = await fetch(`${API_BASE}/settings/app-following`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })
      if (!res.ok) throw requestFailedError('runtimeChrome.browserShim.requests.appFollowing', res.status)
      return parseAppFollowingUpdateResult(await res.json(), enabled)
    },
    async setDisabledApps(apps: string[]) {
      const res = await fetch(`${API_BASE}/settings/disabled-apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apps })
      })
      if (!res.ok) throw requestFailedError('runtimeChrome.browserShim.requests.disabledApps', res.status)
      return parseAppListUpdateResult(await res.json())
    },
    async getLocaleState(): Promise<LocaleState> {
      const res = await fetch(`${API_BASE}/api/locale`)
      return readLocaleResponse(res)
    },
    async setLocalePreference(preference: LocalePreference): Promise<LocaleState> {
      const res = await fetch(`${API_BASE}/api/locale`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference })
      })
      const state = await readLocaleResponse(res)
      emit('locale:changed', state)
      return state
    },
    onLocaleChanged(callback: (state: LocaleState) => void): () => void {
      return on('locale:changed', callback)
    },
    // 对话管理
    async listConversations() {
      const res = await fetch(`${API_BASE}/api/conversations`)
      return res.json()
    },
    // agentId/workspaceId 必须透传，否则浏览器开的"Agent 会话"不会挂上 agent.md/记忆/技能
    async createConversation(role: string, title?: string, agentId?: string, workspaceId?: string) {
      const res = await fetch(`${API_BASE}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, title, agentId, workspaceId })
      })
      return res.json()
    },
    async getConversation(id: string) {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`)
      return res.json()
    },
    async getConversationMessages(id: string) {
      const res = await fetch(`${API_BASE}/api/conversations/${id}/messages`)
      return res.json()
    },
    async appendMessages(id: string, messages: any[]) {
      const res = await fetch(`${API_BASE}/api/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      })
      return res.json()
    },
    // 附件卸载是桌面端优化：插件端返回 null → chatStore 不挂 ref、消息保持内联，行为与从前一致
    async saveConvAttachment() { return null },
    async loadConvAttachment() { return null },
    async replaceMessages(id: string, messages: any[]) {
      const res = await fetch(`${API_BASE}/api/conversations/${id}/messages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      })
      return res.json()
    },
    async deleteConversation(id: string) {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`, { method: 'DELETE' })
      return res.json()
    },
    async updateConversationTitle(id: string, title: string) {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      })
      return res.json()
    },
    // 模型配置
    async getModelConfig() {
      const res = await fetch(`${API_BASE}/api/config/model`)
      return res.json()
    },
    async getModelConfigFull() {
      const res = await fetch(`${API_BASE}/api/config/model`)
      return res.json()
    },
    async saveModelConfig(_config: any) {
      return browserUnsupported('runtimeChrome.browserShim.features.saveModel')
    },
    async testConnection(_config: any) {
      return browserUnsupported('runtimeChrome.browserShim.features.testModel')
    },
    async listRemoteModels(_config: any) {
      return browserUnsupported('runtimeChrome.browserShim.features.listModels')
    },
    async getProviders() {
      const res = await fetch(`${API_BASE}/api/config/providers`)
      return res.json()
    },
    async hasApiKey() {
      const res = await fetch(`${API_BASE}/api/config/has-key`)
      return res.json()
    },
    async isCustomConfig() {
      const res = await fetch(`${API_BASE}/api/config/is-custom`)
      return res.json()
    },
    async clearModelConfig() {
      return browserUnsupported('runtimeChrome.browserShim.features.clearModel')
    },
    // 搜索服务配置 —— v1 桌面独占：不开 HTTP 路由，插件端三个写方法直接说明不支持
    async saveSearchConfig() {
      return browserUnsupported('runtimeChrome.browserShim.features.saveSearch')
    },
    async testSearchConnection() {
      return browserUnsupported('runtimeChrome.browserShim.features.testSearch')
    },
    async clearSearchConfig() {
      return browserUnsupported('runtimeChrome.browserShim.features.clearSearch')
    },
    // 归档记忆
    async listArchivedMemories() {
      const res = await fetch(`${API_BASE}/api/memory/archived`)
      return res.json()
    },
    async restoreMemory(filePath: string) {
      const res = await fetch(`${API_BASE}/api/memory/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      })
      const data = await res.json()
      return data.ok
    },
    // 导出对话 — 浏览器模式不支持系统对话框，返回 null 让前端走 Blob 下载
    saveMarkdownDialog: undefined,
    writeTextFile: undefined,

    // Skills / Agent 模板 / 定时任务 — 浏览器模式暂不支持
    // workspaceId 参数保持向后兼容(可选,不传=全局行为)——浏览器模式两种情况都返回空
    async listSkills(_workspaceId?: string) { return [] },
    async setSkillDisabled() { return { ok: true } },
    async getSkillDetails() { return null },
    async importScanSkills() { return browserUnsupported('runtimeChrome.browserShim.features.importSkills') },
    async importApplySkills() { return browserUnsupported('runtimeChrome.browserShim.features.importSkills') },
    async deleteSkill() { return browserUnsupported('runtimeChrome.browserShim.features.deleteSkill') },
    async listPlugins() { return [] },
    async installPlugin() { return browserUnsupported('runtimeChrome.browserShim.features.installPlugin') },
    async uninstallPlugin() { return browserUnsupported('runtimeChrome.browserShim.features.uninstallPlugin') },
    async setPluginDisabled() { return { ok: true } },
    async listAgentTemplates() { return [] },
    async getAgentTemplate() { return null },
    async createAgentTemplate() { return null },
    async updateAgentTemplate() { return null },
    async deleteAgentTemplate() { return null },
    async listTasks() { return [] },
    async getTask() { return null },
    async createTask() { return null },
    async updateTask() { return null },
    async deleteTask() { return false },
    async toggleTask() { return null },
    onTaskExecuted: () => () => {},

    // Artifact 内 LLM 调用桥（window.openpipal.complete 走这里）
    async completeInArtifact(prompt: string, systemPrompt?: string) {
      const res = await fetch(`${API_BASE}/api/openpipal/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemPrompt })
      })
      return res.json()
    },

    // 角色前置页 manifest
    async getRolePreflow(roleName: string) {
      const res = await fetch(`${API_BASE}/api/chat/role-preflow?roleName=${encodeURIComponent(roleName)}`)
      const data = await res.json()
      return data.manifest
    },

    // 同传目标语言 — 浏览器不支持同传(语音走桌面),stub 掉
    async getInterpretLangs() { return null },
    async setInterpretTarget(_target: string) { return { ok: false } },
    async archiveTranscript(_title: string, _content: string) { return { ok: false } },

    // 画布圈画截图：浏览器模式没有窗口级 capturePage——返回 null，评论退化为纯文字
    async captureRegion(_rect: { x: number; y: number; width: number; height: number }) { return null },

    // 资产库
    async uploadAssetToCategory(_sourcePath: string, _category: string) {
      throw new Error(browserUnsupported('runtimeChrome.browserShim.features.importLocalAsset').error)
    },
    async listAssetsTree() {
      const res = await fetch(`${API_BASE}/api/assets/list-tree`)
      return res.json()
    },
    async deleteAsset(_path: string) {
      throw new Error(browserUnsupported('runtimeChrome.browserShim.features.deleteLocalAsset').error)
    },
    async listDesignSystems() {
      const res = await fetch(`${API_BASE}/api/assets/list-design-systems`)
      const data = await res.json()
      return data.items || []
    },
    async getDesignSystemManifest(name: string) {
      const res = await fetch(`${API_BASE}/api/assets/design-system-manifest?name=${encodeURIComponent(name)}`)
      // 后端非法/不存在返回 null；204/404 也当 null 处理
      if (!res.ok) return null
      return res.json()
    },
    async readDesignSystemResource(name: string, rel: string) {
      const params = new URLSearchParams({ name, rel })
      const res = await fetch(`${API_BASE}/api/assets/design-system-resource?${params}`)
      try {
        return await res.json()
      } catch {
        return {
          ok: false,
          code: 'unavailable',
          error: shimT('runtimeChrome.browserShim.designResourceUnavailable')
        }
      }
    },
    async getDesignSystemResourceCapability(name: string) {
      const res = await fetch(`${API_BASE}/api/assets/design-system-capability?name=${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error(shimT('runtimeChrome.browserShim.designCapabilityUnavailable'))
      const data = await res.json()
      if (typeof data?.capability !== 'string') throw new Error(shimT('runtimeChrome.browserShim.designCapabilityInvalid'))
      return data.capability
    },
    async getCompiledDsManifest(name: string) {
      // 已编译新格式 manifest；未编译/legacy → 后端返回 null，出错也当 null
      try {
        const res = await fetch(`${API_BASE}/api/assets/compiled-ds-manifest?name=${encodeURIComponent(name)}`)
        if (!res.ok) return null
        return res.json()
      } catch { return null }
    },
    async listArtifactHistory(role?: string, limit?: number) {
      const q = new URLSearchParams()
      if (role) q.set('role', role)
      if (limit) q.set('limit', String(limit))
      const res = await fetch(`${API_BASE}/api/artifact/list-history?${q}`)
      const data = await res.json()
      return data.items || []
    },
    async listOutputHistory() {
      const res = await fetch(`${API_BASE}/api/workspace/list-output-history`)
      const data = await res.json()
      return data.items || []
    },
    async saveArtifact(conversationId: string, artifact: { id: string; type: string; title: string; content: string; language?: string }) {
      const res = await fetch(`${API_BASE}/api/artifact/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, artifact })
      })
      return res.json()
    },
    async loadArtifact(ref: { id: string; type: string; title: string; path: string; language?: string }, conversationId?: string) {
      const res = await fetch(`${API_BASE}/api/artifact/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, conversationId })
      })
      return res.json()
    },
    async loadCompiledArtifact(conversationId: string, artifactId: string): Promise<string | null> {
      try {
        const res = await fetch(`${API_BASE}/api/artifact/load-compiled`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId, artifactId })
        })
        if (!res.ok) return null
        const data = await res.json()
        return typeof data?.text === 'string' ? data.text : null
      } catch {
        return null
      }
    },
    async exportDcArtifacts(projectName: string, artifacts: { title: string; content: string }[]) {
      const res = await fetch(`${API_BASE}/api/artifact/export-dc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName, artifacts })
      })
      return res.json()
    },
    async exportArtifactPdf(title: string, content: string) {
      const res = await fetch(`${API_BASE}/api/artifact/export-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
      })
      return res.json()
    },
    async exportZip(_sourceDir: string, _outName: string) {
      return browserUnsupported('runtimeChrome.browserShim.features.exportLocalDirectory')
    },

    // Realtime Voice — 浏览器模式暂不支持（需要 WebSocket proxy）
    async getRealtimeConfig() {
      return { url: '', model: '', hasKey: false }
    },
    async startRealtime() {
      return { success: false, error: shimT('runtimeChrome.browserShim.realtimeUnsupported') }
    },
    stopRealtime() {},
    sendRealtimeEvent() {},
    onRealtimeEvent: () => () => {},
    onRealtimeState: () => () => {}
  }

  // 标记环境
  ;(window as any).__OPENPIPAL_ENV__ = 'browser'
  console.log('[OpenPipal] Web API shim installed (browser mode)')
}
