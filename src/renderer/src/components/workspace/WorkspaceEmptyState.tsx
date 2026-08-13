import { FileText, Globe, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * WorkspacePanel 无打开 tab 时的占位。
 * 提示用户怎么把内容送进 workspace —— 不强行教学，保持冷淡。
 */
export function WorkspaceEmptyState() {
  const { t } = useTranslation()

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-surface-400 px-6 py-10 select-none">
      <div className="flex items-center gap-4 opacity-60 mb-5">
        <FileText size={22} />
        <Palette size={22} />
        <Globe size={22} />
      </div>
      <div className="text-sm font-medium text-surface-600 mb-1.5">
        {t('shell.workspace.empty.title')}
      </div>
      <div className="text-xs leading-relaxed text-center max-w-[260px]">
        {t('shell.workspace.empty.description')}
        <br />
        <span className="opacity-70">{t('shell.workspace.empty.hint')}</span>
      </div>
    </div>
  )
}
