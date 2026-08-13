/**
 * TaskTemplates — 任务模板库（Codex 风格网格）
 *
 * 8 个预置模板，点击后填充到 TaskEditor 的 name/prompt 字段。
 */

import type { TFunction } from 'i18next'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface TaskTemplate {
  id: BuiltinTaskTemplateId
  icon: string
  name: string
  description: string
  prompt: string
}

const BUILTIN_TEMPLATE_DEFINITIONS = [
  { id: 'dailyBugScan', icon: '🐞' },
  { id: 'weeklyReleaseNotes', icon: '📖' },
  { id: 'yesterdayGitStandup', icon: '💬' },
  { id: 'ciFailureDiagnosis', icon: '🎯' },
  { id: 'miniGameBuilder', icon: '🎮' },
  { id: 'skillGrowthAdvice', icon: '🧠' },
  { id: 'weeklyWorkSummary', icon: '📝' },
  { id: 'performanceComparison', icon: '📊' },
] as const

export type BuiltinTaskTemplateId = (typeof BUILTIN_TEMPLATE_DEFINITIONS)[number]['id']

/** Build the product-owned templates in the active UI locale at render time. */
export function getBuiltinTaskTemplates(t: TFunction): TaskTemplate[] {
  return BUILTIN_TEMPLATE_DEFINITIONS.map(({ id, icon }) => ({
    id,
    icon,
    name: t(`tasks.templates.items.${id}.name`),
    description: t(`tasks.templates.items.${id}.description`),
    prompt: t(`tasks.templates.items.${id}.prompt`),
  }))
}

interface Props {
  onPick: (tpl: TaskTemplate) => void
  onClose: () => void
}

export function TaskTemplates({ onPick, onClose }: Props) {
  const { t } = useTranslation()
  const templates = getBuiltinTaskTemplates(t)

  return (
    <div
      className="absolute inset-0 bg-surface-0 dark:bg-surface-50 rounded-2xl z-20 flex flex-col"
      onClick={e => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={t('tasks.templates.title')}
    >
      <div className="shrink-0 px-5 pt-5 pb-3 flex items-center gap-2">
        <span className="flex-1 text-[18px] font-semibold text-surface-700">
          {t('tasks.templates.title')}
        </span>
        <button
          onClick={onClose}
          className="p-1.5 rounded-full hover:bg-surface-100 text-surface-400"
          aria-label={t('common.actions.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          {templates.map(tpl => (
            <button
              key={tpl.id}
              onClick={() => onPick(tpl)}
              className="min-w-0 text-left p-4 rounded-xl border border-surface-100 hover:border-brand-300 hover:bg-brand-50/30 dark:hover:bg-brand-900/10 transition-colors"
            >
              <div className="text-2xl mb-2" aria-hidden="true">{tpl.icon}</div>
              <div className="text-[13px] font-medium text-surface-700 mb-1 break-words">
                {tpl.name}
              </div>
              <div className="text-[11px] text-surface-400 line-clamp-3 leading-relaxed break-words">
                {tpl.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
