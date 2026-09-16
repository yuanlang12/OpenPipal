import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'

/**
 * 会话状态指示器（侧栏 / 历史弹层共用）：红点=需要你（完成未读 / 等待输入，优先），
 * 转圈=纯生成中。自订阅 chatStore 的按会话登记表——父组件无需各自订阅两个字段。
 */
export function ConvStatusDot({ id }: { id: string }) {
  const streaming = useChatStore(s => !!s.streamingConvIds[id])
  const unread = useChatStore(s => !!s.unreadDoneConvIds[id])
  return <StatusDot streaming={streaming} unread={unread} />
}

/** 一组会话（团队行）的聚合状态：有一条要你看就红点，否则有一条在跑就转圈 */
export function ConvGroupStatusDot({ ids }: { ids: string[] }) {
  const streaming = useChatStore(s => ids.some(id => !!s.streamingConvIds[id]))
  const unread = useChatStore(s => ids.some(id => !!s.unreadDoneConvIds[id]))
  return <StatusDot streaming={streaming} unread={unread} />
}

function StatusDot({ streaming, unread }: { streaming: boolean; unread: boolean }) {
  const { t } = useTranslation()
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
