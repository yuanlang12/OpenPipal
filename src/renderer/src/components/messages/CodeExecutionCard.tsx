import { useState } from 'react'
import { ChevronDown, Play, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatMessage } from '../../types'
import { Markdown } from '../shared/Markdown'

interface CodeExecution {
  language: string
  code: string
  stdout: string
  stderr: string
  exitCode: number
  elapsed: number
  description?: string
}

function tryParseExecution(msg: ChatMessage): CodeExecution | null {
  if (!msg.toolArgs) return null
  try {
    const value = JSON.parse(msg.toolArgs) as Partial<CodeExecution> | null
    if (!value || typeof value !== 'object') return null
    if (typeof value.language !== 'string' || typeof value.code !== 'string') return null
    if (typeof value.exitCode !== 'number' || !Number.isFinite(value.exitCode)) return null
    return {
      language: value.language,
      code: value.code,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : '',
      exitCode: value.exitCode,
      elapsed: typeof value.elapsed === 'number' && Number.isFinite(value.elapsed) ? value.elapsed : 0,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
    }
  } catch {
    return null
  }
}

const LANG_LABELS: Record<string, string> = {
  python: 'Python',
  javascript: 'Node.js',
  bash: 'Shell'
}

export function CodeExecutionCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [codeExpanded, setCodeExpanded] = useState(false)
  const exec = tryParseExecution(message)
  if (!exec) return null

  const ok = exec.exitCode === 0
  const langLabel = LANG_LABELS[exec.language] || exec.language

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full pl-3 pr-2 border-l border-border">
        {/* Header — 不再有独立 bg,status 用 icon 颜色 + 文字色表达 */}
        <div className="py-1 flex items-center gap-2">
          {ok ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" strokeWidth={1.75} />
          ) : (
            <XCircle className="w-3.5 h-3.5 text-danger shrink-0" strokeWidth={1.75} />
          )}
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Play className="w-3 h-3 text-ink-tertiary shrink-0" />
            <span className="text-chat-label font-medium text-ink-primary">{langLabel}</span>
            {exec.description && (
              <span className="text-chat-meta text-ink-tertiary truncate">— {exec.description}</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-chat-small text-ink-tertiary shrink-0">
            <Clock className="w-3 h-3" />
            {exec.elapsed < 1000 ? `${exec.elapsed}ms` : `${(exec.elapsed / 1000).toFixed(1)}s`}
          </div>
        </div>

        {/* Code(collapsible)— chevron hover 才浮现,收起态只留"N 行代码"一行元信息 */}
        <button
          onClick={() => setCodeExpanded(!codeExpanded)}
          className="group/code w-full py-0.5 flex items-center gap-1.5 text-chat-meta text-ink-tertiary hover:text-ink-secondary transition-colors"
        >
          <ChevronDown
            className={`w-3 h-3 transition duration-200 ${codeExpanded ? 'rotate-180' : ''} opacity-0 group-hover/code:opacity-100 group-focus-visible/code:opacity-100`}
          />
          <span>{t('chat.codeExecution.codeLines', { count: exec.code.split('\n').length })}</span>
        </button>
        {codeExpanded && (
          <div className="py-1 max-h-48 overflow-auto prose-light text-chat-meta">
            <Markdown content={`\`\`\`${exec.language}\n${exec.code}\n\`\`\``} />
          </div>
        )}

        {/* Output */}
        {(exec.stdout || exec.stderr) && (
          <div className="py-1 max-h-40 overflow-auto">
            {exec.stdout && (
              <pre className="text-chat-meta font-mono text-ink-secondary whitespace-pre-wrap break-all">{exec.stdout}</pre>
            )}
            {exec.stderr && (
              <pre className="text-chat-meta font-mono text-danger whitespace-pre-wrap break-all">{exec.stderr}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
