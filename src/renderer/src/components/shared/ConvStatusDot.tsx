import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'

/**
 * 会话状态指示器（侧栏 / 历史弹层共用）：红点=需要你（完成未读 / 等待输入，优先），
 * 转圈=纯生成中。自订阅 chatStore 的按会话登记表——父组件无需各自订阅两个字段。
 */
export function ConvStatusDot({ id }: { id: string }) {
  const { t } = useTranslation()
  const streaming = useChatStore(s => !!s.streamingConvIds[id])
  const unread = useChatStore(s => !!s.unreadDoneConvIds[id])
  if (unread) {
    const label = t('shell.history.status.needsAttention')
    return <span role="img" aria-label={label} className="shrink-0 w-2 h-2 rounded-full bg-red-500" title={label} />
  }
  if (streaming) {
    const label = t('shell.history.status.generating')
    return <span role="img" aria-label={label} className="shrink-0 w-3 h-3 rounded-full border-2 border-brand-400 border-t-transparent animate-spin" title={label} />
  }
  return null
}
