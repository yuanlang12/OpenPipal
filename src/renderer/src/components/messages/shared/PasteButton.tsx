import { useState } from 'react'
import { Check, X, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function PasteButton({ text, appName }: { text: string; appName: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const label = status === 'success'
    ? t('chat.paste.success')
    : status === 'error'
      ? t('chat.paste.failed')
      : t('chat.paste.toApp', { appName })

  const handlePaste = async () => {
    const result = await window.api.pasteToTarget(text)
    if (result.success) {
      setStatus('success')
      setTimeout(() => setStatus('idle'), 1500)
    } else {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 1500)
    }
  }

  return (
    <button
      type="button"
      onClick={handlePaste}
      title={label}
      aria-label={label}
      className="min-w-0 max-w-full flex items-center gap-1 text-[11px] text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors px-1.5 py-0.5 rounded hover:bg-brand-50 dark:hover:bg-brand-900/30"
    >
      {status === 'success' ? (
        <>
          <Check className="w-3 h-3" />
          <span className="min-w-0 truncate">{label}</span>
        </>
      ) : status === 'error' ? (
        <>
          <X className="w-3 h-3" />
          <span className="min-w-0 truncate">{label}</span>
        </>
      ) : (
        <>
          <Upload className="w-3 h-3" />
          <span className="min-w-0 truncate">{label}</span>
        </>
      )}
    </button>
  )
}
