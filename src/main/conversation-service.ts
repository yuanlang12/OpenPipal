import { randomUUID } from 'node:crypto'
import * as legacy from './conversation-store'
import type {
  Conversation,
  ConversationConfig,
  ConversationSummary,
  StoredMessage,
} from './conversation-store'
import { publishConversationChange } from './conversation-events'
import { PiV4JsonlSessionStore } from './session'
import type {
  OpenPipalSessionCreatedBy,
  OpenPipalOperationOutcome,
  OpenPipalOperationSource,
  OpenPipalSessionStorageKind,
} from './session'

export type {
  Conversation,
  ConversationConfig,
  ConversationSummary,
  StoredMessage,
} from './conversation-store'

export interface InitializeConversationServiceOptions {
  /** Storage for conversations created after initialization. Existing JSON stays legacy. */
  newSessionStorage: OpenPipalSessionStorageKind
  /** Test/diagnostic override. Production uses OpenPipal's private data root. */
  jsonlRoot?: string
}

const NEW_CONVERSATION_TITLE = '新对话'

let configuredStorage: OpenPipalSessionStorageKind = 'legacy-json'
let configuredJsonlRoot: string | undefined
let initialization: Promise<void> | null = null
let jsonlStore: PiV4JsonlSessionStore | null = null
let titleUpdatedCallback: ((id: string, title: string) => void) | null = null

/** Full JSONL projections loaded during this process; legacy reads remain disk-backed. */
const jsonlConversationCache = new Map<string, Conversation>()
/** Summary-only startup projections are enough for synchronous role/config lookups. */
const jsonlSummaryCache = new Map<string, ConversationSummary>()
const jsonlConversationIds = new Set<string>()
const serviceQueues = new Map<string, Promise<unknown>>()
const scheduledTitles = new Map<string, Promise<void>>()

function serialize<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = serviceQueues.get(conversationId) ?? Promise.resolve()
  const run = previous.then(task, task)
  const anchor = run.catch(() => undefined)
  serviceQueues.set(conversationId, anchor)
  return run.finally(() => {
    if (serviceQueues.get(conversationId) === anchor) serviceQueues.delete(conversationId)
  })
}

