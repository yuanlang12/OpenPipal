import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => path.join(actual.tmpdir(), `openpipal-conversation-path-${process.pid}`)
  return { ...actual, default: { ...actual, homedir }, homedir }
})

import {
  appendMessages,
  deleteConversation,
  getConversation,
  getConversationMessagesSerialized,
  listConversations,
  replaceMessages,
  updateConversationConfig,
  updateConversationRole,
  updateConversationTitle,
} from '../../src/main/conversation-store'

const HOME = os.homedir()
const CONVERSATIONS_DIR = path.join(HOME, '.openpipal', 'conversations')
const OUTSIDE_FILE = path.join(HOME, '.openpipal', 'outside.json')

function conversation(id: string, title = id): Record<string, unknown> {
  return {
    id,
    title,
    role: 'general',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  }
}

beforeAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true })

  fs.writeFileSync(
    path.join(CONVERSATIONS_DIR, 'valid-conversation.json'),
    JSON.stringify(conversation('valid-conversation')),
    'utf8'
  )
  fs.writeFileSync(
    path.join(CONVERSATIONS_DIR, 'mismatched.json'),
    JSON.stringify(conversation('different-id')),
    'utf8'
  )
  fs.writeFileSync(OUTSIDE_FILE, JSON.stringify(conversation('../outside')), 'utf8')
  fs.symlinkSync(OUTSIDE_FILE, path.join(CONVERSATIONS_DIR, 'linked.json'))
})

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true })
})

describe('conversation-store path boundary', () => {
  it('lists only regular files whose safe file name and embedded id agree', () => {
    expect(listConversations().map(item => item.id)).toEqual(['valid-conversation'])
    expect(getConversation('valid-conversation')?.id).toBe('valid-conversation')
    expect(getConversation('mismatched')).toBeNull()
    expect(getConversation('linked')).toBeNull()
  })

  it('keeps normal historical ids writable through the guarded async path', async () => {
    await expect(appendMessages('valid-conversation', [{
      id: 'valid-message', role: 'user', content: 'persisted', timestamp: 2
    }])).resolves.toBe(true)

    expect(getConversation('valid-conversation')?.messages).toHaveLength(1)
    expect(fs.statSync(path.join(CONVERSATIONS_DIR, 'valid-conversation.json')).mode & 0o777).toBe(0o600)
  })

  it('fails closed for traversal ids across every public read/write/delete operation', async () => {
    const invalidId = '../outside'
    const message = { id: 'm1', role: 'user' as const, content: 'no write', timestamp: 1 }

    expect(getConversation(invalidId)).toBeNull()
    await expect(getConversationMessagesSerialized(invalidId)).resolves.toEqual([])
    await expect(appendMessages(invalidId, [message])).resolves.toBe(false)
    await expect(replaceMessages(invalidId, [message])).resolves.toBe(false)
    await expect(updateConversationTitle(invalidId, 'changed')).resolves.toBe(false)
    await expect(updateConversationRole(invalidId, 'design')).resolves.toBe(false)
    await expect(updateConversationConfig(invalidId, { projectName: 'changed' })).resolves.toBe(false)
    await expect(deleteConversation(invalidId)).resolves.toBe(false)

    expect(fs.existsSync(OUTSIDE_FILE)).toBe(true)
    expect(JSON.parse(fs.readFileSync(OUTSIDE_FILE, 'utf8')).title).toBe('../outside')
  })

  it('does not follow a safe-named symlink on delete or overwrite', async () => {
    const before = fs.readFileSync(OUTSIDE_FILE, 'utf8')
    await expect(deleteConversation('linked')).resolves.toBe(false)
    await expect(appendMessages('linked', [{
      id: 'm2', role: 'user', content: 'overwrite', timestamp: 2
    }])).resolves.toBe(false)

    expect(fs.lstatSync(path.join(CONVERSATIONS_DIR, 'linked.json')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(OUTSIDE_FILE, 'utf8')).toBe(before)
  })
})
