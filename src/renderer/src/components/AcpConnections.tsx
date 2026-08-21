/**
 * 设置 →「连接」：别的程序此刻怎么连着这台机器上的 OpenPipal。
 *
 * 全部现算现取：主进程推"变了"，这里就重新拉一次快照。**不缓存也不落盘**——
 * 它描述的是此刻，存下来只会留下过期的假象。
 *
 * 「复制给 AI」给出的是**本机 API 的对接说明**，不是编辑器插件的安装步骤：
 * 用户把它粘给另一个 AI，那个 AI 就该知道往哪儿发、怎么带令牌、收什么格式。
 * 因此地址和令牌路径都用当前真实值拼，不写成模板占位。
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Plug, ShieldQuestion } from 'lucide-react'
import type { AcpAdapterLaunch, AcpStatus } from '../../../shared/acp-status-contract'
import { formatRelativeTime } from '../i18n/formatters'

/**
 * 拼一份能直接粘给另一个 AI 的对接说明。三段：往哪儿发、怎么带令牌、收发什么格式。
 *
 * 散文走 i18n，代码块（URL / 头 / JSON）保持字面量——那是接口本身，翻译它等于写错。
 */
/** 编辑器配置里那段 agent server —— 一份 JSON，直接粘 */
export function buildLaunchSnippet(adapter: AcpAdapterLaunch): string {
  return JSON.stringify(
    { command: adapter.command, args: adapter.args, env: adapter.env },
    null,
    2
  )
}

export function buildIntegrationSpec(
  port: number,
  tokenPath: string,
  adapter: AcpAdapterLaunch | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const base = `http://127.0.0.1:${port}`
  return [
    `# ${t('settings.connections.spec.title')}`,
    '',
    `## 1. ${t('settings.connections.spec.connect')}`,
    '',
    t('settings.connections.spec.connectBody', { base }),
    '',
    '```',
    `GET ${base}/health   -> {"status":"ok","app":"openpipal"}`,
    '```',
    '',
    `## 2. ${t('settings.connections.spec.auth')}`,
    '',
    t('settings.connections.spec.authBody', { tokenPath }),
    '',
    '```',
    'X-OpenPipal-ACP-Token: <token>',
    '```',
    '',
    `## 3. ${t('settings.connections.spec.request')}`,
    '',
    t('settings.connections.spec.requestBody'),
    '',
    '```http',
    `POST ${base}/api/conversations`,
    'Content-Type: application/json',
    '',
    '{"title": "my session", "role": "general"}',
    '',
    '-> {"id": "<conversationId>", "role": "general"}',
    '```',
    '',
    '```http',
    `POST ${base}/chat/stream`,
    'Content-Type: application/json',
    '',
    '{"source": "acp",',
    ' "conversationId": "<conversationId>",',
    ' "messages": [{"role": "user", "content": "..."}]}',
    '```',
    '',
    t('settings.connections.spec.historyRule'),
    '',
    `### ${t('settings.connections.spec.stream')}`,
    '',
    t('settings.connections.spec.streamBody'),
    '',
    '```',
    'data: {"type":"thinking","content":"..."}',
    'data: {"type":"tool_start","name":"read_file","toolCallId":"..."}',
    'data: {"type":"tool_end","name":"read_file","toolCallId":"...","mcpResult":"..."}',
    'data: {"type":"text","content":"..."}',
    'data: {"type":"permission","request":{"requestId":"...","tool":"...","risk":"high",',
    '        "conversationId":"...","executionId":"..."}}',
    'data: {"type":"error","content":"..."}',
    'data: {"type":"done"}',
    '```',
    '',
    `### ${t('settings.connections.spec.permission')}`,
    '',
    t('settings.connections.spec.permissionBody'),
    '',
    '```http',
    `POST ${base}/api/permission`,
    'Content-Type: application/json',
    '',
    '{"requestId": "...", "approved": true, "sessionApprove": false,',
    ' "conversationId": "...", "executionId": "..."}',
    '```',
    '',
    `### ${t('settings.connections.spec.extras')}`,
    '',
    '```',
    `GET ${base}/api/agents/list          -> {"builtins": [...], "agents": [...]}`,
    `GET ${base}/api/skills?role=<role>   -> {"skills": [{"name","description"}]}`,
    '```',
    // 没随包带适配器就整段不写——宁可不提，也不给一条跑不通的命令
    ...(adapter
      ? [
        '',
        `## 4. ${t('settings.connections.spec.editor')}`,
        '',
        t('settings.connections.spec.editorBody'),
        '',
        '```json',
        buildLaunchSnippet(adapter),
        '```',
      ]
      : []),
  ].join('\n')
}

