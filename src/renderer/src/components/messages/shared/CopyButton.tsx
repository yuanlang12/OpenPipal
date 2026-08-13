import { useState } from 'react'
import { Check, Clipboard } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const BRAND_SIGNATURE = '\n\n— Powered by OpenPipal'
const BRAND_SIGNATURE_HTML = '<br><br><span style="color:#a8a29e;font-size:12px">— Powered by OpenPipal</span>'

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const textWithBrand = text + BRAND_SIGNATURE
    try {
      // 动态 import：marked 只服务"复制为富文本"这一个点击动作，不进首屏 chunk
      const { marked } = await import('marked')
      const html = await marked(text)
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html + BRAND_SIGNATURE_HTML], { type: 'text/html' }),
          'text/plain': new Blob([textWithBrand], { type: 'text/plain' })
        })
      ])
    } catch {
      await navigator.clipboard.writeText(textWithBrand)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 text-[11px] text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors px-1.5 py-0.5 rounded hover:bg-brand-50 dark:hover:bg-brand-900/30"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" />
          <span>{t('common.actions.copied')}</span>
        </>
      ) : (
        <>
          <Clipboard className="w-3 h-3" />
          <span>{t('common.actions.copy')}</span>
        </>
      )}
    </button>
  )
}
