import { Shield, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface PermissionRequest {
  requestId: string
  tool: string
  args: Record<string, any>
  risk: string
  reason: string
}

interface PermissionModalProps {
  request: PermissionRequest
  onRespond: (requestId: string, approved: boolean) => void
}

import { toolLabel } from '../chat/toolPhrases'

export function PermissionModal({ request, onRespond }: PermissionModalProps) {
  const { t } = useTranslation()
  const isRisky = request.reason.includes('危险') || request.reason.includes('删除')
  const toolDisplayName = toolLabel(request.tool, t)

  // 格式化参数展示
  const argEntries = Object.entries(request.args || {})
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const str = String(v)
      return { key: k, value: str.length > 120 ? str.substring(0, 120) + '...' : str }
    })

  return (
    <div className="absolute inset-0 z-[60] bg-black/40 dark:bg-black/60 flex items-center justify-center p-4" data-testid="permission-modal">
      <div className="op-glass op-glass-edge w-full max-w-[380px] overflow-hidden animate-fade-in">
        {/* Header */}
        <div className={`px-4 py-3 flex items-center gap-2.5 ${isRisky ? 'bg-red-50 dark:bg-red-900/20' : 'bg-amber-50 dark:bg-amber-900/20'}`}>
          {isRisky ? (
            <ShieldAlert className="w-5 h-5 text-red-500 flex-shrink-0" />
          ) : (
            <Shield className="w-5 h-5 text-amber-500 flex-shrink-0" />
          )}
          <div>
            <p className={`text-[13px] font-medium ${isRisky ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {isRisky ? t('chat.permission.highRiskOperation') : t('chat.permission.operationConfirmation')}
            </p>
            <p className="text-[11px] text-surface-500 mt-0.5">{request.reason}</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-surface-400 w-10">{t('chat.permission.tool')}</span>
            <span className="text-[13px] text-surface-700 font-medium">{toolDisplayName}</span>
          </div>

          {argEntries.length > 0 && (
            <div className="bg-surface-50 rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
              {argEntries.map(({ key, value }) => (
                <div key={key} className="flex gap-1.5 text-[11px] mb-1 last:mb-0">
                  <span className="text-surface-400 shrink-0">{key}:</span>
                  <span className="text-surface-600 break-all font-mono text-[10px]">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="px-4 py-3 border-t border-surface-100 flex items-center gap-2">
          <button
            onClick={() => onRespond(request.requestId, false)}
            className="flex-1 text-[12px] py-2 rounded-lg border border-surface-200 text-surface-500 hover:bg-surface-50 transition-colors"
          >
            {t('chat.permission.deny')}
          </button>
          <button
            onClick={() => onRespond(request.requestId, true)}
            className={`flex-1 text-[12px] py-2 rounded-lg text-white transition-colors ${
              isRisky
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-brand-500 hover:bg-brand-600'
            }`}
          >
            {t('chat.permission.allow')}
          </button>
        </div>
      </div>
    </div>
  )
}