function buildSummary(conversation: Conversation): ConversationSummary {
  const last = [...conversation.messages].reverse().find((message) => {
    if (message.role === 'tool' || message.messageKind === 'thinking' || message.permissionRequest) return false
    return Boolean((message.askQuestion || message.content || '').trim())
  })
  const text = (last?.askQuestion || last?.content || '').replace(/\n/g, ' ').trim()
  return {
    id: conversation.id,
    title: conversation.title,
    role: conversation.role,
    ...(conversation.agentId ? { agentId: conversation.agentId } : {}),
    ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
    ...(conversation.config ? { config: conversation.config } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    ...(text ? { lastMessage: text.substring(0, 80) } : {}),
  }
}

function rememberJsonlConversation(conversation: Conversation): Conversation {
  jsonlConversationIds.add(conversation.id)
  jsonlConversationCache.set(conversation.id, conversation)
  jsonlSummaryCache.set(conversation.id, buildSummary(conversation))
  return conversation
}

function rememberJsonlSummary(summary: ConversationSummary): void {
  jsonlConversationIds.add(summary.id)
  jsonlSummaryCache.set(summary.id, summary)
  const loaded = jsonlConversationCache.get(summary.id)
  if (loaded) {
    jsonlConversationCache.set(summary.id, {
      ...loaded,
      title: summary.title,
      role: summary.role,
      ...(summary.agentId ? { agentId: summary.agentId } : { agentId: undefined }),
      ...(summary.workspaceId ? { workspaceId: summary.workspaceId } : { workspaceId: undefined }),
      ...(summary.config ? { config: summary.config } : { config: undefined }),
      updatedAt: summary.updatedAt,
    })
  }
}

function forgetJsonlConversation(conversationId: string): void {
  jsonlConversationIds.delete(conversationId)
  jsonlConversationCache.delete(conversationId)
  jsonlSummaryCache.delete(conversationId)
}

function legacyConversation(conversationId: string): Conversation | null {
  return typeof legacy.getConversation === 'function'
    ? legacy.getConversation(conversationId)
    : null
}

function legacySummaries(): ConversationSummary[] {
  return typeof legacy.listConversations === 'function'
    ? legacy.listConversations()
    : []
}

async function initializeJsonl(): Promise<void> {
  const store = new PiV4JsonlSessionStore(
    configuredJsonlRoot ? { root: configuredJsonlRoot } : undefined
  )
  try {
    let summaries = await store.list()
    let recovered = 0
    for (const summary of summaries) {
      try {
        if (await store.recoverInterruptedOperation(summary.id)) recovered += 1
      } catch (error) {
        // Corrupt operation state is isolated to its conversation. Do not
        // replay tools and do not prevent healthy sessions from starting.
        console.error(`[Conversation] 会话 ${summary.id} 的中断状态无法自动收口:`, error)
      }
    }
    if (recovered > 0) {
      summaries = await store.list()
      console.warn(`[Conversation] 已标记 ${recovered} 个上次未完成的会话，未自动重跑工具`)
    }
    jsonlStore = store
    for (const summary of summaries) rememberJsonlSummary(summary)
    console.log(`[Conversation] Pi JSONL 会话服务就绪：${summaries.length} 个新格式会话`)
  } catch (error) {
    // A storage initialization failure must not make the whole desktop app
    // unusable. Existing legacy data remains untouched and new conversations
    // fall back to the proven backend for this process.
    jsonlStore = null
    console.error('[Conversation] JSONL 会话服务初始化失败，本次启动安全回退旧存储:', error)
  }
}

/**
 * Configure once during app startup. Tests and isolated modules that do not
 * call this function retain the legacy backend, preserving deterministic unit
 * boundaries.
 */
export async function initializeConversationService(
  options: InitializeConversationServiceOptions
): Promise<void> {
  if (initialization) return initialization
  configuredStorage = options.newSessionStorage
  configuredJsonlRoot = options.jsonlRoot
  // The rollout switch selects only where newly created conversations live.
  // Existing JSONL sessions must remain readable during rollback; otherwise a
  // safe-mode launch would make healthy user history appear to have vanished.
  initialization = initializeJsonl()
  return initialization
}

async function ensureInitialized(): Promise<void> {
  if (initialization) await initialization
}

function currentJsonlStore(): PiV4JsonlSessionStore | null {
  return jsonlStore
}

async function projectJsonl(conversationId: string): Promise<Conversation | null> {
  const store = currentJsonlStore()
  if (!store || !jsonlConversationIds.has(conversationId)) return null
  const projected = await store.project(conversationId)
  return projected ? rememberJsonlConversation(projected) : null
}

/**
 * Synchronous read-only snapshot for policy/prompt code that cannot await.
 * Product entry points load the authoritative projection before execution;
 * summary fallback still preserves role/config on a cold restart.
 */
export function peekConversation(conversationId: string): Conversation | null {
  const legacyValue = legacyConversation(conversationId)
  if (legacyValue) return legacyValue
  const loaded = jsonlConversationCache.get(conversationId)
  if (loaded) return loaded
  const summary = jsonlSummaryCache.get(conversationId)
  if (!summary) return null
  return {
    id: summary.id,
    title: summary.title,
    role: summary.role,
    ...(summary.agentId ? { agentId: summary.agentId } : {}),
    ...(summary.workspaceId ? { workspaceId: summary.workspaceId } : {}),
    ...(summary.config ? { config: summary.config } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messages: [],
  }
}

export function peekConversationMessages(conversationId: string): StoredMessage[] {
  const legacyValue = legacyConversation(conversationId)
  if (legacyValue) return legacyValue.messages || []
  return jsonlConversationCache.get(conversationId)?.messages || []
}

export function listConversationsCached(): ConversationSummary[] {
  const byId = new Map<string, ConversationSummary>()
  for (const summary of Array.from(jsonlSummaryCache.values())) byId.set(summary.id, summary)
  // Legacy wins a duplicate id. This fail-safe makes a partially completed
  // future migration unable to steal authority from the original JSON file.
  for (const summary of legacySummaries()) byId.set(summary.id, summary)
  return Array.from(byId.values()).sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureInitialized()
  const store = currentJsonlStore()
  if (!store) return legacySummaries()
  await Promise.all(Array.from(serviceQueues.values(), (queue) => queue.catch(() => undefined)))
  const summaries = await store.list()
  const liveIds = new Set(summaries.map((summary) => summary.id))
  for (const id of Array.from(jsonlConversationIds)) {
    if (!liveIds.has(id)) forgetJsonlConversation(id)
  }
  for (const summary of summaries) rememberJsonlSummary(summary)
  return listConversationsCached()
}

async function makeConversation(
  role: string,
  title?: string,
  agentId?: string,
  workspaceId?: string
): Promise<Conversation> {
  const now = Date.now()
  const { loadConfig } = await import('./config-manager')
  const activePresetId = loadConfig().activePresetId
  return {
    id: randomUUID(),
    title: title || NEW_CONVERSATION_TITLE,
    role,
    ...(agentId ? { agentId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(activePresetId ? { config: { modelPresetId: activePresetId } } : {}),
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
}

export async function createConversation(
  role: string,
  title?: string,
  agentId?: string,
  workspaceId?: string,
  createdBy: OpenPipalSessionCreatedBy = 'desktop'
): Promise<Conversation> {
  await ensureInitialized()
  const store = currentJsonlStore()
  if (configuredStorage !== 'pi-jsonl-v4' || !store) {
    return legacy.createConversation(role, title, agentId, workspaceId)
  }

  const conversation = await makeConversation(role, title, agentId, workspaceId)
  await serialize(conversation.id, async () => {
    await store.create({ conversation, createdBy })
    rememberJsonlConversation(conversation)
  })
  console.log(`[Conversation] 创建 JSONL 会话: ${conversation.id} (${conversation.title})`)
  return conversation
}

async function getConversationDirect(conversationId: string): Promise<Conversation | null> {
  const legacyValue = legacyConversation(conversationId)
  if (legacyValue) return legacyValue
  return projectJsonl(conversationId)
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacyConversation(conversationId)
  return serialize(conversationId, () => getConversationDirect(conversationId))
}

export async function getConversationMessages(conversationId: string): Promise<StoredMessage[]> {
  await ensureInitialized()
  if (!currentJsonlStore()) {
    if (typeof legacy.getConversationMessagesSerialized === 'function') {
      return legacy.getConversationMessagesSerialized(conversationId)
    }
    return typeof legacy.getConversationMessages === 'function'
      ? legacy.getConversationMessages(conversationId)
      : []
  }
  return serialize(conversationId, async () => {
    const legacyValue = legacyConversation(conversationId)
    if (legacyValue) {
      if (typeof legacy.getConversationMessagesSerialized === 'function') {
        return legacy.getConversationMessagesSerialized(conversationId)
      }
      return typeof legacy.getConversationMessages === 'function'
        ? legacy.getConversationMessages(conversationId)
        : []
    }
    const conversation = await projectJsonl(conversationId)
    if (!conversation) return []
    return legacy.rehydrateRecentConversationAttachments(
      conversationId,
      conversation.messages
    )
  })
}

/** Reads are ordered behind writes for the same conversation. */
export const getConversationMessagesSerialized = getConversationMessages

function provisionalTitle(content: string): string {
  const oneLine = content.substring(0, 30).replace(/\n/g, ' ')
  return content.length > 30 ? `${oneLine}...` : oneLine
}

function firstAssistantForTitle(messages: StoredMessage[]): StoredMessage | undefined {
  return messages.find((message) => (
    message.role === 'assistant' &&
    message.messageKind !== 'thinking' &&
    message.messageKind !== 'tool' &&
    message.messageKind !== 'permission_request' &&
    Boolean(message.content?.trim())
  ))
}

function scheduleGeneratedTitle(
  conversationId: string,
  expectedTitle: string,
  userContent: string,
  assistantContent: string
): void {
  if (scheduledTitles.has(conversationId)) return
  const pending = import('./title-generator')
    .then(({ generateTitle }) => generateTitle(userContent, assistantContent))
    .then(async (title) => {
      await serialize(conversationId, async () => {
        const current = await getConversationDirect(conversationId)
        if (!current || current.title !== expectedTitle || !currentJsonlStore()) return
        const updated = await currentJsonlStore()!.updateProduct(conversationId, { title })
        if (!updated) return
        await projectJsonl(conversationId)
        titleUpdatedCallback?.(conversationId, title)
        publishConversationChange(conversationId, 'title')
        console.log(`[Conversation] AI 标题: "${title}" (${conversationId.substring(0, 8)})`)
      })
    })
    .catch(() => undefined)
    .finally(() => {
      if (scheduledTitles.get(conversationId) === pending) scheduledTitles.delete(conversationId)
    })
  scheduledTitles.set(conversationId, pending)
}

async function refreshJsonlAfterMessageWrite(conversationId: string): Promise<Conversation | null> {
  const store = currentJsonlStore()
  if (!store) return null
  let conversation = await store.project(conversationId)
  if (!conversation) return null

  const firstUser = conversation.messages.find((message) => message.role === 'user' && message.content)
  if (!firstUser) return rememberJsonlConversation(conversation)
  const plainProvisional = firstUser.content.substring(0, 30).replace(/\n/g, ' ')
  const canAutoTitle = (
    conversation.title === NEW_CONVERSATION_TITLE ||
    conversation.title === plainProvisional ||
    conversation.title === provisionalTitle(firstUser.content)
  )
  if (!canAutoTitle) return rememberJsonlConversation(conversation)

  const nextTitle = provisionalTitle(firstUser.content)
  if (conversation.title !== nextTitle) {
    await store.updateProduct(conversationId, { title: nextTitle })
    conversation = await store.project(conversationId) ?? conversation
  }
  rememberJsonlConversation(conversation)
  const assistant = firstAssistantForTitle(conversation.messages)
  if (assistant) {
    scheduleGeneratedTitle(conversationId, nextTitle, firstUser.content, assistant.content)
  }
  return conversation
}

export async function appendMessages(
  conversationId: string,
  messages: StoredMessage[]
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.appendMessages(conversationId, messages)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.appendMessages(conversationId, messages)
    const store = currentJsonlStore()!
    if (!jsonlConversationIds.has(conversationId)) return false
    const persisted = await store.appendMessages(conversationId, messages)
    if (persisted) await refreshJsonlAfterMessageWrite(conversationId)
    return persisted
  })
}

export async function replaceMessages(
  conversationId: string,
  messages: StoredMessage[]
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.replaceMessages(conversationId, messages)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.replaceMessages(conversationId, messages)
    const store = currentJsonlStore()!
    if (!jsonlConversationIds.has(conversationId)) return false
    const persisted = await store.replaceMessages(conversationId, messages)
    if (persisted) await refreshJsonlAfterMessageWrite(conversationId)
    return persisted
  })
}

export async function updateConversationTitle(
  conversationId: string,
  title: string
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.updateConversationTitle(conversationId, title)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.updateConversationTitle(conversationId, title)
    const current = await projectJsonl(conversationId)
    if (!current) return false
    const persisted = await currentJsonlStore()!.updateProduct(conversationId, { title })
    if (persisted) {
      await projectJsonl(conversationId)
      publishConversationChange(conversationId, 'title')
    }
    return persisted
  })
}

