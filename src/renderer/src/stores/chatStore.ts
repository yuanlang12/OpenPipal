import { create } from 'zustand'
import { ChatMessage, ChatMessageKind, VoiceTranscriptItem, FileAttachmentData, PermissionRequestData } from '../types'
import { useArtifactStore } from './artifactStore'
import { useVisualizerStore } from './visualizerStore'
import { liveStream } from './liveStreamStore'
import { useWorkspaceStore } from './workspaceStore'
import { shouldDismissTodosArtifact } from '../utils/todosArtifactLifecycle'
import { stripDcSuffix } from '../utils/format'
import { rendererI18n } from '../i18n'
import { mergeSyntheticStreamError } from '../chat/syntheticStreamError'
import {
  hasAnsweredQuestion,
  QUESTIONS_V2_PERSISTENCE_VERSION,
  recoverPendingQuestionFromHistory,
  restorePendingQuestion,
  toPersistedPendingQuestion,
  type PendingQuestion,
  type PersistedPendingQuestion
} from '../chat/questionsPending'

/**
 * 切/新会话时重置 workspace 的 tab 层：
 * 1. 关掉所有 artifact/questions tab（stale，属于上一个会话）
 * 2. 回到摘要 tab
 *
 * 面板显隐（open）不在这里决定——调用方需在 ws.setRehydrating(true) 窗口内调用本函数，
 * 重灌完成后用 ws.restoreOpenForConversation(id, hasArtifacts) 按该会话的显隐记忆收官
 * （见 workspaceStore.ts 的 rehydrating/visibilityMemory 注释）。
 */
function resetWorkspaceForNewConversation(): void {
  const ws = useWorkspaceStore.getState()
  const stale = ws.tabs.filter(t => t.kind === 'artifact').map(t => t.id)
  for (const id of stale) ws.closeTab(id)
  ws.focusSummary()
}

/**
 * 从过程态 artifact 区退场，同时关闭它占用的 workspace tab。
 * 这里只清 UI 投影，不碰 chat messages，因此 update_todos 的工具记录仍留在对话里。
 */
function dismissArtifactFromWorkspace(artifactId: string): void {
  useArtifactStore.getState().removeArtifact(artifactId)
  const ws = useWorkspaceStore.getState()
  const tabs = ws.tabs.filter(t => t.kind === 'artifact' && t.artifactId === artifactId)
  for (const tab of tabs) ws.closeTab(tab.id)
}
import {
  createAskUserMessage,
  createAssistantMessage,
  createPermissionRequestMessage,
  createThinkingMessage,
  createToolMessage,
  createUserMessage,
  createVoiceMessage,
  failUnfinishedToolMessages,
  getMessageKind,
  isRenderableToolMessage,
  isSilentReply,
  normalizeChatMessage,
  normalizeChatMessages,
  shouldSendMessageToModel,
  stripOffloadedInline
} from '../chat/messages'

export interface ConversationSummary {
  id: string
  title: string
  role: string
  agentId?: string
  workspaceId?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessage?: string
  config?: {
    workingDir?: string
    /** questions_v2 的待答状态，随 conversation.json 落盘。 */
    pendingQuestion?: PersistedPendingQuestion
    [key: string]: any
  }
}

export async function refreshConversationSummaries(
  listConversations: () => Promise<ConversationSummary[]>,
  apply: (list: ConversationSummary[]) => void,
): Promise<void> {
  const list = await listConversations()
  apply(list)
}

/**
 * UI history → model history. Images, tool inputs, and tool results remain
 * available regardless of message age. The main process performs one
 * token-budget compaction over the complete history when needed.
 */
export function toApiMessages(messages: ChatMessage[]) {
  return normalizeChatMessages(messages)
    .filter(shouldSendMessageToModel)
    .map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          toolName: msg.toolName,
          toolCallId: msg.toolCallId,
          toolArgs: msg.modelToolArgs || msg.toolArgs,
          screenshot: msg.screenshot,
          screenshotRef: msg.screenshotRef,
          // 老消息（本地实测 64%）没有 toolCallId，主进程会拿 id 当轨迹的稳定标识——
          // 不带的话只能按下标合成，下标随轨迹窗口前移，字节每轮翻转、缓存永不命中
          id: msg.id
        }
      }
      return {
        role: msg.role as string,
        content: msg.content,
        screenshot: msg.screenshot || msg.images?.[0],
        images: msg.images,
        imagePaths: msg.imagePaths,
        fileAttachments: msg.fileAttachments
      }
    })
}

// 流式缓冲区（模块级变量，非响应式）
let streamBuf = ''
let thinkBuf = ''
// 最近一次 sendMessage 使用的 role —— 用于 stream-end 时自动 flush pendingMessages 的 fallback 路径
// artifact/visualizer 流式增量重组缓冲(delta+offset 协议消费侧;offset=0 重放即重置,单活跃流)
let artifactDeltaAcc = ''
let visualizerDeltaAcc = ''
let lastUsedRole = 'learner'
// Abort is execution/conversation scoped. A module-global boolean lets an old
// background end poison the next active conversation's otherwise normal end.
const abortedStreamConversationIds = new Set<string>()
let abortWithoutConversationId = false
let activeThinkingId: string | null = null
let thinkUpdateTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 载荷分区估算（主进程 context-usage-stats 同口径） */
export interface ContextUsageSegments {
  systemPrompt: number
  skills: number
  toolsBuiltin: number
  toolsMcp: number
  messages: number
}

/** 主进程 context_usage 事件的载荷（含可选的逐调用实报与分区） */
export interface ContextUsageEntry {
  promptTokens: number
  contextWindow: number
  budget: number
  compacted: boolean
  usage?: { input: number; cacheRead: number; cacheWrite: number }
  segments?: ContextUsageSegments
}

/** 会话累计命中统计（信息卡"平均缓存命中率"） */
export interface ContextCumulativeStats {
  input: number
  cacheRead: number
  cacheWrite: number
  calls: number
}

/**
 * 用量读数随会话落盘（去抖 2s）：context_usage 每次调用都会来，直接写盘会放大 IO；
 * 2s 合并成每轮一次。合并基线取 conversations 列表里的现行 config（与首轮配置写
 * 同一模式），写失败静默——纯展示数据不值得打断对话。
 */
const contextUsagePersistTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleContextUsagePersist(
  cid: string,
  data: ContextUsageEntry,
  getStats: () => ContextCumulativeStats | undefined
): void {
  const pending = contextUsagePersistTimers.get(cid)
  if (pending) clearTimeout(pending)
  contextUsagePersistTimers.set(cid, setTimeout(() => {
    contextUsagePersistTimers.delete(cid)
    try {
      const s = useChatStore.getState()
      const conv = s.conversations.find(c => c.id === cid)
      if (!conv) return
      const stats = getStats()
      const merged = { ...(conv.config || {}), lastContextUsage: { ...data, stats } }
      void window.api.updateConversationConfig(cid, merged).then((ok: unknown) => {
        if (!ok) return
        // 回种数据源同步刷新：渲染层自己的 conversations 条目也带上 lastContextUsage，
        // 否则长会话窗口里（不重启、不重载）切换会话时读到的还是旧 config。
        useChatStore.setState(st => ({
          conversations: st.conversations.map(c => c.id === cid ? { ...c, config: { ...(c.config || {}), lastContextUsage: { ...data, stats } } } : c)
        }))
      }).catch(() => {})
    } catch { /* 展示数据，写不进就算了 */ }
  }, 2000))
}

function clearContextUsagePersistTimers(): void {
  for (const timer of Array.from(contextUsagePersistTimers.values())) clearTimeout(timer)
  contextUsagePersistTimers.clear()
}

// ── autosave 尾部追加水位线 ──
// persistedCount：当前活跃会话已确认落盘的消息条数（从数组头部计数）。
// dirty：水位线之前的内容发生了就地变更（而非纯尾部追加）——下次落盘必须走全量 replace。
// 两者都必须在切换/新建会话时重置（不同会话的落盘状态互不相关）。
let persistedCount = 0
let dirty = false

/** 无法归约到单一下标的变更（截断/任意重排/外部整体替换）——直接标记需要全量 replace。 */
function markDirty(): void {
  dirty = true
}

/** 下标命中"已落盘区间"（< persistedCount）才需要置 dirty；命中水位线之后（纯尾部追加/未持久化过的内容）无需置位。 */
function markDirtyIfPersisted(idx: number): void {
  if (idx >= 0 && idx < persistedCount) dirty = true
}

/** 切换/新建会话时重置水位线——上一个会话的落盘进度对新会话没有意义。 */
function resetPersistWatermark(count = 0): void {
  persistedCount = count
  dirty = false
}

// 后台会话流缓冲：用户切走后，非活跃会话的文本继续累积，stream-end 时保存到 DB
const bgStreamBufs = new Map<string, string>()
// A conversation remains logically background-owned while an async navigation
// is saving/loading. Without this handoff, chunks arriving during the await
// window still mutate the single active streamBuf and are then cleared by the
// destination conversation.
const exitingConversationIds = new Set<string>()
interface ConversationExitGate {
  promise: Promise<void>
  release: () => void
}
const conversationExitGates = new Map<string, ConversationExitGate>()

function createConversationExitGate(cid: string): ConversationExitGate {
  if (conversationExitGates.has(cid)) {
    throw new Error(`conversation exit already in progress: ${cid}`)
  }
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  const gate = { promise, release }
  conversationExitGates.set(cid, gate)
  return gate
}

function isBackgroundConversation(cid: string): boolean {
  return !!cid && (cid !== useChatStore.getState().activeConversationId || exitingConversationIds.has(cid))
}

interface ConversationAsyncState {
  pending: Set<Promise<void>>
  firstFailure?: unknown
}

// IPC dispatch does not await async renderer listeners. Register the promise
// synchronously before the handler starts so the main-process persistence
// barrier can wait for sidecar/question handlers that were already dispatched.
const conversationAsyncEvents = new Map<string, ConversationAsyncState>()
// Drains used by navigation must never consume a durability failure before the
// desktop ACK request observes it. The request clears the latch only after it
// has failed loud for that execution.
const conversationDurabilityFailures = new Map<string, unknown>()

function trackConversationAsync(cid: string, task: () => Promise<void>): Promise<void> {
  if (!cid) return task()
  let state = conversationAsyncEvents.get(cid)
  if (!state) {
    state = { pending: new Set() }
    conversationAsyncEvents.set(cid, state)
  }

  const operation = Promise.resolve().then(task)
  const settled = operation.then(
    () => {},
    (error) => {
      if (state!.firstFailure === undefined) state!.firstFailure = error
      if (!conversationDurabilityFailures.has(cid)) conversationDurabilityFailures.set(cid, error)
    }
  ).finally(() => {
    state!.pending.delete(settled)
    if (state!.pending.size === 0 && state!.firstFailure === undefined && conversationAsyncEvents.get(cid) === state) {
      conversationAsyncEvents.delete(cid)
    }
  })
  state.pending.add(settled)
  return operation
}

async function drainConversationAsyncEvents(cid: string): Promise<void> {
  while (true) {
    const state = conversationAsyncEvents.get(cid)
    if (!state) return
    if (state.pending.size > 0) await Promise.all(Array.from(state.pending))
    if (conversationAsyncEvents.get(cid) !== state) continue
    conversationAsyncEvents.delete(cid)
    if (state.firstFailure !== undefined) throw state.firstFailure
    if (state.pending.size === 0) return
  }
}

interface BackgroundPersistenceState {
  tail: Promise<void>
  pending: number
  firstFailure?: unknown
}
// Every background transcript write for one conversation is chained here.
// A stream-end persistence request drains the chain (including async artifact
// sidecar work that began before stream-end) and reports any write failure.
const bgPersistence = new Map<string, BackgroundPersistenceState>()

function assertPersistenceSucceeded(result: unknown, operation: string): void {
  const explicitFailure = typeof result === 'object' && result !== null && 'ok' in result && result.ok === false
  if (result === false || explicitFailure) {
    throw new Error(`${operation} returned an unsuccessful persistence result`)
  }
}

function assertArtifactPersistenceSucceeded(
  result: unknown,
  operation: string,
  options: { requireRef?: boolean } = {}
): asserts result is { ok: true; ref?: any } {
  assertPersistenceSucceeded(result, operation)
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
    throw new Error(`${operation} did not confirm durability`)
  }
  if (options.requireRef && !('ref' in result && result.ref)) {
    throw new Error(`${operation} did not return a durable artifact reference`)
  }
}

function enqueueBackgroundPersistence(cid: string, task: () => Promise<void>): Promise<void> {
  let state = bgPersistence.get(cid)
  if (!state) {
    state = { tail: Promise.resolve(), pending: 0 }
    bgPersistence.set(cid, state)
  }
  state.pending += 1
  const runAfterExitSnapshot = async (): Promise<void> => {
    const gate = conversationExitGates.get(cid)
    if (gate) await gate.promise
    await task()
  }
  const operation = state.tail.then(runAfterExitSnapshot, runAfterExitSnapshot)
  state.tail = operation.catch((error) => {
    if (state!.firstFailure === undefined) state!.firstFailure = error
    if (!conversationDurabilityFailures.has(cid)) conversationDurabilityFailures.set(cid, error)
  }).then(() => {
    state!.pending -= 1
    if (state!.pending === 0 && state!.firstFailure === undefined && bgPersistence.get(cid) === state) {
      bgPersistence.delete(cid)
    }
  })
  return operation
}

async function drainBackgroundPersistence(cid: string): Promise<void> {
  const state = bgPersistence.get(cid)
  if (!state) return
  // A task can synchronously enqueue a successor while its promise settles.
  // Keep draining until the observed tail is still the final tail.
  while (state.pending > 0) {
    const observed = state.tail
    await observed
    if (observed === state.tail && state.pending === 0) break
  }
  if (bgPersistence.get(cid) === state) bgPersistence.delete(cid)
  if (state.firstFailure !== undefined) throw state.firstFailure
}
// 后台会话已由 artifact 事件代写过锚点消息的 toolCall（onToolEnd 据此跳过重复落盘）。
// key = `${cid}:${toolCallId}`；stream-end 时按 cid 清残留。
const bgAnchoredCalls = new Set<string>()
// create_artifact may emit tool_end before artifact. Delay that one tool result
// until the artifact event can attach its ref, producing one durable anchor for
// the toolCallId regardless of event order.
const bgPendingArtifactToolEnds = new Map<string, ChatMessage>()
function clearBgAnchoredForCid(cid: string): void {
  for (const k of Array.from(bgAnchoredCalls)) if (k.startsWith(cid + ':')) bgAnchoredCalls.delete(k)
  for (const k of Array.from(bgPendingArtifactToolEnds.keys())) {
    if (k.startsWith(cid + ':')) bgPendingArtifactToolEnds.delete(k)
  }
}
// 后台会话的"等待用户输入"暂存：权限气泡 / questions_v2 问答页。这些事件打到别的会话是串线、
// 直接丢弃是挂死（agent 阻塞等答复,用户侧看是"中断"实案）——暂存 + 列表红点,切回时物归原主。
const bgPendingPermissions = new Map<string, PermissionRequestData[]>()
const bgPendingQuestions = new Map<string, PendingQuestion>()

/** 保留其它会话配置，只增删 question 的持久化状态。 */
function withPendingQuestionConfig(config: Record<string, any> | null | undefined, pending: PendingQuestion | null): Record<string, any> {
  const next = { ...(config || {}) }
  if (pending) next.pendingQuestion = toPersistedPendingQuestion(pending)
  else delete next.pendingQuestion
  return next
}

/**
 * questions 是不落盘的过程型 artifact；切换会话或重启后，须用 pendingQuestion 中的
 * 正文重建当前 UI 投影。这里不写 sidecar，也不把题目复制进对话消息历史。
 */
