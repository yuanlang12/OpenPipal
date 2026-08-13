import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, FilePlus, FileEdit, ChevronDown, Copy, Check, BookOpen, Eye } from 'lucide-react'
import { ChatMessage } from '../../types'
import { toolArgsFilePath } from '../../chat/messages'
import { describeFilePath, resolveFileDisplayLabel } from '../../chat/fileDisplay'
import { toolLabel } from '../../chat/toolPhrases'
import { openInWorkspace } from '../../utils/openInWorkspace'

// 已登记技能使用稳定 key；未登记 skill slug 与 Design System slug 保持原始 payload。
const SKILL_DISPLAY_NAME_KEYS: Record<string, string> = {
  'dc-authoring': 'chat.fileResult.skillNames.dcAuthoring',
  'deck-stage': 'chat.fileResult.skillNames.deckStage',
  'doc-design': 'chat.fileResult.skillNames.docDesign',
  'animation-basics': 'chat.fileResult.skillNames.animationBasics',
  'design-tokens': 'chat.fileResult.skillNames.designTokens',
  'design-system-authoring': 'chat.fileResult.skillNames.designSystemAuthoring',
  'prototype-tweaks': 'chat.fileResult.skillNames.prototypeTweaks',
  'frontend-design': 'chat.fileResult.skillNames.frontendDesign',
  doc: 'chat.fileResult.skillNames.doc',
  slides: 'chat.fileResult.skillNames.slides',
  spreadsheet: 'chat.fileResult.skillNames.spreadsheet',
  pdf: 'chat.fileResult.skillNames.pdf',
  'skill-creator': 'chat.fileResult.skillNames.skillCreator',
  'tool-installer': 'chat.fileResult.skillNames.toolInstaller'
}

