import { useState } from 'react'
import { X, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentTemplate } from '../stores/agentStore'

interface EditorProps {
  initial?: AgentTemplate
  onSave: (data: Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
}

export function AgentTemplateEditor({ initial, onSave, onCancel }: EditorProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [icon, setIcon] = useState(initial?.icon || '🤖')
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt || '')
  const [workingDir, setWorkingDir] = useState(initial?.workingDir || '')
  const [workingDirError, setWorkingDirError] = useState<string | null>(null)

  const handleSelectDir = async () => {
    const dir = await window.api.selectDirectory?.()
    if (!dir) return
    // 第三个选工作目录的入口，与设置页/目录条共用同一套判据与文案。
    // 不校验的话这里存下的目录会在起会话时被安全层静默拒绝，用户还是那句"选完了却动不了"。
    const verdict = await window.api.validateWorkingDir?.(dir)
    if (verdict && !verdict.ok) {
      setWorkingDirError(
        t(`settings.apps.workingDirectory.rejected.${verdict.code || 'unknown'}`, {
          path: verdict.resolved || dir,
          defaultValue: verdict.reason || ''
        })
      )
      return
    }
    setWorkingDirError(null)
    setWorkingDir(dir)
  }

  const handleSave = () => {
    if (!name.trim() || !systemPrompt.trim()) return
    onSave({
      name: name.trim(),
      description: description.trim(),
      icon,
      systemPrompt,
      workingDir: workingDir || undefined
    })
  }

  return (
    <div className="space-y-5">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-surface-800">
          {initial ? t('agents.editor.editTitle') : t('agents.editor.createTitle')}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('agents.editor.actions.close')}
          title={t('agents.editor.actions.close')}
          className="text-surface-400 hover:text-surface-600 p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 基本信息 */}
      <div className="grid grid-cols-[auto_1fr] gap-3 items-start">
        <div>
          <label htmlFor="agent-template-icon" className="text-[11px] text-surface-400 block mb-1">
            {t('agents.editor.fields.icon')}
          </label>
          <input
            id="agent-template-icon"
            value={icon}
            onChange={e => setIcon(e.target.value)}
            className="w-12 h-10 text-center text-xl rounded-lg border border-surface-200 bg-surface-50 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="agent-template-name" className="text-[11px] text-surface-400 block mb-1">
            {t('agents.editor.fields.name')} <span aria-hidden="true">*</span>
          </label>
          <input
            id="agent-template-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('agents.editor.placeholders.name')}
            required
            className="w-full px-3 py-2 text-[13px] rounded-lg border border-surface-200 bg-surface-50 text-surface-800 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>
      </div>

      <div>
        <label htmlFor="agent-template-description" className="text-[11px] text-surface-400 block mb-1">
          {t('agents.editor.fields.description')}
        </label>
        <input
          id="agent-template-description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t('agents.editor.placeholders.description')}
          className="w-full px-3 py-2 text-[13px] rounded-lg border border-surface-200 bg-surface-50 text-surface-800 focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
      </div>

      {/* 工作目录 */}
      <div>
        <label htmlFor="agent-template-working-directory" className="text-[11px] text-surface-400 block mb-1">
          {t('agents.editor.fields.workingDirectory')}
        </label>
        <div className="flex gap-2">
          <input
            id="agent-template-working-directory"
            value={workingDir}
            onChange={e => setWorkingDir(e.target.value)}
            placeholder={t('agents.editor.placeholders.workingDirectory')}
            className="min-w-0 flex-1 px-3 py-2 text-[13px] rounded-lg border border-surface-200 bg-surface-50 text-surface-800 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
          <button
            type="button"
            onClick={handleSelectDir}
            aria-label={t('agents.editor.actions.chooseWorkingDirectory')}
            title={t('agents.editor.actions.chooseWorkingDirectory')}
            className="shrink-0 px-3 py-2 rounded-lg border border-surface-200 hover:bg-surface-100 transition-colors"
          >
            <FolderOpen className="w-4 h-4 text-surface-500" />
          </button>
        </div>
        {workingDirError && (
          <p role="alert" className="mt-1 text-[11px] text-red-500 break-words">{workingDirError}</p>
        )}
      </div>

      {/* 系统提示词 */}
      <div>
        <label htmlFor="agent-template-system-prompt" className="text-[11px] text-surface-400 block mb-1">
          {t('agents.editor.fields.systemPrompt')} <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="agent-template-system-prompt"
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          placeholder={t('agents.editor.placeholders.systemPrompt')}
          required
          rows={6}
          className="w-full px-3 py-2 text-[13px] rounded-lg border border-surface-200 bg-surface-50 text-surface-800 focus:outline-none focus:ring-2 focus:ring-brand-400 resize-y"
        />
      </div>

      {/* 按钮 */}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-[12px] rounded-lg border border-surface-200 text-surface-500 hover:bg-surface-50 transition-colors">
          {t('agents.editor.actions.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!name.trim() || !systemPrompt.trim()}
          className="px-4 py-2 text-[12px] rounded-lg bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {initial ? t('agents.editor.actions.save') : t('agents.editor.actions.create')}
        </button>
      </div>
    </div>
  )
}