function rehydratePendingQuestionArtifact(
  pending: PendingQuestion,
  messages: ChatMessage[]
): { id: string; title: string; titleKey?: string } {
  const anchor = messages.find(message => message.artifactRef?.id === pending.artifactId)
  const hasDynamicTitle = Boolean(pending.title)
  const title = pending.title || rendererI18n.t('chat.questions.defaultTitle')
  useArtifactStore.getState().addArtifact({
    id: pending.artifactId,
    type: 'questions',
    title,
    ...(!hasDynamicTitle ? { titleKey: 'chat.questions.defaultTitle' } : {}),
    content: JSON.stringify({ title: pending.title, questions: pending.questions }),
    messageId: anchor?.id || '',
    createdAt: anchor?.timestamp || Date.now(),
    rehydrated: true
  })
  return {
    id: pending.artifactId,
    title: hasDynamicTitle ? title : '',
    ...(!hasDynamicTitle ? { titleKey: 'chat.questions.defaultTitle' } : {})
  }
}

/**
 * 后台会话的产物锚点落盘（onArtifact/onQuestionsV2 共用）：saveArtifact 取 ref → 建锚点 tool 消息
 * → appendMessages 直写该会话。questions 的 ref 没有 path（主进程不会把它写成 sidecar），其余
 * artifact 则落真实文件；锚点缺失只影响可见性。
 */
async function appendBgArtifactAnchor(
  cid: string,
  payload: { id: string; type: string; title: string; content: string; language?: string },
  toolCallId: string | undefined,
  anchorContent: string,
  baseMessage?: ChatMessage
): Promise<void> {
  const saveApi = (window.api as any).saveArtifact
  const durableSidecar = payload.type !== 'questions'
  if (durableSidecar && !saveApi) throw new Error('save background artifact sidecar is unavailable')
  const result = saveApi ? await saveApi(cid, payload) : null
  if (saveApi) {
    assertArtifactPersistenceSucceeded(result, 'save background artifact sidecar', { requireRef: durableSidecar })
  }
  // Read the pending result after saveArtifact resolves: tool_end can arrive
  // during the sidecar await and should enrich this same anchor, not append a
  // second message.
  const pendingKey = toolCallId ? `${cid}:${toolCallId}` : null
  const pendingToolEnd = pendingKey ? bgPendingArtifactToolEnds.get(pendingKey) : undefined
  const seed = pendingToolEnd || baseMessage
  const anchor: ChatMessage = normalizeChatMessage({
    ...(seed || createToolMessage({
      id: `tool-bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      toolName: payload.type === 'questions' ? 'questions_v2' : 'create_artifact',
      questionsV2Version: payload.type === 'questions' ? QUESTIONS_V2_PERSISTENCE_VERSION : undefined,
      toolCallId,
      content: anchorContent,
      timestamp: Date.now()
    })),
    toolName: payload.type === 'questions' ? 'questions_v2' : 'create_artifact',
    toolCallId: toolCallId || seed?.toolCallId,
    content: seed?.content || anchorContent,
    ...(result?.ok && result.ref ? { artifactRef: result.ref } : {})
  })
  const appendResult = await window.api.appendMessages(cid, stripOffloadedInline(normalizeChatMessages([anchor])))
  assertPersistenceSucceeded(appendResult, 'append background artifact anchor')
  if (pendingKey) bgPendingArtifactToolEnds.delete(pendingKey)
}

function mergeArtifactToolEnd(anchor: ChatMessage, toolEnd: ChatMessage): ChatMessage {
  return normalizeChatMessage({
    ...anchor,
    content: toolEnd.content || anchor.content,
    searchResults: toolEnd.searchResults || anchor.searchResults,
    toolArgs: toolEnd.toolArgs || anchor.toolArgs,
    modelToolArgs: toolEnd.modelToolArgs || anchor.modelToolArgs,
    screenshot: toolEnd.screenshot || anchor.screenshot,
    // The durable ref belongs to the artifact event and must survive a late
    // tool_end payload that naturally has no artifactRef.
    artifactRef: anchor.artifactRef
  })
}

async function replaceBackgroundArtifactToolEnd(
  cid: string,
  toolCallId: string,
  toolEnd: ChatMessage
): Promise<void> {
  const current = normalizeChatMessages(await window.api.getConversationMessages(cid))
  let matched = false
  const updated: ChatMessage[] = []
  for (const message of current) {
    if (message.toolCallId !== toolCallId) {
      updated.push(message)
      continue
    }
    if (!matched) {
      updated.push(mergeArtifactToolEnd(message, toolEnd))
      matched = true
    }
    // Defensive repair for transcripts produced by the old duplicate-anchor
    // race: retain only the first message for this stable toolCallId.
  }
  if (!matched) throw new Error(`background artifact anchor not found for tool call ${toolCallId}`)
  const result = await window.api.replaceMessages(cid, stripOffloadedInline(updated))
  assertPersistenceSucceeded(result, 'merge late background artifact tool result')
}

interface BackgroundTextFlushOptions {
  final?: boolean
  messageKind?: Extract<ChatMessageKind, 'incomplete'>
  messageSubtype?: string
  syntheticError?: string
}

function enqueueBackgroundTextFlush(
  cid: string,
  options: BackgroundTextFlushOptions = {}
): Promise<void> | null {
  const buffered = bgStreamBufs.get(cid) || ''
  const mergedError = options.syntheticError
    ? mergeSyntheticStreamError(buffered, options.syntheticError)
    : null
  const text = mergedError?.content || buffered
  if (options.final) bgStreamBufs.delete(cid)
  else if (bgStreamBufs.has(cid)) bgStreamBufs.set(cid, '')
  if (!text || isSilentReply(text)) return null
  const message = createAssistantMessage({
    id: `bg-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content: text,
    messageKind: options.messageKind,
    messageSubtype: options.messageSubtype,
    syntheticErrorOffset: options.messageSubtype === 'stream-error'
      ? mergedError?.offset
      : undefined,
    timestamp: Date.now()
  })
  return enqueueBackgroundPersistence(cid, async () => {
    const result = await window.api.appendMessages(cid, stripOffloadedInline(normalizeChatMessages([message])))
    assertPersistenceSucceeded(result, 'append background assistant message')
  })
}

function flushPendingBackgroundToolEnds(cid: string): void {
  for (const [key, message] of Array.from(bgPendingArtifactToolEnds.entries())) {
    if (!key.startsWith(cid + ':') || bgAnchoredCalls.has(key)) continue
    bgPendingArtifactToolEnds.delete(key)
    enqueueBackgroundPersistence(cid, async () => {
      const result = await window.api.appendMessages(cid, stripOffloadedInline(normalizeChatMessages([message])))
      assertPersistenceSucceeded(result, 'append deferred background tool message')
    }).catch((error: unknown) => console.warn('[chatStore] 后台工具消息落盘失败:', error))
  }
}

/** 清理 thinking 相关的模块级状态 */
function resetThinkingState(): void {
  if (thinkUpdateTimer) { clearTimeout(thinkUpdateTimer); thinkUpdateTimer = null }
  activeThinkingId = null
  thinkBuf = ''
}

/** flush 当前活跃的 thinking（最终写入 + 清理），供各 boundary 事件调用 */
function flushActiveThinking(): void {
  if (thinkUpdateTimer) { clearTimeout(thinkUpdateTimer); thinkUpdateTimer = null }
  // 内容已通过 throttled update 写入消息，无需额外操作
  activeThinkingId = null
  thinkBuf = ''
}

function findLatestVisualizerToolIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') break
    if (getMessageKind(msg) === 'tool' && msg.toolName === 'create_visualizer') return i
  }
  return -1
}

function findLatestPendingToolIndex(messages: ChatMessage[], toolName: string, toolCallId?: string): number {
  if (toolCallId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'user') break
      if (getMessageKind(msg) === 'tool' && msg.toolCallId === toolCallId) return i
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') break
    if (getMessageKind(msg) === 'tool' && msg.toolName === toolName && !isRenderableToolMessage(msg)) return i
  }
  return -1
}

function findLatestToolIndex(messages: ChatMessage[], toolName: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') break
    if (getMessageKind(msg) === 'tool' && msg.toolName === toolName) return i
  }
  return -1
}

export interface MemoryNotification {
  type: 'extracted' | 'dreamed'
  memories?: { name: string; type: string; scope: string }[]
  actionsApplied?: number
  summary?: string
  timestamp: number
}

/**
 * 用户在 agent 跑的时候挂起的待发消息。
 * - 进入流程：流式中按 Enter → enqueuePending()
 * - 出去流程：sendPendingNow(steer 立即送) / 自动 flush（turn 结束跟单送） / removePending(删)
 */
export interface PendingMessage {
  id: string
  content: string
  images?: string[]
  fileAttachments?: FileAttachmentData[]
  createdAt: number
}

/** 画布圈画评论（HtmlPreview Comment 模式拖拽圈选后提交） */
export interface PendingAnnotation {
  ref: string
  text: string
  /** 圈选时刻的画布截图（裸 base64 JPEG，含红色笔迹）；截图能力缺失（浏览器模式）时为空 */
  image?: string
}

interface ChatState {
  messages: ChatMessage[]
  isStreaming: boolean
  /** 按会话的活跃流登记表（响应式）——主进程 per-cid 并发模型在渲染层的对称影子。
   *  历史上的单值 streamingCid 会被后起并发流顶掉、bgStreamBufs 只在出正文后才登记，thinking
   *  阶段的后台会话在旧信号里不可见（切回按钮误判实案）；列表"生成中"指示也读这里。 */
  streamingConvIds: Record<string, true>
  /** 后台会话生成完成但用户未查看——列表红点；switchConversation 进入即清除（视为已读）。 */
  unreadDoneConvIds: Record<string, true>
  conversations: ConversationSummary[]
  activeConversationId: string | null
  /** 新建对话计数器(仅 newConversation 递增)——WelcomePage 用它精确侦测"新建对话",与切角色(initConversations 改 activeConversationId)区分 */
  welcomeNonce: number
  convLoading: boolean
  pendingPermission: PermissionRequestData | null
  // 内联权限请求（会话流中显示）
  inlinePermissionRequests: Map<string, PermissionRequestData>
  // 待发送文件附件（输入框预览）
  pendingFileAttachments: FileAttachmentData[]
  // 用户在 agent 跑的时候挂起的待发消息（输入框上方的卡片堆叠）
  pendingMessages: PendingMessage[]
  // Agent 模板关联
  activeAgentId: string | null
  // Workspace Agent 关联
  activeWorkspaceId: string | null
  // 对话级配置（工作目录 + 通用前置信息桶）
  conversationConfig: {
    workingDir?: string
    /** 通用前置信息桶 — key=roleName */
    roleBrief?: Record<string, Record<string, any>>
    /** 会话级初始资产（跨角色通用） */
    initialAssets?: Array<{ category: string; fileName: string; path: string; sourceType: string; sizeBytes?: number }>
    /** 通用项目名 */
    projectName?: string
    /**
     * 本会话是否启用思考模式（仅在当前模型 supportsThinking 时有意义）。
     * undefined = 默认开（如果模型支持）；false = 用户主动关闭。
     */
    thinkingEnabled?: boolean
    /** 思考档位（low/medium/high），undefined = 'low'；仅支持档位的模型采纳 */
    thinkingLevel?: 'low' | 'medium' | 'high'
    /** 会话专属模型预设 id。undefined = 跟随全局默认。 */
    modelPresetId?: string
    /** questions_v2 的待答状态；由会话切换/重启恢复。 */
    pendingQuestion?: PersistedPendingQuestion
    [key: string]: any
  } | null
  // 记忆更新通知（对话流内联显示）
  memoryNotification: MemoryNotification | null
  // Agent 调用 questions_v2 时的 pending 追踪——UI 通过 artifactStore 渲染
  pendingQuestionsV2: PendingQuestion | null
  /** Comment 点选模式下，选中元素的 <mentioned-element> 片段列表（支持连点多选）——
   *  InputBar 发送时按加入顺序拼接附上并清空 */
  pendingMentions: string[]
  /** Comment 圈画评论待发区：文字 + 圈选时刻的画布截图（裸 base64 JPEG，含红色笔迹）——
   *  InputBar 发送时文字并入正文、截图并入 images，一并清空 */
  pendingAnnotations: PendingAnnotation[]
  // 思考内容（流式）
  thinkingContent: string // deprecated — thinking 直接作为消息存在，此字段仅用于兼容
  isThinking: boolean
  /** 静默响应周期:由 task-trigger / 系统观察 等隐式消息触发的 AI 响应,整个思考过程不渲染。
   *  对应反模式 4("AI 不解释自己的存在")——学生看不到"AI 在思考",只看到 AI 是否冒出一句话。 */
  silentResponseCycle: boolean
  /** 每会话上下文用量(key=conversationId)——输入框圆环/信息卡用；随 lastContextUsage 落盘、打开会话时回种 */
  contextUsage: Record<string, ContextUsageEntry>
  /** 每会话累计用量(key=conversationId)——信息卡"平均缓存命中率"用；随 lastContextUsage 落盘、打开会话时回种 */
  contextStats: Record<string, ContextCumulativeStats>
}

interface ChatActions {
  // 对话管理
  initConversations: (role: string) => Promise<void>
  newConversation: (role: string) => Promise<void>
  newConversationFromAgent: (role: string, agentId: string, agentName: string) => Promise<void>
  newConversationFromWorkspace: (role: string, workspaceId: string, workspaceName: string) => Promise<void>
  switchConversation: (id: string) => Promise<ChatMessage[]>
  deleteConversation: (id: string) => Promise<void>
  ensureConversation: (role: string) => Promise<string>
  // 对话配置（零门槛 Agent）
  setConversationWorkingDir: (dir: string) => void
  /**
   * 设置本会话是否开启 thinking。
   * enabled=true 显式开（与默认相同），enabled=false 显式关。
   * 仅在当前模型 supportsThinking 时才会被后端采用。
   */
  setConversationThinking: (enabled: boolean) => void
  setConversationThinkingLevel: (level: 'low' | 'medium' | 'high') => void
  /** 设置会话专属模型预设；undefined = 清除、跟随全局默认 */
  setConversationModelPreset: (presetId: string | undefined) => void
  /**
   * 通用前置信息提交入口 — 任意角色 preflow 提交完后调用
   * 把 projectName / roleBrief[roleName] / initialAssets 合并进 conversationConfig
   * 第一条 sendMessage 时这些信息会随 conversationConfig 一起发给 main
   */
  setConversationBrief: (data: { roleName: string; projectName?: string; roleBrief?: Record<string, any>; initialAssets?: Array<{ category: string; fileName: string; path: string; sourceType: string; sizeBytes?: number }> }) => void
  /** 用户提交 questions_v2 答案：清 pending 状态 + 作为 user message 发出 */
  submitQuestionsV2: (answers: Record<string, any>, role: string, images?: string[], files?: FileAttachmentData[]) => void
  /** 追加一条 Comment 选中元素的 mention 片段——按 dom 路径去重(重复点同一元素不重复加) */
  addPendingMention: (snippet: string) => void
  /** 移除单条 pending mention（按 index） */
  removePendingMention: (index: number) => void
  /** 清空全部 pending mention（发送后调用） */
  clearPendingMentions: () => void
  /** 追加一条画布圈画评论（HtmlPreview 圈画提交时调用） */
  addPendingAnnotation: (a: PendingAnnotation) => void
  removePendingAnnotation: (index: number) => void
  clearPendingAnnotations: () => void
  // 聊天
  sendMessage: (content: string, role: string, images?: string[], fileAttachments?: FileAttachmentData[], messageKind?: ChatMessageKind) => Promise<void>
  abortChat: () => void
  clearMessages: () => void
  regenerate: () => void
  editAndResend: (id: string, content: string) => void
  setMessages: (msgs: ChatMessage[]) => void
  insertVoiceMessages: (transcripts: VoiceTranscriptItem[], role: string) => Promise<void>
  /** 流式插入/更新单条 voice transcript 消息（按 itemId upsert，*.done 时持久化） */
  upsertVoiceMessage: (itemId: string, role: 'user' | 'assistant', content: string, isFinal: boolean) => void
  removeVoiceMessage: (itemId: string) => void
  setVoiceMessageAudio: (itemId: string, audioPath: string) => void
  /** 确保 voice 会话开始时有 active conversation（避免每次 transcript 都跑 ensureConversation） */
  ensureVoiceConversation: (role: string) => Promise<void>
  // 待发送文件附件
  addPendingFileAttachment: (file: FileAttachmentData) => void
  removePendingFileAttachment: (index: number) => void
  clearPendingFileAttachments: () => void
  // 消息插队
  /** 用户在 streaming 中按 Enter → 把消息暂存到待发队列（卡片堆叠到输入框上方） */
  enqueuePending: (content: string, images?: string[], fileAttachments?: FileAttachmentData[]) => void
  /** 删除一条挂起消息（用户点 🗑） */
  removePending: (id: string) => void
  /** 立即插入（用户点「⤴ 引导」）—— 调 steerChat，失败则降级为 sendMessage */
  sendPendingNow: (id: string, role: string) => Promise<void>
  /** turn 结束时自动消费队列 —— 按 FIFO 调 queueChat，失败则降级 */
  flushPendingOnTurnEnd: (role: string) => Promise<void>
  // 权限审批（弹窗模式）
  respondPermission: (requestId: string, approved: boolean) => void
  // 内联权限审批（会话流模式）
  addInlinePermission: (request: PermissionRequestData) => void
  respondInlinePermission: (requestId: string, approved: boolean, sessionApprove?: boolean) => void
  // 事件监听
  setupListeners: () => () => void
}

