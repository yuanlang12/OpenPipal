/**
 * 规则自己的小仓库：ctx.store.get / set / delete，每条规则一个 JSON 文件。
 *
 * 放哪（复用已有的命名空间，不新造目录）：
 *   插件里的规则 → `~/.openpipal/plugin-data/<插件>/hooks/<规则>.json`
 *     （插件的数据目录：更新不丢、卸载即删，plugin-manager 规范 §9.2）
 *   Pal / 团队自己目录里的规则 → 规则文件旁边的 `.store/<规则>.json`
 *     （位置即范围：跟着 Pal / 团队走，目录删了状态一起走；hooks/ 扫描器跳过点开头的条目，不会把它当规则）
 *
 * 语义：值经 JSON 往返归一（函数、undefined 会丢；BigInt / 循环引用报错）；get 给副本；
 * 写入 tmp + rename 原子落盘，同一文件的写按序排队；单条规则总量 ≤ 256KB，超了 set 抛错
 * （规则那次调用 fail-open 跳过，不拖垮本轮）。主进程内一份缓存：几条会话同时跑同一条规则
 * 看到的是同一份数据。文件损坏 → 改名留底、从空开始、记日志。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { getPluginDataDir, getPluginsRootDir } from '../plugin-manager'
import type { HookStore } from './hook-types'

export const HOOK_STORE_MAX_BYTES = 256 * 1024
const KEY_MAX_LENGTH = 200

interface StoreEntry {
  data: Record<string, unknown>
  /** 同一文件的写按序排队 */
  queue: Promise<void>
}

const entries = new Map<string, StoreEntry>()
let tmpSequence = 0

/** 规则文件 → 它的仓库文件 */
export function hookStorePathFor(hookFile: string): string {
  const abs = resolve(hookFile)
  const name = `${basename(abs, extname(abs))}.json`
  const pluginsRoot = resolve(getPluginsRootDir())
  if (abs.startsWith(pluginsRoot + sep)) {
    const pluginName = abs.slice(pluginsRoot.length + 1).split(sep)[0]
    if (pluginName) return join(getPluginDataDir(pluginName), 'hooks', name)
  }
  return join(dirname(abs), '.store', name)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loadEntry(path: string): StoreEntry {
  const cached = entries.get(path)
  if (cached) return cached
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('内容不是对象')
    data = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const aside = `${path}.corrupt-${Date.now()}`
      try {
        renameSync(path, aside)
      } catch {
        // 留不下底也从空开始
      }
      console.warn(`[Hooks] 规则仓库 ${path} 读不出来（${errorText(error)}），已改名留底为 ${basename(aside)}，从空开始`)
    }
  }
  const entry: StoreEntry = { data, queue: Promise.resolve() }
  entries.set(path, entry)
  return entry
}

/** 拍下此刻的快照排进写队列；调用方 await 它，写进磁盘才算 set 完成 */
function persist(path: string, entry: StoreEntry): Promise<void> {
  const snapshot = `${JSON.stringify(entry.data, null, 2)}\n`
  const run = entry.queue.then(() => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${++tmpSequence}`
    writeFileSync(tmp, snapshot, 'utf-8')
    renameSync(tmp, path)
  })
  entry.queue = run.catch(() => undefined)
  return run
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !key.trim()) throw new Error('store 的键必须是非空字符串')
  if (key.length > KEY_MAX_LENGTH) throw new Error(`store 的键太长（${key.length} 字符，上限 ${KEY_MAX_LENGTH}）`)
  return key
}

/** JSON 往返：拿到的和写进文件、下次读出来的一模一样；转不了的（BigInt、循环引用）在这里就报错 */
function normalize(value: unknown): unknown {
  const text = JSON.stringify(value)
  return text === undefined ? undefined : JSON.parse(text)
}

export function openHookStore(hookFile: string): HookStore {
  const path = hookStorePathFor(hookFile)
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const value = loadEntry(path).data[checkKey(key)]
      return value === undefined ? undefined : (structuredClone(value) as T)
    },
    async set(key: string, value: unknown): Promise<void> {
      const name = checkKey(key)
      const entry = loadEntry(path)
      const next = normalize(value)
      if (next === undefined) {
        if (!(name in entry.data)) return
        delete entry.data[name]
      } else {
        const had = name in entry.data
        const previous = entry.data[name]
        entry.data[name] = next
        const bytes = Buffer.byteLength(JSON.stringify(entry.data))
        if (bytes > HOOK_STORE_MAX_BYTES) {
          if (had) entry.data[name] = previous
          else delete entry.data[name]
          throw new Error(`规则仓库超过 ${HOOK_STORE_MAX_BYTES / 1024}KB 上限（这次写完会有 ${Math.ceil(bytes / 1024)}KB），先删掉不用的键`)
        }
      }
      await persist(path, entry)
    },
    async delete(key: string): Promise<void> {
      const name = checkKey(key)
      const entry = loadEntry(path)
      if (!(name in entry.data)) return
      delete entry.data[name]
      await persist(path, entry)
    }
  }
}

/** 规则被删了：它的仓库一起清掉，免得以后同名的新规则接手一份旧账 */
export function removeHookStore(hookFile: string): void {
  const path = hookStorePathFor(hookFile)
  entries.delete(path)
  rmSync(path, { force: true })
}

/** 测试用：丢掉进程内缓存，下次访问重新读文件 */
export function resetHookStores(): void {
  entries.clear()
}
