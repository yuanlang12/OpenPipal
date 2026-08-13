import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../shared/Markdown'
import { isReceiptOnlyContent } from '../../utils/format'

interface CodePreviewProps {
  content: string
  language?: string
  title: string
}

export function CodePreview({ content, language, title }: CodePreviewProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  // 曾被"回执当正文"bug 覆写的产物：展示损坏态提示比渲染一行黑块占位对用户更诚实
  if (isReceiptOnlyContent(content)) {
    return (
      <div className="flex flex-col h-full items-center justify-center px-6 text-center gap-2">
        <span className="text-[13px] font-medium text-surface-600">{t('artifacts.invalidContent.title')}</span>
        <span className="text-[12px] text-surface-400 leading-relaxed">
          {t('artifacts.invalidContent.description')}
          <br />{t('artifacts.invalidContent.regenerate', { title })}
        </span>
      </div>
    )
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const codeBlock = `\`\`\`${language || ''}\n${content}\n\`\`\``

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 bg-surface-50 border-b border-surface-100">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-surface-500">{language?.toUpperCase() || 'CODE'}</span>
          <span className="text-[11px] text-surface-400 truncate">{title}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-surface-400 hover:text-surface-600 px-2 py-1 rounded hover:bg-surface-100 transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
          {copied ? t('common.actions.copied') : t('common.actions.copy')}
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3 prose-light text-[12px]">
        <Markdown content={codeBlock} />
      </div>
    </div>
  )
}