// Active-conversation writes are serialized. A barrier call queues behind any
// in-flight debounce save and then takes a fresh store snapshot, so it cannot
// return before changes made during that earlier IPC have been attempted.
let activeSaveTail: Promise<void> = Promise.resolve()

function enqueueActivePersistence(task: () => Promise<void>): Promise<void> {
  const operation = activeSaveTail.then(task, task)
  activeSaveTail = operation.catch(() => {})
  return operation
}

/**
 * 防抖落盘：优先走"只追加尾部"(conv:append-messages)，避免每次工具事件都把整个对话
 * 全量经 IPC 重写一遍。触发全量 replace 的两种情况：
 * 1. dirty=true —— 期间发生过"就地变更"(命中水位线之前的消息，如 onToolEnd 按 index upsert、
 *    regenerate/editAndResend 截断重写、respondInlinePermission 改 permissionStatus 等)。
 * 2. persistedCount > messages.length —— 水位线本身已经失真(如截断后又没等到 dirty 标记的
 *    防御性兜底)，硬性要求走全量，防止 slice(persistedCount) 漏删/漏改已落盘的旧尾巴。
 * 两条路径成功后都把 persistedCount 推进到 messages.length；失败(IPC/网络异常)时都不推进
 * 水位线、不清 dirty —— 下次 debouncedSave 会带着这段未确认内容重试，不会丢数据。
 */
function debouncedSave(_get?: () => ChatState) {
  // 参数保留以兼容既有调用点,但实际忽略:多数调用点传入的是 set(s=>..) 回调里创建的
  // 快照闭包,拿它做"IPC 飞行期间是否切换了会话"的守卫会退化成常量自比、恒真失效。
  // runSave 永远读实时 store;切会话前的挂起内容由 switchConversation/newConversation 显式冲刷。
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => runSave(), 500)
}

/**
 * 大附件卸载：截图 base64 / mcpApp payload 写入会话 attachments/ sidecar，成功后给消息挂 ref。
 * 内联字段仍留在内存——本会话即时渲染与 toApiMessages 模型载荷都不受影响，
 * 只有落盘投影(stripOffloadedInline)剥离它。插件端 shim 返回 null → 静默保持内联（旧行为）。
 */
function offloadAttachment(cid: string | null, messageId: string, kind: 'screenshot' | 'mcpapp', content: string): void {
  const api = window.api as any
  if (!cid || !content || typeof api.saveConvAttachment !== 'function') return
  api.saveConvAttachment(cid, messageId, kind, content).then((ref: string | null) => {
    if (!ref) return
    const refField = kind === 'screenshot' ? 'screenshotRef' : 'mcpAppRef'
    let applied = false
    useChatStore.setState(s => {
      // 已切走会话：附件文件已写好但 ref 不再挂——该消息保持内联落盘，行为不降级
      if (s.activeConversationId !== cid) return {}
      const idx = s.messages.findIndex(m => m.id === messageId)
      if (idx < 0) return {}
      const updated = [...s.messages]
      updated[idx] = { ...updated[idx], [refField]: ref }
      applied = true
      return { messages: updated }
    })
    if (applied) {
      // ref 是对可能已持久化消息的就地改写，须走全量 replace 才能落盘瘦身版本
      markDirty()
      debouncedSave()
    }
  }).catch(() => { /* 卸载失败保持内联，不影响功能 */ })
}

async function performSave(expectedConversationId?: string): Promise<void> {
  const get = (): ChatState => useChatStore.getState()
  const { activeConversationId, messages } = get()
  if (expectedConversationId && activeConversationId !== expectedConversationId) {
    // The user switched while this forced flush waited behind an in-flight
    // save. Never acknowledge the old execution by persisting the new view.
    await drainBackgroundPersistence(expectedConversationId)
    return
  }
  if (!activeConversationId) return
  if (dirty || persistedCount > messages.length) {
    const result = await window.api.replaceMessages(activeConversationId, stripOffloadedInline(normalizeChatMessages(messages)))
    assertPersistenceSucceeded(result, 'replace active conversation messages')
    // IPC 在飞行时用户可能已经切换/新建了别的会话——水位线是"当前活跃会话"的进度，
    // 若切走了就不能用这次(针对旧会话)的结果去覆盖新会话已经被 switchConversation 重置好的水位线
    if (get().activeConversationId === activeConversationId) {
      persistedCount = messages.length
      dirty = false
    }
  } else if (messages.length > persistedCount) {
    const result = await window.api.appendMessages(activeConversationId, stripOffloadedInline(normalizeChatMessages(messages.slice(persistedCount))))
    assertPersistenceSucceeded(result, 'append active conversation messages')
    if (get().activeConversationId === activeConversationId) {
      persistedCount = messages.length
    }
  }
  // Sidebar refresh is not part of the transcript durability acknowledgement.
  // A read failure must not turn a successful disk write into a failed barrier.
  window.api.listConversations().then((list: ConversationSummary[]) => {
    useChatStore.setState({ conversations: list })
  }).catch((err: unknown) => console.warn('[chatStore] 对话列表刷新失败:', err))
}

async function runSave(options: { failLoud?: boolean; expectedConversationId?: string } = {}): Promise<void> {
  const operation = enqueueActivePersistence(() => performSave(options.expectedConversationId))
  try {
    await operation
  } catch (err) {
    console.warn('[chatStore] 会话落盘失败，下次自动重试:', err)
    if (options.failLoud) throw err
  }
}

async function flushTranscriptPersistenceWork(cid: string): Promise<void> {
  if (!cid) return
  // A dispatched async listener may enqueue either an active save or a
  // background append. Drain listeners first, then drain the appropriate
  // persistence lane. Repeat once if completion work registered a successor.
  await drainConversationAsyncEvents(cid)
  flushPendingBackgroundToolEnds(cid)
  await drainBackgroundPersistence(cid)
  if (getActiveConversationId() === cid && !exitingConversationIds.has(cid)) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    await runSave({ failLoud: true, expectedConversationId: cid })
    await drainConversationAsyncEvents(cid)
    await drainBackgroundPersistence(cid)
    clearBgAnchoredForCid(cid)
    return
  }
  // The persistence request is a terminal runtime boundary. These fallbacks
  // make the renderer durable even if a phase/end notification was coalesced.
  enqueueBackgroundTextFlush(cid, { final: true })?.catch((error: unknown) =>
    console.warn('[chatStore] 后台文本落盘失败:', error)
  )
  flushPendingBackgroundToolEnds(cid)
  await drainBackgroundPersistence(cid)
  await drainConversationAsyncEvents(cid)
  await drainBackgroundPersistence(cid)
  clearBgAnchoredForCid(cid)
}

/** Force/wait the renderer-owned transcript projection for a main execution. */
async function flushTranscriptPersistence(cid: string): Promise<void> {
  try {
    await flushTranscriptPersistenceWork(cid)
    const latchedFailure = conversationDurabilityFailures.get(cid)
    if (latchedFailure !== undefined) throw latchedFailure
  } catch (error) {
    // The false ACK represented this execution's failure. Clear only its latch
    // so a later, independent execution can establish a fresh durability state.
    conversationDurabilityFailures.delete(cid)
    throw error
  }
}

function getActiveConversationId(): string | null {
  return useChatStore.getState().activeConversationId
}

interface ConversationExitHandoff {
  cid: string
  complete: () => void
  restore: () => void
}

// Conversation navigation mutates module-level stream/watermark state. Keep
// the entire navigation transaction serialized, not just its initial save, so
// two rapid switch/new actions cannot overwrite the same per-cid exit gate or
// release a gate owned by another transaction.
let conversationNavigationTail: Promise<void> = Promise.resolve()

function enqueueConversationNavigation<T>(task: () => Promise<T>): Promise<T> {
  const operation = conversationNavigationTail.then(task, task)
  conversationNavigationTail = operation.then(() => {}, () => {})
  return operation
}

/**
 * Atomically transfer the active stream projection to its conversation-owned
 * background buffer before any navigation await. The partial stays a streaming
 * projection (not a falsely completed assistant message) and is committed by
 * text_flush/stream_end in the same ordered persistence queue.
 */
async function prepareActiveConversationExit(): Promise<ConversationExitHandoff | null> {
  const state = useChatStore.getState()
  const cid = state.activeConversationId
  if (!cid) return null

  const hasRunningStream = !!state.streamingConvIds[cid] || state.isStreaming
  exitingConversationIds.add(cid)
  const exitGate = createConversationExitGate(cid)
  if (streamBuf || hasRunningStream) {
    bgStreamBufs.set(cid, (bgStreamBufs.get(cid) || '') + streamBuf)
  }
  streamBuf = ''
  liveStream.reset()

  const restore = (): void => {
    if (conversationExitGates.get(cid) === exitGate) conversationExitGates.delete(cid)
    exitGate.release()
    if (useChatStore.getState().activeConversationId !== cid) return
    const buffered = bgStreamBufs.get(cid) || ''
    bgStreamBufs.delete(cid)
    streamBuf = buffered
    exitingConversationIds.delete(cid)
    if (buffered) liveStream.setText(buffered)
  }

  try {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    // Complete any active async artifact/question mutation before snapshotting
    // the old conversation. Events dispatched after the handoff are routed to
    // the background lane by isBackgroundConversation().
    await drainConversationAsyncEvents(cid)
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    await runSave({ failLoud: true, expectedConversationId: cid })
    if (conversationExitGates.get(cid) === exitGate) conversationExitGates.delete(cid)
    exitGate.release()
  } catch (error) {
    restore()
    throw error
  }

  return {
    cid,
    complete: () => {
      if (conversationExitGates.get(cid) === exitGate) conversationExitGates.delete(cid)
      exitGate.release()
      exitingConversationIds.delete(cid)
    },
    restore
  }
}

/**
 * 起流初始化：清缓冲 + 按会话登记 streamingConvIds（isStreaming 的会话级事实源）+ 发 sendChat。
 * 登记必须紧贴 sendChat 之前——配合主进程守卫修 isStreaming 竞态；三条 send 路径逐行为等价。
 * **始终把 activeConversationId 作为 sendChat 第 4 参**：主进程据此 cid 标记每个事件，渲染层按
 * cid 隔离（`onXxx` 守卫 `cid !== active` → 存 bgStreamBufs 不上屏）。历史 bug：regenerate/
 * editAndResend 曾传 undefined → 主进程 `cid = conversationId || ''` 发空 cid → 空串短路掉渲染层
 * `if (cid && …)` 守卫 → 用户切走会话后，旧流（重试尾巴/[Error]）溢出到新会话视图。
 */
function beginStream(get: () => ChatState, msgs: ChatMessage[]): void {
  streamBuf = ''
  thinkBuf = ''
  liveStream.reset()
  // 用户发起新一轮(发送/重新生成/编辑重发) = 重新授权产物完成自动弹开面板。
  // 收口在唯一入口:任何第 N 条生成路径都自动继承,不再靠调用方各自记得(评审收敛)
  useWorkspaceStore.getState().rearmAutoOpen()

  // 登记会话（add 语义，天然并发安全）与发给主进程的 cid 必须是同一个值
  const cid = get().activeConversationId
  if (cid) {
    abortedStreamConversationIds.delete(cid)
    conversationDurabilityFailures.delete(cid)
    useChatStore.setState(s => ({ streamingConvIds: { ...s.streamingConvIds, [cid]: true } }))
  } else {
    abortWithoutConversationId = false
  }
  window.api.sendChat(
    toApiMessages(msgs),
    get().activeAgentId || undefined,
    get().conversationConfig || undefined,
    cid || undefined,
    get().activeWorkspaceId || undefined
  )
}

