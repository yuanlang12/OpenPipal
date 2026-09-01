import path from 'node:path'
import {
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core'
import { isSafeConversationStorageId } from '../attachment-store'
import {
  normalizeStoredMessage,
  type Conversation,
  type ConversationSummary,
  type StoredMessage,
} from '../conversation-store'
import { dataPath } from '../data-root'
import { projectConversation, projectMessageBranch, summarizeConversation } from './conversation-projector'
import {
  OPENPIPAL_MESSAGE_EVENT,
  OPENPIPAL_PRODUCT_SNAPSHOT,
  OPENPIPAL_SESSION_SCHEMA,
  readSessionHeader,
  toJsonValue,
  type OpenPipalMessageEvent,
  type OpenPipalProductSnapshot,
  type OpenPipalSessionHeader,
} from './openpipal-session-events'
import { SecureSessionFileSystem } from './secure-session-filesystem'
import { SessionIndex } from './session-index'
import type {
  CreateOpenPipalSession,
  OpenPipalOperationOutcome,
  OpenPipalOperationSource,
  OpenPipalSessionRef,
  OpenPipalSessionStore,
} from './session-store'

export interface PiV4JsonlSessionStoreOptions {
  root?: string
}

function persistableMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages
    .map(normalizeStoredMessage)
    .filter((message) => !(
      message.messageKind === 'inject-notice' && message.messageSubtype === 'stream-retry'
    ))
}

function sameMessage(left: StoredMessage, right: StoredMessage): boolean {
  return JSON.stringify(toJsonValue(left)) === JSON.stringify(toJsonValue(right))
}

function productSnapshotOf(conversation: Conversation): OpenPipalProductSnapshot {
  return {
    schema: OPENPIPAL_SESSION_SCHEMA,
    title: conversation.title,
    role: conversation.role,
    ...(conversation.agentId ? { agentId: conversation.agentId } : {}),
    ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
    ...(conversation.config ? { config: conversation.config } : {}),
    updatedAt: conversation.updatedAt,
  }
}

/**
 * Append-only OpenPipal storage on Pi's public v4 JsonlSessionRepo.
 *
 * This class deliberately does not run AgentHarness. It stores exact product
 * messages as namespaced custom entries so no OpenPipal-only field is lost,
 * while Pi continues to own sequencing, parent links, lanes and torn-tail
 * repair. The Runtime's existing model-context projector stays independent.
 */
export class PiV4JsonlSessionStore implements OpenPipalSessionStore {
  readonly root: string
  readonly sessionsRoot: string
  readonly namespaceCwd: string
  readonly fileSystem: SecureSessionFileSystem
  readonly repo: JsonlSessionRepo
  readonly index: SessionIndex

  private readonly sessions = new Map<string, Session<JsonlSessionMetadata>>()
  private readonly metadata = new Map<string, JsonlSessionMetadata>()
  /** In-process projection cache. The JSONL log remains authoritative across restart. */
  private readonly projections = new Map<string, Conversation>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(options: PiV4JsonlSessionStoreOptions = {}) {
    this.root = path.resolve(options.root ?? dataPath('sessions-v4'))
    this.sessionsRoot = path.join(this.root, 'logs')
    this.namespaceCwd = path.join(this.root, 'openpipal')
    this.fileSystem = new SecureSessionFileSystem(this.root)
    this.repo = new JsonlSessionRepo({ fs: this.fileSystem, sessionsRoot: this.sessionsRoot })
    this.index = new SessionIndex(this.fileSystem, this.root)
  }

  private serialize<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    if (!isSafeConversationStorageId(conversationId)) {
      return Promise.reject(new Error('conversationId 格式无效'))
    }
    const previous = this.queues.get(conversationId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const anchor = run.catch(() => undefined)
    this.queues.set(conversationId, anchor)
    return run.finally(() => {
      if (this.queues.get(conversationId) === anchor) this.queues.delete(conversationId)
    })
  }

  private async findMetadata(conversationId: string): Promise<JsonlSessionMetadata | null> {
    const cached = this.metadata.get(conversationId)
    if (cached) return cached
    const matches = (await this.repo.list({ cwd: this.namespaceCwd }))
      .filter((item) => item.id === conversationId && readSessionHeader(item.metadata)?.conversationId === conversationId)
    if (matches.length > 1) throw new Error(`Duplicate JSONL sessions found for ${conversationId}`)
    const found = matches[0]
    if (found) this.metadata.set(conversationId, found)
    return found ?? null
  }

