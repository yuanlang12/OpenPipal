import { useState, useRef, useEffect, useCallback, KeyboardEvent, ClipboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, FileText, X } from 'lucide-react'
import { ModelControl, type ThinkingLevel } from './shared/ModelControl'
import { VoiceCallInline } from './VoiceCallInline'
import type { VoiceSessionState } from '../types'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { RolePreflowPanel, type PreflowManifest } from './RolePreflowPanel'
import { RoleAvatar } from './shared/RoleAvatar'
import { useAgentMarkStudio, MarkStudioAffordance } from './agent-mark'
import { extractPastedImages } from '../utils/pasteImages'
import { expandSkillMentions } from '../chat/skillRequest'
import { useSkillMentions, type SkillInfo } from './shared/SkillMention'
import { WorkingDirBar } from './shared/WorkingDirBar'
import { useComposerFileIntake } from './shared/useComposerFileIntake'
import { fmtSize } from '../utils/format'
import { getBuiltinRoleNameKey } from '../../../shared/i18n/resources'

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
  const { currentRole, allRoles, switchRole } = useAppStore()
  const { sendMessage, conversationConfig, setConversationBrief, setConversationModelPreset, newConversationFromAgent, switchConversation } = useChatStore()
  const agentTemplates = useAgentStore(s => s.templates)
  const loadTemplates = useAgentStore(s => s.loadTemplates)

  // 选中的角色。欢迎页固定从通用头像开始,避免一进来就被某角色的 preflow(如 design)整页占满、隐藏头像切换器
  const [selectedRole, setSelectedRole] = useState('general')
  const roleName = selectedRole
  // 新建对话 → 回到通用头像欢迎页(preflow 早返回会隐藏头像,不重置就困住)。
  // 用 welcomeNonce(仅 newConversation 递增)精确侦测"新建对话";切角色走 initConversations 不改它,
  // 避免之前"点头像切角色却跳回 general"的 bug(切角色改了 activeConversationId 误触发复位)
  const welcomeNonce = useChatStore(s => s.welcomeNonce)
  useEffect(() => { setSelectedRole('general') }, [welcomeNonce])
  // 点头像 = 切本地预览 + 真正切全局角色(语音/路由读全局 currentRole)。仅 messages.length===0 时渲染,切不丢会话
  const pickRole = useCallback((name: string) => { setSelectedRole(name); switchRole(name) }, [switchRole])
  const taglineKey = ROLE_TAGLINE[selectedRole]
  const roleDisplay = allRoles.find(r => r.name === selectedRole) || currentRole
  const roleDisplayName = (role: { name: string; displayName?: string }): string => {
    const key = getBuiltinRoleNameKey(role.name)
    return key ? t(key) : (role.displayName || role.name)
  }

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

  useEffect(() => { loadTemplates() }, [])
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

        {/* 角色头像群 — 固定占位，选中放大；未选中保留原色并降低透明度，不给头像增加外框 */}
        {/* flex-wrap 不是装饰:6 个 64px 头像 + 间距 ≈ 444px,挂靠态内容列只有 ~350px,
            不换行就会横向溢出(底部冒出滚动条、两侧头像被裁)。 */}
        <div className="flex flex-wrap items-center justify-center gap-8 mb-6">
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
                    initial: role.mark as never,
                  })}
                />
              </div>
            )
          })}
        </div>

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
        <div className="op-composer-solid relative z-10">
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

        {/* Agent 模板卡片 */}
        {agentTemplates.length > 0 && (
          <div className="mb-4">
            <p className="text-[11px] text-surface-300 mb-2 px-1">
              {t('welcome.templatesTitle')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {agentTemplates.map(t => (
                <button
                  key={t.id}
                  onClick={() => newConversationFromAgent(roleName, t.id, t.name)}
                  className="flex flex-col items-start p-3 rounded-lg bg-surface-50 border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 transition-colors text-left"
                >
                  <span className="text-xl mb-1.5">{t.icon}</span>
                  <span className="text-[13px] font-semibold text-surface-700">{t.name}</span>
                  {t.description && <span className="text-[11px] text-surface-400 mt-0.5 line-clamp-2">{t.description}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {markStudio}
    </div>
  )
}
