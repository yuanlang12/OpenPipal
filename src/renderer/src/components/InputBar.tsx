import { useState, useRef, useCallback, useEffect, useMemo, KeyboardEvent, ClipboardEvent, DragEvent } from 'react'
import { Square, ArrowUp, X, FileText } from 'lucide-react'
import { ModelControl } from './shared/ModelControl'
import { useAppStore } from '../stores/appStore'
import { useChatStore, type ContextUsageEntry, type ContextCumulativeStats } from '../stores/chatStore'
import { extractPastedImages } from '../utils/pasteImages'
import { expandSkillMentions } from '../chat/skillRequest'
import { useSkillMentions, type SkillInfo } from './shared/SkillMention'
import { WorkingDirBar } from './shared/WorkingDirBar'
import { useComposerFileIntake } from './shared/useComposerFileIntake'
import { fmtSize } from '../utils/format'
import type { FileAttachmentData, VoiceSessionState } from '../types'
import { PendingMessageStack } from './PendingMessageStack'
import { VoiceCallInline } from './VoiceCallInline'
import { useTranslation } from 'react-i18next'

export interface FileAttachment {
  fileName: string
  textContent: string
  fileType: string
  sizeBytes: number
  localPath?: string
}

interface InputBarProps {
  onStartVoice?: () => void
  voiceAvailable?: boolean
  // 内联语音通话状态（替代顶部 VoiceCallStrip）
  voiceSessionState?: VoiceSessionState
  voiceDuration?: number
  voiceIsAISpeaking?: boolean
  voiceInputLevel?: number
  onHangupVoice?: () => void
}

