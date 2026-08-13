/**
 * 浏览器站点轴策略的「状态层」(Phase 4)—— 给纯逻辑 browser-policy.ts 喂数据。
 *
 *  - 持久 allowlist / blocklist:落盘 ~/.openpipal/browser-control/policy.json
 *    (仅由可信 UI/主进程更新；模型工具不得直接修改授权文件)
 *  - 本对话 host 授权:进程内存 Map<conversationId, Set<host>>,换对话即失效
 *  - 标签 URL:由 http-server 的 /context 回调和 browser_list_tabs 更新(单向依赖,避免 import 环)
 *
 * 不反向 import http-server / pi-security,保持依赖单向(pi-security → 本模块 → browser-policy)。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { hostOf, decideBrowserAction, type BrowserDecision } from './browser-policy'
import { getBrowserControlPolicyPath } from './credential-paths'

const FILE = getBrowserControlPolicyPath()
const DIR = dirname(FILE)

interface PersistedPolicy {
  allowlist: string[]
  blocklist: string[]
}

let persisted: PersistedPolicy | null = null

function load(): PersistedPolicy {
  if (persisted) return persisted
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, 'utf8'))
      persisted = {
        allowlist: Array.isArray(j.allowlist) ? j.allowlist : [],
        blocklist: Array.isArray(j.blocklist) ? j.blocklist : []
      }
    } else {
      persisted = { allowlist: [], blocklist: [] }
    }
  } catch {
    persisted = { allowlist: [], blocklist: [] }
  }
  return persisted
}

function save(): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify(persisted, null, 2))
  } catch {
    /* 落盘失败不致命:本对话授权仍在内存生效 */
  }
}

// 本对话 host 授权(进程内存;换对话/重启失效)
const sessionHostGrants = new Map<string, Set<string>>()

// 活动标签 URL + tabId → URL 快照。显式 tabId 的命令必须按该标签自身站点判定，
// 绝不能借用另一活动标签的 host；没有快照时保守返回空 host → confirm。
let activeBrowserUrl = ''
const browserTabUrls = new Map<number, string>()
const authorizedHostByArgs = new WeakMap<object, Map<string, string>>()

function validTabId(tabId: unknown): tabId is number {
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0
}

export function setActiveBrowserUrl(url: string | undefined | null, tabId?: number): void {
  activeBrowserUrl = url || ''
  if (validTabId(tabId)) {
    if (activeBrowserUrl) browserTabUrls.set(tabId, activeBrowserUrl)
    else browserTabUrls.delete(tabId)
  } else {
    // 旧版扩展没有 tabId，无法证明旧快照仍对应真实标签；宁可要求重新 list_tabs。
    browserTabUrls.clear()
  }
}

/** 用扩展 list_tabs 的完整快照替换 tabId → URL 缓存，避免关闭标签留下陈旧授权目标。 */
export function replaceBrowserTabUrls(tabs: Array<{ id?: number; url?: string }> | undefined): void {
  browserTabUrls.clear()
  for (const tab of tabs || []) {
    if (validTabId(tab?.id) && typeof tab.url === 'string' && tab.url) {
      browserTabUrls.set(tab.id, tab.url)
    }
  }
}

/** 记录一次扩展已返回的精确标签 URL（navigate/read_page 等结果）。 */
export function setBrowserTabUrl(tabId: unknown, url: unknown): void {
  if (!validTabId(tabId)) return
  if (typeof url === 'string' && url) browserTabUrls.set(tabId, url)
  else browserTabUrls.delete(tabId)
}

const BROWSER_WRITE_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_fill', 'browser_select', 'browser_scroll'
])
export function isBrowserWriteTool(name: string): boolean {
  return BROWSER_WRITE_TOOLS.has(name)
}

function currentTargetHost(toolName: string, args: Record<string, unknown> | undefined): string {
  if (toolName === 'browser_navigate') return hostOf(typeof args?.url === 'string' ? args.url : '')
  if (validTabId(args?.tabId)) return hostOf(browserTabUrls.get(args.tabId) || '')
  return hostOf(activeBrowserUrl)
}

/**
 * 返回授权阶段绑定的 host。Pi Agent 会把同一个已校验 args 对象从 beforeToolCall 交给 execute，
 * 所以确认等待期间即使标签发生导航，执行端仍携带原授权 host，由扩展与真实 tab 二次核对。
 */
export function targetHostForCommand(toolName: string, args: Record<string, unknown> | undefined): string {
  const bound = args && authorizedHostByArgs.get(args)?.get(toolName)
  return bound !== undefined ? bound : currentTargetHost(toolName, args)
}

export function getPolicyState(conversationId?: string) {
  const p = load()
  const grants = conversationId ? sessionHostGrants.get(conversationId) : undefined
  return {
    allowlist: p.allowlist,
    blocklist: p.blocklist,
    sessionGrants: grants ? Array.from(grants) : []
  }
}

/** 对一条浏览器写命令做站点轴决策。conversationId 省略 = 只看持久 allow/blocklist(不含本对话授权) */
export function decideForCommand(
  toolName: string,
  args: Record<string, unknown> | undefined,
  conversationId?: string
): { decision: BrowserDecision; host: string } {
  const host = currentTargetHost(toolName, args)
  if (args) {
    let hosts = authorizedHostByArgs.get(args)
    if (!hosts) {
      hosts = new Map()
      authorizedHostByArgs.set(args, hosts)
    }
    hosts.set(toolName, host)
  }
  return { decision: decideBrowserAction(host, getPolicyState(conversationId)), host }
}

/** 「本对话允许」此 host */
export function grantSessionHost(conversationId: string, host: string): void {
  if (!conversationId || !host) return
  if (!sessionHostGrants.has(conversationId)) sessionHostGrants.set(conversationId, new Set())
  sessionHostGrants.get(conversationId)!.add(host)
}

/** 「始终允许此站点」—— 写入持久 allowlist */
export function grantAlwaysHost(host: string): void {
  if (!host) return
  const p = load()
  if (!p.allowlist.includes(host)) {
    p.allowlist.push(host)
    save()
  }
}

/** 拉黑某 host —— 写入持久 blocklist */
export function blockHost(host: string): void {
  if (!host) return
  const p = load()
  if (!p.blocklist.includes(host)) {
    p.blocklist.push(host)
    save()
  }
}

/** 换对话/对话结束时清掉本对话授权 */
export function clearSessionGrants(conversationId: string): void {
  if (conversationId) sessionHostGrants.delete(conversationId)
}