  private async openSession(conversationId: string): Promise<Session<JsonlSessionMetadata> | null> {
    const cached = this.sessions.get(conversationId)
    if (cached) return cached
    const metadata = await this.findMetadata(conversationId)
    if (!metadata) return null
    const session = await this.repo.open(metadata)
    this.sessions.set(conversationId, session)
    return session
  }

  private async appendMessageEvent(
    session: Session<JsonlSessionMetadata>,
    operation: OpenPipalMessageEvent['operation'],
    message: StoredMessage
  ): Promise<string> {
    const event: OpenPipalMessageEvent = {
      schema: OPENPIPAL_SESSION_SCHEMA,
      operation,
      message,
    }
    return session.appendCustomEntry(OPENPIPAL_MESSAGE_EVENT, toJsonValue(event))
  }

  private async appendProductSnapshot(
    session: Session<JsonlSessionMetadata>,
    snapshot: OpenPipalProductSnapshot
  ): Promise<string> {
    return session.view('product').appendCustomEntry(
      OPENPIPAL_PRODUCT_SNAPSHOT,
      toJsonValue(snapshot)
    )
  }

  private cacheProjection(conversation: Conversation): Conversation {
    const cached = structuredClone(conversation)
    this.projections.set(conversation.id, cached)
    return cached
  }

  private async loadProjection(
    conversationId: string,
    session: Session<JsonlSessionMetadata>
  ): Promise<Conversation> {
    const cached = this.projections.get(conversationId)
    if (cached) return cached
    return this.cacheProjection(await projectConversation(session))
  }