export function AcpConnections(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const [status, setStatus] = useState<AcpStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState<'spec' | 'launch' | null>(null)

  // 浏览器插件用的是 web-api-shim，没有这个能力：ACP 连的是桌面端，插件里
  // 整节都不该出现（而不是显示一个永远读不出东西的空壳）。
  const supported = typeof window.api?.getAcpStatus === 'function'

  const load = useCallback(() => {
    if (typeof window.api?.getAcpStatus !== 'function') return
    window.api.getAcpStatus()
      .then((next: AcpStatus) => {
        setStatus(next)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    if (!supported) return
    load()
    return window.api.onAcpStatusChanged?.(load)
  }, [load, supported])

  const copy = async (what: 'spec' | 'launch'): Promise<void> => {
    if (!status?.port) return
    const text = what === 'spec'
      ? buildIntegrationSpec(status.port, status.tokenPath, status.adapter, t)
      : status.adapter && buildLaunchSnippet(status.adapter)
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  if (!supported) return null

  const listening = status !== null && status.port !== null
  const sessions = status?.sessions ?? []
  const pending = status?.pendingPermissions ?? []

  return (
    <div data-testid="acp-connections" className="space-y-0">
      <p className="text-[11px] text-surface-400 mb-3">{t('settings.connections.description')}</p>

      {failed ? (
        <p role="alert" className="text-[11px] text-red-500 break-words">
          {t('settings.connections.errors.load')}
        </p>
      ) : (
        <>
          {/* 服务状态 */}
          <div className="flex items-center gap-2 py-2 px-2 mb-2 rounded-lg bg-surface-50">
            <Plug className={`w-3.5 h-3.5 shrink-0 ${listening ? 'text-brand-500' : 'text-surface-300'}`} />
            <p className="text-[13px] text-surface-700 min-w-0 break-words">
              {listening
                ? t('settings.connections.service.listening', { port: status?.port })
                : t('settings.connections.service.off')}
            </p>
          </div>

          {/* 待确认权限——这一节存在的最大理由 */}
          {pending.length > 0 && (
            <div
              data-testid="acp-pending-permissions"
              className="py-2 px-2 mb-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
            >
              <div className="flex items-center gap-2 mb-1">
                <ShieldQuestion className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-[13px] text-amber-800 dark:text-amber-200 min-w-0 break-words">
                  {t('settings.connections.pending.title', { count: pending.length })}
                </p>
              </div>
              <p className="text-[11px] text-amber-700 dark:text-amber-300 break-words">
                {t('settings.connections.pending.hint')}
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {pending.map(item => (
                  <li
                    key={`${item.conversationId}-${item.tool}-${item.requestedAt}`}
                    className="text-[11px] text-amber-800 dark:text-amber-200 break-words"
                  >
                    {item.risk
                      ? t('settings.connections.pending.itemWithRisk', { tool: item.tool, risk: item.risk })
                      : t('settings.connections.pending.item', { tool: item.tool })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 会话列表 */}
          {sessions.length === 0 ? (
            <div className="flex items-start gap-2 py-2 px-2 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-surface-300" />
              <p className="text-[11px] text-surface-400 min-w-0 break-words">
                {/* 握手过但没会话 ≠ 没装好：这两种"空"要给出不同的下一步 */}
                {t(status?.lastHandshakeAt
                  ? 'settings.connections.emptyAfterHandshake'
                  : 'settings.connections.empty')}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {sessions.map(session => (
                <div key={session.conversationId} className="py-1.5 px-2 rounded-lg hover:bg-surface-50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-surface-700 min-w-0 break-words">{session.title}</span>
                    <span
                      className={`text-[10px] shrink-0 whitespace-nowrap ${
                        session.streaming ? 'text-brand-600 dark:text-brand-400' : 'text-surface-300'
                      }`}
                    >
                      {session.streaming
                        ? t('settings.connections.session.running')
                        : formatRelativeTime(session.lastActivityAt, locale)}
                    </span>
                  </div>
                  <p className="text-[11px] text-surface-400 break-words">
                    {session.client
                      ? t('settings.connections.session.clientLine', {
                        client: session.client,
                        version: session.protocolVersion ?? 1
                      })
                      : t('settings.connections.session.unknownClient')}
                  </p>
                  {/* 真机验收发现：深目录会把这行撑成三行,盖过其它信息。截断 + hover 看全 */}
                  {session.cwd && (
                    <p className="text-[11px] text-surface-400 truncate" title={session.cwd}>
                      {session.cwd}
                    </p>
                  )}
                  {session.agent && (
                    <p className="text-[11px] text-surface-400 break-words">
                      {t('settings.connections.session.agent', { agent: session.agent })}
                    </p>
                  )}
                  {session.mcpServers.length > 0 && (
                    <p className="text-[11px] text-surface-400 break-words">
                      {t('settings.connections.session.mcp', {
                        servers: session.mcpServers.map(s => `${s.name} (${s.toolCount})`).join(', ')
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 编辑器怎么启动适配器——随包带的那份，用户不必自己装 */}
          <p className="mt-3 text-[11px] text-surface-400 break-words">
            {t(status?.adapter
              ? 'settings.connections.adapter.bundled'
              : 'settings.connections.adapter.missing')}
          </p>
          {status?.adapter && (
            <pre
              data-testid="acp-launch-command"
              // 路径很长：横向滚动会被截成半个词，看着像坏了——让它折行，反正旁边有复制按钮
              className="mt-1 px-2 py-1.5 rounded-lg bg-surface-50 text-[11px] text-surface-500 whitespace-pre-wrap break-all"
            >
              {buildLaunchSnippet(status.adapter)}
            </pre>
          )}

          {/* 接入方式 */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void copy('spec')}
              disabled={!listening}
              data-testid="acp-copy-spec"
              className="text-[12px] px-3 py-1.5 rounded-lg border border-surface-100 text-surface-500 whitespace-nowrap hover:text-surface-700 hover:border-surface-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copied === 'spec' ? t('settings.connections.copied') : t('settings.connections.copyForAi')}
            </button>
            {status?.adapter && (
              <button
                type="button"
                onClick={() => void copy('launch')}
                data-testid="acp-copy-launch"
                className="text-[12px] px-3 py-1.5 rounded-lg border border-surface-100 text-surface-500 whitespace-nowrap hover:text-surface-700 hover:border-surface-200 transition-colors"
              >
                {copied === 'launch' ? t('settings.connections.copied') : t('settings.connections.copyLaunch')}
              </button>
            )}
            <span className="text-[11px] text-surface-300 min-w-0 truncate">
              {t('settings.connections.tokenPath', { path: status?.tokenPath ?? '' })}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
