/**
 * hook-store 单测——规则自己的小仓库（ctx.store）。
 *
 * 覆盖：get / set / delete 往返、真的写进磁盘（丢掉进程缓存后重读一致）、get 给副本、
 * JSON 归一（undefined 等于删、函数丢掉、BigInt 报错）、256KB 上限（超了抛错、原值不变、不落盘）、
 * 坏文件改名留底从空开始、键校验、同一规则的两个句柄共用一份数据；
 * 路径：插件里的规则 → plugin-data/<插件>/hooks/<规则>.json（更新不丢、卸载即删），
 *       Pal / 团队目录里的规则 → 规则文件旁边的 .store/<规则>.json（跟着目录走）。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-hook-store-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME

const { openHookStore, hookStorePathFor, resetHookStores, HOOK_STORE_MAX_BYTES } = await import('../../src/main/hooks/hook-store')

const DATA = join(HOME, '.openpipal')
const PLUGIN_RULE = join(DATA, 'plugins', 'local-rules', 'hooks', 'count-rounds.ts')
const AGENT_RULE = join(DATA, 'agents', 'pal-1', 'hooks', 'count-rounds.ts')

afterAll(() => { rmSync(HOME, { recursive: true, force: true }) })
beforeEach(() => {
  resetHookStores()
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
})

describe('仓库文件放哪', () => {
  it('插件里的规则 → plugin-data/<插件>/hooks/<规则>.json；Pal 目录里的 → 旁边的 .store/', () => {
    expect(hookStorePathFor(PLUGIN_RULE)).toBe(join(DATA, 'plugin-data', 'local-rules', 'hooks', 'count-rounds.json'))
    expect(hookStorePathFor(AGENT_RULE)).toBe(join(DATA, 'agents', 'pal-1', 'hooks', '.store', 'count-rounds.json'))
    expect(hookStorePathFor(join(DATA, 'teams', 't1', 'channels', 'general', 'rules', 'x.js')))
      .toBe(join(DATA, 'teams', 't1', 'channels', 'general', 'rules', '.store', 'x.json'))
  })
})

describe('get / set / delete', () => {
  it('往返一致，真的写进磁盘：丢掉缓存后重读还在', async () => {
    const store = openHookStore(PLUGIN_RULE)
    expect(await store.get('rounds')).toBeUndefined()
    await store.set('rounds', 1)
    await store.set('last', { outcome: 'completed', tools: ['bash', 'read'] })
    expect(await store.get<number>('rounds')).toBe(1)
    expect(await store.get('last')).toEqual({ outcome: 'completed', tools: ['bash', 'read'] })

    const file = hookStorePathFor(PLUGIN_RULE)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ rounds: 1, last: { outcome: 'completed', tools: ['bash', 'read'] } })
    expect(readdirSync(join(DATA, 'plugin-data', 'local-rules', 'hooks')), '不能留下临时文件').toEqual(['count-rounds.json'])

    resetHookStores()
    const reopened = openHookStore(PLUGIN_RULE)
    expect(await reopened.get('rounds')).toBe(1)
    await reopened.delete('rounds')
    expect(await reopened.get('rounds')).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ last: { outcome: 'completed', tools: ['bash', 'read'] } })
  })

  it('get 给的是副本：改它不影响仓库', async () => {
    const store = openHookStore(AGENT_RULE)
    await store.set('files', ['a.py'])
    const got = await store.get<string[]>('files')
    got!.push('b.py')
    expect(await store.get('files')).toEqual(['a.py'])
  })

  it('值按 JSON 归一：函数与 undefined 字段丢掉、set(undefined) 等于删、BigInt 报错', async () => {
    const store = openHookStore(AGENT_RULE)
    await store.set('mixed', { keep: 2, fn: () => 1, gone: undefined })
    expect(await store.get('mixed')).toEqual({ keep: 2 })
    await store.set('mixed', undefined)
    expect(await store.get('mixed')).toBeUndefined()
    await expect(store.set('big', 1n)).rejects.toThrow(/BigInt/)
    expect(await store.get('big')).toBeUndefined()
  })

  it('同一条规则的两个句柄共用一份数据（几条会话同时跑）', async () => {
    const a = openHookStore(PLUGIN_RULE)
    const b = openHookStore(PLUGIN_RULE)
    await a.set('n', 1)
    expect(await b.get('n')).toBe(1)
    await b.set('n', 2)
    expect(await a.get('n')).toBe(2)
  })

  it('键必须是非空字符串', async () => {
    const store = openHookStore(PLUGIN_RULE)
    await expect(store.set('', 1)).rejects.toThrow(/非空字符串/)
    await expect(store.get('   ')).rejects.toThrow(/非空字符串/)
    await expect(store.set('k'.repeat(201), 1)).rejects.toThrow(/太长/)
  })
})

describe('上限与坏文件', () => {
  it('超过 256KB 抛错：原值不变、不落盘', async () => {
    const store = openHookStore(PLUGIN_RULE)
    await store.set('small', 'ok')
    await expect(store.set('huge', 'x'.repeat(HOOK_STORE_MAX_BYTES))).rejects.toThrow(/256KB/)
    expect(await store.get('huge')).toBeUndefined()
    expect(await store.get('small')).toBe('ok')
    expect(readFileSync(hookStorePathFor(PLUGIN_RULE), 'utf-8')).not.toContain('huge')
    // 已有的键改成超大也一样：改回原值
    await expect(store.set('small', 'y'.repeat(HOOK_STORE_MAX_BYTES))).rejects.toThrow(/256KB/)
    expect(await store.get('small')).toBe('ok')
  })

  it('文件损坏：改名留底、从空开始、之后照常写', async () => {
    const file = hookStorePathFor(AGENT_RULE)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{ not json', 'utf-8')
    const store = openHookStore(AGENT_RULE)
    expect(await store.get('anything')).toBeUndefined()
    const siblings = readdirSync(join(file, '..'))
    expect(siblings.some((name) => name.startsWith('count-rounds.json.corrupt-')), `留底文件没出现：${siblings.join(', ')}`).toBe(true)
    await store.set('rounds', 1)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ rounds: 1 })
  })

  it('内容不是对象（比如数组）也当损坏处理', async () => {
    const file = hookStorePathFor(PLUGIN_RULE)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '[1,2]', 'utf-8')
    const store = openHookStore(PLUGIN_RULE)
    expect(await store.get('0')).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })
})
