/**
 * 用户在 agent 跑的时候挂起的待发消息卡片堆叠。
 * 渲染在 InputBar 的输入框上方。
 *
 * 每张卡片：
 *  - 左：↳ 图标 + 消息文本（单行截断，hover tooltip 展示完整）
 *  - 右：「⤴ 引导」立即送（steerChat）+ 「🗑」删除
 *
 * 行为：
 *  - 立即送 → chatStore.sendPendingNow(id, role)，失败降级 sendMessage
 *  - 自动 flush 由 chatStore 在 stream-end 时触发，不需要这里管
 */

import { CornerDownRight, CornerUpLeft, Trash2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useTranslation } from 'react-i18next'

export function PendingMessageStack() {
  const { t } = useTranslation()
  const pendingMessages = useChatStore(s => s.pendingMessages)
  const removePending = useChatStore(s => s.removePending)
  const sendPendingNow = useChatStore(s => s.sendPendingNow)
  const currentRole = useAppStore(s => s.currentRole)
  const roleName = currentRole?.name || 'learner'

  if (pendingMessages.length === 0) return null

  return (
    <div className="max-w-[880px] mx-auto flex flex-col gap-1.5 mb-2" data-testid="pending-message-stack">
      {pendingMessages.map(msg => {
        // 文本可能含图片 placeholder, 展示用 truncate
        const preview = msg.content || (msg.images?.length
          ? t('chat.pending.images', { count: msg.images.length })
          : t('chat.pending.attachment'))
        return (
          <div
            key={msg.id}
            data-testid="pending-message-card"
            className="group flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-100/80 dark:bg-surface-100/60 border border-surface-200 text-xs text-surface-700 transition-colors hover:bg-surface-100"
            title={msg.content}
          >
            <CornerDownRight className="w-3.5 h-3.5 flex-shrink-0 text-surface-400" />
            <span className="flex-1 min-w-0 truncate">{preview}</span>
            <button
              onClick={() => sendPendingNow(msg.id, roleName)}
              data-testid="pending-send-now-btn"
              title={t('chat.pending.sendNowTitle')}
              className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors"
            >
              <CornerUpLeft className="w-3 h-3" />
              <span className="text-[11px]">{t('chat.pending.steer')}</span>
            </button>
            <button
              onClick={() => removePending(msg.id)}
              data-testid="pending-remove-btn"
              title={t('chat.pending.remove')}
              className="flex-shrink-0 p-1 rounded text-surface-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
