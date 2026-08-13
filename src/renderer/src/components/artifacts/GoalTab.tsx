/**
 * GoalTab —— ArtifactType='goal' 的 Workspace 侧栏渲染器
 *
 * content 字段是 JSON.stringify(ConversationGoal):
 * {
 *   text, maxTurns, turnsUsed, status, consecutiveBlocks, createdAt,
 *   lastCheck?: { ok, reason, fallback?, timestamp }
 * }
 *
 * 设计:
 * - 显示目标文本 + 状态徽章(active/done/exceeded) + 进度(turnsUsed/maxTurns)
 * - 上次评估的 reason(GoalChecker 反馈)
 * - 清除按钮(/goal clear 等价)
 */

import { CheckCircle2, Target, AlertTriangle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'

interface GoalState {
  text: string
  maxTurns: number
  turnsUsed: number
  status: 'active' | 'paused' | 'done' | 'exceeded'
  consecutiveBlocks: number
  createdAt: number
  lastCheck?: {
    ok: boolean
    reason: string
    fallback?: boolean
    timestamp: number
  }
}

function parseGoal(content: string): GoalState | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
      return parsed as GoalState
    }
  } catch {
    /* ignore */
  }
  return null
}

const STATUS_CONFIG = {
  active: {
    icon: Target,
    iconColor: 'text-brand-500',
    bg: 'bg-brand-50 dark:bg-brand-900/20',
    border: 'border-brand-200 dark:border-brand-800',
    textColor: 'text-brand-700 dark:text-brand-300'
  },
  done: {
    icon: CheckCircle2,
    iconColor: 'text-emerald-500',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    border: 'border-emerald-200 dark:border-emerald-800',
    textColor: 'text-emerald-700 dark:text-emerald-300'
  },
  exceeded: {
    icon: AlertTriangle,
    iconColor: 'text-amber-500',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    border: 'border-amber-200 dark:border-amber-800',
    textColor: 'text-amber-700 dark:text-amber-300'
  },
  paused: {
    icon: Target,
    iconColor: 'text-surface-400',
    bg: 'bg-surface-50 dark:bg-surface-50/50',
    border: 'border-surface-200',
    textColor: 'text-surface-600'
  }
} as const

export function GoalTab({ content }: { content: string }): JSX.Element {
  const { t } = useTranslation()
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const goal = parseGoal(content)

  const handleClear = (): void => {
    if (!activeConversationId) return
    ;(window.api as any).clearGoal?.(activeConversationId)
  }

  if (!goal) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-surface-400">
        {t('artifacts.goal.invalid')}
      </div>
    )
  }

  const cfg = STATUS_CONFIG[goal.status]
  const Icon = cfg.icon
  const progressPct = goal.maxTurns > 0
    ? Math.min(100, Math.round((goal.turnsUsed / goal.maxTurns) * 100))
    : 0

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* 状态卡 */}
      <div className={`rounded-lg border ${cfg.border} ${cfg.bg} p-4`}>
        <div className="flex items-start gap-3">
          <Icon size={18} className={`mt-0.5 shrink-0 ${cfg.iconColor}`} />
          <div className="flex-1 min-w-0">
            <div className={`text-[11px] font-medium ${cfg.textColor} uppercase tracking-wide mb-1`}>
              {t(`artifacts.goal.status.${goal.status}`)}
            </div>
            <div className="text-sm text-surface-800 break-words">
              {goal.text}
            </div>
          </div>
          {goal.status === 'active' && (
            <button
              onClick={handleClear}
              className="shrink-0 p-1 rounded hover:bg-surface-100 text-surface-400 hover:text-surface-700 transition-colors"
              title={t('artifacts.goal.clearTitle')}
              aria-label={t('artifacts.goal.clearTitle')}
              data-testid="goal-clear-btn"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 进度条 */}
      <div>
        <div className="flex items-center justify-between mb-1.5 text-[11px] text-surface-500">
          <span>{t('artifacts.goal.progress')}</span>
          <span className="font-mono">{t('artifacts.goal.turns', { used: goal.turnsUsed, max: goal.maxTurns })}</span>
        </div>
        <div
          className="h-1.5 bg-surface-100 rounded-full overflow-hidden"
          role="progressbar"
          aria-label={t('artifacts.goal.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
        >
          <div
            className={`h-full transition-all ${
              goal.status === 'done' ? 'bg-emerald-500'
              : goal.status === 'exceeded' ? 'bg-amber-500'
              : 'bg-brand-500'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* 上次评估反馈 */}
      {goal.lastCheck && (
        <div className="text-xs">
          <div className="text-[11px] text-surface-500 mb-1.5">
            {t('artifacts.goal.lastCheck')}{goal.lastCheck.fallback ? t('artifacts.goal.fallbackSuffix') : ''}
          </div>
          <div className="rounded border border-surface-200 bg-surface-50 dark:bg-surface-50/50 p-2.5 text-surface-700 break-words">
            {goal.lastCheck.reason || t('artifacts.goal.noReason')}
          </div>
        </div>
      )}

      {/* 提示文案 */}
      {goal.status === 'active' && (
        <div className="text-[11px] text-surface-400 leading-relaxed">
          {t('artifacts.goal.activeHint', { max: goal.maxTurns })}{' '}
          {t('artifacts.goal.clearHintBefore')}{' '}
          <code className="font-mono">/goal clear</code>{' '}
          {t('artifacts.goal.clearHintAfter')}
        </div>
      )}
      {goal.status === 'done' && (
        <div className="text-[11px] text-surface-400 leading-relaxed">
          {t('artifacts.goal.doneHint')}
        </div>
      )}
      {goal.status === 'exceeded' && (
        <div className="text-[11px] text-surface-400 leading-relaxed">
          {t('artifacts.goal.exceededHint', { max: goal.maxTurns })}
        </div>
      )}
    </div>
  )
}
