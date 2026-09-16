/**
 * 跨会话（所有者 2026-09-16）：一条对话里的 AI 能看到这台机器上的其他单对话——列出来、读记录、发消息过去。
 * 多线程任务要互通进展时用（"问问那边做到哪了""把结论抄给另一条"）。
 *
 * 边界：
 *   - 团队话题不在范围（不列、不读、不发）——团队内部的协作走交接（subagent + pal），有自己的边界与预算。
 *   - 只经会话存储 API，不碰会话文件（pi-security 把读别的会话文件判为 risky，这条路不走文件）。
 *   - send 的对方在**它自己的对话**里跑一轮（照搬定时任务的无头跑法：source='scheduler'，没有 ask_user /
 *     截图这类要人在场的工具），回复带回给发送方；对方正忙就排到它这轮之后、立即返回"已排队"。
 *   - 乒乓保护：消息带跳数，超过 PEER_MAX_HOPS 就拒发——两条对话互相触发不会无限跑（能力拐杖，见 mechanism-registry）。
 *
 * 不新造 IPC 前缀：对方跑完只发一个 conv:peer-turn 让界面刷新 / 点亮未读；消息落盘走 appendMessages（与定时任务同一条路）。
 */
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import {
  appendMessages, beginConversationOperation, finishConversationOperation, getConversation,
  getConversationMessagesSerialized, listConversationsCached, shouldReplayStoredMessage,
  type ConversationSummary, type StoredMessage
} from './conversation-service'
import { acquireConversationExecution, getConversationExecution } from './conversation-execution-coordinator'
import { resolveAgentOverrides } from './agent-overrides'
import type { AgentOverrides, ChatMessage, OpenPipalAgentRuntime } from './agent-runtime/contracts'
import { createTranscriptCollector, hookNoticeToStoredMessage } from './pi-event-adapter'
import { getAgent } from './agent-registry'
import { PEER_MESSAGE_KIND, composePeerMessage } from '../shared/peer-message-contract'

export { PEER_MESSAGE_KIND }
/** 对话之间最多来回几跳（A→B 是 1 跳，B 在回复里再 send 给 C 是 2 跳…） */
export const PEER_MAX_HOPS = 4
/** 发送方等对方回复的上限；超过就放弃这次等待（对方那轮会被中止，不落盘） */
export const PEER_REPLY_TIMEOUT_MS = 5 * 60_000
/** 对方正忙时排队送达的上限：忙完就轮到它，但不会无限期挂着 */
const QUEUED_DELIVERY_TIMEOUT_MS = 30 * 60_000
const LIST_LIMIT = 40
const READ_DEFAULT_LIMIT = 30
const READ_MESSAGE_CHARS = 1200
const READ_TOOL_CHARS = 160

// ---- 跳数：只在进程内记，跟着"由 peer 触发的那一轮"活 ----
const inboundHops = new Map<string, number>()
/** 这条对话当前这一轮是被别的对话发消息触发的第几跳（用户自己发起的对话 = 0） */
export function peerHopsOf(conversationId: string): number {
  return inboundHops.get(conversationId) ?? 0
}

// ---- 运行时接入：由入口（ipc-handlers）注入，这个模块不 import agent-runtime 索引——
// 产品工具在 pi-core 的源码图里，索引会把 legacy 运行时（pi-coding-agent）整条拖进来（agent-runtime-boundary 测试钉着） ----
let runtimeGetter: (() => Promise<Pick<OpenPipalAgentRuntime, 'agentChat'>>) | null = null
export function setPeerRuntime(getter: () => Promise<Pick<OpenPipalAgentRuntime, 'agentChat'>>): void {
  runtimeGetter = getter
}

// ---- 界面通知 ----
let windowGetter: (() => BrowserWindow | null) | null = null
export function setPeerTurnWindowGetter(getter: () => BrowserWindow | null): void {
  windowGetter = getter
}
function notifyPeerTurn(conversationId: string, from: string): void {
  const win = windowGetter?.()
  if (win && !win.isDestroyed()) win.webContents.send('conv:peer-turn', conversationId, from)
}

// ---- 展示辅助 ----
function agentLabel(summary: Pick<ConversationSummary, 'workspaceId' | 'agent' | 'role'>): string {
  return getAgent(summary.workspaceId ?? summary.agent ?? summary.role)?.name ?? summary.role
}
function conversationLabel(summary: ConversationSummary | undefined, fallbackId: string): string {
  return summary ? `「${summary.title}」（${agentLabel(summary)}）` : `对话 ${fallbackId.slice(0, 8)}`
}
function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 与 scheduler.storedMessageToChatMessage 同一口径（那边是私有函数；这里是同一件事的另一条无头入口） */
function storedToChat(message: StoredMessage): ChatMessage {
  if (message.role === 'tool') {
    return { id: message.id, role: 'tool', content: message.content, toolName: message.toolName, toolCallId: message.toolCallId, toolArgs: message.modelToolArgs ?? message.toolArgs }
  }
  return {
    id: message.id, role: message.role, content: message.content, messageKind: message.messageKind,
    screenshot: message.screenshot, screenshotRef: message.screenshotRef, images: message.images, imagePaths: message.imagePaths, fileAttachments: message.fileAttachments
  }
}

