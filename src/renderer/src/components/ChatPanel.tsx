import { useRef, useEffect, useCallback, useState, useMemo, DragEvent } from 'react'
import { MessageBubble } from './MessageBubble'
import { MemoryNotice } from './MemoryNotice'
import { StreamingArea } from './StreamingArea'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { Bot, Focus } from 'lucide-react'
import { isRegeneratableAssistantMessage } from '../chat/messages'
import { groupTurns } from '../chat/groupTurns'
import { ProcessGroup } from './ProcessGroup'
import { useTranslation } from 'react-i18next'

interface ChatPanelProps {
  appName?: string
}

const LONG_CONVERSATION_THRESHOLD = 30

const AGENT_CREATING_STEPS = [
  { key: 'chat.panel.creating.readingConversation', delay: 0 },
  { key: 'chat.panel.creating.analyzingRole', delay: 2000 },
  { key: 'chat.panel.creating.extractingKnowledge', delay: 5000 },
  { key: 'chat.panel.creating.generatingPersona', delay: 8000 },
]

function AgentCreatingProgress() {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const timers = AGENT_CREATING_STEPS.slice(1).map((s, i) =>
      setTimeout(() => setStep(i + 1), s.delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  const currentStep = AGENT_CREATING_STEPS[step]

  return (
    <div className="flex justify-center my-3 animate-fade-in">
      <div className="flex flex-col items-center gap-2 px-5 py-3 rounded-xl bg-brand-50/80 dark:bg-brand-900/20 border border-brand-200/60 dark:border-brand-700">
        <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400 text-[12px] font-medium">
          <div className="w-3.5 h-3.5 border-2 border-brand-300 border-t-brand-600 rounded-full animate-spin" />
          {currentStep ? t(currentStep.key) : null}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-brand-400 dark:text-brand-500">
          <span>{t('chat.panel.elapsedSeconds', { count: elapsed })}</span>
          <div className="flex gap-1">
            {AGENT_CREATING_STEPS.map((_, i) => (
              <div key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${i <= step ? 'bg-brand-500' : 'bg-brand-200 dark:bg-brand-700'}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function isNearBottom(el: HTMLElement, threshold = 60): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

export function ChatPanel({ appName }: ChatPanelProps) {
  const { t } = useTranslation()
  const { currentRole } = useAppStore()
  // 离散 selector(不再整 store 解构)—— ChatPanel 只在这些低频字段变化时重渲染,
  // 流式 token 写的是 liveStreamStore,与本组件解耦,不会触发整页重渲染。
  const messages = useChatStore(s => s.messages)
  const isStreaming = useChatStore(s => s.isStreaming)
  const sendMessage = useChatStore(s => s.sendMessage)
  const regenerate = useChatStore(s => s.regenerate)
  const editAndResend = useChatStore(s => s.editAndResend)
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const activeWorkspaceId = useChatStore(s => s.activeWorkspaceId)
  const focusStream = useAppStore(s => s.focusStream)
  const toggleFocusStream = useAppStore(s => s.toggleFocusStream)
  const workspaces = useAgentStore(s => s.workspaces)
  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  )
  const loadTemplates = useAgentStore(s => s.loadTemplates)
  const loadWorkspaces = useAgentStore(s => s.loadWorkspaces)
  const { createFromConversation, creating: creatingAgent } = useAgentStore()
  const [savedAgentName, setSavedAgentName] = useState<string | null>(null)
  const roleName = currentRole?.name || 'learner'

  // 加载 Agent 模板（只在首次）
  useEffect(() => { loadTemplates(); loadWorkspaces() }, [])

  const handleSaveAsAgent = useCallback(async () => {
    if (!activeConversationId || creatingAgent) return
    try {
      const workspace = await createFromConversation(activeConversationId)
      setSavedAgentName(workspace.meta.name)
      setTimeout(() => setSavedAgentName(null), 4000)
    } catch (err) {
      console.error('[ChatPanel] 保存 Agent 失败:', err)
    }
  }, [activeConversationId, creatingAgent, createFromConversation])
  const onSend = useCallback((content: string) => sendMessage(content, roleName), [sendMessage, roleName])
  const onRegenerate = regenerate
  const onEditAndResend = editAndResend
  const messageCount = messages.length
  // 最后一条消息的 id —— 传给 MessageBubble 判断"是否是当前流式输出的最后一条 assistant 消息"
  // (原来每条 MessageBubble 各自订阅 store 算这个,导致任意新消息追加时全部历史消息重渲染;
  // 现在在此单点算好,作为稳定 prop 逐条传入,未命中的消息拿到的始终是同一个 false)。
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const [detached, setDetached] = useState(false) // 用户上滑脱离贴底 → 显示"跳到最新"提示
  const [isDragOver, setIsDragOver] = useState(false)

  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      const up = !isNearBottom(scrollRef.current)
      userScrolledUp.current = up
      setDetached(up)
    }
  }, [])

  const jumpToBottom = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    userScrolledUp.current = false
    setDetached(false)
  }, [])

  // 会话切换 → 回到底部 + 复位（新会话总是看最新）
  useEffect(() => {
    userScrolledUp.current = false
    setDetached(false)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [activeConversationId])

  // 消息变化（含流式追加工具卡 / 消息）→ **仅当用户没上滑时**才贴底：尊重用户上滑查看历史，
  // 不再每次追加就把用户拽回底部（原实现在这里 reset userScrolledUp + 强制贴底，导致生成中无法上滑）。
  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // 流式滚动跟随已迁入 <StreamingArea>(它订阅 liveStreamStore,随 token 重渲染),
  // ChatPanel 不再因流式内容变化而跑这个 effect。


  // 拖拽上传处理
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) setIsDragOver(true)
  }, [isDragOver])

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const addPendingFileAttachment = useChatStore(s => s.addPendingFileAttachment)

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    // 获取拖拽的文件
    const uris = e.dataTransfer?.getData('text/uri-list')
    if (uris) {
      // Electron: file:// URLs 包含本地路径
      const uriList = uris.split('\n').filter(u => u && u.startsWith('file://'))
      for (const uri of uriList) {
        try {
          const filePath = decodeURI(new URL(uri).pathname)
          // 通过 IPC 打开并解析文件
          if (window.api?.parseFile) {
            const parsed = await window.api.parseFile(filePath)
            addPendingFileAttachment(parsed)
            console.log('[Drop] 文件已添加:', parsed.fileName)
          }
        } catch (err) {
          console.error('[Drop] 处理拖拽文件失败:', err)
        }
      }
    }
  }, [addPendingFileAttachment])

  // 按 turn 分组 + 找最后一条可重新生成的 assistant 消息 —— 两者都只依赖 messages 身份。
  // 用 useMemo 锁在"提交边界"(messages 变化时)重算,不再随流式 token 每次渲染重跑
  // O(messages) 的分组/扫描(这是消除卡顿的派生侧关键点)。
  const { turns, lastAssistantId } = useMemo(() => {
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRegeneratableAssistantMessage(messages[i])) {
        lastAssistantIdx = i
        break
      }
    }
    return {
      turns: groupTurns(messages, { streamingLastTurn: isStreaming }),
      lastAssistantId: lastAssistantIdx >= 0 ? messages[lastAssistantIdx]?.id ?? null : null
    }
  }, [messages, isStreaming])

  // 长会话渲染窗口化：打开/切换会话只挂载最近 TURN_WINDOW_STEP 轮，更早的点按钮再挂
  // （水合大头——IPC 与 JSON 体积——已由附件 sidecar 化解决，这里只治首帧 mount 数量）。
  // 展开时按 scrollHeight 差值补偿 scrollTop，避免内容前插导致视口跳动。
  const TURN_WINDOW_STEP = 30
  const [turnWindow, setTurnWindow] = useState(TURN_WINDOW_STEP)
  useEffect(() => { setTurnWindow(TURN_WINDOW_STEP) }, [activeConversationId])
  const hiddenTurnCount = Math.max(0, turns.length - turnWindow)
  const visibleTurns = hiddenTurnCount > 0 ? turns.slice(hiddenTurnCount) : turns
  const handleLoadEarlierTurns = useCallback(() => {
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    setTurnWindow(w => w + TURN_WINDOW_STEP)
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - prevHeight
    })
  }, [])

  const conversationConfig = useChatStore(s => s.conversationConfig)
  const briefForCurrent = (() => {
    const cfg = conversationConfig
    if (!cfg) return null
    const brief = cfg.roleBrief && Object.values(cfg.roleBrief).find(b => b && Object.keys(b).length > 0)
    const hasAny = !!cfg.projectName || !!brief || (cfg.initialAssets && cfg.initialAssets.length > 0)
    if (!hasAny) return null
    return { projectName: cfg.projectName, brief, assets: cfg.initialAssets || [] }
  })()

  return (
    <div className="op-chat-panel relative flex-1 min-h-0">
    {/* Focus 模式开关:低调常在,右上角。开启后已完成的 turn 只留 user/过程摘要条/交付物/结论。 */}
    <button
      onClick={toggleFocusStream}
      data-testid="focus-stream-toggle"
      title={focusStream ? t('chat.panel.focusEnabledTitle') : t('chat.panel.focusDisabledTitle')}
      aria-pressed={focusStream}
      className={`absolute top-2 right-2 z-20 p-1.5 rounded-lg transition-colors ${
        focusStream
          ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30'
          : 'text-surface-300 hover:text-surface-500 hover:bg-surface-50'
      }`}
    >
      <Focus className="w-3.5 h-3.5" />
    </button>
    {/* 向下滚进输入框底下 —— 这一半 pass-behind 是真的(输入框和消息列在同一个
        未被裁剪的层里)。向上钻标题栏那一半做不到:.op-app-body 和 .op-app-shell
        都是 overflow:hidden,绝对定位后代探出去的部分会被裁掉,实测标题栏那条带
        在「有内容滚到底下」和「没有」两种状态下像素完全一致。曾经写过 -top-10,
        那是个看不见的假探出,只会误导后来的人。标题栏的通透感由窗口 vibrancy 提供。 */}
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="chat-scroll"
      className="absolute inset-0 overflow-y-auto overflow-x-hidden px-5 [&>*]:max-w-[880px] [&>*]:mx-auto"
      style={{
        paddingTop: '20px',
        paddingBottom: 'calc(var(--op-dock-h) + var(--op-dock-gap))',
        scrollPaddingBottom: 'calc(var(--op-dock-h) + var(--op-dock-gap))',
      }}
    >
      {/* 会话简报 banner：前置页填过东西时永久显示 */}
      {briefForCurrent && (
        <div className="mb-4 rounded-lg border border-brand-100 dark:border-brand-900/30 bg-brand-50/40 dark:bg-brand-900/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-brand-600 dark:text-brand-400 mb-1.5 font-medium">{t('chat.panel.briefTitle')}</div>
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
      {messages.length === 0 && !isStreaming && activeWorkspace && (
        <div className="flex flex-col items-center justify-center h-full px-4 pb-4 max-w-lg mx-auto" data-testid="agent-onboarding">
          <span className="text-5xl mb-3">{activeWorkspace.icon}</span>
          <p className="font-display text-[17px] font-bold text-surface-700 tracking-tight mb-1">
            {activeWorkspace.name}
          </p>
          <p className="text-[13px] text-surface-400 text-center leading-relaxed mb-4">
            {activeWorkspace.description}
          </p>
          <p className="text-[12px] text-surface-400 mb-2">{t('chat.panel.agentReady')}</p>
        </div>
      )}


      {hiddenTurnCount > 0 && (
        <div className="flex justify-center mb-3">
          <button
            onClick={handleLoadEarlierTurns}
            data-testid="load-earlier-turns"
            className="px-3 py-1 rounded-full text-chat-meta text-ink-secondary border border-border hover:bg-surface-50 transition-colors"
          >
            {t('chat.panel.loadEarlierTurns', {
              loadCount: Math.min(TURN_WINDOW_STEP, hiddenTurnCount),
              remainingCount: hiddenTurnCount,
            })}
          </button>
        </div>
      )}
      {visibleTurns.map((turn, turnIdx) => {
        const isLastTurn = turnIdx === visibleTurns.length - 1
        const turnActive = isStreaming && isLastTurn
        // 单一过程段(文字模式)沿用「整轮耗时」(用户发送→最终回答);
        // 多过程段(语音流交错)各段用自身消息时间跨度,更贴合那次工具调用本身
        const singleProcessSeg =
          turn.segments.filter(s => s.kind === 'process').length === 1
        // Focus 模式:已完成的 turn(非流式中的最后一个)收敛为 user → 过程摘要条(一条)→ 交付物 → 结论。
        // 进行中的 turn 永远走下面的 segments 全量交错渲染,不受 focus 开关影响(一个字节不变)。
        const useFocusCollapse = focusStream && !turnActive
        // 该 turn 真实结束时间(最后一条消息,不管过程/结论)—— 摘要条耗时用它,比只取 finalMsgs 更准
        // (纯工具收尾、无文本结论的 turn 此时 finalMsgs 可能为空)。
        const lastSeg = turn.segments[turn.segments.length - 1]
        const turnEndTs = lastSeg
          ? (lastSeg.kind === 'final' ? lastSeg.message.timestamp : lastSeg.messages[lastSeg.messages.length - 1]?.timestamp)
          : turn.userMsg?.timestamp
        return (
          <div key={turn.id}>
            {/* 用户消息(turn 开头) */}
            {turn.userMsg && (
              <MessageBubble
                message={turn.userMsg}
                appName={appName}
                roleIcon={currentRole?.icon}
                onSend={onSend}
                onEditAndResend={!isStreaming ? onEditAndResend : undefined}
              />
            )}
            {useFocusCollapse ? (
              /* Focus 收敛:全部过程消息在首个过程段的位置合并为一条摘要;
                 其余 final 段(交付物/结论/待处理 ask·permission/voice/inject-notice)按真实顺序常显。
                 收敛只压缩「过程」,绝不吞 final——否则 pending 权限气泡/语音转录整类消失(事故级)。 */
              (() => {
                let summaryRendered = false
                return turn.segments.map(seg => {
                  if (seg.kind === 'process') {
                    if (summaryRendered) return null
                    summaryRendered = true
                    return (
                      <ProcessGroup
                        key={seg.id}
                        messages={turn.processMsgs}
                        isActive={false}
                        roleIcon={currentRole?.icon}
                        turnStartTs={turn.userMsg?.timestamp}
                        turnEndTs={turnEndTs}
                      />
                    )
                  }
                  const msg = seg.message
                  const isConclusion = turn.conclusion?.id === msg.id
                  return (
                    <MessageBubble
                      key={seg.id}
                      message={msg}
                      appName={appName}
                      roleIcon={currentRole?.icon}
                      onSend={onSend}
                      onEditAndResend={msg.role === 'user' && !isStreaming ? onEditAndResend : undefined}
                      onRegenerate={isConclusion && msg.id === lastAssistantId && !isStreaming ? onRegenerate : undefined}
                      onSaveAsAgent={isConclusion && msg.id === lastAssistantId && !isStreaming && messageCount >= 4 && activeConversationId && !creatingAgent ? handleSaveAsAgent : undefined}
                    />
                  )
                })
              })()
            ) : (
              /* 按真实顺序渲染片段:process 折叠成 ProcessGroup,final 独立显示。
                 语音流交错(说话→工具→说话)因此保序,工具卡不再冒到最上面。 */
              turn.segments.map((seg, segIdx) => {
                const isLastSeg = segIdx === turn.segments.length - 1
                if (seg.kind === 'process') {
                  return (
                    <ProcessGroup
                      key={seg.id}
                      messages={seg.messages}
                      isActive={turnActive && isLastSeg}
                      roleIcon={currentRole?.icon}
                      turnStartTs={singleProcessSeg ? turn.userMsg?.timestamp : undefined}
                      turnEndTs={singleProcessSeg ? turn.finalMsgs[turn.finalMsgs.length - 1]?.timestamp : undefined}
                    />
                  )
                }
                const msg = seg.message
                return (
                  <MessageBubble
                    key={seg.id}
                    message={msg}
                    appName={appName}
                    roleIcon={currentRole?.icon}
                    onSend={onSend}
                    onRegenerate={msg.id === lastAssistantId && !isStreaming ? onRegenerate : undefined}
                    onEditAndResend={msg.role === 'user' && !isStreaming ? onEditAndResend : undefined}
                    onSaveAsAgent={msg.id === lastAssistantId && !isStreaming && messageCount >= 4 && activeConversationId && !creatingAgent ? handleSaveAsAgent : undefined}
                    isLastStreaming={isStreaming && msg.role !== 'user' && msg.id === lastMessageId}
                  />
                )
              })
            )}
          </div>
        )
      })}

      {/* 记忆更新通知 */}
      {!isStreaming && <MemoryNotice />}

      {/* 保存 Agent 成功提示 */}
      {savedAgentName && (
        <div className="flex justify-center my-3 animate-fade-in">
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 text-[12px] font-medium">
            <Bot className="w-3.5 h-3.5" />
            {t('chat.panel.savedAgent', { name: savedAgentName })}
          </div>
        </div>
      )}

      {/* 正在分析对话创建 Agent 的加载状态 */}
      {creatingAgent && <AgentCreatingProgress />}

      {/* 对话过长提示 */}
      {messageCount > LONG_CONVERSATION_THRESHOLD && !isStreaming && messages.length > 0 && (
        <div className="flex justify-center my-3">
          <button
            onClick={() => onSend?.('')}
            className="text-[11px] text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 px-3 py-1.5 rounded-full bg-surface-50 border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 transition-colors"
            style={{ display: 'none' }} // 仅作为提示，不做功能按钮
          >
            {t('chat.panel.longConversation')}
          </button>
          <p className="text-[10px] text-surface-300 text-center">
            {t('chat.panel.longConversation')}
          </p>
        </div>
      )}

      {/* 流式区(隔离叶子):工具指示 / 流式预览 / 流式文字 / 思考点。
          订阅 liveStreamStore,每个 token 只重渲染此组件,不牵动上面的消息列表。 */}
      <StreamingArea scrollRef={scrollRef} userScrolledUp={userScrolledUp} />
    </div>
    {/* 跳到最新：用户上滑脱离贴底时浮现；生成中标"生成中·查看最新"，点击回到最新消息 */}
    {detached && (
      <button
        onClick={jumpToBottom}
        data-testid="jump-to-latest"
        className="op-glass op-glass-edge absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink-secondary hover:text-ink-primary active:translate-y-[0.5px] transition-all"
        style={{ bottom: 'calc(var(--op-dock-h) + var(--op-dock-gap))' }}
      >
        {isStreaming && <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />}
        <span>{isStreaming ? t('chat.panel.generatingLatest') : t('chat.panel.backLatest')}</span>
        <span aria-hidden>↓</span>
      </button>
    )}
    </div>
  )
}
