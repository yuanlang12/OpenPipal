import { useState } from 'react'
import { Terminal, ChevronDown, Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatMessage } from '../../types'

export function BashOutputCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)

  // 从 toolArgs 提取命令
  let command = ''
  try {
    const args = JSON.parse(message.toolArgs || '{}')
    command = args.command || ''
  } catch {
    // Malformed tool arguments should not hide already-captured terminal output.
  }

  const output = message.content || ''
  const isError = output.includes('[exit code:') && !output.includes('[exit code: 0]')

  const handleCopy = () => {
    navigator.clipboard.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-[92%] sm:max-w-[85%] w-full">
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 rounded-t-lg px-3 py-2 bg-surface-800 dark:bg-[#0a0a0a] text-left"
        >
          <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="text-[12px] font-mono text-surface-300 truncate flex-1">
            {command ? `$ ${command}` : t('chat.bashOutput.terminal')}
          </span>
          {!expanded && output && (
            <span className={`text-chat-meta truncate max-w-[30%] ${isError ? 'text-red-400' : 'text-surface-500'}`}>
              {output.slice(0, 40)}
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-surface-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>

        {/* Output */}
        {expanded && (
          <div className="relative rounded-b-lg bg-surface-800 dark:bg-[#0a0a0a] border-t border-surface-700 dark:border-surface-200">
            <pre className="px-3 py-2.5 text-chat-meta font-mono text-surface-200 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
              {output || t('chat.bashOutput.noOutput')}
            </pre>
            <button
              onClick={handleCopy}
              title={copied ? t('common.actions.copied') : t('common.actions.copy')}
              aria-label={copied ? t('common.actions.copied') : t('common.actions.copy')}
              className="absolute top-2 right-2 text-surface-500 hover:text-surface-300 transition-colors p-1 rounded"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