export async function updateConversationRole(
  conversationId: string,
  role: string
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.updateConversationRole(conversationId, role)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.updateConversationRole(conversationId, role)
    const current = await projectJsonl(conversationId)
    if (!current || current.messages.length > 0) return false
    const persisted = await currentJsonlStore()!.updateProduct(conversationId, { role })
    if (persisted) {
      await projectJsonl(conversationId)
      publishConversationChange(conversationId, 'persona')
    }
    return persisted
  })
}

export async function updateConversationWorkspace(
  conversationId: string,
  workspaceId: string | undefined
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.updateConversationWorkspace(conversationId, workspaceId)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.updateConversationWorkspace(conversationId, workspaceId)
    const current = await projectJsonl(conversationId)
    if (!current || current.messages.length > 0) return false
    const persisted = await currentJsonlStore()!.updateProduct(conversationId, { workspaceId })
    if (persisted) {
      await projectJsonl(conversationId)
      publishConversationChange(conversationId, 'persona')
    }
    return persisted
  })
}

export async function updateConversationConfig(
  conversationId: string,
  config: ConversationConfig
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.updateConversationConfig(conversationId, config)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.updateConversationConfig(conversationId, config)
    const current = await projectJsonl(conversationId)
    if (!current) return false
    const persisted = await currentJsonlStore()!.updateProduct(conversationId, { config })
    if (persisted) {
      await projectJsonl(conversationId)
      publishConversationChange(conversationId, 'config')
    }
    return persisted
  })
}

