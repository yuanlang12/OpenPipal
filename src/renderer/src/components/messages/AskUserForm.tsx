/**
 * 表单式用户输入组件 — 替代在聊天中列出问题清单
 * AI 通过 ask_user 工具的 fields 模式触发
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface FormField {
  label: string
  placeholder?: string
  /** 未知类型按 text 渲染，保证服务端新增字段时表单仍可提交。 */
  type?: string
  options?: string[]
  required?: boolean
}

interface AskUserFormProps {
  question: string
  fields: FormField[]
  onSubmit: (answers: string) => void
  /**
   * 布局变体：
   * - 'message'（默认）：作为消息气泡渲染，带左对齐和 85% 最大宽度，给头像留位置
   * - 'popup'：作为 InputBar 上方的浮层，填满父容器宽度，不带外层 flex wrapper
   */
  variant?: 'message' | 'popup'
}

export function AskUserForm({ question, fields, onSubmit, variant = 'message' }: AskUserFormProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    fields.forEach(f => { init[f.label] = '' })
    return init
  })
  const [submitted, setSubmitted] = useState(false)

  const handleChange = (label: string, value: string) => {
    setValues(prev => ({ ...prev, [label]: value }))
  }

  const handleSubmit = () => {
    // 格式化为结构化文本回复
    const parts = fields.map(f => `${f.label}: ${values[f.label] || t('chat.askUser.notFilled')}`).join('\n')
    onSubmit(parts)
    setSubmitted(true)
  }

  const allRequiredFilled = fields.filter(f => f.required).every(f => values[f.label]?.trim())

  // popup 模式：填满父容器，不带外层 flex + 85% 约束
  // message 模式：保持原样，作为消息气泡
  const outerClass = variant === 'popup'
    ? 'animate-fade-in'
    : 'flex justify-start mb-msg animate-fade-in'
  const innerClass = variant === 'popup'
    ? 'w-full bg-surface-0 dark:bg-surface-50 overflow-hidden'
    : 'max-w-[92%] sm:max-w-[85%] w-full rounded-lg border border-surface-100 bg-surface-0 dark:bg-surface-50 overflow-hidden'
  const innerClassSubmitted = variant === 'popup'
    ? 'w-full bg-surface-0 dark:bg-surface-50 px-4 py-3'
    : 'max-w-[92%] sm:max-w-[85%] w-full rounded-lg border border-surface-100 bg-surface-0 dark:bg-surface-50 px-4 py-3'

  if (submitted) {
    return (
      <div className={outerClass}>
        <div className={innerClassSubmitted}>
          <p className="text-chat-label text-surface-400 mb-2">{question}</p>
          {fields.map(f => (
            <div key={f.label} className="flex gap-2 text-chat-label mb-1">
              <span className="text-surface-400 shrink-0">{f.label}:</span>
              <span className="text-surface-600">{values[f.label] || '—'}</span>
            </div>
          ))}
          <p className="text-chat-meta text-brand-500 mt-2">{t('chat.askUser.submitted')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={outerClass}>
      <div className={innerClass}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface-100">
          <p className="text-chat font-medium text-surface-700">{question}</p>
        </div>

        {/* Fields */}
        <div className="px-4 py-3 space-y-3">
          {fields.map(f => (
            <div key={f.label}>
              <label className="text-chat-meta font-medium text-surface-500 mb-1 block">
                {f.label} {f.required && <span className="text-brand-500">*</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  value={values[f.label] || ''}
                  onChange={e => handleChange(f.label, e.target.value)}
                  placeholder={f.placeholder}
                  rows={3}
                  className="w-full px-3 py-2 text-chat rounded-md bg-surface-50 border border-surface-100 text-surface-700 placeholder:text-surface-300 focus:outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100 resize-y"
                />
              ) : f.type === 'select' && f.options ? (
                <select
                  value={values[f.label] || ''}
                  onChange={e => handleChange(f.label, e.target.value)}
                  className="w-full px-3 py-2 text-chat rounded-md bg-surface-50 border border-surface-100 text-surface-700 focus:outline-none focus:border-brand-300"
                >
                  <option value="">{f.placeholder || t('chat.askUser.selectPlaceholder')}</option>
                  {f.options.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={values[f.label] || ''}
                  onChange={e => handleChange(f.label, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 text-chat rounded-md bg-surface-50 border border-surface-100 text-surface-700 placeholder:text-surface-300 focus:outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100"
                />
              )}
            </div>
          ))}
        </div>

        {/* Submit */}
        <div className="px-4 py-3 border-t border-surface-100 flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={!allRequiredFilled}
            className={`px-4 py-1.5 rounded-md text-chat-label font-medium transition-colors ${
              allRequiredFilled
                ? 'bg-brand-500 text-ink-on-accent hover:bg-brand-600'
                : 'bg-surface-100 text-surface-300 cursor-not-allowed'
            }`}
          >
            {t('chat.askUser.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