// ---- list ----
export interface PeerConversation {
  id: string
  title: string
  agent: string
  updatedAt: number
  messageCount: number
  busy: boolean
  self: boolean
}

/** 其他单对话（团队话题一律不出现），最近更新的在前 */
export function listPeerConversations(selfId?: string, limit = LIST_LIMIT): PeerConversation[] {
  return listConversationsCached()
    .filter(c => !c.teamId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map(c => ({
      id: c.id, title: c.title, agent: agentLabel(c), updatedAt: c.updatedAt, messageCount: c.messageCount,
      busy: !!getConversationExecution(c.id), self: c.id === selfId
    }))
}

export function formatPeerList(items: PeerConversation[]): string {
  if (items.length === 0) return '这台机器上还没有别的对话。'
  return items.map(c =>
    `- ${c.id} · ${c.title} · ${c.agent} · ${formatTime(c.updatedAt)} · ${c.messageCount} 条${c.busy ? ' · 正在运行' : ''}${c.self ? ' · （当前对话）' : ''}`
  ).join('\n')
}

// ---- read ----
type PeerResult<T> = ({ ok: true } & T) | { ok: false; error: string }

async function peerTarget(conversationId: string): Promise<PeerResult<{ conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>> }>> {
  const conversation = await getConversation(conversationId)
  if (!conversation) return { ok: false, error: `对话 ${conversationId} 不存在（用 list 看有哪些）` }
  if (conversation.teamId) return { ok: false, error: '团队话题不在跨会话范围里' }
  return { ok: true, conversation }
}

/** 读一条对话最近的记录：用户 / 助手的文字照录（截断），工具调用压成一行 */
export async function readPeerConversation(conversationId: string, limit = READ_DEFAULT_LIMIT): Promise<PeerResult<{ text: string }>> {
  const target = await peerTarget(conversationId)
  if (!target.ok) return target
  const { conversation } = target
  const summary = listConversationsCached().find(c => c.id === conversationId)
  const label = agentLabel(summary ?? conversation)
  const all = (await getConversationMessagesSerialized(conversationId))
    .filter(shouldReplayStoredMessage)
    .filter(m => m.messageKind !== 'runtime-context')
  const shown = all.slice(-Math.max(1, Math.min(limit, 200)))
  const lines = shown.map(m => {
    if (m.role === 'tool') return `[工具 ${m.toolName ?? '?'}] ${clip(m.content, READ_TOOL_CHARS)}`
    if (m.role === 'assistant') return `[${label}] ${clip(m.content, READ_MESSAGE_CHARS)}`
    const who = m.messageKind === PEER_MESSAGE_KIND ? '来自其他对话' : m.messageKind === 'task-trigger' ? '任务触发' : '用户'
    return `[${who}] ${clip(m.content, READ_MESSAGE_CHARS)}`
  })
  const header = `「${conversation.title}」· ${label} · 更新于 ${formatTime(conversation.updatedAt)} · 共 ${all.length} 条${getConversationExecution(conversationId) ? ' · 正在运行' : ''}`
  const body = lines.length ? lines.join('\n') : '（还没有消息）'
  return { ok: true, text: `${header}\n--- 最近 ${shown.length} 条 ---\n${body}` }
}

// ---- send ----
export type SendPeerResult =
  | { status: 'replied'; reply: string }
  | { status: 'queued' }
  | { status: 'error'; error: string }

export interface SendPeerOptions {
  fromConversationId: string
  toConversationId: string
  text: string
  /** 发送方那条工具调用的 signal：发送方被中止，等待也一起停 */
  signal?: AbortSignal
}

/**
 * 发消息到另一条对话：对方空闲 → 在它那边跑一轮、等回复（最长 PEER_REPLY_TIMEOUT_MS）；
 * 对方正忙 → 排到它这轮之后送达，立即返回 queued（结果之后用 read 看）。
 */
export async function sendPeerMessage(options: SendPeerOptions): Promise<SendPeerResult> {
  const { fromConversationId, toConversationId, text } = options
  if (!text.trim()) return { status: 'error', error: '消息内容是空的' }
  if (toConversationId === fromConversationId) return { status: 'error', error: '不能发给当前对话自己' }
  const target = await peerTarget(toConversationId)
  if (!target.ok) return { status: 'error', error: target.error }
  const hops = peerHopsOf(fromConversationId) + 1
  if (hops > PEER_MAX_HOPS) {
    return { status: 'error', error: `对话之间已经来回 ${PEER_MAX_HOPS} 跳，停止转发（避免两条对话互相无限触发）。要继续请让用户来推动。` }
  }
  const fromLabel = conversationLabel(listConversationsCached().find(c => c.id === fromConversationId), fromConversationId)
  const delivery = { toConversationId, fromConversationId, fromLabel, content: composePeerMessage(fromLabel, fromConversationId, text), hops }

  if (getConversationExecution(toConversationId)) {
    void deliverPeerMessage({ ...delivery, timeoutMs: QUEUED_DELIVERY_TIMEOUT_MS }).then(result => {
      if (result.status === 'error') console.warn(`[Peer] 排队送达 ${toConversationId.slice(0, 8)} 失败: ${result.error}`)
    })
    return { status: 'queued' }
  }
  return deliverPeerMessage({ ...delivery, timeoutMs: PEER_REPLY_TIMEOUT_MS, signal: options.signal })
}

interface Delivery {
  toConversationId: string
  fromConversationId: string
  fromLabel: string
  content: string
  hops: number
  timeoutMs: number
  signal?: AbortSignal
}

async function deliverPeerMessage(d: Delivery): Promise<SendPeerResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`等对方回复超过 ${Math.round(d.timeoutMs / 60_000)} 分钟，放弃`)), d.timeoutMs)
  const onExternalAbort = (): void => controller.abort(d.signal?.reason ?? new Error('发送方已中止'))
  if (d.signal?.aborted) onExternalAbort()
  else d.signal?.addEventListener('abort', onExternalAbort, { once: true })

  let lease: Awaited<ReturnType<typeof acquireConversationExecution>> | null = null
  let runId: string | null = null
  let outcome: 'completed' | 'aborted' | 'failed' = 'completed'
  let failure: Error | undefined
  try {
    lease = await acquireConversationExecution({
      conversationId: d.toConversationId,
      owner: { entrypoint: 'scheduler', ownerId: `peer:${d.fromConversationId}` },
      policy: 'wait',
      signal: controller.signal
    })
    const conversation = await getConversation(d.toConversationId)
    if (!conversation) throw new Error('对方对话已不存在')
    runId = await beginConversationOperation(d.toConversationId, 'scheduler')
    inboundHops.set(d.toConversationId, d.hops)

    const overrides: AgentOverrides = resolveAgentOverrides({
      workspaceId: conversation.workspaceId,
      conversationId: d.toConversationId,
      conversationConfig: conversation.config
    }) ?? { systemPrompt: '', conversationId: d.toConversationId }
    const startedAt = Date.now()
    const trigger: ChatMessage = { id: randomUUID(), role: 'user', content: d.content, messageKind: PEER_MESSAGE_KIND }
    const history = (await getConversationMessagesSerialized(d.toConversationId))
      .filter(shouldReplayStoredMessage)
      .map(storedToChat)
      .concat(trigger)

    const collector = createTranscriptCollector()
    if (!runtimeGetter) throw new Error('跨会话运行时未接入（setPeerRuntime）')
    const runtime = await runtimeGetter()
    for await (const event of runtime.agentChat(history, lease.signal, 'scheduler', overrides)) {
      if (event.type === 'error') throw new Error(String((event as { content?: unknown }).content ?? '').trim() || '对方的 Agent 运行失败')
      collector.feed(event)
    }
    if (lease.signal.aborted) throw (lease.signal.reason instanceof Error ? lease.signal.reason : new Error('对方这一轮被中止'))

    const reply = collector.finish()
    const transcript = collector.finishTranscript()
    const toAppend: StoredMessage[] = [{ id: randomUUID(), role: 'user', content: d.content, timestamp: startedAt, messageKind: PEER_MESSAGE_KIND }]
    const rc = collector.finishRuntimeContext()
    if (rc) toAppend.push({ id: randomUUID(), role: 'user', content: rc.text, timestamp: rc.timestamp, messageKind: 'runtime-context' })
    for (const entry of transcript) {
      const timestamp = Date.now()
      if (entry.kind === 'hook') { toAppend.push(hookNoticeToStoredMessage(entry.notice, timestamp)); continue }
      toAppend.push(entry.kind === 'tool'
        ? { id: randomUUID(), role: 'tool', content: entry.content, timestamp, toolName: entry.toolName, toolCallId: entry.toolCallId, toolArgs: entry.toolArgs, ...(entry.searchResults ? { searchResults: entry.searchResults } : {}) }
        : { id: randomUUID(), role: 'assistant', content: entry.content, timestamp })
    }
    const persisted = await appendMessages(d.toConversationId, toAppend)
    if (!persisted) throw new Error('对方对话已不存在，消息没能保存')
    notifyPeerTurn(d.toConversationId, d.fromLabel)
    return { status: 'replied', reply: reply.trim() || '（对方这一轮只有工具结果，没有文字回复；用 read 看细节）' }
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err))
    outcome = controller.signal.aborted || lease?.signal.aborted ? 'aborted' : 'failed'
    return { status: 'error', error: failure.message }
  } finally {
    clearTimeout(timer)
    d.signal?.removeEventListener('abort', onExternalAbort)
    inboundHops.delete(d.toConversationId)
    if (runId) await finishConversationOperation(d.toConversationId, runId, outcome, failure ? { code: 'PEER_TURN_FAILED', message: failure.message } : undefined).catch(() => { /* 标记失败不影响结果 */ })
    lease?.release()
  }
}