export async function mutateConversationConfig(
  conversationId: string,
  mutate: (config: ConversationConfig) => ConversationConfig | null
): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.mutateConversationConfig(conversationId, mutate)
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId)) return legacy.mutateConversationConfig(conversationId, mutate)
    const current = await projectJsonl(conversationId)
    if (!current) return false
    const next = mutate({ ...(current.config || {}) })
    if (!next) return false
    const persisted = await currentJsonlStore()!.updateProduct(conversationId, { config: next })
    if (persisted) {
      await projectJsonl(conversationId)
      publishConversationChange(conversationId, 'config')
    }
    return persisted
  })
}

/**
 * Durable run markers are JSONL-only. Legacy conversations keep their prior
 * behavior until explicitly migrated; returning null means no marker exists.
 */
export async function beginConversationOperation(
  conversationId: string,
  source: OpenPipalOperationSource
): Promise<string | null> {
  await ensureInitialized()
  if (!currentJsonlStore()) return null
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId) || !jsonlConversationIds.has(conversationId)) return null
    return currentJsonlStore()!.beginOperation(conversationId, source)
  })
}

export async function finishConversationOperation(
  conversationId: string,
  runId: string | null,
  outcome: OpenPipalOperationOutcome,
  error?: { code: string; message: string }
): Promise<boolean> {
  if (!runId) return true
  await ensureInitialized()
  if (!currentJsonlStore()) return false
  return serialize(conversationId, async () => {
    if (legacyConversation(conversationId) || !jsonlConversationIds.has(conversationId)) return false
    return currentJsonlStore()!.finishOperation(conversationId, runId, outcome, error)
  })
}

