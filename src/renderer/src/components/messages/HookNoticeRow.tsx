/**
 * HookNoticeRow —— 对话流里「已定下规则：…」那枚胶囊。
 *
 * 规则不是这轮的主线任务，是顺手定下的一件事：居中、小，长期留在它发生的位置——随会话落盘，
 * 不发给模型、不算对话历史；不弹窗、不自动消失。与记忆胶囊（MemoryNoticeRow）同族，壳在 NoticeCapsule。
 * 文案来自加载器的结论（message.hookNotice），"现在还开着没有"是渲染时从 hookStore 算的：
 * 以后在插件页关掉了，回头翻这条对话会看到「（已撤销）」，不会骗人。
 * 撤销 = 文件改名成 .off（可恢复）；查看 = 跳到插件页。开关失败的原因就地显示几秒，不吞。
 */
import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '../../types'
import { useHookStore } from '../../stores/hookStore'
import { useAppStore } from '../../stores/appStore'
import { NoticeCapsule } from './shared/NoticeCapsule'

type RowState = 'unknown' | 'ok' | 'error' | 'off' | 'plugin-off' | 'deleted'

/**
 * 这行现在该显示成什么：
 *   清单还没拿到（或这端拿不到，比如浏览器插件）→ 按写入时的结论显示，不下"已删除"的判断
 *   清单里有它 → 以清单为准（后来改好了就变"已定下"，关了就"已撤销"，所在插件停用了另说）
 *   清单里没有 → 写入时就失败的（比如插件无效，清单本来就不列）仍显示失败原因；写入成功过的才算"已删除"
 */
export function resolveHookRowState(
  loaded: boolean,
  current: { status: 'ok' | 'error' | 'off'; offReason?: 'file' | 'plugin' } | undefined,
  noticeStatus: 'ok' | 'error'
): RowState {
  if (!loaded) return 'unknown'
  if (!current) return noticeStatus === 'error' ? 'error' : 'deleted'
  if (current.status === 'off') return current.offReason === 'plugin' ? 'plugin-off' : 'off'
  return current.status
}

const actionCls = 'flex-shrink-0 opacity-80 hover:opacity-100 underline-offset-2 hover:underline transition-opacity'

export function HookNoticeRow({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const notice = message.hookNotice
  const entries = useHookStore((s) => s.entries)
  const loaded = useHookStore((s) => s.loaded)
  const refresh = useHookStore((s) => s.refresh)
  const setEnabled = useHookStore((s) => s.setEnabled)
  const openToolsHub = useAppStore((s) => s.openToolsHub)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  if (!notice) return null

  const current = loaded ? entries.find((entry) => entry.id === notice.hookId) : undefined
  const state = resolveHookRowState(loaded, current, notice.status)
  // 文案以"现在"为准：写入时失败、后来改好了，这行就该变成「已定下规则」
  const failed = state === 'error' || (state === 'unknown' && notice.status === 'error')
  const description = current?.description || notice.description
  const errorText = current?.error || notice.error || ''
  const text = failed
    ? t('chat.message.hookRuleFailed', { error: errorText })
    : t('chat.message.hookRuleSet', { description })
  const suffix = state === 'off'
    ? t('chat.message.hookRuleRevoked')
    : state === 'plugin-off'
      ? t('chat.message.hookRulePluginOff')
      : state === 'deleted'
        ? t('chat.message.hookRuleDeleted')
        : ''
  const file = current?.file || notice.file

  const toggle = async (enabled: boolean): Promise<void> => {
    setActionError(null)
    const result = await setEnabled(file, enabled)
    if (!result.ok) {
      setActionError(result.error || t('chat.message.hookRuleToggleFailed'))
      setTimeout(() => setActionError(null), 6000)
    }
  }

  return (
    <NoticeCapsule
      subtype="hook"
      tone={failed ? 'warn' : suffix ? 'muted' : 'brand'}
      icon={<ShieldCheck className="w-3.5 h-3.5" />}
      title={file || undefined}
      attrs={{ 'data-hook-state': state }}
    >
      <span className="truncate">{text}{suffix}</span>
      <button type="button" className={actionCls} onClick={() => openToolsHub('rules')}>
        {t('chat.message.hookRuleView')}
      </button>
      {(state === 'ok' || state === 'error') && file && (
        <button type="button" className={actionCls} onClick={() => { void toggle(false) }}>
          {t('chat.message.hookRuleRevoke')}
        </button>
      )}
      {state === 'off' && (
        <button type="button" className={actionCls} onClick={() => { void toggle(true) }}>
          {t('chat.message.hookRuleRestore')}
        </button>
      )}
      {actionError && (
        <span className="flex-shrink-0 text-red-500" data-testid="hook-notice-error">{actionError}</span>
      )}
    </NoticeCapsule>
  )
}
