import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => path.join(actual.tmpdir(), `openpipal-config-atomicity-${process.pid}`)
  return { ...actual, default: { ...actual, homedir }, homedir }
})

import {
  getConversation,
  mutateConversationConfig,
  updateConversationConfig
} from '../../src/main/conversation-store'
import { clearConversationGoal, setConversationGoal } from '../../src/main/conversation-goal'

const HOME = os.homedir()
const CONVERSATIONS_DIR = path.join(HOME, '.openpipal', 'conversations')
const ID = 'atomicity'

function seed(config: Record<string, unknown> = {}): void {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(CONVERSATIONS_DIR, `${ID}.json`),
    JSON.stringify({ id: ID, title: ID, role: 'general', createdAt: 1, updatedAt: 1, config, messages: [] }),
    'utf8'
  )
}

beforeEach(() => seed())
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }))

describe('conversation config read-modify-write', () => {
  it('keeps both fields when two writers touch the config at the same time', async () => {
    await Promise.all([
      mutateConversationConfig(ID, config => ({ ...config, projectName: '甲项目' })),
      mutateConversationConfig(ID, config => ({ ...config, workingDir: '/tmp/乙' }))
    ])

    const config = getConversation(ID)?.config
    expect(config?.projectName).toBe('甲项目')
    expect(config?.workingDir).toBe('/tmp/乙')
  })

  it('does not let setting a goal clobber a concurrent config write', async () => {
    // 真实场景：编辑器里 /goal 设目标，同一条会话正在跑的那轮同时写回别的会话级状态
    const [goal] = await Promise.all([
      setConversationGoal(ID, '把周报写完'),
      mutateConversationConfig(ID, config => ({ ...config, projectName: '季度复盘' }))
    ])

    const config = getConversation(ID)?.config
    expect(goal?.text).toBe('把周报写完')
    expect(config?.goal?.text).toBe('把周报写完')
    expect(config?.goal?.maxTurns).toBe(8)
    // 并发那一份没有被过期快照盖掉
    expect(config?.projectName).toBe('季度复盘')
  })

  it('clears only the goal and leaves the rest of the config intact', async () => {
    seed({ projectName: '季度复盘', workingDir: '/tmp/丙' })
    await setConversationGoal(ID, '把周报写完')

    expect(await clearConversationGoal(ID)).toBe(true)
    const config = getConversation(ID)?.config
    expect(config?.goal).toBeUndefined()
    expect(config?.projectName).toBe('季度复盘')
    expect(config?.workingDir).toBe('/tmp/丙')
  })

  it('shows why the whole-object write is the unsafe one', async () => {
    // 锁外读一次、整份写回——正是被换掉的那种写法。留着当反例：
    // 它按定义会把并发写盖掉，所以任何"只想改一个字段"的调用方都不能走这条。
    const stale = getConversation(ID)?.config || {}
    await mutateConversationConfig(ID, config => ({ ...config, projectName: '并发写入' }))
    await updateConversationConfig(ID, { ...stale, workingDir: '/tmp/整份写回' })

    const config = getConversation(ID)?.config
    expect(config?.workingDir).toBe('/tmp/整份写回')
    expect(config?.projectName).toBeUndefined()
  })

  it('refuses to write when the conversation is gone or the mutator opts out', async () => {
    expect(await mutateConversationConfig('missing-conversation', config => config)).toBe(false)
    expect(await mutateConversationConfig(ID, () => null)).toBe(false)
    expect(await setConversationGoal(ID, '   ')).toBeNull()
    expect(await setConversationGoal('missing-conversation', '目标')).toBeNull()
  })
})