export async function deleteConversation(conversationId: string): Promise<boolean> {
  await ensureInitialized()
  if (!currentJsonlStore()) return legacy.deleteConversation(conversationId)
  return serialize(conversationId, async () => {
    const legacyPresent = Boolean(legacyConversation(conversationId))
    const jsonlPresent = jsonlConversationIds.has(conversationId)
    let deleted = false
    // User-requested deletion removes both only in the duplicate-id fail-safe
    // case, preventing a hidden partial migration from resurrecting later.
    if (legacyPresent) deleted = await legacy.deleteConversation(conversationId) || deleted
    if (jsonlPresent) deleted = await currentJsonlStore()!.delete(conversationId) || deleted
    forgetJsonlConversation(conversationId)
    return deleted
  })
}

export function setTitleUpdateCallback(callback: (id: string, title: string) => void): void {
  titleUpdatedCallback = callback
  if (typeof legacy.setTitleUpdateCallback === 'function') {
    legacy.setTitleUpdateCallback(callback)
  }
}

export function shouldReplayStoredMessage(message: StoredMessage): boolean {
  return legacy.shouldReplayStoredMessage(message)
}

export async function drainConversationService(): Promise<void> {
  await ensureInitialized()
  await Promise.all(Array.from(serviceQueues.values(), (queue) => queue.catch(() => undefined)))
  await currentJsonlStore()?.drain()
}
