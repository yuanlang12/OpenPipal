import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * usage-log 在模块加载时就把 getDataRoot() 固化成常量——隔离必须发生在 import 之前。
 * 用 OPENPIPAL_ISOLATED_HOME 指向临时目录（data-root 的 QA 隔离通道）。
 */
const isolated = mkdtempSync(join(tmpdir(), 'openpipal-usage-today-'))
process.env.OPENPIPAL_ISOLATED_HOME = isolated

const { appendUsageRecord, readTodayUsageByModel } = await import('../../src/main/usage-log')

function todayIso(): string {
  return new Date().toISOString()
}
function yesterdayIso(): string {
  return new Date(Date.now() - 26 * 3600 * 1000).toISOString()
}

describe('readTodayUsageByModel（用量卡"今日"分区）', () => {
  const logDir = join(isolated, '.openpipal')
  const logPath = join(logDir, 'usage.jsonl')
  beforeEach(() => {
    mkdirSync(logDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(isolated, { recursive: true, force: true })
  })

  it('只聚合今日 call 记录，按模型累计 prompt/output/cacheRead/calls/cost', async () => {
    const today = todayIso()
    writeFileSync(logPath, [
      JSON.stringify({ ts: today, kind: 'call', model: 'glm-5.3', prompt: 1000, output: 100, cacheRead: 800, cacheWrite: 200, cost: 0.01 }),
      JSON.stringify({ ts: today, kind: 'call', model: 'glm-5.3', prompt: 3000, output: 200, cacheRead: 2800, cacheWrite: 200, cost: 0.02 }),
      JSON.stringify({ ts: today, kind: 'call', model: 'ds-flash', prompt: 500, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 }),
      // 昨日与 turn/runtime_turn 记录不进聚合
      JSON.stringify({ ts: yesterdayIso(), kind: 'call', model: 'glm-5.3', prompt: 9999, output: 0, cacheRead: 0, cacheWrite: 0 }),
      JSON.stringify({ ts: today, kind: 'turn', model: 'glm-5.3', calls: 2, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, hit: 0 }),
      // 缺 ts 的旧行跳过
      JSON.stringify({ kind: 'call', model: 'glm-5.3', prompt: 7777, output: 0, cacheRead: 0, cacheWrite: 0 }),
      ''
    ].join('\n'))
    // 让下一次 append 的字节水位重新 stat（文件被测试改写过）
    const rows = await readTodayUsageByModel()
    expect(rows).toHaveLength(2)
    // 按 prompt 降序
    expect(rows[0].model).toBe('glm-5.3')
    expect(rows[0]).toMatchObject({ prompt: 4000, output: 300, cacheRead: 3600, calls: 2, cost: 0.03 })
    expect(rows[1]).toMatchObject({ model: 'ds-flash', prompt: 500, calls: 1, cost: 0 })
  })

  it('appendUsageRecord 写出的行可被聚合（cost 透传、ts 由落盘层统一补）', async () => {
    appendUsageRecord({
      kind: 'call', conv: 'abcdefgh', model: 'qwen3.7-plus', seq: 1,
      input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, hit: 33,
      trailTok: 0, trailMsgs: 0, histMsgs: 1, compacted: false,
      cost: 0.005
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const rows = await readTodayUsageByModel()
    const row = rows.find(r => r.model === 'qwen3.7-plus')
    expect(row).toMatchObject({ prompt: 60, output: 40, cacheRead: 20, calls: 1, cost: 0.005 })
  })

  it('日志缺失时按空处理（卡片少一栏不报错）', async () => {
    rmSync(logPath, { force: true })
    const rows = await readTodayUsageByModel()
    expect(rows).toEqual([])
  })
})
