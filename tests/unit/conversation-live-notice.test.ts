import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => path.join(actual.tmpdir(), `openpipal-live-notice-${process.pid}`)
  return { ...actual, default: { ...actual, homedir }, homedir }
})

import { appendMessages, getConversationMessages, replaceMessages } from '../../src/main/conversation-store'

const HOME = os.homedir()
const CONVERSATIONS_DIR = path.join(HOME, '.openpipal', 'conversations')
const ID = 'live-notice'

const retryNotice = (id: string): any => ({
  id, role: 'assistant', content: 'openpipal:stream-retry:1/5',
  messageKind: 'inject-notice', messageSubtype: 'stream-retry', timestamp: 2
})
const steerNotice = (id: string): any => ({
  id, role: 'assistant', content: '↳ 已引导对话',
  messageKind: 'inject-notice', messageSubtype: 'steer', timestamp: 2
})

function seed(messages: any[] = []): void {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(CONVERSATIONS_DIR, `${ID}.json`),
    JSON.stringify({ id: ID, title: ID, role: 'general', createdAt: 1, updatedAt: 1, config: {}, messages }),
    'utf8'
  )
}

beforeEach(() => seed())
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }))

// 断流重连提示是实时状态行，不是记录：撤销只跑在前台 stream-end，用户切走后这一轮在后台
// 收尾时那条提示就再也没人删了。挡在落盘口子上，前后台就没有不对称可言。
describe('断流重连提示不进记录', () => {
  it('append 写不进去', async () => {
    await appendMessages(ID, [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 } as any,
      retryNotice('n1'),
      { id: 'a1', role: 'assistant', content: '答案', timestamp: 3 } as any
    ])
    expect(getConversationMessages(ID).map(m => m.id)).toEqual(['u1', 'a1'])
  })

  it('replace 写不进去', async () => {
    await replaceMessages(ID, [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 } as any,
      retryNotice('n1')
    ])
    expect(getConversationMessages(ID).map(m => m.id)).toEqual(['u1'])
  })

  it('旧记录里已经躺着的那条，读的时候也消失', () => {
    seed([
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
      retryNotice('n1'),
      { id: 'a1', role: 'assistant', content: '答案', timestamp: 3 }
    ])
    expect(getConversationMessages(ID).map(m => m.id)).toEqual(['u1', 'a1'])
  })

  it('别的插队提示照旧保留——挡的是实时状态行，不是整类 inject-notice', async () => {
    await appendMessages(ID, [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 } as any,
      steerNotice('n1')
    ])
    expect(getConversationMessages(ID).map(m => m.id)).toEqual(['u1', 'n1'])
  })
})