export function FileResultCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // 路径三键兼容收口在 chat/messages.toolArgsFilePath(与 ProcessGroup 文件聚合同源)
  const filePath = toolArgsFilePath(message.toolArgs) || ''
  const operationType: 'read' | 'write' | 'edit' =
    message.toolName === 'write' ? 'write' : message.toolName === 'edit' ? 'edit' : 'read'

  const content = message.content || ''
  const fileName = filePath.split('/').pop() || t('shell.workspace.fallback.untitledFile')
  // 错误判定只看内容开头——工具失败时错误文案在头部；全文 includes 会把
  // 内容里恰好含"失败/Error"字样的正常文件（如技能教学文本）误标成失败
  const isError = /失败|错误|Error|ENOENT|not found/i.test(content.slice(0, 80))

  // 识别 SKILL.md 读取：展示为醒目的"加载技能"卡片而非普通"读取文件"
  // 触发条件：读操作 + 文件名是 SKILL.md + 路径在某个 skills 目录下（built-in/user/agent/_mcp
  // 四种根都含 `/skills/`），避免把任意名为 SKILL.md 的普通文件误判成技能。
  // skill 名取路径倒数第二段（/.../{skill-name}/SKILL.md）
  const isSkillMd = operationType === 'read' && fileName === 'SKILL.md'
  const isDsLoad = isSkillMd && filePath.includes('/design-systems/')
  const isSkillLoad = isDsLoad || (isSkillMd && filePath.includes('/skills/'))
  const skillSlug = isSkillLoad ? (filePath.split('/').slice(-2, -1)[0] || 'skill') : ''
  const skillNameKey = SKILL_DISPLAY_NAME_KEYS[skillSlug]
  const skillName = isDsLoad
    ? skillSlug
    : skillNameKey ? t(skillNameKey) : skillSlug
  const skillBadge = isDsLoad
    ? t('chat.fileResult.badges.designSystem')
    : t('chat.fileResult.badges.skill')
  const skillVerb = isDsLoad
    ? t('chat.fileResult.actions.loadDesignSystem')
    : toolLabel('load_skill', t)

  const handleCopy = () => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // 展开内容（SKILL.md 正文 / 文件内容）—— 技能卡片与普通文件卡片共用
  const expandedBlock = expanded && (
    <div className="relative mt-1 rounded-lg overflow-hidden bg-surface-800 dark:bg-[#0a0a0a] border border-surface-700 dark:border-surface-200">
      {filePath && (
        <div className="px-3 pt-2 pb-1 border-b border-surface-700 dark:border-surface-200">
          <span className="text-chat-small text-surface-400 font-mono">{filePath}</span>
        </div>
      )}
      <pre className="px-3 py-2.5 text-chat-meta font-mono text-surface-200 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
        {content || t('chat.fileResult.empty')}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 text-surface-500 hover:text-surface-300 transition-colors p-1 rounded"
        title={copied ? t('common.actions.copied') : t('common.actions.copy')}
        aria-label={copied ? t('common.actions.copied') : t('common.actions.copy')}
      >
        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  )

  // ── 技能加载：醒目琥珀 pill + "技能"徽章，一眼区别于普通灰色文件行 ──
  // 这是用户"看不到 ai 在用技能"的修复：原来只是换图标/标签，仍是同样的细行，容易被划过。
  if (isSkillLoad) {
    return (
      <div className="flex justify-start mb-msg animate-fade-in">
        <div className="max-w-msg w-full">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-800/40 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors text-left"
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/50 text-amber-800 dark:text-amber-200">
              {skillBadge}
            </span>
            <span className="text-chat-label font-medium text-amber-900 dark:text-amber-100 truncate flex-1">
              {skillVerb} · {skillName}
            </span>
            {isError && <span className="shrink-0 text-chat-meta text-red-400">{t('chat.fileResult.failed')}</span>}
            <ChevronDown
              className={`w-3.5 h-3.5 text-amber-500/70 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
          {expandedBlock}
        </div>
      </div>
    )
  }

  // ── 长期档案（教学风格 / 记忆）：说人话，不露序号前缀、扩展名与绝对路径 ──
  // 失败的读取不做美化——模型猜错路径时（如凭空编一个 memory 文件名）不该被包装成
  // 一份真实存在的档案，此时露出原始路径反而有助于判断
  const archive = isError ? null : describeFilePath(filePath)
  if (archive) {
    const isSystem = archive.scope === 'role-system'
    const verb = operationType === 'write'
      ? t('chat.fileResult.actions.add')
      : operationType === 'edit' ? t('chat.fileResult.actions.update') : ''
    const docName = resolveFileDisplayLabel(archive.docName, t)
    const title = isSystem ? `${archive.groupName} · ${docName}` : docName
    return (
      <div className="flex justify-start mb-msg animate-fade-in">
        <div className="max-w-msg w-full">
          <button
            data-testid="archive-file-card"
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200/70 dark:border-emerald-800/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors text-left"
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-200/70 dark:bg-emerald-800/50 text-emerald-800 dark:text-emerald-200">
              {isSystem ? t('chat.fileResult.badges.teachingStyle') : t('chat.fileResult.badges.memory')}
            </span>
            <span className="text-chat-label font-medium text-emerald-900 dark:text-emerald-100 truncate flex-1">
              {verb && `${verb} · `}{title}
            </span>
            {isError && <span className="shrink-0 text-chat-meta text-red-400">{t('chat.fileResult.failed')}</span>}
            <ChevronDown
              className={`w-3.5 h-3.5 text-emerald-500/70 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
          {expandedBlock}
        </div>
      </div>
    )
  }

  // ── 普通文件读/写/编辑（保持原有渲染不变）──
  const Icon = operationType === 'write' ? FilePlus : operationType === 'edit' ? FileEdit : FileText
  const iconColor = isError
    ? 'text-red-400'
    : operationType === 'write' ? 'text-emerald-500'
    : operationType === 'edit' ? 'text-amber-500'
    : 'text-brand-500'
  const label = toolLabel(operationType, t)

  // 只对"写/编辑"操作提供 workspace 预览（读操作已经看到内容了，不必重开）
  const canPreview = !!filePath && (operationType === 'write' || operationType === 'edit')

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex-1 min-w-0 flex items-center gap-2 pl-3 pr-2 py-1.5 border-l border-border hover:bg-surface-50 dark:hover:bg-surface-50/50 rounded-r transition-colors text-left"
          >
            <Icon className={`w-3.5 h-3.5 shrink-0 ${iconColor}`} />
            <span className="text-chat-label font-medium text-surface-600 truncate flex-1">
              {label}: {fileName}
            </span>
            {!expanded && (
              <span className="text-chat-meta text-surface-400 truncate max-w-[30%]">
                {filePath}
              </span>
            )}
            <ChevronDown className={`w-3.5 h-3.5 text-surface-300 dark:text-surface-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          {canPreview && (
            <button
              onClick={() => openInWorkspace(filePath, { title: fileName })}
              className="shrink-0 h-[28px] px-2 rounded-lg bg-surface-50 border border-surface-100 hover:bg-surface-100 transition-colors text-surface-600 text-chat-meta flex items-center gap-1"
              title={t('chat.fileResult.actions.previewTitle')}
            >
              <Eye className="w-3 h-3" />{t('chat.fileResult.actions.preview')}
            </button>
          )}
        </div>
        {expandedBlock}
      </div>
    </div>
  )
}
