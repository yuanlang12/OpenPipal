import { useState, useRef, useEffect, useCallback, KeyboardEvent, ClipboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, FileText, X } from 'lucide-react'
import { ModelControl, type ThinkingLevel } from './shared/ModelControl'
import { VoiceCallInline } from './VoiceCallInline'
import type { VoiceSessionState } from '../types'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { RolePreflowPanel, type PreflowManifest } from './RolePreflowPanel'
import { RoleAvatar, resolveRoleMark } from './shared/RoleAvatar'
import { useAgentMarkStudio, MarkStudioAffordance } from './agent-mark'
import { extractPastedImages } from '../utils/pasteImages'
import { expandSkillMentions } from '../chat/skillRequest'
import { useSkillMentions, type SkillInfo } from './shared/SkillMention'
import { WorkingDirBar } from './shared/WorkingDirBar'
import { useComposerFileIntake } from './shared/useComposerFileIntake'
import { useWindowFileDragging, useWindowFileDrop } from './shared/FileDrop'
import { fmtSize } from '../utils/format'
import { builtinDisplayName } from '../../../shared/i18n/resources'
import { startConversationWith } from '../utils/startConversationWith'
import { AgentAvatar } from './shared/AgentAvatar'

// 只有 teacher / design 有副标题,其余角色不展示 —— 一张 6 个角色、
// 4 个是空对象的表没有存在价值。
const ROLE_TAGLINE: Record<string, string> = {
  teacher: 'roles.teacher.tagline',
  design: 'roles.design.tagline',
}

const INTERPRET_LANGUAGE_KEYS: Record<string, string> = {
  en: 'welcome.interpretation.languages.en',
  zh: 'welcome.interpretation.languages.zh',
  ja: 'welcome.interpretation.languages.ja',
  ko: 'welcome.interpretation.languages.ko',
}

interface WelcomePageProps {
  /** 启动语音通话（来自 App 顶层的 useRealtimeVoice 单例，与 InputBar 同源） */
  onStartVoice?: () => void
  /** 是否已配置语音服务（hasKey） */
  voiceAvailable?: boolean
  // 内联语音通话状态
  voiceSessionState?: VoiceSessionState
  voiceDuration?: number
  voiceIsAISpeaking?: boolean
  voiceInputLevel?: number
  onHangupVoice?: () => void
}

