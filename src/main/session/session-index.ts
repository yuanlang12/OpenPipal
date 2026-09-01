import path from 'node:path'
import type { ConversationSummary } from '../conversation-store'
import { toJsonValue } from './openpipal-session-events'
import { SecureSessionFileSystem } from './secure-session-filesystem'

interface SessionIndexEntry {
  summary: ConversationSummary
  sourceModifiedAt: number
}
interface SessionIndexFile {
  schema: 1
  entries: SessionIndexEntry[]
}

export interface SessionIndexSource {
  id: string
  modifiedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseIndex(content: string): SessionIndexFile | null {
  try {
    const value: unknown = JSON.parse(content)
    if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.entries)) return null
    for (const item of value.entries) {
      if (!isRecord(item) || typeof item.sourceModifiedAt !== 'number' || !isRecord(item.summary)) return null
      const summary = item.summary
      if (
        typeof summary.id !== 'string' ||
        typeof summary.title !== 'string' ||
        typeof summary.role !== 'string' ||
        typeof summary.createdAt !== 'number' ||
        typeof summary.updatedAt !== 'number' ||
        typeof summary.messageCount !== 'number'
      ) return null
    }
    return value as unknown as SessionIndexFile
  } catch {
    return null
  }
}

/** Rebuildable sidebar projection. JSONL remains the only authoritative state. */
export class SessionIndex {
  readonly path: string
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly fileSystem: SecureSessionFileSystem,
    root: string
  ) {
    this.path = path.join(root, 'session-index.json')
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async readDirect(): Promise<SessionIndexFile | null> {
    const exists = await this.fileSystem.exists(this.path)
    if (!exists.ok) throw exists.error
    if (!exists.value) return null
    const content = await this.fileSystem.readTextFile(this.path)
    if (!content.ok) throw content.error
    return parseIndex(content.value)
  }

  private async writeDirect(index: SessionIndexFile): Promise<void> {
    const temporary = `${this.path}.tmp`
    const content = `${JSON.stringify(toJsonValue(index))}\n`
    const staged = await this.fileSystem.writeFile(temporary, content)
    if (!staged.ok) throw staged.error
    const published = await this.fileSystem.renameFile(temporary, this.path)
    if (!published.ok) {
      await this.fileSystem.remove(temporary, { force: true })
      throw published.error
    }
  }

  readIfFresh(sources: SessionIndexSource[]): Promise<ConversationSummary[] | null> {
    return this.serialize(async () => {
      const index = await this.readDirect()
      if (!index || index.entries.length !== sources.length) return null
      const sourceById = new Map(sources.map((source) => [source.id, source.modifiedAt]))
      if (index.entries.some((entry) => sourceById.get(entry.summary.id) !== entry.sourceModifiedAt)) return null
      return index.entries.map((entry) => entry.summary)
    })
  }

  replace(entries: SessionIndexEntry[]): Promise<void> {
    return this.serialize(() => this.writeDirect({ schema: 1, entries }))
  }

  upsert(entry: SessionIndexEntry): Promise<void> {
    return this.serialize(async () => {
      const current = await this.readDirect() ?? { schema: 1 as const, entries: [] }
      const next = current.entries.filter((item) => item.summary.id !== entry.summary.id)
      next.push(entry)
      await this.writeDirect({ schema: 1, entries: next })
    })
  }

  remove(conversationId: string): Promise<void> {
    return this.serialize(async () => {
      const current = await this.readDirect()
      if (!current) return
      await this.writeDirect({
        schema: 1,
        entries: current.entries.filter((entry) => entry.summary.id !== conversationId),
      })
    })
  }

  async drain(): Promise<void> {
    await this.tail.catch(() => undefined)
  }
}