/** 上下文用量圆环——16px SVG 进度环，颜色随占比分级；无数据时不渲染（由调用方判断） */
function ContextRing({ promptTokens, contextWindow, budget, compacted }: {
  promptTokens: number; contextWindow: number; budget: number; compacted: boolean
}) {
  const { t } = useTranslation()
  const ratio = Math.min(1, Math.max(0, contextWindow > 0 ? promptTokens / contextWindow : 0))
  const colorClass = ratio > 0.85
    ? 'text-red-500 dark:text-red-400'
    : ratio > 0.6
      ? 'text-amber-500 dark:text-amber-400'
      : 'text-surface-400'
  const r = 6
  const c = 2 * Math.PI * r
  const title = t('chat.input.contextUsage', {
    used: formatTokens(promptTokens),
    total: formatTokens(contextWindow),
    budget: `${Math.round(budget / 1000)}k`,
    compacted: compacted ? t('chat.input.compactedSuffix') : '',
  })
  return (
    <div
      data-testid="context-ring"
      title={title}
      className={`flex items-center gap-1 shrink-0 ${colorClass}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle
          cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
        />
      </svg>
      {compacted && <span data-testid="context-ring-compacted" className="w-2 h-2 rounded-full bg-current opacity-70" />}
    </div>
  )
}

/**
 * usage-log.TodayModelUsage 过 IPC 后的形状。这里必须手写而不能从 preload 声明推导：
 * useRealtimeVoice.ts 里另有一份 `interface Window { api: {...} }` 增强与 preload 的
 * OpenPipalAPI 冲突，整个渲染层的 window.api 因此塌成 any——推导出来的只会是 any。
 */
type TodayUsageRow = { model: string; prompt: number; output: number; cacheRead: number; calls: number; cost: number }

/** 今日按模型用量的 30s 展开级缓存——卡片每次 hover 都拉一遍 8MB 日志没有意义 */
let todayUsageCache: { at: number; rows: TodayUsageRow[] } | undefined

interface ContextUsageCardProps {
  usage: ContextUsageEntry
  stats?: ContextCumulativeStats
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

/**
 * 用量信息卡 —— 圆环 hover 展开。三块：容量+分区占比（估算）、平均缓存命中率（会话累计实报）、
 * 今日按模型用量（usage-log 聚合，30s 级缓存；BYO-key 形态没有可靠的"余额"接口，用量更有意义）。
 * 分区是字符口径估算、总量是服务商实报——分区之和可能≠总量，偏差落在"消息"桶里，展示按占比归一。
 */
function ContextUsageCard({ usage, stats }: ContextUsageCardProps) {
  const { t } = useTranslation()
  const [todayRows, setTodayRows] = useState<TodayUsageRow[] | undefined>(todayUsageCache?.rows)

  useEffect(() => {
    if (todayUsageCache && Date.now() - todayUsageCache.at < 30_000) return
    let cancelled = false
    window.api.getTodayUsage?.().then((rows: TodayUsageRow[] | undefined) => {
      if (cancelled || !Array.isArray(rows)) return
      todayUsageCache = { at: Date.now(), rows }
      setTodayRows(rows)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [usage.promptTokens])

  const segs = usage.segments
  const pct = (v: number): number => (usage.promptTokens > 0 ? (v / usage.promptTokens) * 100 : 0)
  const hitDenom = (stats?.input || 0) + (stats?.cacheRead || 0) + (stats?.cacheWrite || 0)
  const hitPct = hitDenom > 0 ? ((stats!.cacheRead / hitDenom) * 100).toFixed(1) : undefined
  // 最近一次调用的命中率：冷启动（首次 0%）会长期拖低累计平均，两个口径并列展示才不会误读
  const lastUsage = usage.usage
  const lastDenom = lastUsage ? lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite : 0
  const lastHitPct = lastDenom > 0 ? ((lastUsage!.cacheRead / lastDenom) * 100).toFixed(1) : undefined

  // 主色系单色深→浅（brand 阶随用户主题派生）：按占用从多到少排列，最大者最深、依次变浅
  const BRAND_SHADES = ['bg-brand-700', 'bg-brand-600', 'bg-brand-500', 'bg-brand-400', 'bg-brand-300']
  const sortedSegments = [
    { key: 'messages', tokens: segs?.messages ?? 0 },
    { key: 'tools', tokens: segs?.toolsBuiltin ?? 0 },
    { key: 'mcpTools', tokens: segs?.toolsMcp ?? 0 },
    { key: 'systemPrompt', tokens: segs?.systemPrompt ?? 0 },
    { key: 'skills', tokens: segs?.skills ?? 0 }
  ]
    .filter(s => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((s, i) => ({ ...s, color: BRAND_SHADES[Math.min(i, BRAND_SHADES.length - 1)] }))
  const remainingTokens = Math.max(0, usage.contextWindow - usage.promptTokens)
  const windowPct = (v: number): number => (usage.contextWindow > 0 ? (v / usage.contextWindow) * 100 : 0)

  return (
    <div data-testid="context-usage-card" className="op-menu absolute bottom-full right-0 mb-2 w-72 p-3 text-xs z-50 text-left">
      <div data-testid="context-usage-card-title" className="flex items-center justify-between font-medium mb-2">
        <span>{t('chat.input.contextCard.title', { used: formatTokens(usage.promptTokens), total: formatTokens(usage.contextWindow) })}</span>
        <span className="opacity-60">{usage.contextWindow > 0 ? Math.round((usage.promptTokens / usage.contextWindow) * 100) : 0}%</span>
      </div>

      {/* 总进度条以整个窗口为分母：主色段按占用占比填充，浅色轨道即剩余空间 */}
      <div data-testid="context-usage-segments" className="flex h-1.5 rounded-full overflow-hidden mb-2 bg-black/10 dark:bg-white/10">
        {sortedSegments.map(s => (
          <div key={s.key} className={s.color} style={{ width: `${windowPct(s.tokens)}%` }} />
        ))}
      </div>
      {/* 分区明细：占用从多到少、主色从深到浅；末行给出剩余空间 */}
      <div className="flex flex-col gap-1 mb-2">
        {sortedSegments.map(s => (
          <div key={s.key} data-testid={`context-usage-segment-${s.key}`} className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.color}`} />
              <span className="truncate">{t(`chat.input.contextCard.seg.${s.key}`)}</span>
            </span>
            <span className="opacity-70 shrink-0 tabular-nums">
              {Math.round(pct(s.tokens))}%
            </span>
          </div>
        ))}
        <div data-testid="context-usage-segment-remaining" className="flex items-center justify-between gap-2 opacity-60">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-black/15 dark:bg-white/15" />
            <span className="truncate">{t('chat.input.contextCard.seg.remaining')}</span>
          </span>
          <span className="shrink-0 tabular-nums">
            {Math.round(windowPct(remainingTokens))}%
          </span>
        </div>
      </div>

      <div className="border-t border-black/5 dark:border-white/10 pt-2 mb-2 flex items-center justify-between">
        <span className="opacity-70">{t('chat.input.contextCard.hitRate')}</span>
        <span data-testid="context-usage-hit" className="font-medium">
          {hitPct === undefined ? '—' : (
            <>
              {t('chat.input.contextCard.hitLast', { pct: lastHitPct ?? '—' })} · {hitPct}%
            </>
          )}
        </span>
      </div>

      <div className="border-t border-black/5 dark:border-white/10 pt-2">
        <div className="opacity-70 mb-1">{t('chat.input.contextCard.today')}</div>
        <div data-testid="context-usage-today" className="flex flex-col gap-0.5">
          {(todayRows ?? []).slice(0, 5).map(row => (
            <div key={row.model} data-testid="context-usage-today-row" className="flex items-center justify-between">
              <span className="truncate max-w-[9rem]">{row.model}</span>
              <span className="opacity-70 shrink-0">
                {formatTokens(row.prompt)}{row.cost > 0 ? ` · ¥${row.cost.toFixed(3)}` : ''}
              </span>
            </div>
          ))}
          {(!todayRows || todayRows.length === 0) && <span className="opacity-50">{t('chat.input.contextCard.todayEmpty')}</span>}
        </div>
      </div>
    </div>
  )
}