export function WelcomePage({
  onStartVoice,
  voiceAvailable,
  voiceSessionState = 'idle',
  voiceDuration = 0,
  voiceIsAISpeaking = false,
  voiceInputLevel = 0,
  onHangupVoice
}: WelcomePageProps = {}) {
  const { t } = useTranslation()
  const { openMarkStudio, markStudio } = useAgentMarkStudio()
  const { currentRole, allRoles, setCurrentRoleName } = useAppStore()
  const { sendMessage, conversationConfig, setConversationBrief, setConversationModelPreset, switchConversation } = useChatStore()
  const agents = useAppStore(s => s.agents)
  const loadAgents = useAppStore(s => s.loadAgents)
  // 我的 Pal（含模板）跟内置头像排在同一行：选谁就用谁开对话（统一身份第 4 段）
  const myAgents = agents.filter(a => a.kind === 'pal')

  // 选中的角色住在 appStore.currentRole：新建对话 / 启动落通用头像页，点头像只改这个待定选择（不落盘、不切什么全局角色），
  // 首条消息 ensureConversation 才把它钉成会话的 role；切到别的会话时 App 会用那条会话的 role 覆盖它（统一身份第 4 段）
  const selectedRole = currentRole?.name || 'general'
  const roleName = selectedRole
  const pickRole = useCallback((name: string) => setCurrentRoleName(name), [setCurrentRoleName])
  const taglineKey = ROLE_TAGLINE[selectedRole]
  const roleDisplay = allRoles.find(r => r.name === selectedRole) || currentRole
  const roleDisplayName = (role: { name: string; displayName?: string }): string => builtinDisplayName(t, role.name, role.displayName || role.name)

  const [input, setInput] = useState('')
  const [interpretLangs, setInterpretLangs] = useState<{ targetLanguages: string[]; current: string } | null>(null)
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [modelName, setModelName] = useState('')
  const [modelIsBuiltin, setModelIsBuiltin] = useState(false)
  const [modelSupportsThinking, setModelSupportsThinking] = useState(false)
  const [modelSupportsDial, setModelSupportsDial] = useState(false)
  const [modelThinkingAlwaysOn, setModelThinkingAlwaysOn] = useState(false)
  const [modelThinkingLevels, setModelThinkingLevels] = useState<ThinkingLevel[] | undefined>(undefined)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; model: string; active: boolean; supportsThinking?: boolean; supportsEffortDial?: boolean; thinkingAlwaysOn?: boolean; thinkingLevels?: ThinkingLevel[]; providerName?: string; builtin?: boolean }>>([])

  // 读当前激活模型的完整配置（含 supportsThinking / 派生的档位能力位）
  const refreshActiveModel = useCallback(async () => {
    const mc = await window.api.getModelConfigFull?.().catch(() => null)
    if (mc) {
      setModelName(mc.model || '')
      setModelIsBuiltin(!!mc.builtin)
      setModelSupportsThinking(!!mc.supportsThinking)
      setModelSupportsDial(!!mc.supportsEffortDial)
      setModelThinkingAlwaysOn(!!mc.thinkingAlwaysOn)
      setModelThinkingLevels(mc.thinkingLevels?.length ? mc.thinkingLevels : undefined)
    }
  }, [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // `/` 快捷指令面板 + 内联 token 着色（与对话页 InputBar 同一套）。
  // 欢迎页不给内置命令：`/goal` 这类改的是会话状态，这里还没有会话可改。
  const mentions = useSkillMentions({
    skills: allSkills,
    value: input,
    onChange: setInput,
    textareaRef,
    mirrorClassName: 'px-4 pt-3 pb-2 text-[14px] text-surface-700'
  })
  // 粘贴的剪贴板图片（base64，无 data: 前缀）——与聊天 InputBar 同一管道
  const [images, setImages] = useState<string[]>([])
  const setActiveView = useAppStore(s => s.setActiveView)

  // 上传：进料规则（图片内联 / study 进知识库 / 其余挂附件）与对话页共用一份
  const pendingFileAttachments = useChatStore(s => s.pendingFileAttachments)
  const removePendingFileAttachment = useChatStore(s => s.removePendingFileAttachment)
  const clearPendingFileAttachments = useChatStore(s => s.clearPendingFileAttachments)
  const { handleFile, handleFileUpload } = useComposerFileIntake(
    (base64) => setImages(prev => [...prev, base64])
  )
  // 拖文件：整窗都接，落进这个输入框（欢迎页没有消息列，亮的是输入框自己那圈边）
  useWindowFileDrop({ onFilePath: (p) => { void handleFile(p) }, onImage: (b64) => setImages(prev => [...prev, b64]) })
  const isDragOver = useWindowFileDragging()

  useEffect(() => { void loadAgents() }, [])
  useEffect(() => {
    window.api.listSkills?.().then(setAllSkills).catch(() => {})
    refreshActiveModel()
    window.api.getAvailableModels?.().then(setAvailableModels).catch(() => {})
  }, [refreshActiveModel])
  useEffect(() => { textareaRef.current?.focus() }, [])
  // 同传角色:加载可选目标语言(文件式 interpret.json 可 override,默认 zh/en;源自动识别)
  useEffect(() => {
    if (selectedRole !== 'interpreter') { setInterpretLangs(null); return }
    window.api.getInterpretLangs?.().then(setInterpretLangs).catch(() => setInterpretLangs(null))
  }, [selectedRole])

  // 欢迎页可能背后已有一条空会话，也可能尚未物化会话；两种路径都必须把显式选择放进
  // conversationConfig。只改全局默认会让胶囊显示新模型、首条请求却继续使用出生时的旧模型。
  const sessionPresetId = conversationConfig?.modelPresetId
  const sessionPreset = sessionPresetId ? availableModels.find(m => m.id === sessionPresetId) : undefined
  // 两个分支都来自红线出口：sessionPreset 是 getAvailableModels 的哨兵列表，modelName 是
  // get-model-full 的展示口径（主进程已遮蔽并附 builtin 位）——builtin 时一律按位本地化
  const effectiveModelName = sessionPreset
    ? (sessionPreset.builtin ? t('chat.modelControl.builtinModel') : sessionPreset.model)
    : (modelIsBuiltin ? t('chat.modelControl.builtinModel') : modelName)
  const effectiveSupportsThinking = sessionPreset ? !!sessionPreset.supportsThinking : modelSupportsThinking
  const effectiveSupportsDial = sessionPreset ? !!sessionPreset.supportsEffortDial : modelSupportsDial
  const effectiveThinkingAlwaysOn = sessionPreset ? !!sessionPreset.thinkingAlwaysOn : modelThinkingAlwaysOn
  const effectiveThinkingLevels = (sessionPreset ? sessionPreset.thinkingLevels : modelThinkingLevels) || undefined
  const handleSwitchModel = (id: string) => setConversationModelPreset(id)

  // 思考开关/档位 UI 已抽到 shared/ThinkingControl（与对话页 InputBar 共用）
  // 工作目录选择在 shared/WorkingDirBar，自己连 chatStore，这里不再持有
  const handleSetInterpretTarget = (lang: string) => {
    setInterpretLangs(prev => (prev ? { ...prev, current: lang } : prev))
    window.api.setInterpretTarget?.(lang)
  }
  // 附件也算内容：只挂了一个文件就该能发（正文留空时补一句默认请求）
  const hasContent = input.trim().length > 0 || images.length > 0 || pendingFileAttachments.length > 0
  const handleSend = () => {
    const trimmed = input.trim()
    if (!hasContent) return
    // 文件不进正文——只传路径，AI 用自有工具读取（与对话页同一契约）
    const filesMeta = pendingFileAttachments.map(f => ({
      fileName: f.fileName, fileType: f.fileType, sizeBytes: f.sizeBytes, path: f.path
    }))
    // 正文留空时的默认请求（"请分析这个文件"）由 chatStore.sendMessage 统一补，这里不重复
    sendMessage(
      expandSkillMentions(trimmed, allSkills.map(s => s.name)),
      roleName,
      images.length ? images : undefined,
      filesMeta.length ? filesMeta : undefined
    )
    setInput(''); setImages([]); clearPendingFileAttachments()
  }
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend() }
  }
  const handlePaste = (e: ClipboardEvent) => extractPastedImages(
    e,
    (b64) => setImages(prev => [...prev, b64]),
    { onFilePath: (p) => { void handleFile(p) } }
  )

  // ---- 通用角色前置页（Preflow）----
  // 当选中的角色在 ~/.openpipal/system-agents/<role>/preflow.json 有 manifest 时
  // 替换输入区为 RolePreflowPanel。提交后 dismissed，用户回到正常输入
  const [preflowManifest, setPreflowManifest] = useState<PreflowManifest | null>(null)
  const [dismissedForRole, setDismissedForRole] = useState<string>('')
  useEffect(() => {
    setPreflowManifest(null)
    if (!roleName || dismissedForRole === roleName) return
    let cancelled = false
    const fn = (window.api as any)?.getRolePreflow
    if (typeof fn !== 'function') return
    fn(roleName).then((m: any) => { if (!cancelled) setPreflowManifest(m || null) })
      .catch(() => { if (!cancelled) setPreflowManifest(null) })
    return () => { cancelled = true }
  }, [roleName, dismissedForRole])
  const showPreflow = !!preflowManifest && dismissedForRole !== roleName

  // showPreflow 时完全替换内容——role 图标+名称+介绍+preflow 一起总是超出视窗，分出来单独满屏
  if (showPreflow && preflowManifest && roleDisplay) {
    return (
      <RolePreflowPanel
        roleName={roleName}
        roleDisplayName={roleDisplayName(roleDisplay)}
        roleIcon={roleDisplay.icon || '🎨'}
        role={roleDisplay as any}
        manifest={preflowManifest}
        onSkip={() => setDismissedForRole(roleName)}
        onOpenConversation={switchConversation}
        onSubmit={(data) => {
          setConversationBrief({
            roleName,
            projectName: data.projectName,
            roleBrief: data.roleBrief,
            initialAssets: data.initialAssets
          })
          // 前置页选的模型 = 会话专属：写进本会话 conversationConfig（在 brief 之后调，两者都从
          // 当前 config 合并；无 activeConversationId 时先落内存态，随首条消息建会话时一并持久化）
          if (data.modelPresetId) setConversationModelPreset(data.modelPresetId)
          setDismissedForRole(roleName)
          // 前置页输入框里直接写了需求（文字或粘贴的图）→ 提交简报后立刻开聊（简报已同步进 conversationConfig）
          if (data.initialMessage || data.initialImages?.length) sendMessage(data.initialMessage || '', roleName, data.initialImages)
        }}
      />
    )
  }

  // 会话简报 — 前置页提交后、发首条消息前，让用户看到自己的输入被保存
  const briefForCurrent = (() => {
    const cfg = conversationConfig
    if (!cfg) return null
    const brief = cfg.roleBrief && Object.values(cfg.roleBrief).find(b => b && Object.keys(b).length > 0)
    const hasAny = !!cfg.projectName || !!brief || (cfg.initialAssets && cfg.initialAssets.length > 0)
    if (!hasAny) return null
    return { projectName: cfg.projectName, brief, assets: cfg.initialAssets || [] }
  })()

  return (
    <div className="flex-1 flex flex-col items-center px-6 overflow-y-auto min-h-0">
      <div className="w-full max-w-xl py-8 mt-[8vh] mb-auto">

        {/* 会话简报：preflow 提交后显示，和 ChatPanel 的 banner 视觉一致 */}
        {briefForCurrent && (
          <div className="mb-6 rounded-lg border border-brand-100 dark:border-brand-900/30 bg-brand-50/40 dark:bg-brand-900/10 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-brand-600 dark:text-brand-400 mb-1.5 font-medium">
              {t('welcome.briefSaved')}
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {briefForCurrent.projectName && (
                <span className="px-2 py-0.5 rounded bg-surface-0 dark:bg-surface-50 border border-surface-200 text-surface-600">
                  📁 {briefForCurrent.projectName}
                </span>
              )}
              {briefForCurrent.brief && Object.entries(briefForCurrent.brief).map(([k, v]) => (
                <span key={k} className="px-2 py-0.5 rounded bg-surface-0 dark:bg-surface-50 border border-surface-200 text-surface-600">
                  {k}: {Array.isArray(v) ? v.join(', ') : String(v)}
                </span>
              ))}
              {briefForCurrent.assets.map((a: any, i: number) => (
                <span key={i} className="px-2 py-0.5 rounded bg-surface-0 dark:bg-surface-50 border border-surface-200 text-surface-500">
                  {a.sourceType === 'figma' ? '🎨' : a.sourceType === 'codebase' ? '📁' : '📎'} {a.fileName}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 品牌 / 角色名 —— 放在头像行上方。和下面的头像+输入框之间留一大段留白:
            品牌是标题,头像和输入框是一组操作,两者贴太近会读成同一块。 */}
        <div className="text-center mb-12">
          <h1 className="text-xl font-bold text-surface-700 tracking-tight mb-2">
            {roleDisplay ? roleDisplayName(roleDisplay) : 'OpenPipal'}
          </h1>
          {taglineKey && (
            <p className="text-[15px] font-medium text-brand-600 dark:text-brand-300 mb-2">
              {t(taglineKey)}
            </p>
          )}
        </div>

        {/* 角色头像群 — 固定占位，选中放大；未选中保留原色并降低透明度，不给头像增加外框。
            一行排到底：放不下的从两侧半遮出去，点被遮住的那个就滚过去看更多（AvatarStrip）。 */}
        <AvatarStrip className="mb-2">
          {/* 通用助手（默认） */}
          <div className="group relative h-11 w-11">
            <button
              onClick={() => pickRole('general')}
              aria-pressed={selectedRole === 'general'}
              className="flex h-11 w-11 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              title={t('welcome.generalRoleTitle')}
            >
              <RoleAvatar
                role={{
                  name: 'general',
                  avatarDataUrl: allRoles.find(r => r.name === 'general')?.avatarDataUrl,
                  mark: allRoles.find(r => r.name === 'general')?.mark,
                }}
                size={44}
                className={`sw-welcome-avatar ${
                  selectedRole === 'general'
                    ? 'sw-welcome-avatar--active'
                    : 'sw-welcome-avatar--inactive'
                }`}
              />
            </button>
            <MarkStudioAffordance
              size={16}
              label={t('agentMark.entry')}
              onClick={() => openMarkStudio({ roleName: 'general', displayName: t('welcome.generalRoleTitle') })}
            />
          </div>

          {/* general 由上面硬编码的 ✦ 按钮渲染，这里过滤掉避免重复 */}
          {allRoles.filter(r => r.name !== 'general').map(role => {
            const isActive = role.name === selectedRole
            return (
              <div key={role.name} className="group relative h-11 w-11">
                <button
                  onClick={() => pickRole(role.name)}
                  aria-pressed={isActive}
                  className="flex h-11 w-11 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  title={roleDisplayName(role)}
                >
                  <RoleAvatar
                    role={{ name: role.name, avatarDataUrl: role.avatarDataUrl, mark: role.mark }}
                    size={44}
                    className={`sw-welcome-avatar ${
                      isActive
                        ? 'sw-welcome-avatar--active'
                        : 'sw-welcome-avatar--inactive'
                    }`}
                  />
                </button>
                <MarkStudioAffordance
                  size={16}
              label={t('agentMark.entry')}
                  onClick={() => openMarkStudio({
                    roleName: role.name,
                    displayName: roleDisplayName(role),
                    initial: resolveRoleMark(role), // 没捏过也从角色默认（红围脖等）起手，不从墨色空白起手
                  })}
                />
              </div>
            )
          })}
          {myAgents.length > 0 && (
            <>
              <span aria-hidden="true" className="h-8 w-px bg-surface-200" />
              {myAgents.map(agent => (
                <div key={agent.id} className="group relative h-11 w-11" data-testid="welcome-my-agent">
                  <button
                    onClick={() => { void startConversationWith(agent) }}
                    className="flex h-11 w-11 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                    title={agent.name}
                  >
                    <AgentAvatar agent={agent} size={44} className="sw-welcome-avatar sw-welcome-avatar--inactive text-3xl" />
                  </button>
                  {agent.kind === 'pal' && (
                    <MarkStudioAffordance
                      size={16}
                      label={t('agentMark.entry')}
                      onClick={() => openMarkStudio({ scope: 'agent', roleName: agent.id, displayName: agent.name })}
                    />
                  )}
                </div>
              ))}
            </>
          )}
        </AvatarStrip>

        {/* 同传:目标语言选择(源语言自动识别)*/}
        {selectedRole === 'interpreter' && interpretLangs && (
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-[12px] text-surface-400">
              🎧 {t('welcome.interpretation.translateTo')}
            </span>
            <div className="inline-flex rounded-lg bg-surface-100 p-0.5">
              {interpretLangs.targetLanguages.map(l => (
                <button
                  key={l}
                  onClick={() => handleSetInterpretTarget(l)}
                  className={`px-3 py-1 rounded-md text-[12px] transition-colors ${
                    interpretLangs.current === l
                      ? 'bg-surface-0 dark:bg-surface-50 text-brand-600 dark:text-brand-300 shadow-sm font-medium'
                      : 'text-surface-400 hover:text-surface-600'
                  }`}
                >
                  {INTERPRET_LANGUAGE_KEYS[l] ? t(INTERPRET_LANGUAGE_KEYS[l]) : l}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-surface-300">
              · {t(interpretLangs.current === 'zh'
                ? 'welcome.interpretation.speakEnglish'
                : 'welcome.interpretation.speakChinese')}
            </span>
          </div>
        )}

        {/* 输入框 */}
        {/* 欢迎页底下没有消息流穿过去,所以这里用实心变体(官方 Composer 的
            glass={false})。玻璃只出现在有内容从底下流过去的地方 —— 这条克制
            正是玻璃在会话页里读得出来的原因。 */}
        <div className={`op-composer-solid relative z-10 transition-shadow ${isDragOver ? 'op-composer--drop' : ''}`}>
          {pendingFileAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {pendingFileAttachments.map((file, i) => (
                <span key={`f${i}`} data-testid="welcome-file-chip" className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-50 text-[11px] text-surface-500">
                  <FileText className="w-3 h-3 shrink-0" />
                  <span className="truncate max-w-[160px]">{file.fileName}</span>
                  <span className="text-surface-300">({fmtSize(file.sizeBytes)})</span>
                  <button
                    onClick={() => removePendingFileAttachment(i)}
                    aria-label={t('welcome.input.removeFile')}
                    className="ml-0.5 text-surface-300 hover:text-surface-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {images.length > 0 && (
            <div className="flex items-center gap-1.5 px-4 pt-3 flex-wrap">
              {images.map((img, i) => (
                <div key={`i${i}`} className="relative group">
                  <img src={`data:image/jpeg;base64,${img}`} alt="" className="w-10 h-10 object-cover rounded border border-surface-200" />
                  <button
                    onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                    aria-label={t('welcome.input.removeImage', { index: i + 1 })}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-surface-600 text-white rounded-full flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* relative：@ 弹层与内联 token 镜像层锚点 */}
          <div className="relative">
            {mentions.mirror}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={mentions.handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onSelect={mentions.handleSelect}
              onClick={mentions.handleSelect}
              onScroll={mentions.handleScroll}
              onFocus={mentions.handleFocus}
              onBlur={mentions.handleBlur}
              onCompositionStart={mentions.handleCompositionStart}
              onCompositionEnd={mentions.handleCompositionEnd}
              placeholder={t('welcome.input.placeholder')}
              rows={2}
              className={`relative w-full px-4 pt-3 pb-2 text-[14px] text-surface-700 placeholder:text-surface-300 bg-transparent resize-none outline-none ${mentions.textareaClass}`}
              style={mentions.textareaStyle}
            />
            {mentions.popup}
          </div>

          <div className="flex items-center justify-between gap-2 px-4 pb-3 min-w-0">
            <div className="flex items-center gap-1 relative min-w-0 flex-1">
              {/* 上传 —— 对话页是 + 菜单里的一项，欢迎页这里只有这一项，就不套一层菜单了 */}
              <button
                onClick={handleFileUpload}
                data-testid="welcome-upload-btn"
                title={t('chat.input.uploadFileOrImage')}
                aria-label={t('chat.input.uploadFileOrImage')}
                className="flex items-center px-2 py-1 rounded-md text-surface-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors shrink-0"
              >
                <span className="text-[16px] leading-none font-light">+</span>
              </button>
              <VoiceCallInline
                sessionState={voiceSessionState}
                duration={voiceDuration}
                isAISpeaking={voiceIsAISpeaking}
                inputLevel={voiceInputLevel}
                voiceAvailable={!!voiceAvailable}
                onStart={onStartVoice}
                onHangup={() => onHangupVoice?.()}
              />
              {/* 模型+思考深度合一控件；选择写入当前/待物化会话，不改全局默认 */}
              {effectiveModelName && (
                <ModelControl
                  models={availableModels}
                  displayModel={effectiveModelName}
                  supportsThinking={effectiveSupportsThinking}
                  supportsDial={effectiveSupportsDial}
                  alwaysOn={effectiveThinkingAlwaysOn}
                  levels={effectiveThinkingLevels}
                  selectedId={sessionPresetId}
                  onSelectModel={(id) => { if (id) handleSwitchModel(id) }}
                  className="ml-auto"
                  triggerTestId="welcome-model-select"
                  menuTestId="welcome-model-menu"
                />
              )}
            </div>
            <button
              onClick={handleSend}
              disabled={!hasContent}
              data-testid="send-btn"
              aria-label={t('welcome.input.send')}
              className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-all ${
                hasContent ? 'bg-brand-500 text-ink-on-accent hover:bg-brand-600 active:scale-95' : 'bg-surface-100 text-surface-300 cursor-not-allowed'
              }`}>
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 工作目录 —— 欢迎页输入框上面还有欢迎语，只能往下贴 */}
        <WorkingDirBar placement="below" className="mb-5" />

      </div>
      {markStudio}
    </div>
  )
}

/**
 * 头像横排条：一行排到底，放不下时两侧用渐变半遮住溢出的头像；点到被遮住的头像只是滚过去看它，不算选中。
 * 挂靠态内容列只有 ~350px，六七个头像 + 间距远超一行——以前靠换行，现在靠这个条。
 */
function AvatarStrip({ className = '', children }: { className?: string; children: React.ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })
  const EDGE = 28   // 渐变遮罩宽度，也是"算被遮住"的判据

  // 左侧：滚过就算；右侧用最后一个头像的位置判，不用 scrollWidth——头像角上的捏头像小按钮是绝对定位的，会把它撑大几像素
  const measure = useCallback(() => {
    const el = scrollerRef.current
    const last = el?.lastElementChild as HTMLElement | null
    if (!el || !last) return
    const left = el.scrollLeft > 0
    const right = last.getBoundingClientRect().right > el.getBoundingClientRect().right + 1
    setOverflow(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])
  // 只在头像个数变了时重量；欢迎页每次按键都会重渲，children 引用每次都是新的，不能当依赖
  const childCount = Array.isArray(children) ? children.length : 1
  useEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, childCount])

  // 被遮住的头像：先滚到它，不触发它自己的点击（capture 阶段拦下来）
  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollerRef.current
    const btn = (e.target as HTMLElement).closest('button')
    if (!el || !btn || !el.contains(btn)) return
    const box = el.getBoundingClientRect()
    const r = btn.getBoundingClientRect()
    const hiddenLeft = overflow.left && r.left < box.left + EDGE
    const hiddenRight = overflow.right && r.right > box.right - EDGE
    if (!hiddenLeft && !hiddenRight) return
    e.preventDefault()
    e.stopPropagation()
    btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  const mask = overflow.left || overflow.right
    ? `linear-gradient(to right, ${overflow.left ? 'transparent' : 'black'} 0, black ${EDGE}px, black calc(100% - ${EDGE}px), ${overflow.right ? 'transparent' : 'black'} 100%)`
    : undefined
  return (
    <div
      ref={scrollerRef}
      onScroll={measure}
      onClickCapture={onClickCapture}
      data-testid="welcome-avatar-strip"
      data-overflow-left={overflow.left ? '1' : undefined}
      data-overflow-right={overflow.right ? '1' : undefined}
      // 横向可滚就必然竖向裁切：配饰伸到身体外（耳机头梁、厨师帽最高到身体上方约二十像素），用上下 padding 把它们收进裁切框，
      // 再用等量负 margin 抵掉，版面高度不变（所有者 2026-09-16：耳机头梁被条的上沿切平）
      className={`flex items-center gap-8 overflow-x-auto op-no-scrollbar px-3 py-5 -my-4 ${className}`}
      style={{ justifyContent: 'safe center', WebkitMaskImage: mask, maskImage: mask }}
    >
      {children}
    </div>
  )
}