  private async guardProjection<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    } catch (error) {
      // A Pi append can be durable even when a later append/index step fails.
      // Drop the derived cache so a retry re-projects the acknowledged prefix
      // from the log and can resume idempotently instead of duplicating it.
      this.projections.delete(conversationId)
      throw error
    }
  }

  private async refreshedMetadata(
    conversationId: string,
    session: Session<JsonlSessionMetadata>
  ): Promise<JsonlSessionMetadata> {
    const metadata = await session.getMetadata()
    const fileInfo = await this.fileSystem.fileInfo(metadata.path)
    if (!fileInfo.ok) throw fileInfo.error
    const refreshed = { ...metadata, modifiedAt: fileInfo.value.mtimeMs }
    this.metadata.set(conversationId, refreshed)
    return refreshed
  }

  private async updateIndex(conversation: Conversation): Promise<void> {
    try {
      const session = await this.openSession(conversation.id)
      if (!session) throw new Error(`Session metadata disappeared for ${conversation.id}`)
      const metadata = await this.refreshedMetadata(conversation.id, session)
      await this.index.upsert({
        summary: summarizeConversation(conversation),
        sourceModifiedAt: metadata.modifiedAt,
      })
    } catch (error) {
      // The index is derived. A failed refresh must never turn an acknowledged
      // JSONL append into a reported write failure or tempt a caller to retry it.
      console.warn('[SessionIndex] 摘要索引更新失败，将在下次 list 时重建:', error)
    }
  }

  async create(input: CreateOpenPipalSession): Promise<OpenPipalSessionRef> {
    const conversation = input.conversation
    return this.serialize(conversation.id, async () => {
      const header: OpenPipalSessionHeader = {
        openpipalSchema: OPENPIPAL_SESSION_SCHEMA,
        conversationId: conversation.id,
        createdBy: input.createdBy ?? 'desktop',
        initialRole: conversation.role,
        initialTitle: conversation.title,
        initialCreatedAt: conversation.createdAt,
        ...(conversation.agentId ? { initialAgentId: conversation.agentId } : {}),
        ...(conversation.workspaceId ? { initialWorkspaceId: conversation.workspaceId } : {}),
      }
      const metadata = toJsonValue(header)
      if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
        throw new Error('OpenPipal session header must be a JSON object')
      }
      let session: Session<JsonlSessionMetadata> | undefined
      try {
        session = await this.repo.create({
          id: conversation.id,
          cwd: this.namespaceCwd,
          metadata,
        })
        await session.createLane('product', null)
        await session.setName(conversation.title)
        for (const message of persistableMessages(conversation.messages)) {
          await this.appendMessageEvent(session, 'append', message)
        }
        await this.appendProductSnapshot(session, productSnapshotOf({
          ...conversation,
          messages: persistableMessages(conversation.messages),
        }))
        const createdMetadata = await session.getMetadata()
        this.sessions.set(conversation.id, session)
        this.metadata.set(conversation.id, createdMetadata)
        const persistedConversation = {
          ...conversation,
          messages: persistableMessages(conversation.messages),
        }
        this.cacheProjection(persistedConversation)
        await this.updateIndex(persistedConversation)
        return {
          conversationId: conversation.id,
          storage: 'pi-jsonl-v4',
          createdAt: conversation.createdAt,
        }
      } catch (error) {
        if (session) {
          try { await this.repo.delete(await session.getMetadata()) } catch { /* best-effort rollback */ }
        }
        this.sessions.delete(conversation.id)
        this.metadata.delete(conversation.id)
        this.projections.delete(conversation.id)
        throw error
      }
    })
  }

  async project(conversationId: string): Promise<Conversation | null> {
    if (!isSafeConversationStorageId(conversationId)) return null
    return this.serialize(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return null
      return structuredClone(await this.loadProjection(conversationId, session))
    })
  }

  async open(conversationId: string): Promise<OpenPipalSessionRef | null> {
    if (!isSafeConversationStorageId(conversationId)) return null
    return this.serialize(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return null
      const metadata = await session.getMetadata()
      const header = readSessionHeader(metadata.metadata)
      if (!header) throw new Error(`Session ${conversationId} is not an OpenPipal JSONL session`)
      return {
        conversationId,
        storage: 'pi-jsonl-v4',
        createdAt: header.initialCreatedAt,
      }
    })
  }

  async list() {
    const metadata = (await this.repo.list({ cwd: this.namespaceCwd }))
      .filter((item) => readSessionHeader(item.metadata)?.conversationId === item.id)
    let indexed: ConversationSummary[] | null = null
    try {
      indexed = await this.index.readIfFresh(metadata.map((item) => ({
        id: item.id,
        modifiedAt: item.modifiedAt,
      })))
    } catch (error) {
      console.warn('[SessionIndex] 摘要索引不可读，将从 JSONL 重建:', error)
    }
    if (indexed) return indexed.sort((left, right) => right.updatedAt - left.updatedAt)
    const summaries = await Promise.all(metadata.map((item) => this.serialize(item.id, async () => {
      try {
        this.metadata.set(item.id, item)
        const session = await this.openSession(item.id)
        if (!session) return null
        return summarizeConversation(this.cacheProjection(await projectConversation(session)))
      } catch (error) {
        // One damaged conversation must not hide every healthy session from the
        // sidebar. Keep the source file untouched and surface the exact id in
        // logs; opening that conversation still fails loudly for repair.
        console.error(`[Session] 会话 ${item.id} 无法投影，已从本次列表隔离:`, error)
        this.sessions.delete(item.id)
        return null
      }
    })))
    const resolved = summaries
      .filter((summary): summary is NonNullable<typeof summary> => summary !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const modifiedAtById = new Map(metadata.map((item) => [item.id, item.modifiedAt]))
    try {
      await this.index.replace(resolved.map((summary) => ({
        summary,
        sourceModifiedAt: modifiedAtById.get(summary.id)!,
      })))
    } catch (error) {
      console.warn('[SessionIndex] 摘要索引重建失败，JSONL 权威数据不受影响:', error)
    }
    return resolved
  }

  async appendMessages(conversationId: string, messages: StoredMessage[]): Promise<boolean> {
    if (!isSafeConversationStorageId(conversationId)) return false
    return this.serialize(conversationId, () => this.guardProjection(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return false
      const current = await this.loadProjection(conversationId, session)
      const incoming = persistableMessages(messages)

      // Renderer retries an unacknowledged batch. If a crash or I/O failure
      // happened after only part of that batch was appended, consume the
      // already-present suffix instead of duplicating stable message ids.
      let overlap = Math.min(current.messages.length, incoming.length)
      while (overlap > 0) {
        const currentStart = current.messages.length - overlap
        let matches = true
        for (let index = 0; index < overlap; index += 1) {
          if (!sameMessage(current.messages[currentStart + index], incoming[index])) {
            matches = false
            break
          }
        }
        if (matches) break
        overlap -= 1
      }
      const pending = incoming.slice(overlap)
      const existingIds = new Set(current.messages.map((message) => message.id))
      const pendingIds = new Set<string>()
      for (const message of pending) {
        if (existingIds.has(message.id) || pendingIds.has(message.id)) {
          throw new Error(`Message id collision while appending ${message.id}`)
        }
        pendingIds.add(message.id)
      }
      for (const message of pending) {
        await this.appendMessageEvent(session, 'append', message)
      }
      const updatedAt = Date.now()
      const conversation = this.cacheProjection({
        ...current,
        messages: [...current.messages, ...pending],
        updatedAt,
      })
      await this.appendProductSnapshot(session, {
        ...productSnapshotOf(conversation),
        updatedAt,
      })
      await this.updateIndex(conversation)
      return true
    }))
  }

  async replaceMessages(conversationId: string, messages: StoredMessage[]): Promise<boolean> {
    if (!isSafeConversationStorageId(conversationId)) return false
    return this.serialize(conversationId, () => this.guardProjection(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return false
      const incoming = persistableMessages(messages)
      const currentConversation = await this.loadProjection(conversationId, session)
      const current = await projectMessageBranch(session)
      let firstDifference = 0
      while (
        firstDifference < current.messages.length &&
        firstDifference < incoming.length &&
        sameMessage(current.messages[firstDifference], incoming[firstDifference])
      ) firstDifference += 1

      if (firstDifference < current.messages.length || firstDifference < incoming.length) {
        const isTailUpdate = (
          current.messages.length > 0 &&
          firstDifference === current.messages.length - 1 &&
          firstDifference < incoming.length &&
          current.messages[firstDifference].id === incoming[firstDifference].id
        )
        if (isTailUpdate) {
          await this.appendMessageEvent(session, 'update', incoming[firstDifference])
          for (const message of incoming.slice(firstDifference + 1)) {
            await this.appendMessageEvent(session, 'append', message)
          }
        } else {
          const branchAnchor = firstDifference === 0 ? null : current.anchors[firstDifference - 1]
          await session.moveLane('main', branchAnchor)
          for (const message of incoming.slice(firstDifference)) {
            await this.appendMessageEvent(session, 'append', message)
          }
        }
      }

      const updatedAt = Date.now()
      const conversation = this.cacheProjection({
        ...currentConversation,
        messages: incoming,
        updatedAt,
      })
      await this.appendProductSnapshot(session, {
        ...productSnapshotOf(conversation),
        updatedAt,
      })
      await this.updateIndex(conversation)
      return true
    }))
  }

  async updateProduct(
    conversationId: string,
    update: Partial<Omit<OpenPipalProductSnapshot, 'schema' | 'updatedAt'>>
  ): Promise<boolean> {
    if (!isSafeConversationStorageId(conversationId)) return false
    return this.serialize(conversationId, () => this.guardProjection(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return false
      const current = await this.loadProjection(conversationId, session)
      const has = (key: keyof typeof update): boolean => Object.prototype.hasOwnProperty.call(update, key)
      const snapshot: OpenPipalProductSnapshot = {
        schema: OPENPIPAL_SESSION_SCHEMA,
        title: update.title ?? current.title,
        role: update.role ?? current.role,
        ...(has('agentId')
          ? (update.agentId ? { agentId: update.agentId } : {})
          : (current.agentId ? { agentId: current.agentId } : {})),
        ...(has('workspaceId')
          ? (update.workspaceId ? { workspaceId: update.workspaceId } : {})
          : (current.workspaceId ? { workspaceId: current.workspaceId } : {})),
        ...(has('config')
          ? (update.config ? { config: update.config } : {})
          : (current.config ? { config: current.config } : {})),
        updatedAt: Date.now(),
      }
      await this.appendProductSnapshot(session, snapshot)
      if (snapshot.title !== current.title) await session.setName(snapshot.title)
      const conversation = this.cacheProjection({
        ...current,
        title: snapshot.title,
        role: snapshot.role,
        ...(snapshot.agentId ? { agentId: snapshot.agentId } : { agentId: undefined }),
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : { workspaceId: undefined }),
        ...(snapshot.config ? { config: snapshot.config } : { config: undefined }),
        updatedAt: snapshot.updatedAt,
      })
      await this.updateIndex(conversation)
      return true
    }))
  }

  async beginOperation(
    conversationId: string,
    source: OpenPipalOperationSource
  ): Promise<string | null> {
    if (!isSafeConversationStorageId(conversationId)) return null
    return this.serialize(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return null
      const conversation = await this.loadProjection(conversationId, session)
      const existing = await session.findOpenOperations('main', { limit: 1 })
      if (existing.length > 0) {
        throw new Error(`Conversation ${conversationId} already has an unfinished operation`)
      }
      const runId = session.idGenerator.next()
      await session.appendRecord({
        id: runId,
        type: 'operation_started',
        lane: 'main',
        sourceLeafId: await session.getLeafId(),
        intent: {
          kind: 'run',
          originalPrompt: [],
          initialMessages: [],
          resumeData: {
            'openpipal.runtime': { source },
          },
        },
      })
      // Operation records change the source mtime even though the sidebar
      // projection is unchanged. Refresh the derived index so list() stays O(1).
      await this.updateIndex(conversation)
      return runId
    })
  }

  async finishOperation(
    conversationId: string,
    runId: string,
    outcome: OpenPipalOperationOutcome,
    error?: { code: string; message: string }
  ): Promise<boolean> {
    if (!isSafeConversationStorageId(conversationId) || !runId) return false
    return this.serialize(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return false
      const conversation = await this.loadProjection(conversationId, session)
      const open = await session.findOpenOperations('main', { limit: 2 })
      if (!open.some((operation) => operation.id === runId)) return false
      await session.appendRecord({
        id: session.idGenerator.next(),
        type: 'operation_finished',
        lane: 'main',
        runId,
        outcome,
        ...(error ? { error } : {}),
      })
      await this.updateIndex(conversation)
      return true
    })
  }

  async recoverInterruptedOperation(conversationId: string): Promise<boolean> {
    if (!isSafeConversationStorageId(conversationId)) return false
    return this.serialize(conversationId, () => this.guardProjection(conversationId, async () => {
      const session = await this.openSession(conversationId)
      if (!session) return false
      const current = await this.loadProjection(conversationId, session)
      const open = await session.findOpenOperations('main', { limit: 2 })
      if (open.length === 0) return false
      if (open.length > 1) {
        throw new Error(`Conversation ${conversationId} has multiple unfinished operations`)
      }
      const operation = open[0]
      const now = Date.now()
      const warning: StoredMessage = {
        id: `runtime-interrupted-${operation.id}`,
        role: 'assistant',
        content: '上一次运行在完成保存前中断。为避免重复执行工具，OpenPipal 没有自动重跑；请检查最后的结果后再继续。',
        messageVersion: 2,
        messageKind: 'incomplete',
        messageSubtype: 'runtime-interrupted',
        timestamp: now,
      }
      await this.appendMessageEvent(session, 'update', warning)
      await session.appendRecord({
        id: session.idGenerator.next(),
        type: 'operation_finished',
        lane: 'main',
        runId: operation.id,
        outcome: 'failed',
        error: {
          code: 'app_restarted',
          message: 'The application exited before the operation was durably completed',
        },
      })
      const warningPosition = current.messages.findIndex((message) => message.id === warning.id)
      const recoveredMessages = [...current.messages]
      if (warningPosition >= 0) recoveredMessages[warningPosition] = warning
      else recoveredMessages.push(warning)
      const conversation = this.cacheProjection({
        ...current,
        messages: recoveredMessages,
        updatedAt: now,
      })
      await this.appendProductSnapshot(session, {
        ...productSnapshotOf(conversation),
        updatedAt: now,
      })
      await this.updateIndex(conversation)
      return true
    }))
  }

  async delete(conversationId: string): Promise<boolean> {
    if (!isSafeConversationStorageId(conversationId)) return false
    return this.serialize(conversationId, async () => {
      const metadata = await this.findMetadata(conversationId)
      if (!metadata) return false
      await this.repo.delete(metadata)
      this.sessions.delete(conversationId)
      this.metadata.delete(conversationId)
      this.projections.delete(conversationId)
      try {
        await this.index.remove(conversationId)
      } catch (error) {
        console.warn('[SessionIndex] 删除后的摘要索引更新失败:', error)
      }
      return true
    })
  }

  async drain(): Promise<void> {
    await Promise.all(Array.from(this.queues.values(), (queue) => queue.catch(() => undefined)))
    await this.index.drain()
  }
}