/** 圆环 + hover 信息卡包装。卡片自身只随 usage 事件重渲染（每次 LLM 调用一次），不在渲染帧上算东西 */
function ContextUsageIndicator({ usage, stats }: ContextUsageCardProps) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="relative shrink-0"
      data-testid="context-usage-indicator"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <ContextRing {...usage} />
      {open && <ContextUsageCard usage={usage} stats={stats} />}
    </div>
  )
}

export function InputBar({
  onStartVoice,
  voiceAvailable,
  voiceSessionState = 'idle',
  voiceDuration = 0,
  voiceIsAISpeaking = false,
  voiceInputLevel = 0,
  onHangupVoice
}: InputBarProps) {
  const { t } = useTranslation()
  const { currentRole } = useAppStore()
  // 离散 selector(不再整 store 解构)—— 避免任意 chatStore 变动(每次 tool 事件/流式提交)都重渲染整个 InputBar
  const isStreaming = useChatStore(s => s.isStreaming)
  const sendMessage = useChatStore(s => s.sendMessage)
  const abortChat = useChatStore(s => s.abortChat)
  const pendingFileAttachments = useChatStore(s => s.pendingFileAttachments)
  const removePendingFileAttachment = useChatStore(s => s.removePendingFileAttachment)
  const clearPendingFileAttachments = useChatStore(s => s.clearPendingFileAttachments)
  const conversationConfig = useChatStore(s => s.conversationConfig)
  // 当前会话若绑定了独立智能体（Workspace Agent），技能选择器只列它自有目录的技能（隔离）
  const activeWorkspaceId = useChatStore(s => s.activeWorkspaceId)
  const setConversationModelPreset = useChatStore(s => s.setConversationModelPreset)
  const enqueuePending = useChatStore(s => s.enqueuePending)
  const pendingMentions = useChatStore(s => s.pendingMentions)
  const removePendingMention = useChatStore(s => s.removePendingMention)
  const clearPendingMentions = useChatStore(s => s.clearPendingMentions)
  const pendingAnnotations = useChatStore(s => s.pendingAnnotations)
  const removePendingAnnotation = useChatStore(s => s.removePendingAnnotation)
  const clearPendingAnnotations = useChatStore(s => s.clearPendingAnnotations)
  const contextUsage = useChatStore(s => s.activeConversationId ? s.contextUsage[s.activeConversationId] : undefined)
  const contextStats = useChatStore(s => s.activeConversationId ? s.contextStats[s.activeConversationId] : undefined)
  const roleName = currentRole?.name || 'learner'
  const onSend = useCallback((content: string, images?: string[], fileAttachments?: FileAttachmentData[]) =>
    sendMessage(content, roleName, images, fileAttachments), [sendMessage, roleName])
  const onAbort = abortChat
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])

  // `/` 快捷指令面板 + 内联 token 着色（弹层/镜像层都挂在 textarea 的 relative 容器里）。
  // 行首打 `/` 时面板顶部还给内置命令：`/goal` 由下面的 handleSend 拦下，不进模型。
  const commands = useMemo(
    () => [{ name: 'goal', description: t('chat.input.commands.goal') }],
    [t]
  )
  const mentions = useSkillMentions({
    skills: allSkills,
    commands,
    value: input,
    onChange: setInput,
    textareaRef,
    mirrorClassName: 'px-3 py-2.5 text-[13px] leading-relaxed text-surface-800'
  })

  const [modelName, setModelName] = useState('')
  const [modelIsBuiltin, setModelIsBuiltin] = useState(false)
  const [modelSupportsThinking, setModelSupportsThinking] = useState(false)
  const [modelSupportsDial, setModelSupportsDial] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; model: string; active: boolean; supportsThinking?: boolean; supportsEffortDial?: boolean; providerName?: string; builtin?: boolean }>>([])

  // 会话专属模型（ConversationConfig.modelPresetId）：设置了就用它，否则跟随全局默认。
  // 预设被删（记忆里的 id 查无此预设）→ 视同跟随全局，picker 里给出标注。
  const sessionPresetId = conversationConfig?.modelPresetId
  const sessionPreset = sessionPresetId ? availableModels.find(m => m.id === sessionPresetId) : undefined
  const sessionPresetDangling = !!sessionPresetId && availableModels.length > 0 && !sessionPreset
  // 两个分支都来自红线出口：sessionPreset 是 getAvailableModels 的哨兵列表，modelName 是
  // get-model-full 的展示口径（主进程已遮蔽并附 builtin 位）——builtin 时一律按位本地化
  const effectiveModelName = sessionPreset
    ? (sessionPreset.builtin ? t('chat.modelControl.builtinModel') : sessionPreset.model)
    : (modelIsBuiltin ? t('chat.modelControl.builtinModel') : modelName)
  const effectiveSupportsThinking = sessionPreset ? !!sessionPreset.supportsThinking : modelSupportsThinking
  const effectiveSupportsDial = sessionPreset ? !!sessionPreset.supportsEffortDial : modelSupportsDial

  // 读当前激活模型的完整配置（含 supportsThinking）
  const refreshActiveModel = useCallback(async () => {
    const mc = await window.api.getModelConfigFull?.().catch(() => null)
    if (mc) {
      setModelName(mc.model || '')
      setModelIsBuiltin(!!mc.builtin)
      setModelSupportsThinking(!!mc.supportsThinking)
      setModelSupportsDial(!!mc.supportsEffortDial)
    }
  }, [])

  useEffect(() => {
    window.api.listSkills?.(activeWorkspaceId || undefined).then(setAllSkills).catch(() => {})
    refreshActiveModel()
    window.api.getAvailableModels?.().then(setAvailableModels).catch(() => {})
  }, [refreshActiveModel, activeWorkspaceId])

  // 会话内选模型 = 本会话专属（只写会话配置，不碰全局 modelConfig——改全局默认去设置页）
  const handleSwitchModel = (id: string) => setConversationModelPreset(id)
  const handleFollowGlobal = () => setConversationModelPreset(undefined)

  // 思考开关/档位 UI 已抽到 shared/ThinkingControl（欢迎页共用），状态仍走会话配置
  // 工作目录选择在 shared/WorkingDirBar，自己连 chatStore

  const handleSend = () => {
    const trimmed = input.trim()

    // === Slash 命令拦截:/goal <text> | /goal show | /goal clear ===
    // 必须在 hasContent / isStreaming 判断之前,即使流式中也允许设/清/查看 goal
    if (trimmed.startsWith('/goal')) {
      const cid = useChatStore.getState().activeConversationId
      if (!cid) {
        console.warn('[Goal] 无活跃会话,slash 命令忽略')
        return
      }
      // 截掉 "/goal" 后剩余文本(允许 /goal、/goalfoo 等情况:slice(5) 后再 trim)
      const rest = trimmed.slice(5).trim()
      const api = window.api as any
      if (rest === '' || rest === 'show') {
        api.showGoal?.(cid)
      } else if (rest === 'clear') {
        api.clearGoal?.(cid)
      } else {
        api.setGoal?.(cid, rest)
      }
      setInput('')
      textareaRef.current?.focus()
      return
    }

    const hasContent = trimmed || images.length > 0 || pendingFileAttachments.length > 0 || pendingMentions.length > 0 || pendingAnnotations.length > 0
    if (!hasContent) return

    // 文件不再注入消息内容——只传路径，AI 用自有工具读取
    const filesMeta = pendingFileAttachments.map(f => ({
      fileName: f.fileName,
      fileType: f.fileType,
      sizeBytes: f.sizeBytes,
      path: f.path
    }))

    const defaultText = pendingFileAttachments.length > 0
      ? (trimmed || (pendingFileAttachments.length > 1 ? '请分析这些文件' : '请分析这个文件'))
      : trimmed

    // 正文里的 /技能名 = 对这条消息的强调，就地换成标签（不写会话配置）
    const withSkills = expandSkillMentions(defaultText, allSkills.map(s => s.name))

    // Phase 6: 如果有 Comment 选中的元素（可多选），把 <mentioned-element> 片段按加入顺序拼接 prepend 到消息；
    // 圈画评论同理——文字成 <canvas-annotation> 行、截图并入 images（模型按"随消息附图"提示对应）
    const annotationLines = pendingAnnotations.map(a =>
      `<canvas-annotation ref="${a.ref}"${a.image ? ' screenshot="随消息附图为该圈选区域截图（红色笔迹圈出的部位）"' : ''}>${a.text}</canvas-annotation>`
    )
    const mentionBlock = [...pendingMentions, ...annotationLines]
    const finalText = mentionBlock.length > 0
      ? `${mentionBlock.join('\n')}\n\n${withSkills}`
      : withSkills
    const allImages = [...images, ...pendingAnnotations.map(a => a.image).filter((x): x is string => !!x)]

    // Agent 正在跑 → 入队挂起（卡片堆叠到输入框上方，等用户决定立即送 / 自动跟单）
    // 空闲 → 直接发出（保持原行为）
    if (isStreaming) {
      enqueuePending(finalText, allImages.length > 0 ? allImages : undefined, filesMeta)
    } else {
      onSend(finalText, allImages.length > 0 ? allImages : undefined, filesMeta)
    }
    setInput('')
    setImages([])
    clearPendingFileAttachments()
    if (pendingMentions.length > 0) clearPendingMentions()
    if (pendingAnnotations.length > 0) clearPendingAnnotations()
    textareaRef.current?.focus()
  }

  // 文件分流（图片内联 / study 进知识库 / 其余挂附件）走共用进料口，与欢迎页同一份规则
  const { handleFile, handleFileUpload } = useComposerFileIntake(
    (base64) => setImages(prev => [...prev, base64])
  )

  // 拖拽处理
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    // 同步取完 File 引用再异步处理（DataTransfer 在 await 后可能失效）
    for (const file of Array.from(files)) {
      // Electron 32+ 移除了 File.path——真实路径走 preload 的 webUtils；旧字段兜底 legacy
      const filePath = ((window.api as any).getPathForFile?.(file) ?? (file as any).path) as string | undefined
      if (filePath) {
        await handleFile(filePath)
      } else if (file.type.startsWith('image/')) {
        // 浏览器模式：图片走 base64
        const reader = new FileReader()
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1]
          setImages(prev => [...prev, base64])
        }
        reader.readAsDataURL(file)
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // @ 弹层开着时它先吃键（↑↓ 导航 / Enter 选中 / Esc 关闭），不与发送冲突
    if (mentions.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  // 自动撑高输入框；未达上限时禁用滚动条——scrollHeight 取整会比真实内容矮零点几像素
  // (13px×1.625 行高是小数),overflow-y:auto 会为这零点几像素冒出常驻滚动条
  const INPUT_MAX_HEIGHT = 160
  const autoResize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, INPUT_MAX_HEIGHT) + 'px'
    el.style.overflowY = el.scrollHeight > INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
  }

  // 输入内容变化(含发送后程序化清空)后重算高度:空内容回到单行自然高度,
  // 不再因写死的 height 短于实际行高而出现多余的上下滚动条(及其溢出圆角)。
  useEffect(() => { autoResize() }, [input])

  const handlePaste = (e: ClipboardEvent) => {
    extractPastedImages(e, (b64) => setImages(prev => [...prev, b64]), {
      onFilePath: (p) => { void handleFile(p) }
    })
  }

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // 流式中也能点 Send —— 会走 enqueue 分支挂到上方队列
  const hasInputContent = input.trim().length > 0 || images.length > 0 || pendingFileAttachments.length > 0
  const canSend = hasInputContent

  return (
    <div
      className="op-composer-dock px-5 pt-2 pb-4"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="max-w-[880px] mx-auto mb-2 p-3 text-center border border-dashed border-brand-400 rounded-lg bg-brand-50/50 dark:bg-brand-900/10">
          <p className="text-[12px] text-brand-600 dark:text-brand-400">{t('chat.input.dropFiles')}</p>
        </div>
      )}

      {/* Agent 跑的时候用户挂起的待发消息（卡片堆叠） */}
      <PendingMessageStack />

      {/* 工作目录 —— 对话页输入框停在窗口底部,只能往上贴 */}
      <WorkingDirBar placement="above" className="max-w-[880px] mx-auto" />

      {/* 统一输入容器 —— 宽度对齐消息列(max-w-880 居中)。
          这里是全窗口最厚的一块玻璃:消息从它底下滚过去,blur 才有东西可折射。 */}
      <div className={`op-composer op-glass op-glass-edge max-w-[880px] mx-auto relative z-10 transition-shadow ${
        isDragOver ? 'op-composer--drop' : ''
      }`}>
        {/* 已选附件/图片/pills — 容器内顶部 */}
        {(images.length > 0 || pendingFileAttachments.length > 0 || pendingMentions.length > 0 || pendingAnnotations.length > 0) && (
          <div className="px-3 pt-2.5 flex flex-wrap gap-1.5">
            {pendingAnnotations.map((a, i) => (
              <span key={`a${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-900/20 text-[10px] text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800" title={a.text}>
                {a.image ? (
                  <img src={`data:image/jpeg;base64,${a.image}`} alt="" className="w-6 h-6 object-cover rounded-sm border border-red-200 dark:border-red-800" />
                ) : (
                  <span>✏️</span>
                )}
                {a.text.length > 14 ? `${a.text.slice(0, 14)}…` : a.text}
                <button onClick={() => removePendingAnnotation(i)} className="ml-0.5 text-red-300 hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
              </span>
            ))}
            {pendingMentions.map((m, i) => {
              // 从 <mentioned-element ref dom>text</mentioned-element> 提取 dom 尾段/文本摘要做 chip 简短展示
              const dom = m.match(/dom="([^"]*)"/)?.[1] || ''
              const text = m.match(/>([^<]*)<\/mentioned-element>/)?.[1] || ''
              const domTail = dom.split(' > ').pop() || dom
              const label = text ? (text.length > 16 ? `${text.slice(0, 16)}…` : text) : (domTail || t('chat.input.selectedElement'))
              return (
                <span key={`m${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-[10px] text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800" title={m}>
                  💬 {label}
                  <button onClick={() => removePendingMention(i)} className="ml-0.5 text-amber-300 hover:text-amber-500"><X className="w-2.5 h-2.5" /></button>
                </span>
              )
            })}
            {pendingFileAttachments.map((file, i) => (
              <span key={`f${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-100 text-[10px] text-surface-500">
                <FileText className="w-3 h-3" />
                {file.fileName}
                <span className="text-surface-300">({fmtSize(file.sizeBytes)})</span>
                <button onClick={() => removePendingFileAttachment(i)} className="ml-0.5 text-surface-300 hover:text-surface-500"><X className="w-2.5 h-2.5" /></button>
              </span>
            ))}
            {images.map((img, i) => (
              <div key={`i${i}`} className="relative group">
                <img src={`data:image/jpeg;base64,${img}`} alt="" className="w-8 h-8 object-cover rounded border border-surface-200" />
                <button onClick={() => removeImage(i)} className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-surface-600 text-white rounded-full flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">×</button>
              </div>
            ))}
          </div>
        )}

        {/* 文本输入区 —— relative：@ 弹层与内联 token 镜像层都锚在这里 */}
        <div className="relative">
          {mentions.mirror}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { mentions.handleChange(e); setTimeout(autoResize, 0) }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onSelect={mentions.handleSelect}
            onClick={mentions.handleSelect}
            onScroll={mentions.handleScroll}
            onFocus={mentions.handleFocus}
            onBlur={mentions.handleBlur}
            onCompositionStart={mentions.handleCompositionStart}
            onCompositionEnd={mentions.handleCompositionEnd}
            placeholder={t('chat.input.placeholder')}
            rows={1}
            className={`relative w-full bg-transparent text-surface-800 text-[13px] px-3 py-2.5 resize-none outline-none placeholder:text-surface-300 leading-relaxed ${mentions.textareaClass}`}
            style={{ minHeight: '36px', maxHeight: '160px', overflowY: 'hidden', ...mentions.textareaStyle }}
          />
          {mentions.popup}
        </div>

        {/* 底部工具栏 —— relative：`/` 面板等浮层用 absolute bottom-full 贴着它往上弹，
            缺定位祖先时会锚到更外层容器、整个弹到视窗外 */}
        <div className="relative flex items-center px-2 pb-2 gap-1 min-w-0">
          {/* 左侧："+" 直接开文件选择器；技能改成输入框里打 `/` 唤起快捷指令面板 */}
          <button
            data-testid="inputbar-plus-btn"
            onClick={handleFileUpload}
            title={t('chat.input.uploadFileOrImage')}
            aria-label={t('chat.input.uploadFileOrImage')}
            className="p-1.5 rounded-md text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
          >
            <span className="text-[16px] leading-none font-light">+</span>
          </button>

          {/* 内联语音控件 —— 空闲显示麦克风，通话中原地变紧凑控件（替代顶部长条） */}
          <VoiceCallInline
            sessionState={voiceSessionState}
            duration={voiceDuration}
            isAISpeaking={voiceIsAISpeaking}
            inputLevel={voiceInputLevel}
            voiceAvailable={!!voiceAvailable}
            onStart={onStartVoice}
            onHangup={() => onHangupVoice?.()}
          />

          {/* 右侧：思考开关 + 模型 + 发送/停止 */}
          <div className="flex-1" />

          {/* 模型+思考深度合一控件；会话内选模型=会话专属，重置行=跟随全局 */}
          {effectiveModelName && (
            <ModelControl
              models={availableModels}
              displayModel={effectiveModelName}
              supportsThinking={effectiveSupportsThinking}
              supportsDial={effectiveSupportsDial}
              selectedId={sessionPresetId}
              resetRow={{
                label: modelName
                  ? t('chat.input.followGlobalDefaultWithModel', { model: modelName })
                  : t('chat.input.followGlobalDefault'),
              }}
              notice={sessionPresetDangling ? t('chat.input.missingPreset') : undefined}
              onSelectModel={(id) => id ? handleSwitchModel(id) : handleFollowGlobal()}
            />
          )}

          {/* 上下文用量圆环 + hover 信息卡 —— 无数据(会话还没发过消息)时不渲染 */}
          {contextUsage && <ContextUsageIndicator usage={contextUsage} stats={contextStats} />}

          {/* 流式中：左 Stop（放弃当前回复）+ 右 Send（挂队列）；空闲：仅 Send */}
          {isStreaming && (
            <button onClick={onAbort} data-testid="stop-btn"
              title={t('chat.input.stopReply')}
              className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-800/40 text-red-500 active:scale-95 transition-all">
              <Square className="w-3.5 h-3.5" fill="currentColor" />
            </button>
          )}
          {(!isStreaming || hasInputContent) && (
            <button onClick={handleSend} disabled={!canSend} data-testid="send-btn"
              title={isStreaming ? t('chat.input.queueAfterReply') : t('chat.input.send')}
              className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                canSend
                  ? 'bg-brand-500 hover:bg-brand-600 text-ink-on-accent active:translate-y-[0.5px]'
                  : 'bg-surface-100 text-surface-300 cursor-not-allowed'
              }`}>
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
