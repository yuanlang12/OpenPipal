/**
 * git 项目轴授权的「状态层」—— 给纯逻辑 git-policy.ts 喂数据。
 *
 *  - 持久授权：落盘 ~/.openpipal/git-policy.json（只由可信主进程写；
 *    该文件已登记进 getCredentialReadDenyPaths()，模型读不到也改不了）
 *  - 本对话授权：进程内存 Map<conversationId, Set<projectKey>>，换对话即失效
 *
 * 结构照抄 browser-policy-store 的分工，别再发明第二套。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import path from 'path'
import { getGitPolicyPath } from './credential-paths'

const FILE = getGitPolicyPath()
const DIR = path.dirname(FILE)

interface PersistedGitPolicy {
  /** 已授权项目的规范化根目录 */
  allowlist: string[]
}

let persisted: PersistedGitPolicy | null = null

function load(): PersistedGitPolicy {
  if (persisted) return persisted
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
      persisted = { allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [] }
    } else {
      persisted = { allowlist: [] }
    }
  } catch {
    persisted = { allowlist: [] }
  }
  return persisted
}

function save(): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify(persisted, null, 2))
  } catch {
    /* 落盘失败不致命：本对话授权仍在内存里生效 */
  }
}

/**
 * 规范化到磁盘真实路径。
 *
 * 必须用 `realpathSync.native`：它走内核、返回磁盘真实大小写，而 macOS 默认 APFS
 * 不区分大小写、下面的授权判定是字符串相等比较 —— 不规范化的话 `~/Code/app` 与
 * `~/code/app` 是同一个目录却比不上，用户授权过还会被反复追问；反方向则更糟，
 * 一个大小写变体就能让"精确匹配"形同虚设。同款理由见 pi-security.ts 的 resolveRealPath。
 */
function realOf(dir: string): string {
  const resolved = path.resolve(dir)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/**
 * 授权的单位是**仓库**，不是当前 cwd。
 *
 * 命令常常跑在仓库的子目录里（`packages/web` 下 `git push`）。按 cwd 精确匹配会让
 * 同一个仓库的每个子目录各问一遍；按前缀匹配又会让"授权 ~/code"顺带授权底下所有仓库。
 * 往上找到最近的 .git 就两头都躲开了：一个仓库一次授权，且不外溢到兄弟仓库。
 *
 * .git 可能是目录（普通仓库）也可能是文件（worktree / submodule），existsSync 两种都认。
 * 找不到 .git 就退回该目录本身 —— 非仓库目录里跑 git 远端命令本来就该单独授权。
 */
export function resolveProjectKey(dir: string): string {
  let current = realOf(dir)
  const root = path.parse(current).root
  while (current !== root) {
    try {
      if (existsSync(path.join(current, '.git'))) return current
    } catch {
      /* 权限问题就当没找到，继续往上 */
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return realOf(dir)
}

// 本对话授权（进程内存；换对话 / 重启即失效）
const sessionProjectGrants = new Map<string, Set<string>>()

/** 这个目录所属的项目是否已被授权用 git 凭据。 */
export function hasGitGrant(dir: string, conversationId?: string): boolean {
  if (!dir) return false
  const key = resolveProjectKey(dir)
  if (load().allowlist.includes(key)) return true
  if (!conversationId) return false
  return sessionProjectGrants.get(conversationId)?.has(key) === true
}

/** 「本次对话允许」—— 只在这条对话里记住。 */
export function grantSessionProject(conversationId: string, dir: string): void {
  if (!conversationId || !dir) return
  const key = resolveProjectKey(dir)
  if (!sessionProjectGrants.has(conversationId)) sessionProjectGrants.set(conversationId, new Set())
  sessionProjectGrants.get(conversationId)!.add(key)
}

/** 「以后这个项目都允许」—— 写持久授权。 */
export function grantAlwaysProject(dir: string): void {
  if (!dir) return
  const key = resolveProjectKey(dir)
  const policy = load()
  if (!policy.allowlist.includes(key)) {
    policy.allowlist.push(key)
    save()
  }
}

/** 撤销一个项目的持久授权（设置页/未来的"忘记这个项目"用）。 */
export function revokeProject(dir: string): void {
  if (!dir) return
  const key = resolveProjectKey(dir)
  const policy = load()
  const next = policy.allowlist.filter(entry => entry !== key)
  if (next.length !== policy.allowlist.length) {
    policy.allowlist = next
    save()
  }
}

/** 换对话 / 对话结束时清掉本对话授权。 */
export function clearSessionGitGrants(conversationId: string): void {
  if (conversationId) sessionProjectGrants.delete(conversationId)
}

/** 只读快照，供设置页展示与测试断言。 */
export function getGitPolicyState(conversationId?: string): {
  allowlist: string[]
  sessionGrants: string[]
} {
  const grants = conversationId ? sessionProjectGrants.get(conversationId) : undefined
  return {
    allowlist: [...load().allowlist],
    sessionGrants: grants ? Array.from(grants) : []
  }
}

/** 仅供单测重置模块级缓存。 */
export function __resetGitPolicyForTests(): void {
  persisted = null
  sessionProjectGrants.clear()
}
