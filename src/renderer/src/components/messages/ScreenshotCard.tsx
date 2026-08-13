import { useEffect, useState } from 'react'
import { Camera } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatMessage } from '../../types'
import { useChatStore } from '../../stores/chatStore'

export function ScreenshotCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  // 截图可能已卸载到附件 sidecar(只剩 screenshotRef)——挂载时按 ref 懒加载
  const cid = useChatStore(s => s.activeConversationId)
  const [lazyScreenshot, setLazyScreenshot] = useState<string | null>(null)
  useEffect(() => {
    if (message.screenshot || !message.screenshotRef || !cid) return
    let cancelled = false
    ;(window.api as any).loadConvAttachment?.(cid, message.screenshotRef)
      ?.then((data: string | null) => {
        if (!cancelled && data) setLazyScreenshot(data)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [message.screenshot, message.screenshotRef, cid])

  const screenshot = message.screenshot || lazyScreenshot
  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full pl-3 pr-2 py-1.5 border-l border-border">
        <div className="flex items-center gap-1.5 mb-1">
          <Camera className="w-3 h-3 text-brand-500 shrink-0" strokeWidth={1.75} />
          <span className="text-chat-meta font-medium text-ink-secondary">{t('chat.screenshot.title')}</span>
        </div>
        {screenshot ? (
          <img
            src={`data:image/jpeg;base64,${screenshot}`}
            alt={t('chat.screenshot.title')}
            className="rounded-md border border-border max-h-40 w-auto"
          />
        ) : (
          <div className="rounded-md border border-border h-20 w-40 flex items-center justify-center text-chat-meta text-ink-secondary/60">
            {t('chat.screenshot.loading')}
          </div>
        )}
      </div>
    </div>
  )
}