export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
  messages: [],
  isStreaming: false,
  streamingConvIds: {},
  unreadDoneConvIds: {},
  conversations: [],
  activeConversationId: null,
  welcomeNonce: 0,
  convLoading: true,
  pendingPermission: null,
  inlinePermissionRequests: new Map(),
  pendingFileAttachments: [],
  pendingMessages: [],
  activeAgentId: null,
  activeWorkspaceId: null,
  conversationConfig: null,
  memoryNotification: null,
  pendingQuestionsV2: null,
  pendingMentions: [],
  pendingAnnotations: [],
  thinkingContent: '',
  isThinking: false,
  silentResponseCycle: false,
  contextUsage: {},
  contextStats: {},

  // ---- 对话管理 ----

  initConversations: (_role) => enqueueConversationNavigation(async () => {
    const exitHandoff = await prepareActiveConversationExit()
    // 切角色/启动一律停在欢迎页"开新的"——只载会话列表,不自动续最近会话(messages 留空 → 渲染 WelcomePage)。
    // 续旧会话由用户点左侧历史列表显式加载,与"切角色=开新的"解耦。
    let list: ConversationSummary[]
    try {
      list = await window.api.listConversations()
    } catch (error) {
      exitHandoff?.restore()
      throw error
    }
    set({
      conversations: list,
      activeConversationId: null,
      messages: [],
      pendingQuestionsV2: null,
      isStreaming: false,
      convLoading: false
    })
    exitHandoff?.complete()
    resetPersistWatermark()
    // 无活跃会话——顺带断开 workspace 的会话归属,避免后续手动 toggle 被错记到上一个会话头上
    useWorkspaceStore.getState().setCurrentConversationId(null)
  }),

  newConversation: (role) => enqueueConversationNavigation(async () => {
    const exitHandoff = await prepareActiveConversationExit()
    artifactDeltaAcc = ''
    visualizerDeltaAcc = ''
    let conv: any
    let list: ConversationSummary[]
    try {
      conv = await window.api.createConversation(role)
      list = await window.api.listConversations()
    } catch (error) {
      exitHandoff?.restore()
      throw error
    }
    set({
      activeConversationId: conv.id,
      welcomeNonce: get().welcomeNonce + 1,  // 新建对话 → WelcomePage 复位到通用头像页
      activeAgentId: null,
      activeWorkspaceId: null,
      // 水合出生配置（含创建时钉住的 modelPresetId）——此前硬编码 null 导致"+"路径的
      // chat:send 载荷不带钉住,全靠 agent-overrides 磁盘兜底(层次评审:两处防线意图对齐)
      conversationConfig: conv.config ?? null,
      memoryNotification: null,
      conversations: list,
      messages: [],
      pendingQuestionsV2: null,
      isStreaming: false
    })
    exitHandoff?.complete()
    streamBuf = ''
    liveStream.reset()
    resetThinkingState()
    resetPersistWatermark()
    // 只清这个新会话的授权（id 复用兜底），别把并发中其它会话的"本次会话允许"一起抹掉
    window.api.clearSessionApprovals?.(conv.id)
    useArtifactStore.getState().clearArtifacts()
    useVisualizerStore.getState().clearAll()
    const ws = useWorkspaceStore.getState()
    ws.setRehydrating(true)
    resetWorkspaceForNewConversation()
    ws.setRehydrating(false)
    ws.restoreOpenForConversation(conv.id, false)
  }),

  newConversationFromAgent: (role, agentId, agentName) => enqueueConversationNavigation(async () => {
    const exitHandoff = await prepareActiveConversationExit()
    let conv: any
    let list: ConversationSummary[]
    try {
      conv = await window.api.createConversation(role, agentName, agentId)
      list = await window.api.listConversations()
    } catch (error) {
      exitHandoff?.restore()
      throw error
    }
    set({
      activeConversationId: conv.id,
      activeAgentId: agentId,
      activeWorkspaceId: null,
      // 出生配置水合——浅合并下漏掉该字段会让上一个会话的 config 静默残留（评审登记缺口）
      conversationConfig: conv.config ?? null,
      conversations: list,
      messages: [],
      pendingQuestionsV2: null,
      isStreaming: false
    })
    exitHandoff?.complete()
    streamBuf = ''
    liveStream.reset()
    resetThinkingState()
    resetPersistWatermark()
    // 只清这个新会话的授权（id 复用兜底），别把并发中其它会话的"本次会话允许"一起抹掉
    window.api.clearSessionApprovals?.(conv.id)
    useArtifactStore.getState().clearArtifacts()
    useVisualizerStore.getState().clearAll()
    const ws = useWorkspaceStore.getState()
    ws.setRehydrating(true)
    resetWorkspaceForNewConversation()
    ws.setRehydrating(false)
    ws.restoreOpenForConversation(conv.id, false)
  }),

  newConversationFromWorkspace: (role, workspaceId, workspaceName) => enqueueConversationNavigation(async () => {
    const exitHandoff = await prepareActiveConversationExit()
    let conv: any
    let list: ConversationSummary[]
    try {
      conv = await window.api.createConversation(role, workspaceName, undefined, workspaceId)
      list = await window.api.listConversations()
    } catch (error) {
      exitHandoff?.restore()
      throw error
    }
    set({
      activeConversationId: conv.id,
      activeAgentId: null,
      activeWorkspaceId: workspaceId,
      // 出生配置水合——同 newConversationFromAgent
      conversationConfig: conv.config ?? null,
      conversations: list,
      messages: [],
      pendingQuestionsV2: null,
      isStreaming: false
    })
    exitHandoff?.complete()
    streamBuf = ''
    liveStream.reset()
    resetThinkingState()
    resetPersistWatermark()
    // 只清这个新会话的授权（id 复用兜底），别把并发中其它会话的"本次会话允许"一起抹掉
    window.api.clearSessionApprovals?.(conv.id)
    useArtifactStore.getState().clearArtifacts()
    useVisualizerStore.getState().clearAll()
    const ws = useWorkspaceStore.getState()
    ws.setRehydrating(true)
    resetWorkspaceForNewConversation()
    ws.setRehydrating(false)
    ws.restoreOpenForConversation(conv.id, false)
  }),

  switchConversation: (id) => enqueueConversationNavigation(async () => {
    const exitHandoff = await prepareActiveConversationExit()
    // 切会话即作废流式增量重组基线——避免切回时用陈旧 offset 拼出乱序内容
    artifactDeltaAcc = ''
    visualizerDeltaAcc = ''
    resetThinkingState()
    let msgs: ChatMessage[]
    try {
      // Phase/tool/artifact writes may already be queued for the destination
      // while it was in the background. Load only after that ordered prefix is
      // durable, otherwise the newly active UI starts from a stale transcript.
      await drainConversationAsyncEvents(id)
      await drainBackgroundPersistence(id)
      msgs = await window.api.getConversationMessages(id)
    } catch (error) {
      exitHandoff?.restore()
      throw error
    }
    const conv = get().conversations.find(c => c.id === id)
    const configuredPending = restorePendingQuestion(conv?.config?.pendingQuestion, id)
    // 配置写入与用户答案分别异步落盘；若进程恰在答案写完、pending 清除前退出，
    // 恢复时以答案为准，不把已完成的问卷重新打开。
    const pendingFromConfig = configuredPending && !hasAnsweredQuestion(
      msgs || [], configuredPending.title, configuredPending.artifactId
    )
      ? configuredPending
      : null
    const configAfterPendingReconcile = configuredPending && !pendingFromConfig
      ? withPendingQuestionConfig(conv?.config as Record<string, any> | undefined, null)
      : conv?.config ?? null

    // 检查目标会话是否有后台流正在生成
    const hasBgStream = bgStreamBufs.has(id)
    if (hasBgStream) {
      streamBuf = bgStreamBufs.get(id) || ''
      bgStreamBufs.delete(id)
    } else {
      streamBuf = ''
    }

    set(s => {
      // 进入即视为已读：清掉该会话的"完成未读"红点
      const unread = { ...s.unreadDoneConvIds }
      delete unread[id]
      // 用量圆环回种：本会话在当前窗口还没有读数时，用落盘的 lastContextUsage 直接显示
      // （打开旧会话即刻见圆环，不必先发消息）。当前窗口已有实时读数则不动。
      const persistedUsage = (conv?.config as any)?.lastContextUsage as (ContextUsageEntry & { stats?: ContextCumulativeStats }) | undefined
      const seededUsage = persistedUsage && !s.contextUsage[id]
        ? { ...s.contextUsage, [id]: persistedUsage }
        : s.contextUsage
      const seededStats = persistedUsage?.stats && !s.contextStats[id]
        ? { ...s.contextStats, [id]: persistedUsage.stats }
        : s.contextStats
      return {
        activeConversationId: id,
        activeAgentId: conv?.agentId || null,
        activeWorkspaceId: (conv as any)?.workspaceId || null,
        conversationConfig: configAfterPendingReconcile,
        messages: normalizeChatMessages(msgs || []),
        // 不可沿用上个会话的问卷；存在持久化状态时立刻恢复，避免产物 tab 首帧误判“已提交”。
        pendingQuestionsV2: pendingFromConfig,
        // 恢复流式状态：后台正文缓冲 / 按会话登记表（thinking 阶段唯一可靠信号）
        isStreaming: hasBgStream || !!s.streamingConvIds[id],
        isThinking: false,
        pendingPermission: null,
        unreadDoneConvIds: unread,
        contextUsage: seededUsage,
        contextStats: seededStats,
        conversations: s.conversations.map(c => c.id === id && c.config !== configAfterPendingReconcile
          ? { ...c, config: configAfterPendingReconcile || undefined }
          : c)
      }
    })
    exitHandoff?.complete()
    if (configuredPending && !pendingFromConfig) {
      void window.api.updateConversationConfig(id, configAfterPendingReconcile).catch((err: unknown) =>
        console.warn('[questions_v2] clear stale pending state failed:', err)
      )
    }
    // 水位线归零到"刚从磁盘读出的条数"——这就是新活跃会话此刻的落盘真相，dirty 一并清空
    resetPersistWatermark((msgs || []).length)
    // 恢复后台暂存的"等待用户输入"事件（权限气泡 / 问答页）——物归原主
    const stashedPerms = bgPendingPermissions.get(id)
    if (stashedPerms?.length) {
      bgPendingPermissions.delete(id)
      set(s => ({
        messages: [...s.messages, ...stashedPerms.map(r => createPermissionRequestMessage({
          id: `perm-${r.requestId}`, permissionRequest: r, permissionStatus: 'pending' as const, timestamp: Date.now()
        }))]
      }))
    }
    const stashedQ = bgPendingQuestions.get(id)
    if (stashedQ) {
      bgPendingQuestions.delete(id)
      const config = withPendingQuestionConfig(conv?.config as Record<string, any> | undefined, stashedQ)
      set(s => ({
        pendingQuestionsV2: stashedQ,
        conversationConfig: s.activeConversationId === id ? config : s.conversationConfig,
        conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c)
      }))
      void window.api.updateConversationConfig(id, config).catch((err: unknown) =>
        console.warn('[questions_v2] persist pending state failed:', err)
      )
    }
    // live 流式投影:有后台流则恢复文字,否则清空(工具指示一律清)
    liveStream.reset()
    if (hasBgStream) liveStream.setText(streamBuf)
    useArtifactStore.getState().clearArtifacts()
    useVisualizerStore.getState().clearAll()

    // 重灌窗口：清理上个会话的 stale workspace tab + 重灌 artifact 期间，面板显隐（open）
    // 一律不受 openTab/setOpen 影响（见 workspaceStore.rehydrating）——避免"重灌历史产物"
    // 覆盖用户对目标会话的手动关闭/展开记忆。窗口结束后按记忆/默认规则一次性收官。
    const normalized = normalizeChatMessages(msgs || [])
    const ws = useWorkspaceStore.getState()
    ws.setRehydrating(true)
    try {
      resetWorkspaceForNewConversation()

      // Rehydrate artifacts：扫消息里的 artifactRef，从磁盘 sidecar 加载回 artifactStore
      // 这样切回历史会话能重新看到 agent 之前生成的 HTML / questions 等产物
      const loadApi = (window.api as any).loadArtifact
      // 首次出现顺序去重（同一 artifact 可有多条 anchor：create+若干 edit），供 tab 恢复用
      const rehydratedForTabs: { id: string; title: string; titleKey?: string; titleParams?: Record<string, string | number> }[] = []
      const rehydratedIds = new Set<string>()
      // questions 没有 sidecar，必须从 pendingQuestion 重建；否则 pending 状态虽在，问答 UI
      // 却在切会话/重启后消失，用户无法继续回答。
      if (pendingFromConfig) {
        const pendingArtifact = rehydratePendingQuestionArtifact(pendingFromConfig, normalized)
        rehydratedIds.add(pendingArtifact.id)
        rehydratedForTabs.push(pendingArtifact)
      }
      if (loadApi) {
        for (const m of normalized) {
          const ref = (m as any).artifactRef
          if (!ref || !ref.path) continue
          try {
            const result = await loadApi(ref, id)
            if (result?.ok && result.artifact) {
              useArtifactStore.getState().addArtifact({
                id: result.artifact.id,
                type: result.artifact.type as any,
                title: result.artifact.title,
                content: result.artifact.content,
                language: result.artifact.language,
                messageId: m.id,
                createdAt: m.timestamp || Date.now(),
                rehydrated: true
              })
              if (!rehydratedIds.has(result.artifact.id)) {
                rehydratedIds.add(result.artifact.id)
                const title = stripDcSuffix(result.artifact.title)
                rehydratedForTabs.push({
                  id: result.artifact.id,
                  title,
                  ...(!title ? { titleKey: 'shell.workspace.fallback.untitledArtifact' } : {})
                })
              }
            }
          } catch (err) {
            console.warn('[artifact] rehydrate failed:', ref.path, err)
          }
        }
      }
      // 收官（仍在重灌窗口内）：按该会话的 tab 记忆重建产物 tab 集合——用户关过的不再弹回，
      // 无记忆才全量打开。桥接层只认非重灌产物，恢复决策全在此处（确定性归代码，时序无关）。
      ws.restoreArtifactTabsForConversation(id, rehydratedForTabs)
    } finally {
      ws.setRehydrating(false)
    }
    // 兼容修复前已落盘的问卷：旧会话没有 pendingQuestion 配置时，从问卷锚点与后续答案
    // 恢复一张仍未回答的问卷，并立即迁移到持久化状态。
    if (!get().pendingQuestionsV2) {
      const recovered = recoverPendingQuestionFromHistory(
        normalized,
        useArtifactStore.getState().artifacts,
        id
      )
      if (recovered) {
        const config = withPendingQuestionConfig(conv?.config as Record<string, any> | undefined, recovered)
        set(s => ({
          pendingQuestionsV2: recovered,
          conversationConfig: s.activeConversationId === id ? config : s.conversationConfig,
          conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c)
        }))
        void window.api.updateConversationConfig(id, config).catch((err: unknown) =>
          console.warn('[questions_v2] migrate pending state failed:', err)
        )
      }
    }
    // 收官：目标会话有记忆用记忆，无记忆按"有产物→开/无产物→关"默认规则
    ws.restoreOpenForConversation(id, useArtifactStore.getState().artifacts.length > 0)
    // 待答问卷是 agent 等待用户输入的阻塞点；即使用户此前关过普通产物面板，切回/重启后
    // 也必须把这张仍未完成的问答卡带回前台，不能只保留一个不可见的 pending 状态。
    const pendingToResume = get().pendingQuestionsV2
    if (pendingToResume && useArtifactStore.getState().artifacts.some(a => a.id === pendingToResume.artifactId)) {
      ws.openTab({
        kind: 'artifact',
        title: pendingToResume.title || '',
        ...(!pendingToResume.title ? { titleKey: 'chat.questions.defaultTitle' } : {}),
        artifactId: pendingToResume.artifactId
      })
    }

    return normalized
  }),

  deleteConversation: async (id) => {
    artifactDeltaAcc = ''
    visualizerDeltaAcc = ''
    await window.api.deleteConversation(id)
    // 清理该会话的全部登记残留（评审 L4）：流表/红点/待输入暂存/锚点去重键
    bgStreamBufs.delete(id)
    bgPendingPermissions.delete(id)
    bgPendingQuestions.delete(id)
    abortedStreamConversationIds.delete(id)
    conversationDurabilityFailures.delete(id)
    clearBgAnchoredForCid(id)
    window.api.clearSessionApprovals?.(id)   // 主进程侧的会话级权限授权也属于"该会话的登记残留"
    set(s => {
      const streaming = { ...s.streamingConvIds }; delete streaming[id]
      const unread = { ...s.unreadDoneConvIds }; delete unread[id]
      return { streamingConvIds: streaming, unreadDoneConvIds: unread }
    })
    const { activeConversationId } = get()
    if (activeConversationId === id) {
      set({ activeConversationId: null, messages: [], pendingQuestionsV2: null })
      resetPersistWatermark()
    }
    const list = await window.api.listConversations()
    set({ conversations: list })
  },

  ensureConversation: async (role) => {
    const { activeConversationId, newConversation } = get()
    if (activeConversationId) {
      // 所见即所得：空会话（还没开聊）的 role 跟随本次发送的显式选择——
      // 新建对话默认 general，欢迎页切到某角色再发送时在这里落成会话事实
      const conv = get().conversations.find(c => c.id === activeConversationId)
      if (conv && get().messages.length === 0 && conv.role !== role) {
        const ok = await window.api.updateConversationRole(activeConversationId, role)
        if (!ok) throw new Error('Failed to persist first-turn conversation role')
        set(s => ({ conversations: s.conversations.map(c => c.id === activeConversationId ? { ...c, role } : c) }))
      }
      return activeConversationId
    }
    // 欢迎页无活跃会话时攒下的会话配置（preflow 简报/技能/目录）要随首条消息走：
    // 这里的自动建会话是"物化当前会话"，不是用户显式"新建对话"——newConversation 的
    // conversationConfig 重置对这条路径是误伤，建完把配置写回并持久化
    const inflightConfig = get().conversationConfig
    await newConversation(role)
    const id = get().activeConversationId!
    if (inflightConfig) {
      // 合并而非覆写：主进程建会话时会把当时的全局模型预设钉进 config（出生快照，防全局切换
      // 翻转运行中会话）——渲染层攒的 inflightConfig 若没带 modelPresetId，不能把钉住冲掉；
      // 用户在前置页显式选过模型时 inflightConfig 有值，仍以显式选择为准。
      const born = get().conversations.find(c => c.id === id)?.config
      const merged = { ...born, ...inflightConfig }
      set(s => ({
        conversationConfig: merged,
        conversations: s.conversations.map(c => c.id === id ? { ...c, config: merged } : c)
      }))
      const persisted = await window.api.updateConversationConfig(id, merged)
      assertPersistenceSucceeded(persisted, 'persist first-turn conversation config')
    }
    return id
  },

  // ---- 聊天 ----

  sendMessage: async (content, role, images, fileAttachments, messageKind) => {
    const { messages, isStreaming, ensureConversation } = get()
    if (isStreaming || (!content.trim() && !images?.length && !fileAttachments?.length)) return
    lastUsedRole = role  // 记下来，给 onStreamEnd 自动 flush 用

    // 模型未配置 → 轻提示并 early-return,避免静默"AI 不回我"困惑
    // (task-trigger 等隐式消息走系统触发,不在此拦)
    if (messageKind !== 'task-trigger') {
      const hasKey = await (window.api as any).hasApiKey?.()
      if (hasKey && !hasKey.hasKey) {
        window.alert(rendererI18n.t('chat.errors.modelNotConfigured'))
        return
      }
    }

    await ensureConversation(role)

    // 随消息图片落盘（官方 uploads/ 形状）：拿到相对路径挂进消息元数据——模型侧据此注入
    // "图片已存盘"事实，dc 配图直接引用文件，消灭"全盘找图"（失败不阻塞发送，仅少这条事实）
    let imagePaths: string[] | undefined
    if (images?.length) {
      const convId = get().activeConversationId
      if (convId) {
        imagePaths = await (window.api as any).persistChatImages?.(convId, images).catch(() => undefined)
        if (imagePaths && imagePaths.length === 0) imagePaths = undefined
      }
    }

    const userMessage: ChatMessage = {
      ...createUserMessage({
        id: Date.now().toString(),
        content: content.trim() || rendererI18n.t(
          fileAttachments && fileAttachments.length > 1
            ? 'chat.message.analyzeFiles'
            : 'chat.message.analyzeFile'
        ),
        images,
        imagePaths,
        fileAttachments,
        timestamp: Date.now(),
        messageKind  // task-trigger 等 silent kind 时,UI 隐藏但 AI 仍能读到
      })
    }

    const newMessages = normalizeChatMessages([...messages, userMessage])
    // task-trigger 类隐式消息 → 整个响应周期标记为静默(thinking 不渲染、NO_REPLY 一并过滤)
    set({
      messages: newMessages,
      isStreaming: true,
      silentResponseCycle: messageKind === 'task-trigger'
    })
    beginStream(get, newMessages)
  },

  abortChat: () => {
    // 用户预期"停止 = 停止"：绑定当前 cid，即使随后切走，旧流的
    // stream_end 也只会收敛旧会话，不会污染下一会话的正常结束。
    const cid = get().activeConversationId
    if (cid) abortedStreamConversationIds.add(cid)
    else abortWithoutConversationId = true
    // 只停**当前会话**的流（per-conversation abort）——不误杀别的会话的后台流
    window.api.abortChat(cid || undefined)
  },

  clearMessages: () => {
    set({ messages: [], thinkingContent: '', isThinking: false, isStreaming: false })
    streamBuf = ''
    thinkBuf = ''
    liveStream.reset()
    resetPersistWatermark()
    useArtifactStore.getState().clearArtifacts()
    useVisualizerStore.getState().clearAll()
    // 切角色场景下常紧跟在这后面调用——顺带断开 workspace 的会话归属，理由同 initConversations
    useWorkspaceStore.getState().setCurrentConversationId(null)
  },

  regenerate: () => {
    const { messages, isStreaming } = get()
    if (isStreaming) return

    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx === -1) return

    const truncated = messages.slice(0, lastUserIdx + 1)
    // 截断丢弃了尾部——水位线之前的"落盘状态"与新数组已经对不上，必须走全量 replace
    markDirty()
    set({ messages: truncated, isStreaming: true })
    beginStream(get, truncated)
  },

  editAndResend: (messageId, newContent) => {
    const { messages, isStreaming } = get()
    if (isStreaming) return

    const idx = messages.findIndex(m => m.id === messageId)
    if (idx === -1) return

    const updated = messages.slice(0, idx + 1)
    updated[idx] = normalizeChatMessage({ ...updated[idx], content: newContent })

    // 截断 + 就地改写第 idx 条内容——同 regenerate，必须走全量 replace
    markDirty()
    set({ messages: updated, isStreaming: true })
    beginStream(get, updated)
  },

  // 目前渲染层无调用方(供测试/未来外部驱动)——任意整体替换，无法判断与水位线的关系，保守整体标脏
  setMessages: (msgs) => { markDirty(); set({ messages: normalizeChatMessages(msgs) }) },

  respondPermission: (requestId, approved) => {
    window.api.respondPermission?.(requestId, approved)
    set({ pendingPermission: null })
  },

  addInlinePermission: (request) => {
    set(s => {
      const newMap = new Map(s.inlinePermissionRequests)
      newMap.set(request.requestId, request)
      return { inlinePermissionRequests: newMap }
    })
  },

  respondInlinePermission: (requestId, approved, sessionApprove) => {
    const request = get().inlinePermissionRequests.get(requestId)
    window.api.respondPermissionInline?.(
      requestId,
      approved,
      sessionApprove,
      request?.executionId,
      request?.conversationId
    )
    set(s => {
      // 从 pending map 里移除
      const newMap = new Map(s.inlinePermissionRequests)
      newMap.delete(requestId)
      // 同时把对应消息的 permissionStatus 打上最终决定 —— PermissionCard 会切到"已允许/已拒绝"视图隐藏按钮
      const nextStatus: 'approved' | 'denied' = approved ? 'approved' : 'denied'
      const targetIdx = s.messages.findIndex(m => m.permissionRequest?.requestId === requestId)
      const messages = targetIdx === -1
        ? s.messages
        : s.messages.map((m, i) => i === targetIdx ? { ...m, permissionStatus: nextStatus } : m)
      // 这里本身不落盘(沿用原行为，由后续事件的 debouncedSave 一并带上)——但改写的是既有消息，
      // 命中水位线之前时必须让"后续那次落盘"改走全量 replace，否则 append-only 会漏掉这次状态变更
      markDirtyIfPersisted(targetIdx)
      return { inlinePermissionRequests: newMap, messages }
    })
  },

  // ---- 对话配置 ----

  setConversationWorkingDir: (dir) => {
    const config = { ...get().conversationConfig, workingDir: dir || undefined }
    set({ conversationConfig: config })
    const id = get().activeConversationId
    if (id) window.api.updateConversationConfig(id, config)
    set(s => ({ conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c) }))
  },

  setConversationThinking: (enabled) => {
    // 写入对话配置；undefined / true 等价（默认开），false 表示用户主动关闭
    const config = { ...get().conversationConfig, thinkingEnabled: enabled }
    set({ conversationConfig: config })
    const id = get().activeConversationId
    if (id) window.api.updateConversationConfig(id, config)
    set(s => ({ conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c) }))
  },

  setConversationThinkingLevel: (level) => {
    // 选档位即视为想要思考——顺手把 thinkingEnabled 拉回默认开，免去两次点击
    const config = { ...get().conversationConfig, thinkingLevel: level, thinkingEnabled: true }
    set({ conversationConfig: config })
    const id = get().activeConversationId
    if (id) window.api.updateConversationConfig(id, config)
    set(s => ({ conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c) }))
  },

  setConversationModelPreset: (presetId) => {
    // 会话专属模型（不碰全局 modelConfig）；undefined = 清除专属、回到跟随全局
    const config = { ...get().conversationConfig, modelPresetId: presetId }
    if (presetId === undefined) delete (config as any).modelPresetId
    set({ conversationConfig: config })
    const id = get().activeConversationId
    if (id) window.api.updateConversationConfig(id, config)
    set(s => ({ conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c) }))
  },

  /**
   * 用户提交 questions_v2 答案 — 清空 pending 状态 + 把答案作为 user message 发出去
   */
  submitQuestionsV2: async (answers, role, images, files) => {
    const pending = get().pendingQuestionsV2
    // 把答案格式化成 user message —— 问题原文随行:questions_v2 的问题卡以 tool 消息落盘,
    // 会被 shouldSendMessageToModel 过滤出模型历史(messages.ts:285-294,省 token 的刻意设计,
    // 不动)。若答案消息只有 "key: value"，模型下一轮就看不到自己问过什么，会重新问一遍
    // （真机复现）。这里让答案消息自包含问题原文，替代被过滤掉的那条工具消息的上下文。
    const questionsById = new Map((pending?.questions || []).map((q: any) => [q?.id, q]))
    const header = pending?.title ? `[Questions answered] 问题卡「${pending.title}」` : '[Questions answered]'
    const lines = [header]
    for (const [k, v] of Object.entries(answers || {})) {
      const val = Array.isArray(v) ? v.join(', ') : String(v ?? '')
      if (!val) continue
      const q = questionsById.get(k)
      // 展示文本优先取 title（QuestionsV2Panel/normalizeQuestionsV2Items 的标准字段），
      // question/label 是防御性兜底（弱模型或未规范化的坏形状问题对象），都拿不到才降级用 key。
      const qText = (q?.title || q?.question || q?.label || k) as string
      lines.push(`${qText}: ${val}`)
    }
    const content = lines.join('\n')
    // 先把提交动作发出去，再清 pending / 从 artifactStore 移除 / 关 tab——避免 sendMessage 内部
    // 前置检查（未配置 API Key 等）early-return 时，问答面板已经先一步被销毁、用户看不到任何反馈
    await get().sendMessage(content, role, images, files)
    if (pending?.conversationId) {
      const existingConfig = get().activeConversationId === pending.conversationId
        ? get().conversationConfig
        : get().conversations.find(c => c.id === pending.conversationId)?.config
      const config = withPendingQuestionConfig(existingConfig, null)
      set(s => ({
        pendingQuestionsV2: null,
        conversationConfig: s.activeConversationId === pending.conversationId ? config : s.conversationConfig,
        conversations: s.conversations.map(c => c.id === pending.conversationId ? { ...c, config } : c)
      }))
      void window.api.updateConversationConfig(pending.conversationId, config).catch((err: unknown) =>
        console.warn('[questions_v2] clear pending state failed:', err)
      )
    } else {
      set({ pendingQuestionsV2: null })
    }
    // questions 是过程物（ephemeral）：提交后即用完即清——从 artifactStore 移除 + 关闭 workspace tab，
    // 不留在产物列表里（复用 artifact 管道 ≠ 同等持久化待遇）
    if (pending?.artifactId) {
      useArtifactStore.getState().removeArtifact(pending.artifactId)
      const ws = useWorkspaceStore.getState()
      const tab = ws.tabs.find(t => t.kind === 'artifact' && t.artifactId === pending.artifactId)
      if (tab) ws.closeTab(tab.id)
    }
  },

  addPendingMention: (snippet) => set((state) => {
    // 按 dom 路径去重：snippet 形如 <mentioned-element ref="cc-N" dom="...">text</mentioned-element>
    const dom = snippet.match(/dom="([^"]*)"/)?.[1]
    if (dom && state.pendingMentions.some(m => m.match(/dom="([^"]*)"/)?.[1] === dom)) {
      return {}
    }
    return { pendingMentions: [...state.pendingMentions, snippet] }
  }),
  removePendingMention: (index) => set((state) => ({
    pendingMentions: state.pendingMentions.filter((_, i) => i !== index)
  })),
  clearPendingMentions: () => set({ pendingMentions: [] }),

  addPendingAnnotation: (a) => set((state) => ({ pendingAnnotations: [...state.pendingAnnotations, a] })),
  removePendingAnnotation: (index) => set((state) => ({
    pendingAnnotations: state.pendingAnnotations.filter((_, i) => i !== index)
  })),
  clearPendingAnnotations: () => set({ pendingAnnotations: [] }),

  setConversationBrief: ({ roleName, projectName, roleBrief, initialAssets }) => {
    const prev = get().conversationConfig || {}
    const mergedRoleBrief = { ...(prev.roleBrief || {}) }
    if (roleBrief && Object.keys(roleBrief).length > 0) {
      mergedRoleBrief[roleName] = { ...(mergedRoleBrief[roleName] || {}), ...roleBrief }
    }
    const config = {
      ...prev,
      projectName: projectName !== undefined ? projectName : prev.projectName,
      roleBrief: Object.keys(mergedRoleBrief).length > 0 ? mergedRoleBrief : undefined,
      initialAssets: initialAssets && initialAssets.length > 0
        ? [...(prev.initialAssets || []), ...initialAssets]
        : prev.initialAssets
    }
    set({ conversationConfig: config })
    const id = get().activeConversationId
    if (id) window.api.updateConversationConfig(id, config)
    set(s => ({ conversations: s.conversations.map(c => c.id === id ? { ...c, config } : c) }))
  },

  // ---- 待发送文件附件 ----

  addPendingFileAttachment: (file) => set(s => ({
    pendingFileAttachments: [...s.pendingFileAttachments, file]
  })),

  removePendingFileAttachment: (index) => set(s => ({
    pendingFileAttachments: s.pendingFileAttachments.filter((_, i) => i !== index)
  })),

  clearPendingFileAttachments: () => set({ pendingFileAttachments: [] }),

  // ---- 消息插队（pending messages stacked above input bar） ----

  enqueuePending: (content, images, fileAttachments) => {
    const trimmed = content.trim()
    if (!trimmed && !images?.length && !fileAttachments?.length) return
    const msg: PendingMessage = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: trimmed,
      images,
      fileAttachments,
      createdAt: Date.now()
    }
    set(s => ({ pendingMessages: [...s.pendingMessages, msg] }))
  },

  removePending: (id) => set(s => ({
    pendingMessages: s.pendingMessages.filter(m => m.id !== id)
  })),

  sendPendingNow: async (id, role) => {
    const { pendingMessages, activeConversationId, sendMessage } = get()
    const target = pendingMessages.find(m => m.id === id)
    if (!target) return
    // 乐观先从队列移除（避免重复点击）
    set(s => ({ pendingMessages: s.pendingMessages.filter(m => m.id !== id) }))
    const cid = activeConversationId || ''
    const res = cid ? await window.api.steerChat(cid, target.content, target.images) : { ok: false }
    if (res.ok) {
      // ✨ Codex 风格的两条消息：
      //   1) 用户消息正常显示在右侧（无 subtype，干净的 user bubble）
      //   2) 紧跟一条左对齐细灰字 "↳ 已引导对话"，表示 agent 在此处接管新指令
      const userMsg = createUserMessage({
        id: `inject-user-${Date.now()}`,
        content: target.content,
        images: target.images,
        fileAttachments: target.fileAttachments,
        timestamp: Date.now()
      })
      const notice: ChatMessage = {
        id: `inject-notice-${Date.now()}`,
        role: 'assistant',
        content: '↳ 已引导对话',
        messageKind: 'inject-notice',
        messageSubtype: 'steer',
        timestamp: Date.now() + 1  // 紧贴 user 之后
      }
      set(s => ({ messages: normalizeChatMessages([...s.messages, userMsg, notice]) }))
      debouncedSave(get)
    } else {
      // agent 不在跑 / 跨会话不匹配 → 降级为普通新一轮（sendMessage 内部会自动 append user bubble）
      await sendMessage(target.content, role, target.images, target.fileAttachments)
    }
  },

  flushPendingOnTurnEnd: async (role) => {
    const { pendingMessages, activeConversationId, sendMessage } = get()
    if (pendingMessages.length === 0) return
    // 取出全部，清空队列
    const toFlush = [...pendingMessages]
    set({ pendingMessages: [] })
    const cid = activeConversationId || ''
    // FIFO 跟单：每条尝试 queueChat；若失败（生产环境 currentAgent 多半已被清掉），降级为 sendMessage
    // 不论哪条路径，都要保证 user message 在聊天流可见
    let needFallback = false
    for (const m of toFlush) {
      let didQueueOk = false
      if (cid && !needFallback) {
        const res = await window.api.queueChat(cid, m.content, m.images)
        didQueueOk = res.ok
        if (!res.ok) needFallback = true
      }
      if (didQueueOk) {
        // queueChat 成功 → 两条：user bubble + inject-notice "已加入跟单队列"
        const ts = Date.now()
        const userMsg = createUserMessage({
          id: `inject-user-${ts}-${Math.random().toString(36).slice(2, 6)}`,
          content: m.content,
          images: m.images,
          fileAttachments: m.fileAttachments,
          timestamp: ts
        })
        const notice: ChatMessage = {
          id: `inject-notice-${ts}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: '↳ 已加入跟单队列',
          messageKind: 'inject-notice',
          messageSubtype: 'queue',
          timestamp: ts + 1
        }
        set(s => ({ messages: normalizeChatMessages([...s.messages, userMsg, notice]) }))
        debouncedSave(get)
      } else {
        // 降级 → sendMessage 自带 append + sendChat
        await sendMessage(m.content, role, m.images, m.fileAttachments)
      }
    }
  },

  insertVoiceMessages: async (transcripts, role) => {
    if (transcripts.length === 0) return
    await get().ensureConversation(role)
    const newMsgs: ChatMessage[] = transcripts.map((t, i) => createVoiceMessage({
      id: `voice-${Date.now()}-${i}`,
      role: t.role as 'user' | 'assistant',
      content: t.transcript,
      timestamp: Date.now() + i
    }))
    set(s => {
      const updated = normalizeChatMessages([...s.messages, ...newMsgs])
      debouncedSave(() => ({ ...s, messages: updated }))
      return { messages: updated }
    })
  },

  ensureVoiceConversation: async (role) => {
    await get().ensureConversation(role)
  },

  upsertVoiceMessage: (itemId, role, content, isFinal) => {
    set(s => {
      // 无 active conversation 时丢弃（边缘场景，理论上 ensureVoiceConversation 已在 startSession 跑过）
      if (!s.activeConversationId) return s

      const existingIdx = s.messages.findIndex(m => m.voiceItemId === itemId)
      let updated: ChatMessage[]

      if (existingIdx >= 0) {
        // 已存在：更新内容（content 替换，因为 OpenAI realtime 的 transcript delta 是增量但 done 是全量）
        updated = [...s.messages]
        updated[existingIdx] = {
          ...updated[existingIdx],
          content,
          voiceFinal: isFinal
        }
        // 通常这条还没落盘(idx >= persistedCount，纯粹是同一条尾部消息反复覆写)；但如果是
        // 已终态后又收到修正（罕见），idx 可能已经 < persistedCount，必须标脏防止 append 漏改
        markDirtyIfPersisted(existingIdx)
      } else {
        // 新建：按 itemId 作为稳定 id 前缀
        const newMsg: ChatMessage = {
          ...createVoiceMessage({
            id: `voice-${itemId}`,
            role,
            content,
            timestamp: Date.now()
          }),
          voiceItemId: itemId,
          voiceFinal: isFinal
        }
        updated = [...s.messages, newMsg]
      }

      // 只在终态时落盘，避免 delta 高频刷磁盘
      if (isFinal) {
        debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
      }
      return { messages: updated }
    })
  },

  // 删除某条语音消息（用于丢弃 ASR 幻觉的用户转录,如静音/噪声被转成"YOUTUBE.COM"等水印词）
  removeVoiceMessage: (itemId) => {
    set(s => {
      const idx = s.messages.findIndex(m => m.voiceItemId === itemId)
      if (idx < 0) return s
      const updated = s.messages.filter((_, i) => i !== idx)
      // 移除会导致其后所有下标整体前移——命中水位线之前时，append-only 的位置语义就此失真，必须全量
      markDirtyIfPersisted(idx)
      debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
      return { messages: updated }
    })
  },

  // 给某条语音消息挂上音频 WAV 路径（回听）。音频落盘是异步的，存好后回调挂路径并持久化。
  setVoiceMessageAudio: (itemId, audioPath) => {
    set(s => {
      const idx = s.messages.findIndex(m => m.voiceItemId === itemId)
      if (idx < 0) return s
      const updated = [...s.messages]
      updated[idx] = { ...updated[idx], audioPath }
      // 音频落盘异步完成后才回填 audioPath，此时这条语音消息通常早已落盘(idx < persistedCount)
      markDirtyIfPersisted(idx)
      debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
      return { messages: updated }
    })
  },

  // ---- 事件监听 ----

  setupListeners: () => {
    const cleanups = [
      window.api.onStreamChunk((cid: string, chunk: string) => {
        if (isBackgroundConversation(cid)) {
          bgStreamBufs.set(cid, (bgStreamBufs.get(cid) || '') + chunk)
          return
        }
        if (thinkBuf) {
          set({ isThinking: false })
        }
        streamBuf += chunk
        // NO_REPLY 静默回复:整段不展示给学生(避免出现"NO_REPLY: ..."闪现)
        // 节流写入(~66ms 合帧):下游 markdown+KaTeX 全量重解析从 O(chunk 数) 降到 O(帧数)；
        // 权威 streamBuf 本身不受影响,仍是每个 chunk 都同步累积。
        liveStream.setTextThrottled(isSilentReply(streamBuf) ? '' : streamBuf)
      }),

      // ─── Thinking: 直接作为消息存在，不再双轨渲染 ───
      // 每个 thinking 阶段在首个 chunk 时立即创建 ThinkingMessage，
      // 后续 chunk 原地更新。不需要 flush/merge 逻辑。
      window.api.onThinking?.((cid: string, content: string) => {
        if (isBackgroundConversation(cid)) return
        thinkBuf += content
        // 静默响应周期(由 task-trigger 触发):整个思考过程不上屏,但 thinkBuf 仍累积供 AI 上下文。
        // 这比 scheduler 的"end-时一次性 append"走得更远——后者仅解决持久化,我们同时屏蔽实时渲染。
        if (get().silentResponseCycle) return
        if (!activeThinkingId) {
          activeThinkingId = `think-${Date.now()}`
          set(s => ({
            messages: [...s.messages, createThinkingMessage({ id: activeThinkingId!, thinkingContent: thinkBuf, timestamp: Date.now() })],
            isThinking: true
          }))
        } else if (!thinkUpdateTimer) {
          // throttle 150ms — O(1) 查找（thinking 消息总是最近添加的）
          thinkUpdateTimer = setTimeout(() => {
            thinkUpdateTimer = null
            const id = activeThinkingId
            set(s => {
              const msgs = s.messages
              const last = msgs.length - 1
              const idx = (last >= 0 && msgs[last].id === id) ? last : msgs.findIndex(m => m.id === id)
              if (idx === -1) return s
              const updated = [...msgs]
              updated[idx] = { ...updated[idx], thinkingContent: thinkBuf }
              return { messages: updated }
            })
          }, 150)
        }
      }),

      window.api.onThinkingEnd?.((cid: string) => {
        if (isBackgroundConversation(cid)) return
        if (thinkUpdateTimer) { clearTimeout(thinkUpdateTimer); thinkUpdateTimer = null }
        if (activeThinkingId) {
          const id = activeThinkingId
          set(s => {
            const msgs = s.messages
            const last = msgs.length - 1
            const idx = (last >= 0 && msgs[last].id === id) ? last : msgs.findIndex(m => m.id === id)
            if (idx === -1) return { isThinking: false }
            const updated = [...msgs]
            updated[idx] = { ...updated[idx], thinkingContent: thinkBuf }
            return { messages: updated, isThinking: false }
          })
        } else {
          set({ isThinking: false })
        }
        // 只清 thinkBuf，保留 activeThinkingId 以吸收后端可能发来的重复内容
        // activeThinkingId 在下一个 phase boundary（tool_start / stream_end）才清除
        thinkBuf = ''
      }),

      window.api.onStreamEnd((cid: string, error?: string) => {
        const endedCid = cid || get().activeConversationId || ''
        const endWasAbort = endedCid
          ? abortedStreamConversationIds.delete(endedCid)
          : abortWithoutConversationId
        if (!endedCid) abortWithoutConversationId = false
        const isActiveConv = !cid || !isBackgroundConversation(cid)
        if (!isActiveConv) {
          // 非当前会话的 stream-end：后台缓冲文本**追加**落盘。此前是 get→replace 的读改写——
          // 快照读不经按会话写队列，会把并发中的后台工具/锚点 append 整个冲掉（评审 H1，
          // 数据丢失级）；append 走主进程 serializeWrite，物理上不可能覆盖别人。
          const bgText = bgStreamBufs.get(cid) || ''
          const terminalIncomplete = endWasAbort || !!error
          const textWrite = cid ? enqueueBackgroundTextFlush(cid, {
            final: true,
            messageKind: terminalIncomplete ? 'incomplete' : undefined,
            messageSubtype: error ? 'stream-error' : endWasAbort ? 'aborted' : undefined,
            syntheticError: error
          }) : null
          if (textWrite) {
            textWrite.then(() => {
              window.api.listConversations().then((list: ConversationSummary[]) => useChatStore.setState({ conversations: list }))
            }).catch((err: unknown) => console.warn('[chatStore] 后台回复落盘失败:', err))
          } else if (cid) {
            // 工具型回合可能全程无正文——列表的条数/时间也要刷新
            window.api.listConversations().then((list: ConversationSummary[]) => useChatStore.setState({ conversations: list })).catch(() => {})
          }
          if (cid) {
            flushPendingBackgroundToolEnds(cid)
            // 按会话登记表注销 + 挂"完成未读"红点；questions_v2 仍在等待用户回答，
            // 不能在 stream-end 当成过期暂存删掉（持久化配置与这个内存兜底都要保留）。
            bgPendingPermissions.delete(cid)
            if (!window.api.onTranscriptPersistenceRequest) clearBgAnchoredForCid(cid)
            // 静默回合（NO_REPLY/task-trigger）不挂红点——用户没有可看的东西（评审 L6）
            const silent = !error && bgText ? isSilentReply(bgText) : false
            useChatStore.setState(s => {
              const streaming = { ...s.streamingConvIds }
              delete streaming[cid]
              return {
                streamingConvIds: streaming,
                unreadDoneConvIds: silent ? s.unreadDoneConvIds : { ...s.unreadDoneConvIds, [cid]: true }
              }
            })
          }
          return
        }
        if (error) {
          const before = get().messages
          const finalized = failUnfinishedToolMessages(before, error)
          if (finalized !== before) {
            // 空工具锚点可能已被前一轮防抖保存落盘；就地改成失败态必须走全量 replace。
            markDirty()
            set({ messages: finalized })
          }
        }
        const remaining = streamBuf
        const mergedError = error ? mergeSyntheticStreamError(remaining, error) : null
        const terminalContent = mergedError?.content || remaining

        // NO_REPLY 静默回复:不持久化、不渲染,等同"AI 选择沉默"
        const silentSwallow = !error && remaining && isSilentReply(remaining)

        if (terminalContent && !silentSwallow) {
          set(s => {
            const updated = [...s.messages, createAssistantMessage({
              id: Date.now().toString(),
              content: terminalContent,
              messageKind: (endWasAbort || !!error) ? 'incomplete' : undefined,
              messageSubtype: error ? 'stream-error' : endWasAbort ? 'aborted' : undefined,
              syntheticErrorOffset: mergedError?.offset,
              timestamp: Date.now()
            })]
            debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
            return { messages: updated }
          })
        } else if (silentSwallow) {
          console.log('[Cave] 🤫 AI 静默回复:', remaining.substring(0, 80))
          // 注:silentResponseCycle 模式下 thinking 从未上屏,无需清孤儿卡片(替代了 retroactive cleanup)
        } else {
          debouncedSave(get)
        }
        streamBuf = ''
        resetThinkingState()
        // silentResponseCycle 在响应周期结束时复位,下一条普通消息恢复正常 thinking 渲染
        if (cid && !window.api.onTranscriptPersistenceRequest) clearBgAnchoredForCid(cid)
        set(s => {
          const streaming = { ...s.streamingConvIds }
          if (cid) delete streaming[cid]
          else if (s.activeConversationId) delete streaming[s.activeConversationId]
          return { isThinking: false, isStreaming: false, silentResponseCycle: false, streamingConvIds: streaming }
        })
        liveStream.reset()
        useVisualizerStore.getState().finalizeStreaming()
        // 自动 flush 挂起消息：仅在 agent 自然结束时触发；用户主动 abort 不动队列
        if (!endWasAbort && !error && get().pendingMessages.length > 0) {
          get().flushPendingOnTurnEnd(lastUsedRole).catch(err =>
            console.warn('[chatStore] flushPendingOnTurnEnd 失败:', err)
          )
        }
      }),

      // ─── TextFlush: phase boundary — 清除 thinking 跟踪 + flush 文本 ───
      window.api.onTextFlush((cid: string) => {
        if (isBackgroundConversation(cid)) {
          enqueueBackgroundTextFlush(cid, {
            messageKind: abortedStreamConversationIds.has(cid) ? 'incomplete' : undefined
          })?.catch((error: unknown) =>
            console.warn('[chatStore] 后台文本落盘失败:', error)
          )
          return
        }
        activeThinkingId = null
        thinkBuf = ''
        if (streamBuf) {
          // NO_REPLY 静默回复:同 onStreamEnd 处理,不 commit
          if (isSilentReply(streamBuf)) {
            console.log('[Cave] 🤫 静默 flush:', streamBuf.substring(0, 80))
            liveStream.setText('')
            streamBuf = ''
            return
          }
          const assistantMsg = createAssistantMessage({
            id: `flush-${Date.now()}`,
            content: streamBuf,
            timestamp: Date.now()
          })
          set(s => ({
            messages: [...s.messages, assistantMsg]
          }))
          liveStream.setText('')
          streamBuf = ''
        }
      }),

      // ─── ToolStart: phase boundary — 清除 thinking 跟踪 + flush 文本 ───
      window.api.onToolStart((cid: string, name: string, toolCallId?: string) => {
        if (isBackgroundConversation(cid)) {
          enqueueBackgroundTextFlush(cid, {
            messageKind: abortedStreamConversationIds.has(cid) ? 'incomplete' : undefined
          })?.catch((error: unknown) =>
            console.warn('[chatStore] 后台文本落盘失败:', error)
          )
          return
        }
        activeThinkingId = null
        thinkBuf = ''
        // NO_REPLY 静默回复:tool 触发前的待 flush 内容若是静默,丢弃不 commit
        const silentFlush = streamBuf && isSilentReply(streamBuf)
        if (silentFlush) {
          console.log('[Cave] 🤫 静默 flush(tool 前):', streamBuf.substring(0, 80))
        }
        const flushedAssistant = streamBuf && !silentFlush
          ? createAssistantMessage({
              id: `flush-${Date.now()}`,
              content: streamBuf,
              timestamp: Date.now()
            })
          : null
        const toolAnchor = createToolMessage({
          id: toolCallId ? `tool-${toolCallId}` : `tool-${Date.now()}`,
          toolName: name,
          toolCallId,
          timestamp: Date.now()
        })

        streamBuf = ''

        set(s => {
          const updated = [...s.messages]
          // 按事件到达顺序 append 到末尾(与 onThinking/onStreamEnd/onAskUser/questions_v2 等一致)。
          // 到 tool-start 时,本轮此前的 thinking(role:'assistant')、流式文字都已在数组里按时序排好,
          // 工具调用发生在它们之后 → 直接 push 即是正确时序。
          // 历史教训:曾用"插到最近一条 user 之后"的启发式,会把工具卡顶到 thinking 前面
          // (thinking role 不是 'user',被跳过)→ 搜索结果冒到推理上方。append 从构造上就不会错位。
          if (flushedAssistant) updated.push(flushedAssistant)
          updated.push(toolAnchor)
          debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
          return {
            messages: updated
          }
        })
        // tool 开始:清流式文字 + 切到工具指示(text='' / status=name / progress=0 / title='')
        liveStream.reset()
        liveStream.setToolStatus(name)
      }),

      window.api.onToolProgress?.((cid: string, _name: string, chars: number, path?: string) => {
        if (isBackgroundConversation(cid)) return
        liveStream.setToolProgress(chars, path)
      }),

      window.api.onToolEnd((
        cid: string, name: string,
        screenshot?: string, searchResults?: string, mcpResult?: string, mcpArgs?: string,
        visualizer?: { id: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number },
        toolCallId?: string,
        modelToolArgs?: string
      ) => {
        if (isBackgroundConversation(cid)) {
          // 后台会话的工具结果不再丢弃——直接落盘该会话（主进程按会话串行化写入，无竞态）。
          // 实案：用户切走时 create_artifact 的回执与 artifactRef 全被丢，产物落了盘却在 UI 隐形，
          // 且下一轮模型历史里丢失自己的工具结果。截图 base64 刻意不带（附件卸载管线只在活跃路径）。
          const msg = createToolMessage({
            id: `tool-bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: name,
            toolCallId,
            content: mcpResult || '',
            searchResults,
            toolArgs: mcpArgs,
            modelToolArgs: modelToolArgs || mcpArgs,
            timestamp: Date.now()
          })
          // 去重只在 toolCallId 存在时启用——无 id 时宁可偶发重复也不静默丢失（评审 M2）。
          // artifact 事件先到：在同一 cid 队列里 replace 那条锚点，保留 ref 并合并
          // args/result；不能只 continue，否则模型历史丢掉这次工具的完整轨迹。
          // tool_end 先到：create_artifact 暂缓到 artifact 事件，避免两条 append。
          const callKey = toolCallId ? `${cid}:${toolCallId}` : null
          if (callKey && bgAnchoredCalls.has(callKey)) {
            bgPendingArtifactToolEnds.set(callKey, msg)
            enqueueBackgroundPersistence(cid, () => replaceBackgroundArtifactToolEnd(cid, toolCallId!, msg))
              .then(() => bgPendingArtifactToolEnds.delete(callKey))
              .catch((err: unknown) => console.warn('[chatStore] 后台 artifact 工具结果合并失败:', err))
            return
          }
          if (callKey && name === 'create_artifact') {
            bgPendingArtifactToolEnds.set(callKey, msg)
            return
          }
          // 无可见载荷的非 artifact 工具消息与活跃路径同款剔除。
          if (!isRenderableToolMessage(msg)) return
          enqueueBackgroundPersistence(cid, async () => {
            const result = await window.api.appendMessages(cid, stripOffloadedInline(normalizeChatMessages([msg])))
            assertPersistenceSucceeded(result, 'append background tool message')
          }).catch((err: unknown) => console.warn('[chatStore] 后台工具消息落盘失败:', err))
          return
        }
        liveStream.setToolStatus(null)
        // create_artifact 结束但流式稿还挂着 = 门闩拒绝（成功路径 artifact 事件先到并 finalize）。
        // 丢弃残稿，避免重试首个空 delta 造成"预览原地擦除重播"
        if (name === 'create_artifact') {
          const artifactState = useArtifactStore.getState()
          if (artifactState.streamingArtifact) artifactState.discardStreaming()
        }
        // questions_v2 校验失败/execute 报错（isError）时不会走专属 onQuestionsV2 终态事件，
        // 只会落到这条通用 onToolEnd。streaming tab 会一直卡"生成问题中…"——丢弃残稿关掉僵尸 tab。
        if (name === 'questions_v2') {
          const artifactState = useArtifactStore.getState()
          if (artifactState.streamingArtifact?.type === 'questions') artifactState.discardStreaming()
        }
        let offloadScreenshotMsgId: string | null = null
        set(s => {
          const updated = [...s.messages]
          const pendingIndex = findLatestPendingToolIndex(updated, name, toolCallId)
          const targetIndex = pendingIndex >= 0 ? pendingIndex : findLatestToolIndex(updated, name)
          const existing = targetIndex >= 0 ? updated[targetIndex] : null
          const existingVisualizerHtml = existing?.visualizerHtml
          const existingVisualizerHeight = existing?.visualizerHeight
          const streamingVisualizer = name === 'create_visualizer' ? useVisualizerStore.getState().streamingVisualizer : null
          const finalVisualizer = name === 'create_visualizer' ? (visualizer || streamingVisualizer || null) : null

          const finalToolMessage = createToolMessage({
            id: existing?.id || `tool-${Date.now()}`,
            toolName: name,
            toolCallId: toolCallId || existing?.toolCallId,
            content: mcpResult || existing?.content || '',
            screenshot: screenshot || existing?.screenshot,
            searchResults: searchResults || existing?.searchResults,
            toolArgs: mcpArgs || existing?.toolArgs,
            modelToolArgs: modelToolArgs || existing?.modelToolArgs || mcpArgs || existing?.toolArgs,
            visualizerHtml: finalVisualizer?.content || existingVisualizerHtml,
            visualizerHeight: finalVisualizer?.height ?? existingVisualizerHeight,
            artifactRef: existing?.artifactRef,
            timestamp: existing?.timestamp || Date.now()
          })

          const hasVisiblePayload = isRenderableToolMessage(finalToolMessage)

          let persistedMessageId = finalToolMessage.id

          if (targetIndex >= 0) {
            // 按 index 就地覆写(或整条移除，会导致其后下标前移)——工具执行耗时较长时，
            // onToolStart 挂的占位早已被前一轮 debouncedSave 落盘，命中水位线之前须走全量 replace
            markDirtyIfPersisted(targetIndex)
            if (hasVisiblePayload || name === 'create_visualizer') {
              updated[targetIndex] = finalToolMessage
              persistedMessageId = finalToolMessage.id
              // 本事件带来的新截图且消息留在列表里 → 落盘前卸载到附件 sidecar
              if (screenshot && !finalToolMessage.screenshotRef) offloadScreenshotMsgId = finalToolMessage.id
            } else {
              updated.splice(targetIndex, 1)
            }
          } else if (hasVisiblePayload) {
            updated.push(finalToolMessage)
            if (screenshot && !finalToolMessage.screenshotRef) offloadScreenshotMsgId = finalToolMessage.id
          }

          if (name === 'create_visualizer' && finalVisualizer && (hasVisiblePayload || targetIndex >= 0)) {
            useVisualizerStore.getState().setVisualizer(persistedMessageId, {
              id: finalVisualizer.id || persistedMessageId,
              messageId: persistedMessageId,
              type: 'type' in finalVisualizer ? (finalVisualizer.type || 'html') : 'html',
              title: finalVisualizer.title || '',
              content: finalVisualizer.content || '',
              height: finalVisualizer.height,
              createdAt: Date.now()
            })
            useVisualizerStore.getState().finalizeStreaming()
          }

          debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
          return { messages: updated }
        })
        if (offloadScreenshotMsgId && screenshot) {
          offloadAttachment(get().activeConversationId, offloadScreenshotMsgId, 'screenshot', screenshot)
        }
      }),

      window.api.onAskUser((cid: string, question: string, options: { label: string; value: string }[], fields?: any[]) => {
        // ⚠️ 已知缺口（层次评审 2026-07-21）：老版 ask_user 的后台事件仍被丢弃——与已修的
        // questions_v2/权限暂存是同一类"agent 阻塞等输入→后台会话挂死"路径。design 主链路已迁
        // questions_v2,此处低频;若实测撞到,按 bgPendingQuestions 同款暂存+红点修。第 5 个需要
        // 后台处理的 handler 出现时,应抽统一的按会话事件路由表,不再逐个复制 if 分支。
        if (isBackgroundConversation(cid)) return
        // thinking 已作为消息存在，只 flush 文本
        const flushedAssistant = streamBuf
          ? createAssistantMessage({ id: `flush-${Date.now()}`, content: streamBuf, timestamp: Date.now() })
          : null
        streamBuf = ''
        flushActiveThinking()

        set(s => {
          const updated = [...s.messages]
          if (flushedAssistant) updated.push(flushedAssistant)
          updated.push(createAskUserMessage({ id: `ask-${Date.now()}`, question, options, fields, timestamp: Date.now() }))
          debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
          return { messages: updated, isStreaming: false }
        })
        liveStream.reset()
      }),

      // questions_v2 整页问答 —— 作为 artifact 走工作台管道（useArtifactWorkspaceBridge 自动开 tab）
      // pendingQuestionsV2 仅保留 conversationId + artifactId，供 submitQuestionsV2 回填和关闭 tab
      (window.api as any).onQuestionsV2?.((cid: string, title: string, questions: any[]) => {
        const trackedCid = cid || get().activeConversationId || ''
        void trackConversationAsync(trackedCid, async () => {
        if (isBackgroundConversation(cid)) {
          // 后台会话的问答页：与活跃路径同款写入 pending 配置 + 轻量锚点，暂存答题状态
          // 供切回恢复；红点提示"需要你输入"。此前直接丢弃 → agent 阻塞等答案 = 会话挂死实案。
          const artifactId = `questions-${Date.now()}`
          const pending: PendingQuestion = { title: title || '', questions, conversationId: cid, artifactId }
          const contentStr = JSON.stringify({ title, questions })
          const config = withPendingQuestionConfig(
            get().conversations.find(c => c.id === cid)?.config,
            pending
          )
          set(s => ({ conversations: s.conversations.map(c => c.id === cid ? { ...c, config } : c) }))
          const configResult = await window.api.updateConversationConfig(cid, config)
          assertPersistenceSucceeded(configResult, 'persist background questions pending config')
          void enqueueBackgroundPersistence(cid, () => appendBgArtifactAnchor(
            cid,
            { id: artifactId, type: 'questions', title: title || '', content: contentStr },
            undefined,
            title ? `问答页: ${title}` : '问答页'
          )).catch((err: unknown) => console.warn('[questions_v2] persist background anchor failed:', err))
          bgPendingQuestions.set(cid, pending)
          useChatStore.setState(s => ({ unreadDoneConvIds: { ...s.unreadDoneConvIds, [cid]: true } }))
          return
        }
        const flushedAssistant = streamBuf
          ? createAssistantMessage({ id: `flush-${Date.now()}`, content: streamBuf, timestamp: Date.now() })
          : null
        streamBuf = ''
        flushActiveThinking()

        // 流式预览稿收尾:丢弃 streamingArtifact(桥接会关掉临时 streaming tab),
        // 随后 addArtifact 以真实 id 开定稿 tab。终态语义(pendingQuestionsV2 + loop break)不变。
        const artStore = useArtifactStore.getState()
        if (artStore.streamingArtifact) artStore.discardStreaming()

        const artifactId = `questions-${Date.now()}`
        const contentStr = JSON.stringify({ title, questions })
        const questionCid = cid || get().activeConversationId || ''
        const pending: PendingQuestion = {
          title: title || '',
          questions,
          conversationId: questionCid,
          artifactId
        }
        // 先写待答状态，再注入 artifact。此前 saveArtifact 的 await 让 tab 先渲染，
        // 此时 pending 还是 null，于是 QuestionsArtifactView 会闪成“问答已提交”。
        const config = withPendingQuestionConfig(get().conversationConfig, pending)
        set(s => ({
          pendingQuestionsV2: pending,
          conversationConfig: s.activeConversationId === questionCid ? config : s.conversationConfig,
          conversations: s.conversations.map(c => c.id === questionCid ? { ...c, config } : c)
        }))
        if (questionCid) {
          const configResult = await window.api.updateConversationConfig(questionCid, config)
          assertPersistenceSucceeded(configResult, 'persist active questions pending config')
        }

        // 作为 artifact 注入——复用 artifact → workspace tab 的统一管道
        useArtifactStore.getState().addArtifact({
          id: artifactId,
          type: 'questions',
          title: title || rendererI18n.t('chat.questions.defaultTitle'),
          ...(!title ? { titleKey: 'chat.questions.defaultTitle' } : {}),
          content: contentStr,
          messageId: '',
          createdAt: Date.now()
        })

        // 生成轻量 artifactRef + tool 锚点。questions 的 saveArtifact 在主进程只返回空 path，
        // 不会落题目 sidecar；切换/重启时由 pendingQuestion 恢复 UI。
        let artifactRef: any = null
        const saveApi = (window.api as any).saveArtifact
        if (saveApi) {
          const result = await saveApi(questionCid, { id: artifactId, type: 'questions', title: title || '', content: contentStr })
          assertArtifactPersistenceSucceeded(result, 'persist active questions anchor metadata')
          artifactRef = result.ref
        }

        set(s => {
          const updated = [...s.messages]
          if (flushedAssistant) updated.push(flushedAssistant)
          // 记录一条 tool anchor，以便切回会话时据此 rehydrate
          updated.push(createToolMessage({
            id: `tool-${artifactId}`,
            toolName: 'questions_v2',
            questionsV2Version: QUESTIONS_V2_PERSISTENCE_VERSION,
            content: title ? `问答页: ${title}` : '问答页',
            artifactRef: artifactRef || undefined,
            timestamp: Date.now()
          }))
          debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
          return {
            messages: updated,
            isStreaming: false
          }
        })
        liveStream.reset()
        }).catch((error: unknown) => console.warn('[questions_v2] async event failed:', error))
      }),

      // 内联权限请求事件
      window.api.onPermissionRequestInline?.((request: PermissionRequestData) => {
        // 主进程载荷带 conversationId（渲染层类型未声明）：后台会话的权限请求暂存归位，
        // 绝不打进当前会话（此前会串进活跃会话消息流）；红点提示"需要你输入"。
        const reqCid = (request as any).conversationId as string | undefined
        if (reqCid && isBackgroundConversation(reqCid)) {
          bgPendingPermissions.set(reqCid, [...(bgPendingPermissions.get(reqCid) || []), request])
          useChatStore.setState(s => ({ unreadDoneConvIds: { ...s.unreadDoneConvIds, [reqCid]: true } }))
          return
        }
        const flushedAssistant = streamBuf
          ? createAssistantMessage({ id: `flush-${Date.now()}`, content: streamBuf, timestamp: Date.now() })
          : null
        streamBuf = ''
        flushActiveThinking()

        set(s => {
          const updated = [...s.messages]
          if (flushedAssistant) updated.push(flushedAssistant)
          updated.push(createPermissionRequestMessage({
            id: `perm-${request.requestId}`, permissionRequest: request, permissionStatus: 'pending', timestamp: Date.now()
          }))
          debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
          return { messages: updated }
        })
        liveStream.setText('')
      }),
    ]

    // Desktop only: force the exact conversation transcript to disk (or wait
    // for its background write chain) before main releases the runtime lease.
    // Browser and older test shims omit this optional capability.
    if (window.api.onTranscriptPersistenceRequest) {
      cleanups.push(window.api.onTranscriptPersistenceRequest(async (cid: string) => {
        await flushTranscriptPersistence(cid)
      }))
    }

    // Artifact 流式 delta 事件
    if ((window.api as any).onArtifactDelta) {
      cleanups.push(
        (window.api as any).onArtifactDelta((cid: string, data: { id: string; title?: string; artifactType?: string; delta?: string; offset?: number; content?: string }) => {
          if (isBackgroundConversation(cid)) return
          // delta+offset 位置式重组(生产端 O(n) 增量协议):offset=0 即重放/新流,天然覆盖重置
          if (typeof data.offset !== 'number' || typeof data.delta !== 'string') {
            // 旧形状兜底({content} 全量):协议不匹配时降级为全量替换,绝不静默吞内容
            if (typeof data.content === 'string') artifactDeltaAcc = data.content
            else console.warn('[artifact_delta] 未知 payload 形状,已忽略:', Object.keys(data || {}))
          } else {
            if (data.offset > artifactDeltaAcc.length) console.warn('[artifact_delta] offset 跳空:', data.offset, '>', artifactDeltaAcc.length)
            artifactDeltaAcc = artifactDeltaAcc.slice(0, data.offset) + (data.delta || '')
          }
          const store = useArtifactStore.getState()
          if (!store.streamingArtifact) {
            store.startStreaming(data.id, data.artifactType, data.title)
          } else {
            store.updateStreaming(data.title, data.artifactType, artifactDeltaAcc)
          }
          if (data.title) liveStream.setToolStreamingTitle(data.title)
        })
      )
    }

    // 通用 artifact 状态广播 — goal/非流式 artifact 状态更新走这条
    // payload.removed=true 时从 artifactStore 移除;否则 upsert
    if ((window.api as any).onArtifactUpdate) {
      cleanups.push(
        (window.api as any).onArtifactUpdate((cid: string, artifact: any) => {
          if (isBackgroundConversation(cid)) return
          const store = useArtifactStore.getState()
          if (artifact?.removed || shouldDismissTodosArtifact(artifact)) {
            dismissArtifactFromWorkspace(artifact.id)
            return
          }
          store.addArtifact({
            id: artifact.id,
            type: artifact.type as any,
            title: artifact.title,
            content: artifact.content,
            messageId: 'artifact-system',
            createdAt: Date.now()
          })
        })
      )
    }

    // Artifact 完成事件
    if (window.api.onArtifact) {
      cleanups.push(
        window.api.onArtifact((cid: string, artifact: any, toolCallId?: string) => {
          const trackedCid = cid || get().activeConversationId || ''
          const backgroundEvent = isBackgroundConversation(cid)
          const durableEvent = !['todos', 'questions', 'goal', 'mcp-app'].includes(artifact?.type)
          const eventCallKey = toolCallId ? `${cid}:${toolCallId}` : null
          // Remember a durable artifact event even while active. If navigation
          // begins between artifact and tool_end, the latter is routed to the
          // background lane and must still update/skip this same logical call.
          if (!backgroundEvent && durableEvent && eventCallKey) bgAnchoredCalls.add(eventCallKey)
          void trackConversationAsync(trackedCid, async () => {
          if (backgroundEvent) {
            // 后台会话的产物锚点必须落盘，否则切回/重启后 rehydrate 找不到指针（产物隐形实案）。
            // 过程态类型（todos/questions 等）不落锚——它们本就不进历史产物清单。
            if (['todos', 'questions', 'goal', 'mcp-app'].includes(artifact?.type)) return
            const dedupKey = toolCallId ? `${cid}:${toolCallId}` : null
            if (dedupKey && bgAnchoredCalls.has(dedupKey)) return
            if (dedupKey) bgAnchoredCalls.add(dedupKey) // 同步登记：tool_end 紧随其后，不能等 await
            void enqueueBackgroundPersistence(cid, () => appendBgArtifactAnchor(cid, {
              id: artifact.id, type: artifact.type, title: artifact.title,
              content: artifact.content, language: artifact.language
            }, toolCallId, `已创建: ${artifact.title || artifact.id} (id: ${artifact.id})`)).catch(() => {
              // 锚点失败必须撤销去重登记，否则 tool_end 的兜底也被吞掉 → 这次调用从历史里彻底消失（评审 M1）
              if (dedupKey) bgAnchoredCalls.delete(dedupKey)
            })
            return
          }
          const store = useArtifactStore.getState()
          const finalArtifact = {
            ...artifact,
            type: artifact.type as any,
            messageId: `artifact-msg-${Date.now()}`,
            createdAt: Date.now()
          }
          // todos 是临时工作面板：全部完成（或显式清空）后从 Artifacts 与 tab 退场。
          // tool_end 已先把本次 update_todos 摘要写进对话，故这里不会丢历史记录。
          if (shouldDismissTodosArtifact(finalArtifact)) {
            if (store.streamingArtifact?.id === finalArtifact.id) store.discardStreaming()
            dismissArtifactFromWorkspace(finalArtifact.id)
            return
          }
          // 如果正在流式生成，用 finalize 替换；否则直接 add
          if (store.streamingArtifact) {
            store.finalizeStreaming(finalArtifact)
          } else {
            store.addArtifact(finalArtifact)
          }
          // 落盘 sidecar 文件 + 给最近 create_artifact tool 消息挂 ref
          let artifactRef: any = null
          const saveApi = (window.api as any).saveArtifact
          if (durableEvent && !saveApi) throw new Error('save active artifact sidecar is unavailable')
          if (saveApi) {
            const result = await saveApi(cid, {
              id: finalArtifact.id,
              type: finalArtifact.type,
              title: finalArtifact.title,
              content: finalArtifact.content,
              language: (finalArtifact as any).language
            })
            if (durableEvent) {
              assertArtifactPersistenceSucceeded(result, 'save active artifact sidecar', { requireRef: true })
            }
            if (result?.ok && result.ref) artifactRef = result.ref
          }

          const durableAnchor = !['todos', 'questions', 'goal', 'mcp-app'].includes(finalArtifact.type)
          if (!durableAnchor) return
          const transitionToolEnd = eventCallKey ? bgPendingArtifactToolEnds.get(eventCallKey) : undefined
          set(s => {
            const updated = [...s.messages]
            let foundIdx = -1
            for (let i = updated.length - 1; i >= 0; i--) {
              const exactCall = toolCallId ? updated[i].toolCallId === toolCallId : true
              if (exactCall && updated[i].toolName === 'create_artifact') {
                foundIdx = i
                break
              }
            }
            const anchorContent = `已创建: ${finalArtifact.title || finalArtifact.id} (id: ${finalArtifact.id})`
            if (foundIdx >= 0) {
              updated[foundIdx] = {
                ...updated[foundIdx],
                content: transitionToolEnd?.content || updated[foundIdx].content || anchorContent,
                searchResults: transitionToolEnd?.searchResults || updated[foundIdx].searchResults,
                toolArgs: transitionToolEnd?.toolArgs || updated[foundIdx].toolArgs,
                modelToolArgs: transitionToolEnd?.modelToolArgs || updated[foundIdx].modelToolArgs,
                ...(artifactRef ? { artifactRef } : {})
              }
              // 锚点可能已由 tool_start/tool_end 落盘；异步 ref 必须 replace 同一条。
              markDirtyIfPersisted(foundIdx)
            } else if (toolCallId) {
              updated.push(createToolMessage({
                id: `tool-${toolCallId}`,
                toolName: 'create_artifact',
                toolCallId,
                content: anchorContent,
                artifactRef: artifactRef || undefined,
                timestamp: Date.now()
              }))
            }
            debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
            return { messages: updated }
          })
          if (eventCallKey) bgPendingArtifactToolEnds.delete(eventCallKey)
          }).catch((error: unknown) => console.warn('[artifact] async event failed:', error))
        })
      )
    }

    // questions_v2 流式 delta 事件 —— 复用 artifactStore streaming 机制,
    // QuestionsV2Panel 渐进渲染(已成型的问题先显示)。终态 onQuestionsV2 收尾会 discardStreaming。
    if ((window.api as any).onQuestionsV2Delta) {
      cleanups.push(
        (window.api as any).onQuestionsV2Delta((cid: string, data: { id: string; title?: string; questions: any[] }) => {
          if (isBackgroundConversation(cid)) return
          const store = useArtifactStore.getState()
          const title = data.title || rendererI18n.t('chat.questions.defaultTitle')
          const contentStr = JSON.stringify({ title: data.title || '', questions: data.questions || [] })
          if (!store.streamingArtifact) {
            store.startStreaming(
              data.id,
              'questions',
              title,
              !data.title ? 'chat.questions.defaultTitle' : undefined
            )
          }
          store.updateStreaming(title, 'questions', contentStr)
          liveStream.setToolStreamingTitle(title)
        })
      )
    }

    // Visualizer 流式 delta 事件
    if ((window.api as any).onVisualizerDelta) {
      cleanups.push(
        (window.api as any).onVisualizerDelta((cid: string, data: { id: string; title?: string; delta?: string; offset?: number; content?: string; height?: number }) => {
          if (isBackgroundConversation(cid)) return
          if (typeof data.offset !== 'number' || typeof data.delta !== 'string') {
            if (typeof data.content === 'string') visualizerDeltaAcc = data.content
            else console.warn('[visualizer_delta] 未知 payload 形状,已忽略:', Object.keys(data || {}))
          } else {
            if (data.offset > visualizerDeltaAcc.length) console.warn('[visualizer_delta] offset 跳空:', data.offset, '>', visualizerDeltaAcc.length)
            visualizerDeltaAcc = visualizerDeltaAcc.slice(0, data.offset) + (data.delta || '')
          }
          const store = useVisualizerStore.getState()
          if (!store.streamingVisualizer) {
            store.startStreaming(data.id, data.title, data.height)
          } else {
            store.updateStreaming(data.title, visualizerDeltaAcc, data.height)
          }
          if (data.title) liveStream.setToolStreamingTitle(data.title)
        })
      )
    }

    // Visualizer 完成事件
    if (window.api.onVisualizer) {
      cleanups.push(
        window.api.onVisualizer((cid: string, visualizer: any) => {
          if (isBackgroundConversation(cid)) return
          set(s => {
            const toolIndex = findLatestVisualizerToolIndex(s.messages)
            if (toolIndex === -1) return s

            const target = s.messages[toolIndex]
            if (target.visualizerHtml === visualizer.content && target.visualizerHeight === visualizer.height) {
              return s
            }

            const updated = [...s.messages]
            updated[toolIndex] = normalizeChatMessage({
              ...target,
              visualizerHtml: visualizer.content || target.visualizerHtml,
              visualizerHeight: visualizer.height ?? target.visualizerHeight
            })
            // 就地覆写已有 tool 消息的 visualizer 内容——命中水位线之前时必须走全量 replace
            markDirtyIfPersisted(toolIndex)

            useVisualizerStore.getState().setVisualizer(target.id, {
              id: visualizer.id || target.id,
              messageId: target.id,
              type: visualizer.type || 'html',
              title: visualizer.title || '',
              content: visualizer.content || '',
              height: visualizer.height,
              createdAt: Date.now()
            })

            useVisualizerStore.getState().finalizeStreaming()
            debouncedSave(() => ({ ...s, messages: updated, activeConversationId: s.activeConversationId }))
            return { messages: updated }
          })
        })
      )
    }

    // MCP App inline 渲染事件 — 推一条独立的 'mcp_app_render' 消息到 messages 末尾。
    // 这样它一定排在权限确认 / 其它中间消息之后,顺序自然:工具调用 → 权限确认 → 渲染结果
    if ((window.api as any).onMcpAppInline) {
      cleanups.push(
        (window.api as any).onMcpAppInline((cid: string, data: { messageId: string; payload: any }) => {
          if (isBackgroundConversation(cid)) return
          const renderMsgId = `mcp-app-render-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          set(s => {
            const renderMsg: any = {
              id: renderMsgId,
              role: 'tool',
              toolName: 'mcp_app_render',
              content: '',
              mcpAppPayload: data.payload,
              timestamp: Date.now()
            }
            const messages = [...s.messages, normalizeChatMessage(renderMsg)]
            debouncedSave(() => ({ ...s, messages, activeConversationId: s.activeConversationId }))
            return { messages }
          })
          // payload 动辄 MB 级(iframe html + contentBlocks)——卸载到附件 sidecar，落盘只留 ref
          try {
            offloadAttachment(get().activeConversationId, renderMsgId, 'mcpapp', JSON.stringify(data.payload))
          } catch { /* 序列化失败保持内联 */ }
        })
      )
    }

    // 对话标题更新事件
    if (window.api.onTitleUpdated) {
      cleanups.push(
        window.api.onTitleUpdated((id: string, title: string) => {
          // Keep the title responsive, then replace the whole summary from the
          // durable source. messageCount/bindings may have changed alongside
          // the title and must not remain stale in sentinel classification.
          set(s => ({
            conversations: s.conversations.map(c =>
              c.id === id ? { ...c, title } : c
            )
          }))
          void refreshConversationSummaries(
            () => window.api.listConversations(),
            list => set({ conversations: list }),
          ).catch((err: unknown) => console.warn('[chatStore] 标题更新后对话列表刷新失败:', err))
        })
      )
    }

    // 任务执行通知 — 刷新会话列表让新建的对话可见
    if (window.api.onTaskExecuted) {
      cleanups.push(
        window.api.onTaskExecuted(() => {
          window.api.listConversations().then((list: ConversationSummary[]) => {
            set({ conversations: list })
          })
        })
      )
    }

    // 记忆更新事件
    if (window.api.onMemoryUpdated) {
      cleanups.push(
        window.api.onMemoryUpdated((event: Omit<MemoryNotification, 'timestamp'>) => {
          const ts = Date.now()
          set({ memoryNotification: { ...event, timestamp: ts } })
          setTimeout(() => {
            set(s => s.memoryNotification?.timestamp === ts ? { memoryNotification: null } : {})
          }, 8000)
        })
      )
    }

    // 权限审批事件监听（Electron 环境才有）
    if (window.api.onPermissionRequest) {
      cleanups.push(
        window.api.onPermissionRequest((request: PermissionRequestData) => {
          set({ pendingPermission: request })
        })
      )
    }

    // 上下文用量圆环/信息卡——按 conversationId 存最新一次用量与累计命中统计，不清理历史条目（体量小）
    if ((window.api as any).onContextUsage) {
      cleanups.push(
        (window.api as any).onContextUsage((cid: string, data: ContextUsageEntry) => {
          if (!cid) return
          let statsSnapshot: ContextCumulativeStats | undefined
          set(s => {
            const prev = s.contextStats[cid] || { input: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
            const usage = data.usage || { input: 0, cacheRead: 0, cacheWrite: 0 }
            const nextStats = {
              input: prev.input + (usage.input || 0),
              cacheRead: prev.cacheRead + (usage.cacheRead || 0),
              cacheWrite: prev.cacheWrite + (usage.cacheWrite || 0),
              calls: prev.calls + 1
            }
            statsSnapshot = nextStats
            return {
              contextUsage: { ...s.contextUsage, [cid]: data },
              contextStats: { ...s.contextStats, [cid]: nextStats }
            }
          })
          // 随会话落盘（去抖 2s）：重开应用/切回旧会话时圆环直接显示上次读数，
          // 不必先发一条消息。写失败不影响对话（纯展示数据）。
          scheduleContextUsagePersist(cid, data, () => statsSnapshot)
        })
      )
    }

    // runtime-context 快照落盘：紧跟本轮末条用户消息之后插入/替换隐藏消息。
    // 落盘副本与主进程实发字节一致 → 下轮回放命中前缀缓存（见 pi-agent-service 注释）。
    // regenerate 重跑同一轮时，事件会再发一次——替换旧快照而不是追加，防止纸条堆积。
    if ((window.api as any).onRuntimeContext) {
      cleanups.push(
        (window.api as any).onRuntimeContext((cid: string, text: string) => {
          if (!cid || !text) return
          set(s => {
            if (s.activeConversationId !== cid) return s
            const messages = [...s.messages]
            // 找末条用户消息（跳过其后的既有 runtime-context 快照）
            let lastUserIdx = -1
            for (let i = messages.length - 1; i >= 0; i--) {
              const kind = getMessageKind(messages[i] as any)
              if (kind === 'runtime-context') continue
              if (kind === 'user') { lastUserIdx = i; break }
              // 用户消息之后已有 AI 回复落进本地数组（事件迟到时）——快照仍插在用户消息后
              break
            }
            if (lastUserIdx < 0) return s
            const snapshot: ChatMessage = {
              ...createUserMessage({
                id: `rc-${messages[lastUserIdx].id || Date.now()}`,
                content: text,
                timestamp: Date.now(),
                messageKind: 'runtime-context'
              })
            }
            const insertAt = lastUserIdx + 1
            const existing = messages[insertAt]
            const next =
              existing && getMessageKind(existing as any) === 'runtime-context'
                ? [...messages.slice(0, insertAt), snapshot, ...messages.slice(insertAt + 1)]
                : [...messages.slice(0, insertAt), snapshot, ...messages.slice(insertAt)]
            // 在已落盘区间内插行/换行：水位线语义被破坏，下次落盘走全量 replace
            markDirtyIfPersisted(insertAt)
            return { messages: normalizeChatMessages(next) }
          })
        })
      )
    }

    return () => {
      cleanups.forEach(fn => { if (typeof fn === 'function') fn() })
      clearContextUsagePersistTimers()
      resetThinkingState()
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    }
  },
}))

// 暴露给 E2E 测试 —— 让测试能直接调 chatStore action（绕开 audio/麦克风权限链路）
// 仅在 renderer dev server / 测试环境下挂载；生产 packaged 应用不影响
if (typeof window !== 'undefined') {
  ;(window as any).__chatStore = useChatStore
}
