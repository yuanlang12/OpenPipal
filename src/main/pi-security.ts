/**
 * Pi Security — 三层安全模型
 *
 * Layer 1: 工具风险分类器（beforeToolCall）
 *   → safe: 自动放行
 *   → risky: 阻止，Agent 自动换方案
 *   → needs_confirmation: 升级到 Layer 2
 *
 * Layer 2: 用户确认（IPC 弹窗 / dialog）
 *   → 设置安全上限后自动拒绝
 *
 * Layer 3: 硬性边界（不可绕过）
 *   → 敏感路径黑名单
 *   → 系统目录禁写
 *   → 符号链接追踪
 *
 * 参考：Claude Code auto mode（分类器 + 升级）、LobsterAI（纵深防御）
 * 详细文档：docs/security/security-model.md
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { isSandboxed, syncSandboxWorkspaceRoots } from './sandbox-manager'
import { decideForCommand } from './browser-policy-store'
import { getWorkingDir } from './config-manager'
import { decideGitAccess, detectGitRemoteUse } from './git-policy'
import { grantSessionProject, hasGitGrant, resolveProjectKey } from './git-policy-store'
import { containsReceiptPlaceholder } from './tool-content-compactor'
import { dataPath, getDataRoot } from './data-root'
import { normalizeCodeExecutionLanguage } from './code-execution-language'
import {
  deniedWorkspaceRootsFor,
  isCaseInsensitivePathPlatform,
  isDriveRoot,
  osSandboxAvailableOnPlatform,
  sensitiveDirsFor,
  systemDirsFor
} from './security-paths'
import {
  discoveryRootContainsPluginMcpConfig,
  ENV_TEMPLATE_BASENAMES,
  getAuditLogPath,
  getCredentialDiscoveryDenyRoots,
  getCredentialReadDenyPaths,
  getPluginsRootPath,
  isEnvTemplateBasename,
  isPluginMcpConfigPath,
  SENSITIVE_READ_GLOBS
} from './credential-paths'

const HOME = os.homedir()

/** artifact sidecar 根目录——write/edit 直写这里会绕过 edit_artifact/create_artifact 的截断检测与 jsx 重编译（Workstream B1） */
const ARTIFACTS_SIDECAR_ROOT = dataPath('conversations', 'artifacts')
const OPENPIPAL_ROOT = getDataRoot()
const OPENPIPAL_AGENTS_ROOT = dataPath('agents')
const OPENPIPAL_CONVERSATIONS_ROOT = dataPath('conversations')
const OPENPIPAL_OUTPUTS_ROOT = dataPath('outputs')

/**
 * 模拟 pi-coding-agent write/edit 工具的 resolveToCwd：~ 展开 + 相对路径按 agent 当前工作目录解析。
 * 只用于 write/edit 的 artifact 目录判定——不能用字面 '~' 或 process.cwd() 比前缀，两者都会算错。
 */
function resolveAgentPath(filePath: string, workingDir = getWorkingDir()): string {
  let p = filePath
  if (p === '~') p = HOME
  else if (p.startsWith('~/')) p = path.join(HOME, p.slice(2))
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(workingDir, p)
}

// =====================================================================
// 内联权限请求全局状态（供会话流模式使用）
// =====================================================================

export type PermissionRequestSettlementCause =
  | 'response'
  | 'abort'
  | 'timeout'
  | 'send-failed'

/** Maximum human-response window for nested MCP write confirmations. */
export const MCP_PERMISSION_TIMEOUT_MS = 3_600_000

export interface PermissionRequestSettlement {
  requestId: string
  approved: boolean
  cause: PermissionRequestSettlementCause
}

type PendingPermissionResolver = (
  approved: boolean,
  cause?: PermissionRequestSettlementCause
) => void

// 保存待处理权限请求的解析器
export const pendingPermissionResolvers = new Map<string, PendingPermissionResolver>()

let permissionRequestSettlementHandler: (
  settlement: PermissionRequestSettlement
) => void = () => undefined

/**
 * Observe the single settlement point of runtime-neutral permission requests.
 * IPC/HTTP adapters use this to clear request ownership metadata on response,
 * abort, timeout, and send failure without coupling the Runtime to a transport.
 */
export function setPermissionRequestSettlementHandler(
  handler: ((settlement: PermissionRequestSettlement) => void) | null
): void {
  permissionRequestSettlementHandler = handler || (() => undefined)
}

function notifyPermissionRequestSettlement(
  requestId: string,
  approved: boolean,
  cause: PermissionRequestSettlementCause
): void {
  try {
    permissionRequestSettlementHandler({ requestId, approved, cause })
  } catch (error) {
    // Metadata observers must never change an allow/deny decision or strand the
    // Agent promise. Their cleanup is best-effort and independently idempotent.
    console.error('[Security] 权限请求收尾通知失败:', requestId, error)
  }
}

// 内联权限请求发送函数（由 ipc-handlers 设置）
let sendInlinePermissionRequestFn: ((getWindow: () => BrowserWindow | null, request: any) => void) | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null

/**
 * 设置内联权限请求发送器。
 * 这个函数由主进程在启动时调用，注入 IPC 发送函数。
 */
export function setInlinePermissionSender(
  fn: typeof sendInlinePermissionRequestFn,
  getWindow: () => BrowserWindow | null
): void {
  sendInlinePermissionRequestFn = fn
  getWindowRef = getWindow
}

/**
 * 解析权限请求（由 IPC 处理器调用）
 */
export function resolvePermissionRequest(requestId: string, approved: boolean): void {
  const resolve = pendingPermissionResolvers.get(requestId)
  if (resolve) {
    pendingPermissionResolvers.delete(requestId)
    try {
      resolve(approved, 'response')
    } finally {
      notifyPermissionRequestSettlement(requestId, approved, 'response')
    }
  }
}

// =====================================================================
// Layer 3: 硬性边界（不可绕过）
// =====================================================================

/**
 * 敏感目录——即使在 homedir 内也绝对拒绝访问。
 * 目录清单按平台取（security-paths.ts）：POSIX 那套点目录各平台通用，Windows 再补上
 * %APPDATA% 下同一批工具的凭据位置（gh / gcloud / gnupg / PowerShell 历史）。
 */
const SENSITIVE_DIRS = sensitiveDirsFor(process.platform, HOME, process.env).concat([
  // Keep the rest of the data root available for legitimate memories and
  // artifacts while hard-denying every authoritative credential location.
  ...getCredentialReadDenyPaths(),
])

/** 系统目录——禁止写入（Windows 上是 %SystemRoot% / Program Files / ProgramData） */
const SYSTEM_DIRS = systemDirsFor(process.platform, process.env)

/**
 * 允许操作的目录白名单。
 *
 * **这张表被两个层消费，而它们的匹配语义不一样**——加条目前先想清楚要哪一层生效：
 *   - `isAllowedPath()`（本文件的授权层）把每条都过一遍 `resolveRealPath`，所以 `/tmp`
 *     会解析成 `/private/tmp`，**能匹配上**；
 *   - 沙箱 profile（`sandbox-manager.ts` 的 `allowWrite`）拿到的是这里的**原始字符串**，
 *     渲染成 `(subpath "/tmp")`，而 seatbelt 比的是内核给的真实路径 `/private/tmp`，
 *     **匹配不上**。
 * 于是 `/tmp` 今天是"授权层放行、沙箱不放行"：结构化文件工具判 safe，真去写时 bash 那边
 * 拿 EPERM。方向是偏严不是偏松，不构成安全问题，所以没顺手"修"——把沙箱那条对齐等于
 * 把整个 `/private/tmp` 放开给 bash 写，那是扩大写权限，要单独决定。
 * 别删 `/tmp`：授权层那一半是活的，`tests/bench/*` 六个脚本的 scratch 默认就在
 * `/tmp/opb-shadow`（`os.tmpdir()` 在 macOS 是 `/var/folders/…/T`，盖不住它）。
 */
const ALLOWED_DIRS = [
  getDataRoot(),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Downloads'),
  '/tmp',
  os.tmpdir(),
]

/**
 * 解析成磁盘上的真实路径。
 *
 * 必须用 `realpathSync.native`：它走内核（macOS 上是 F_GETPATH），返回**磁盘真实大小写**；
 * JS 版的 realpathSync 只跟符号链接，大小写原样返回。而 macOS 默认 APFS 不区分大小写，
 * 本文件所有边界判定（pathWithin / SENSITIVE_DIRS / SYSTEM_DIRS / ALLOWED_DIRS）都是字节
 * 前缀比较——不规范化的话，`~/.SSH` 与 `~/.ssh` 是同一个目录却比不上，整层黑名单被大小写
 * 变体绕过。native 版对不存在的路径同样抛错，所以下面那套逐级回退原样保留。
 */
function realpathCanonical(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    // native 在极少数情况下（超长路径等）会失败，退回 JS 实现总比放弃解析强。
    return fs.realpathSync(p)
  }
}

/** 解析真实路径（追踪符号链接 + 规范化大小写） */
function resolveRealPath(filePath: string): string {
  const visitedLinks = new Set<string>()

  const resolveAddressedPath = (input: string): string => {
    const addressed = path.resolve(input)
    try {
      return realpathCanonical(addressed)
    } catch {
      // Continue so new paths and dangling symlinks can still be classified.
    }

    const tail: string[] = []
    let cursor = addressed
    while (true) {
      try {
        const stat = fs.lstatSync(cursor)
        if (stat.isSymbolicLink()) {
          if (visitedLinks.size >= 40 || visitedLinks.has(cursor)) {
            return path.join(path.parse(addressed).root, '__openpipal_unresolvable_symlink__')
          }
          visitedLinks.add(cursor)
          const target = fs.readlinkSync(cursor)
          return resolveAddressedPath(path.resolve(path.dirname(cursor), target, ...tail))
        }
        try {
          return path.join(realpathCanonical(cursor), ...tail)
        } catch {
          return path.join(path.parse(addressed).root, '__openpipal_unresolvable_symlink__')
        }
      } catch {
        const parent = path.dirname(cursor)
        if (parent === cursor) return addressed
        tail.unshift(path.basename(cursor))
        cursor = parent
      }
    }
  }

  return resolveAddressedPath(filePath)
}

/** @internal Deterministic test seam for the hard path boundary. */
export function canonicalizeSecurityPath(filePath: string): string {
  return resolveRealPath(filePath)
}

/** Canonical product-integrity guard; the optional root is an isolated test seam. */
export function isArtifactSidecarPath(
  filePath: string,
  artifactRoot = ARTIFACTS_SIDECAR_ROOT
): boolean {
  return pathWithin(resolveRealPath(filePath), resolveRealPath(artifactRoot))
}

/**
 * 比较用的规范形。Windows 折叠大小写：那里 realpath 对不存在的路径原样返回、盘符大小写
 * 随调用方，`c:\Users\x\.SSH` 与 `C:\Users\x\.ssh` 是同一个目录，字节比较会放过它
 * （理由与 macOS 那边为什么**不**折叠见 security-paths 的 isCaseInsensitivePathPlatform）。
 */
function comparablePath(p: string): string {
  return isCaseInsensitivePathPlatform() ? p.toLowerCase() : p
}

function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b)
}

function pathWithin(candidate: string, root: string): boolean {
  const c = comparablePath(candidate)
  const r = comparablePath(root)
  if (c === r) return true
  // 盘根 / 根目录自带尾分隔符，再拼一个会让 `C:\Users` 与 `C:\` 比不上
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * 拦下来的是哪一类凭据。**分类不是为了改判据，是为了把话说准**——
 * 三类共用一句「属于敏感目录（如 .ssh、.aws）」时，助手撞上工作目录里的 `.env`
 * 会被告知那是个「敏感目录」，于是它去猜是不是路径写错了、要不要换个目录，
 * 而真正的原因是「这个文件里是密钥」。判据一个字没动，只是让拒绝的理由和事实对上。
 */
type SensitivePathKind = 'dotenv' | 'plugin-mcp' | 'credential-dir'

/** 拒绝理由。第二人称、说清「为什么」和「还能做什么」，别让模型去猜。 */
function sensitivePathReason(kind: SensitivePathKind, resolvedPath: string): string {
  switch (kind) {
    case 'dotenv':
      // 模板名单从 credential-paths 直接取：写死一份 prose 的话，名单一改，
      // 这句话就会向模型陈述一条已经不成立的规则——而说准正是这个函数存在的理由。
      return `${resolvedPath} 是 dotenv 文件，里面是密钥，不对助手开放。`
        + `只有模板（${ENV_TEMPLATE_BASENAMES.join(' / ')}）可以读，且一律不能写。`
    case 'plugin-mcp':
      return `${resolvedPath} 是插件的 MCP 配置，里面存着服务器凭据，禁止访问。`
    case 'credential-dir':
      return `${resolvedPath} 在凭据目录里（.ssh / .aws / .gnupg / ~/.openpipal 这类），禁止访问。`
  }
}

function classifySensitivePath(filePath: string, readOnly = false): SensitivePathKind | null {
  const real = resolveRealPath(filePath)
  const addressed = path.resolve(filePath)
  // Provider dotenv files can live in any user-selected workspace. Treat both
  // the addressed and canonical basenames as credentials so symlink aliases
  // cannot bypass the structured read tools' boundary.
  // `.env.example` 这类**模板**不算凭据：它们本来就提交在版本库里给人看
  // （判据与放行理由见 credential-paths.ts 的 `isEnvTemplateBasename`）。
  //
  // **只在只读访问上放行**。这道判据是读写共用的总闸：不加 `readOnly` 门的话，
  // 模板会一路落到下面 `WRITE_FILE_TOOLS` 分支，而那里 `isSandboxed()` 为真时直接返回
  // `safe`——于是装机版里助手能**静默覆写**别人仓库里已提交的 `.env.example`。
  // 2026-08-28 第一版就漏了这道门，评审逮到、真机复现过（dev 下是 needs_confirmation，
  // 沙箱下是 safe，所以只跑单测看不出来）。放宽读是有代价证据的，放宽写没有。
  //
  // 两个候选名都得是模板才放行——软链名和真实名不一致时按最严的算。
  const isDotEnv = [addressed, real].some(candidate => /^\.env/i.test(path.basename(candidate)))
    && !(readOnly && [addressed, real].every(candidate => isEnvTemplateBasename(path.basename(candidate))))
  const pluginsRoot = getPluginsRootPath()
  const isPluginCredential = isPluginMcpConfigPath(addressed, pluginsRoot)
    || isPluginMcpConfigPath(real, resolveRealPath(pluginsRoot))
  if (isDotEnv) return 'dotenv'
  if (isPluginCredential) return 'plugin-mcp'
  const inCredentialDir = SENSITIVE_DIRS.some(d => (
    pathWithin(addressed, path.resolve(d))
    || pathWithin(real, resolveRealPath(d))
  ))
  return inCredentialDir ? 'credential-dir' : null
}

/** Whether a recursive/discovery root would include a sensitive entry. */
function containsSensitivePath(filePath: string): boolean {
  const real = resolveRealPath(filePath)
  const addressed = path.resolve(filePath)
  const pluginsRoot = getPluginsRootPath()
  return discoveryRootContainsPluginMcpConfig(addressed, pluginsRoot)
    || discoveryRootContainsPluginMcpConfig(real, resolveRealPath(pluginsRoot))
    || getCredentialDiscoveryDenyRoots().some(d => (
    pathWithin(path.resolve(d), addressed)
    || pathWithin(resolveRealPath(d), real)
  ))
}

/** 检查路径是否在系统目录 */
function isSystemPath(filePath: string): boolean {
  const real = resolveRealPath(filePath)
  return SYSTEM_DIRS.some(d => pathWithin(real, d))
}

/**
 * 会话工作目录能不能当"允许根"。
 *
 * ALLOWED_DIRS 是编译期常量，只覆盖 ~/Documents|Desktop|Downloads、/tmp 和数据根——
 * 代码仓库住在 ~/code、~/work、/Volumes/… 是常态，落在表外时六个结构化文件工具会被
 * 判 risky 并硬拒（没有弹窗、没有会话放行），而目录选择器又不校验，症状是"选完了，
 * 一动手全拒、且无声"。这里让用户显式选定的那个目录成为允许根，但只放行"足够窄"的：
 * 整个家目录、/Users、/Volumes、根目录这类会把整台机器带进来的一律不算。
 *
 * 这不放松 Layer 3：具体文件仍要过敏感目录（.ssh/.aws/凭证）与系统目录检查，
 * 那两道在 classifyToolRisk 里跑在本函数之前，工作目录再宽也绕不过去。
 */
export type WorkspaceRootRejection =
  | 'empty'        // 没给目录
  | 'not_found'    // 目录不存在
  | 'not_dir'      // 给的是文件不是目录
  | 'too_broad'    // 家目录 / /Users / 根目录这类，等于把整台机器放进来
  | 'system'       // 系统目录
  | 'sensitive'    // 目录本身或其下含凭证文件

export interface WorkspaceRootVerdict {
  ok: boolean
  /** 不通过的机器可读原因——渲染层按它取 i18n 文案，不要直接展示 reason */
  code?: WorkspaceRootRejection
  /** 主进程日志用的中文原因（渲染层没有对应文案时的兜底） */
  reason?: string
  /** 参与判定的规范化路径，给 UI 拼进提示 */
  resolved?: string
}

/** 不能当工作根的目录——分 equal / subtree 两类，理由与清单见 security-paths.ts */
function deniedWorkspaceRoots(): { equal: string[]; subtree: string[] } {
  return deniedWorkspaceRootsFor(process.platform, HOME, process.env)
}

/**
 * 家目录下形如 `~/.foo` 的**单层**点目录一律不当工作根（~/.claude、~/.ssh、~/.openpipal、
 * ~/.cargo…都是工具的私产，不是项目）。只挡这一层：`~/.openpipal/workspace` 是我们自己的
 * 默认工作区，必须继续可用。
 */
function isBareHomeDotDir(real: string): boolean {
  return samePath(path.dirname(real), HOME) && path.basename(real).startsWith('.')
}

export function assessWorkspaceRoot(dir: string | null | undefined): WorkspaceRootVerdict {
  if (!dir || typeof dir !== 'string' || !dir.trim()) {
    return { ok: false, code: 'empty', reason: '没有指定目录' }
  }
  const addressed = resolveAgentPath(dir.trim(), HOME)
  let stat: fs.Stats
  try {
    stat = fs.statSync(addressed)
  } catch {
    return { ok: false, code: 'not_found', reason: `目录不存在：${addressed}`, resolved: addressed }
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'not_dir', reason: `不是目录：${addressed}`, resolved: addressed }
  }
  const real = resolveRealPath(addressed)
  // 过宽 / 系统 / 敏感三类一律不接受。注意比的是 real——符号链接指回家目录、
  // 或大小写变体（macOS 默认不区分大小写）都已经在 resolveRealPath 里规范化掉。
  const denied = deniedWorkspaceRoots()
  // isDriveRoot：Windows 上 `D:\` 这类非系统盘的盘根不在 equal 表里（表里只有家目录所在的盘），
  // 但拿整块盘当工作根同样等于把整台机器放进来。
  if (isDriveRoot(real) || denied.equal.some(root => samePath(real, resolveRealPath(root)))) {
    return { ok: false, code: 'too_broad', reason: `目录太宽，会把整台机器都放进工作范围：${real}`, resolved: real }
  }
  if (denied.subtree.some(root => pathWithin(real, resolveRealPath(root))) || isBareHomeDotDir(real)) {
    return { ok: false, code: 'too_broad', reason: `这是系统或工具的私有目录，不是项目目录：${real}`, resolved: real }
  }
  // 别人的家目录：在 /Users 下但不在自己家里
  if (pathWithin(real, resolveRealPath(path.dirname(HOME))) && !pathWithin(real, resolveRealPath(HOME))) {
    return { ok: false, code: 'too_broad', reason: `不是当前用户的目录：${real}`, resolved: real }
  }
  if (isSystemPath(real) || SYSTEM_DIRS.some(d => pathWithin(path.resolve(d), real))) {
    return { ok: false, code: 'system', reason: `系统目录不能作为工作目录：${real}`, resolved: real }
  }
  // 工作目录整个不许落在凭据上，读写一视同仁——所以这里**不传 readOnly**：
  // 模板放行是给单个文件的读操作开的口子，不是给「拿凭据目录当工作根」开的。
  if (classifySensitivePath(real) !== null || containsSensitivePath(real)) {
    return { ok: false, code: 'sensitive', reason: `该目录包含凭证文件，不能作为工作目录：${real}`, resolved: real }
  }
  return { ok: true, resolved: real }
}

/**
 * 工作目录当允许根时的规范化路径；不合格返回 null（不合格 = 只剩 ALLOWED_DIRS 那张表）。
 * 每次文件工具分类都会走到这里，而工作目录在一次会话里几乎不变——按输入字符串记忆一格，
 * 省掉每次 stat + realpath。目录被删或被换成文件属于跨会话事件，下次换目录自然失效。
 */
let _workspaceRootMemo: { key: string; value: string } | null = null
function workspaceAllowRoot(dir: string | null | undefined): string | null {
  if (!dir) return null
  if (_workspaceRootMemo?.key === dir) return _workspaceRootMemo.value
  const verdict = assessWorkspaceRoot(dir)
  // **只缓存成功**。失败缓存会让"目录后来变可用了"永远恢复不了：工作目录在外置盘上、
  // 开机时盘还没挂载，启动期那次判定写进 null，用户插上硬盘后本进程再也认不出来，
  // 症状恰好就是这次要根治的"一动手全拒且无声"。失败本来就是异常路径，多跑一次 stat 无所谓。
  if (!verdict.ok) {
    _workspaceRootMemo = null
    return null
  }
  _workspaceRootMemo = { key: dir, value: verdict.resolved! }
  return verdict.resolved!
}

/** 工作目录变更后清掉记忆（换目录 / 目录被移走都要重新判一次） */
export function invalidateWorkspaceRootCache(): void {
  _workspaceRootMemo = null
}

/**
 * 沙箱 allowWrite 用的工作根集合。
 *
 * 分层约定：**分类器是精确闸门，沙箱是粗网**。每次工具调用都按本次会话的 workingDir
 * 精确判定（isAllowedPath），而 OS 沙箱是进程级的、一次配置对所有会话生效，做不到按
 * 会话收窄——多个会话可以各带各的工作目录同时在跑，所以这里是并集。
 *
 * ⚠️ 并集对 bash / execute_code 是**真实的写权限**，不是"只少了 OS 那一层"：这两个工具
 * 的分类器分支只看危险命令正则和 isSandboxed()，完全不做路径归属判定，OS 沙箱是它们
 * 唯一的写边界。所以集合里多留一个根 = 那个根对 bash 一直可写。为此在用户显式换全局
 * 工作目录时整表重置（见 replaceGlobalWorkspaceRoot）——那是用户在说"我不干那个项目了"；
 * 仍在跑的会话会在下一次工具调用时把自己的根重新登记回来，自愈且失败方向是收紧。
 */
const _sandboxWorkspaceRoots = new Set<string>()
let _sandboxRootsDirty = false

/** 登记一个工作根供沙箱放行；不合格返回 null（此时沙箱维持原样） */
export function registerWorkspaceRoot(dir: string | null | undefined): string | null {
  const root = workspaceAllowRoot(dir)
  if (!root) return null
  if (!_sandboxWorkspaceRoots.has(root)) {
    _sandboxWorkspaceRoots.add(root)
    _sandboxRootsDirty = true
  }
  return root
}

/**
 * 授权链路每次工具调用都会走到这里。登记本身是「memo 命中 + Set.has」两步，
 * 真正贵的 updateConfig 只在集合确实变大时才发一次。
 *
 * 挂在 authorizeToolCall 而不是 createSecurityHook：现役的 pi-core 主循环是自己
 * new PiCoreToolAuthorizer（pi-core-runtime.ts:489），根本不经过 createSecurityHook——
 * 挂错地方就是「登记了但实体从未创建」那类静默落空，症状是沙箱始终不认新目录。
 */
function noteActiveWorkspaceRoot(dir: string | null | undefined): void {
  registerWorkspaceRoot(dir)
  if (!_sandboxRootsDirty) return
  _sandboxRootsDirty = false
  void syncSandboxWorkspaceRoots()
}

export function listWorkspaceRoots(): string[] {
  return Array.from(_sandboxWorkspaceRoots)
}

/**
 * 用户显式换了全局工作目录：整表重置成新根，不再累积。
 * 见上方并集说明——旧根留着等于对 bash 一直可写。
 */
export function replaceGlobalWorkspaceRoot(dir: string | null | undefined): string | null {
  _sandboxWorkspaceRoots.clear()
  _workspaceRootMemo = null
  const root = registerWorkspaceRoot(dir)
  _sandboxRootsDirty = true
  return root
}

/** 仅供测试：清空登记表 */
export function resetWorkspaceRoots(): void {
  _sandboxWorkspaceRoots.clear()
  _sandboxRootsDirty = false
  _workspaceRootMemo = null
}

/** 检查路径是否在允许目录内（ALLOWED_DIRS ∪ 本次会话的工作目录） */
function isAllowedPath(filePath: string, workingDir?: string | null): boolean {
  if (!filePath) return false
  const real = resolveRealPath(filePath)
  if (ALLOWED_DIRS.some(d => pathWithin(real, resolveRealPath(d)))) return true
  const root = workspaceAllowRoot(workingDir)
  return !!root && pathWithin(real, root)
}

/**
 * 内置资源根（打包 = app Resources、开发 = 仓库 resources/）——**只读**白名单补充。
 * 技能索引/角色种子发给模型的就是这里的绝对路径（如 …/Resources/skills/<name>/SKILL.md）；
 * 曾被 ALLOWED_DIRS 误拦（2026-07-22 实案：read 连续被拒 → 模型降级用 bash cat 读 SKILL.md，
 * 既丑又浪费轮次）。开发模式仓库住 ~/Documents 下所以从未暴露——打包版专属盲区。
 * 只对 READONLY_FILE_TOOLS 生效，写类工具照旧拒绝（内置资源必须只读）。
 */
let _builtinRoots: string[] | null = null
export function isBuiltinResourcePath(filePath: string): boolean {
  if (!filePath) return false
  // 根路径进程生命周期内不变——惰性算一次缓存（每次 2 个 realpath syscall 省掉）
  if (!_builtinRoots) {
    const roots: string[] = []
    // 根与目标同过一遍 realpath——macOS 的 /var→/private/var 符号链接会让裸前缀比较失配
    if (process.resourcesPath) roots.push(resolveRealPath(process.resourcesPath))
    try {
      const { app } = require('electron')
      if (app?.getAppPath) roots.push(resolveRealPath(path.join(app.getAppPath(), 'resources')))
    } catch { /* 非 electron 环境（单测）→ 仅认 process.resourcesPath */ }
    _builtinRoots = roots
  }
  const roots = _builtinRoots
  if (!roots.length) return false
  const real = resolveRealPath(filePath)
  return roots.some(d => pathWithin(real, d))
}

// =====================================================================
// Layer 1: 工具风险分类器
// =====================================================================

export type RiskLevel = 'safe' | 'risky' | 'needs_confirmation'

export interface RiskAssessment {
  level: RiskLevel
  reason: string
  /**
   * 这一次确认**不许被"完全允许"档吃掉**。
   *
   * 用来区分两种 needs_confirmation：一种是"别老打扰我"（改文件、可逆的破坏性命令），
   * 用户选 full 就是在说这个；另一种是隐私暴露面（主目录/全盘遍历会触发 TCC 连环授权、
   * 读遍桌面与 iCloud），那不是打扰，是另一件事的知情同意，不该被一次"别问我了"顺带关掉。
   */
  alwaysConfirm?: boolean
}

export interface ToolScope {
  conversationId?: string
  workspaceId?: string
  workingDir?: string
  /** Canonical filesystem capability root for unattended internal agents. */
  assignedRoot?: string
  /** Remote MCP names are untrusted and must not inherit built-in semantics. */
  origin?: 'local' | 'mcp'
}

export interface OpenPipalTenantRoots {
  root: string
  agents: string
  conversations: string
  artifacts: string
  outputs: string
}

const DEFAULT_TENANT_ROOTS: OpenPipalTenantRoots = {
  root: OPENPIPAL_ROOT,
  agents: OPENPIPAL_AGENTS_ROOT,
  conversations: OPENPIPAL_CONVERSATIONS_ROOT,
  artifacts: ARTIFACTS_SIDECAR_ROOT,
  outputs: OPENPIPAL_OUTPUTS_ROOT
}

function expandHome(input: string): string {
  return input === '~' ? HOME : input.startsWith('~/') ? path.join(HOME, input.slice(2)) : input
}

function inside(candidate: string, root: string, workingDir?: string): boolean {
  const expanded = expandHome(candidate)
  const addressed = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workingDir || process.cwd(), expanded)
  const resolved = resolveRealPath(addressed)
  const base = resolveRealPath(root)
  return pathWithin(resolved, base)
}

/**
 * 遍历类命令（find/rg/du/tree、grep -r、ls -R；PowerShell 的 Get-ChildItem -Recurse）的目标
 * 是否是主目录根 / /Users（C:\Users）/ 全盘。命中返回提示语（needs_confirmation 用），未命中 null。
 * 只认"遍历根 = 主目录本身或更上层"，明确子目录（~/Documents/code、~/Desktop/xx）不拦——
 * 防线对准的是隐私暴露面，不是读操作本身。
 *
 * platform / home 是测试接缝：Windows 的 token 形状（`C:\`、`/c/`、`%USERPROFILE%`、
 * `$env:USERPROFILE`）在 macOS 上要用 path.win32 才算得出来。
 */
export function detectHomeWideScan(
  command: string,
  platform: NodeJS.Platform = process.platform,
  home: string = HOME
): string | null {
  const traversal = /\b(?:find|rg|du|tree)\b/.test(command) ||
    /\bgrep\b[^|;&]*\s-[A-Za-z]*[rR]/.test(command) ||
    /\bls\b[^|;&]*\s-[A-Za-z]*R/.test(command) ||
    /\b(?:Get-ChildItem|gci|dir|ls)\b[^|;&\n]*\s-Rec(?:urse)?\b/i.test(command)
  if (!traversal) return null
  const win32 = platform === 'win32'
  const p = win32 ? path.win32 : path.posix
  const fold = (value: string): string => (win32 ? value.toLowerCase() : value)
  // 目标 token：独立出现的 ~ / $HOME / %USERPROFILE% / $env:USERPROFILE / /Users[/<name>] /
  // 盘根 `C:\` / `C:\Users[\<name>]` / Git Bash 的 `/c/` / 裸 /（后面紧跟空白、引号、命令分隔或行尾才算）
  const scan = command
    .replace(/\$env:userprofile/gi, '$env:USERPROFILE')
    .replace(/%userprofile%/gi, '%USERPROFILE%')
  const tokens = scan.match(
    /(?:^|[\s"'`=])(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|\/Users(?:\/[A-Za-z0-9._-]+)?\/?|[A-Za-z]:[\\/](?:Users(?:[\\/][A-Za-z0-9._-]+)?[\\/]?)?|\/[a-z]\/(?:Users(?:\/[A-Za-z0-9._-]+)?\/?)?|\/)(?=[\s"'`;|&)]|$)/g
  ) || []
  const resolveTarget = (t: string): string => {
    if (t === '~' || t === '$HOME' || t === '$env:USERPROFILE' || t === '%USERPROFILE%') return home
    if (win32) {
      // Git Bash 把盘符写成 /c/…；PowerShell 与 cmd 用 C:\…
      const gitBashDrive = t.match(/^\/([a-z])(\/.*)?$/)
      if (gitBashDrive) return p.resolve(`${gitBashDrive[1].toUpperCase()}:\\${(gitBashDrive[2] || '').slice(1)}`)
    }
    return p.resolve(t)
  }
  for (const raw of tokens) {
    const t = raw.replace(/^[\s"'`=]+/, '')
    const resolved = resolveTarget(t)
    const wholeMachine = win32 ? isDriveRoot(resolved, 'win32') : resolved === '/'
    const usersRoot = win32 ? fold(resolved) === fold(p.dirname(home)) : resolved === '/Users'
    if (wholeMachine || usersRoot || fold(resolved) === fold(home)) {
      return win32
        ? `命令要遍历用户目录/整块磁盘（${t}）——会触达桌面、文档、下载等隐私目录。如确有必要请确认；若在找随消息发来的图片，存盘路径已在消息中注明，无需搜索`
        : `命令要遍历主目录/全盘（${t}）——会触达桌面、iCloud、照片、音乐等隐私目录并触发系统授权弹窗。如确有必要请确认；若在找随消息发来的图片，存盘路径已在消息中注明，无需搜索`
    }
  }
  return null
}

/**
 * OpenPipal 内部目录是多租户数据，不应因为 OS 沙箱允许 ~/.openpipal 就彼此可见。
 * 这里只收紧本产品自己的 agents/conversations 边界，不限制用户显式给出的 Documents 等路径。
 */
export function assessToolScope(toolName: string, args: any, scope: ToolScope): RiskAssessment | null {
  return assessToolScopeWithRoots(toolName, args, scope, DEFAULT_TENANT_ROOTS)
}

/** @internal Exported for deterministic tenant-boundary tests with an isolated home. */
export function assessToolScopeWithRoots(
  toolName: string,
  args: any,
  scope: ToolScope,
  roots: OpenPipalTenantRoots
): RiskAssessment | null {
  const discoveryTool = ['find', 'grep', 'ls'].includes(toolName)
  const requestedPath = extractPath(args)
  const directPath = requestedPath || (discoveryTool ? (scope.workingDir || getWorkingDir()) : null)
  const checkInternalPath = (candidate: string): RiskAssessment | null => {
    const p = expandHome(candidate)
    if (inside(p, roots.agents, scope.workingDir)) {
      const own = scope.workspaceId ? path.join(roots.agents, scope.workspaceId) : ''
      if (!own || !inside(p, own, scope.workingDir)) {
        return { level: 'risky', reason: '禁止读取其他 Agent 的工作区；请只使用当前任务挂载的工作目录、记忆和技能' }
      }
    }
    if (inside(p, roots.conversations, scope.workingDir)) {
      const ownArtifacts = scope.conversationId ? path.join(roots.artifacts, scope.conversationId) : ''
      // 自己会话的 JSON 与 artifact sidecar 都属于"当前任务自身的数据"，不是跨租户越界
      const ownConvJson = scope.conversationId
        ? path.join(roots.conversations, `${scope.conversationId}.json`)
        : ''
      const allowed = (ownArtifacts && inside(p, ownArtifacts, scope.workingDir)) ||
        (ownConvJson && resolveRealPath(resolveAgentPath(p, scope.workingDir)) === resolveRealPath(ownConvJson))
      if (!allowed) {
        return { level: 'risky', reason: '禁止扫描其他对话数据；历史对话不会自动挂载到当前任务' }
      }
    }
    return null
  }

  if (directPath && typeof directPath === 'string') {
    const denied = checkInternalPath(directPath)
    if (denied) return denied
    if (discoveryTool && (
      inside(directPath, roots.outputs, scope.workingDir)
      || resolveRealPath(resolveAgentPath(directPath, scope.workingDir)) === resolveRealPath(roots.root)
    )) {
      return { level: 'risky', reason: '禁止枚举 OpenPipal 的共享历史目录；请使用当前任务已知的具体路径' }
    }
  }

  if (toolName !== 'bash' && toolName !== 'shell' && toolName !== 'powershell') return null
  const command = String(args?.command || '')
  if (!command) return null
  const broadDiscovery = /\b(?:find|rg|grep|ls|Get-ChildItem|gci|dir)\b/i.test(command)

  // Bash 参数不是结构化路径，针对 OpenPipal 自有根目录做明确的租户边界判定。
  // 先抓绝对/~ 路径；命令里只写 `.openpipal/...` 的情况再用关键目录兜底。
  const pathTokens = command.match(/(?:~|\/Users\/[^/\s"'`|;&]+|\/home\/[^/\s"'`|;&]+)?\/?\.openpipal\/[^\s"'`|;&]*/g) || []
  for (const token of pathTokens) {
    const candidate = token.startsWith('.openpipal/') ? path.join(HOME, token) : token
    if (broadDiscovery && resolveRealPath(resolveAgentPath(candidate, scope.workingDir)) === resolveRealPath(roots.root)) {
      return { level: 'risky', reason: '禁止枚举整个 OpenPipal 数据目录；请使用当前任务挂载的工作区或具体路径' }
    }
    const denied = checkInternalPath(candidate)
    if (denied) return denied
  }

  // outputs 目前没有会话子目录；允许读取明确文件，但禁止 find/rg/grep/ls 之类枚举整个共享根。
  // 这切断截图中的“顺手把所有历史产物拉回上下文”，同时保留已知导出文件的后续处理。
  if (broadDiscovery && (command.includes(roots.outputs) || command.includes('~/.openpipal/outputs'))) {
    return { level: 'risky', reason: '禁止枚举所有历史 outputs；请使用当前任务已知的具体产物路径' }
  }
  return null
}

// ---- 只读工具（safe）----
const READONLY_TOOLS = new Set([
  'read_screen', 'read_page_content', 'recall_memory',
  'web_search', 'capture_screenshot',
  'mcp_execute', 'read_artifact',
])

// ---- 文件工具按读写分组（均先过 ALLOWED_DIRS 路径验证）----
// 只读发现类验证后免确认；写类继续走 artifact sidecar 封锁 + 沙箱分级。
// 实案教训：ls/find/grep 实体补上后漏了这里 → 每次列目录弹确认，一次内联请求挂满 1800s 超时
// 发现类 = 省略 path 时默认扫**整个工作目录**的那几个（对比 read：不给 path 就没得读）。
// 单列一张表是因为下面要用它判两件不同的事——「path 省略时补哪个根」和「要不要查递归会不会
// 扫进凭据目录」——而这两处以前各自写死了一遍 `ls || find || grep`。
// 是 READONLY_FILE_TOOLS 的子集：加一个新的发现类工具，两张表都得进。
const DISCOVERY_FILE_TOOL_NAMES = ['ls', 'find', 'grep']
const DISCOVERY_FILE_TOOLS = new Set(DISCOVERY_FILE_TOOL_NAMES)
const READONLY_FILE_TOOLS = new Set(['read', 'read_file', ...DISCOVERY_FILE_TOOL_NAMES])
const WRITE_FILE_TOOLS = new Set(['write', 'edit', 'write_file', 'create_file'])

// ---- MCP 工具名前缀分类 ----
const MCP_WRITE_PREFIXES = ['create_', 'add_', 'edit_', 'modify_', 'update_', 'set_']
const MCP_DESTRUCTIVE_PREFIXES = ['delete_', 'remove_', 'drop_', 'stop_', 'end_']

// ---- 代码执行中的删除类 API（execute_code 的 python/js 与 bash rm 同权确认）----
const DESTRUCTIVE_CODE_RE = /\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\.unlink\s*\(|\bsend2trash\b|\bfs\.(rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir)\b|\brimraf\b/

/**
 * 命令位置：行首、或紧跟在 `;` `&&` `||` `|` `(` 之后。
 *
 * 之前 `eval` / `exec` 用的是裸 `\bword\b`，于是 `npm run test:eval`、
 * `npx vitest run src/eval.test.ts`、`npm exec tsc` 全被当危险命令硬拒——它们里的
 * eval/exec 是脚本名和子命令，不是 shell 内建。只在命令位置匹配，既保住防绕过的原意，
 * 又不再打日常命令。
 */
function atCommandPosition(word: string, flags = ''): RegExp {
  return new RegExp(String.raw`(?:^|[\n;&|(])\s*${word}\b`, flags)
}

/**
 * 危险命令分两档——依据是 CLAUDE.md 的判定公式「如果模型是完美的，这机制还需要吗？」
 *
 * blocked（永久硬边界）：不可逆、或越过沙箱的信任模型。完美的模型也不该在别人机器上
 * 干这些，所以不给放行通道。
 *
 * confirm（交给用户裁决）：在编码工作里是**日常操作**——回滚一次失败的改动、清掉
 * node_modules 重装、强推一个自己的分支。硬拒它们不是安全，是让 agent 在需要回滚时
 * 走投无路；而且此前只拦 bash 这一条通道，模型转头用 python subprocess 就绕过去了
 * （2026-07-26 实案：rm 被拦 → 改用 shutil.rmtree 把上个会话的产物删了）。
 * 现在三条通道同一套判据、同一档结果：要么都问，要么都拦，不再有"堵一扇门开一扇窗"。
 */
const IRREVERSIBLE_COMMANDS: Array<[RegExp, string]> = [
  [/\bsudo\b/, 'sudo 提权'],
  [/\bmkfs\b/, '格式化文件系统'],
  [/\bdd\s+if=/, 'dd 裸设备写入'],
  [/\b(curl|wget)\b[^\n]*\|\s*(ba|z|k)?sh\b/, '把下载内容直接喂给 shell'],
  [/\b(chmod|chown)\b.*\b777\b/, '把权限改成 777'],
  [atCommandPosition('eval'), 'shell eval'],
  [atCommandPosition('exec'), 'shell exec'],
  // ---- PowerShell / cmd（Windows 的 powershell 工具，以及 bash 里嵌的 `pwsh -c` 同一张表）----
  // 对应关系：Format-Volume ≈ mkfs、`irm … | iex` ≈ `curl | sh`、Invoke-Expression ≈ eval、
  // RunAs/runas ≈ sudo、icacls Everyone ≈ chmod 777。HKLM 是机器级注册表，删了整机受影响。
  [/\b(?:Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk)\b/i, '格式化或抹掉磁盘分区'],
  // `format` 只认后面直接跟盘符的写法：python 的 `format(x)` 也会出现在行首
  [/(?:^|[\n;&|(])\s*format(?:\.com)?\s+[A-Za-z]:/i, '格式化磁盘（format）'],
  [/(?:^|[\n;&|(])\s*diskpart\b/i, '改动磁盘分区（diskpart）'],
  [/\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest|curl|wget)\b[^\n]*\|\s*(?:iex|Invoke-Expression|pwsh|powershell)\b/i, '把下载内容直接喂给 PowerShell'],
  [atCommandPosition('Invoke-Expression', 'i'), 'PowerShell Invoke-Expression'],
  // `iex` 别名只认 PowerShell 的用法（后面跟 $var / ( / 引号 / -Command，或直接收尾如 `… | iex`）：
  // Elixir 的 REPL 也叫 iex，`iex -S mix` 是日常命令，不能一并硬拒
  [/(?:^|[\n;&|(])\s*iex(?:\s+[($"'`]|\s+-Command\b|(?=\s*(?:$|[\n;&|)])))/i, 'PowerShell Invoke-Expression（iex）'],
  [/\bStart-Process\b[^\n]*-Verb\s+RunAs\b/i, '提权运行（Start-Process -Verb RunAs）'],
  [/(?:^|[\n;&|(])\s*runas(?:\.exe)?\s/i, '提权运行（runas）'],
  [/\breg(?:\.exe)?\s+delete\s+HKLM\b/i, '删机器级注册表（reg delete HKLM）'],
  [/\bRemove-Item\b[^\n]*\bHKLM:/i, '删机器级注册表（Remove-Item HKLM:）'],
  [/\b(?:Stop-Computer|Restart-Computer)\b/i, '关机 / 重启'],
  [/(?:^|[\n;&|(])\s*shutdown(?:\.exe)?\s+[/-]/i, '关机 / 重启（shutdown）'],
  [/\bSet-MpPreference\b[^\n]*-Disable/i, '关闭 Defender 防护'],
  [/\bicacls\b[^\n]*\/grant[^\n]*\b(?:Everyone|\*S-1-1-0)\b/i, '把权限放给 Everyone'],
]

const DESTRUCTIVE_COMMANDS: Array<[RegExp, string]> = [
  // rm 的开关可以连写也可以分开：-rf / -r -f / --recursive / --force
  [/\brm\s+(-[a-zA-Z]*[rRfF]|--recursive\b|--force\b)/, '递归或强制删除（rm）'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fdx]/, 'git clean'],
  // --force-with-lease 恰恰是 --force 的安全替代，不能一起拦
  [/\bgit\s+push\b[^\n;&|]*(--force(?!-with-lease)\b|\s-f\b)/, 'git push 强推'],
  // 不能写 `\b-delete\b`：`\b` 要求非词字符与词字符相邻，而 `-` 前面是空格——两边都是
  // 非词字符，边界不成立，这条规则原本从来没有命中过（继承自旧的 DANGEROUS_BASH_PATTERNS）
  [/\bfind\b.*(?:^|\s)-delete\b/, 'find -delete'],
  // ---- PowerShell / cmd 的递归或强制删除。bash 那条 `rm -r` 规则对 PowerShell 的 rm 别名同样命中，
  // 这里补的是它认不出的写法：Remove-Item -Recurse/-Force、rd /s /q、del /s /q、`gci … | Remove-Item`
  [/\b(?:Remove-Item|ri|rmdir|rd|del|erase)\b[^\n;|&]*(?:\s-Recurse\b|\s-Force\b|\s-rf?\b|\s-fo\b|\s\/[sSqQ]\b)/i, '递归或强制删除（Remove-Item / rd / del）'],
  [/\|\s*(?:Remove-Item|ri|del|erase)\b/i, '管道批量删除（… | Remove-Item）'],
  // HKLM 版本在上面是硬拒；用户自己的注册表项（HKCU 等）与回收站交给用户裁决
  [/\breg(?:\.exe)?\s+delete\b/i, '删注册表项（reg delete）'],
  [/\bRemove-Item\b[^\n]*\bHK(?:CU|U|CR|CC):/i, '删注册表项（Remove-Item HKCU:）'],
  [/\bClear-RecycleBin\b/i, '清空回收站'],
]

export type DestructiveTier = 'blocked' | 'confirm'
export interface DestructiveVerdict { tier: DestructiveTier; label: string }

/**
 * 把参数数组式的调用摊平成近似命令行，让 python/js 通道也能被同一套判据看见：
 * `subprocess.run(["git", "reset", "--hard"])` → `subprocess.run( git   reset   --hard )`。
 * 只用于 confirm 档——多问一次的代价远小于漏过；blocked 档仍只看原文，避免字符串里
 * 提一句 sudo 就把整段代码硬拒。
 */
function flattenArgvLiterals(code: string): string {
  return code.replace(/['"`,[\]]/g, ' ')
}

/** 三条通道（bash / execute_code(bash) / execute_code(python|js)）共用的危险判据 */
export function assessDestructiveCommand(text: string, isShell: boolean): DestructiveVerdict | null {
  if (!text) return null
  for (const [re, label] of IRREVERSIBLE_COMMANDS) {
    if (re.test(text)) return { tier: 'blocked', label }
  }
  const scanned = isShell ? [text] : [text, flattenArgvLiterals(text)]
  for (const [re, label] of DESTRUCTIVE_COMMANDS) {
    if (scanned.some(candidate => re.test(candidate))) return { tier: 'confirm', label }
  }
  return null
}

// ---- bash 直写 artifact sidecar 旁路封锁 ----
// write/edit 工具已锁死 ARTIFACTS_SIDECAR_ROOT（见下方 write/edit 分支），但 bash 里的
// cp/重定向/sed -i 能绕过 edit_artifact 的截断检测 + create_artifact 的 jsx 重编译。
// 必须识别真正的写入目标，不能只看整条命令里是否同时出现 sidecar 路径和写命令：
// `cp sidecar/source.png /tmp/review.png` 的 sidecar 只是只读来源，误拦会把模型逼进 OCR/沙箱绕路。
// 宁可漏拦（变量拼接的怪写法）不可误拦（误拦会把模型逼向更怪的绕路）。
const ARTIFACT_SIDECAR_PATH_RE = /conversations[\\/]+artifacts\b/i

function shellTokens(segment: string): string[] {
  return (segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) || [])
    .map(token => {
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1)
      }
      return token
    })
}

function artifactPathIn(value: string | undefined): boolean {
  return Boolean(value && ARTIFACT_SIDECAR_PATH_RE.test(value))
}

function commandWritesArtifactSidecar(command: string): boolean {
  // 仅做有界 shell 解析：按常见控制符拆成简单命令，再检查每个写命令的目标参数。
  // 引号内含控制符属于少见动态写法，按上方"宁可漏拦不可误拦"原则不扩成全 shell AST。
  const segments = command.split(/&&|\|\||[;|\n]/)
  for (const segment of segments) {
    const tokens = shellTokens(segment)
    if (tokens.length === 0) continue

    // `>` / `>>`（含 `2>/path`、`>/path`）的下一个 token或同 token 尾部就是写入目标。
    for (let i = 0; i < tokens.length; i++) {
      const redirect = tokens[i].match(/^\d*(>>?)(.*)$/)
      if (!redirect) continue
      const target = redirect[2] || tokens[i + 1]
      if (artifactPathIn(target)) return true
    }

    let commandIndex = tokens.findIndex(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    if (commandIndex < 0) continue
    if (path.basename(tokens[commandIndex]) === 'env') {
      commandIndex++
      while (commandIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex])) commandIndex++
    }
    // PowerShell 的 cmdlet 与别名不分大小写；把 `Copy-Item` / `Set-Content` 这类写命令
    // 折成小写后和 cp/tee 走同一套"目标操作数"判定（Windows 上 bash 与 powershell 都要拦）
    const executable = path.basename(tokens[commandIndex] || '').toLowerCase()
    const args = tokens.slice(commandIndex + 1)
    const operands = args.filter(arg => arg !== '--' && !arg.startsWith('-'))

    if (['cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'cpi', 'mi'].includes(executable)) {
      // cp/mv 的最后一个操作数是目标；前面的 sidecar 路径都只是来源。
      if (artifactPathIn(operands.at(-1))) return true
    } else if ([
      'tee', 'mkdir', 'touch', 'rm',
      'set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'remove-item', 'ri', 'del', 'md'
    ].includes(executable)) {
      if (operands.some(artifactPathIn)) return true
    } else if (executable === 'sed' && args.some(arg => arg === '-i' || arg.startsWith('-i'))) {
      // sed -i 会原地改写文件，出现的 sidecar 文件就是写入目标。
      if (args.some(artifactPathIn)) return true
    }
  }
  return false
}

/**
 * 没有 OS 沙箱的平台上给用户看的那句话——确认卡上每条命令都带着它。
 * 说的是事实（边界 = 你的账号权限），不是安抚。
 */
export const NO_SANDBOX_SHELL_NOTICE = '本平台没有系统沙箱，这条命令会以你的账号权限直接执行'

/**
 * 命令 / 代码文本里有没有**写明**的凭据路径。
 *
 * 只在没有 OS 沙箱的平台上用（Windows）：那里 `cat ~/.ssh/id_rsa` 与 `ls` 的差别只剩一张
 * 确认卡，而人对确认卡的反应是习惯性点允许。文本判据认不全（变量拼接、子解释器），
 * 所以它不替代逐条确认，只把最直白的那一类从「问用户」提到「直接拦」。
 *
 * 按 token 找**路径形状**的片段，不做整串子串匹配：`process.env.X` 里的 `.env` 不是路径，
 * 项目根下的 `.npmrc` 是仓库配置不是家目录凭据——所以家目录专属的那几个文件名要求 token
 * 以家目录标记（~、$HOME、%USERPROFILE%、/Users/x、C:\Users\x）开头。反斜杠先折成正斜杠，
 * 一张表同时盖住 bash 与 PowerShell 的写法。
 */
const CREDENTIAL_PATH_PATTERNS: Array<[RegExp, string, 'anywhere' | 'home']> = [
  [/(^|\/)\.(?:ssh|aws|gnupg|kube|docker|password-store|credentials)(\/|$)/i, '.ssh / .aws 这类凭据目录', 'anywhere'],
  [/(^|\/)\.(?:git-credentials|netrc|npmrc|gitconfig\.local)$/i, '家目录下的 git / npm 凭据文件', 'home'],
  [/(^|\/)\.config\/(?:gh|hub|gcloud)(\/|$)/i, 'CLI 登录凭据（gh / gcloud）', 'anywhere'],
  [/(^|\/)\.config\/git\/credentials$/i, 'git 凭据文件', 'anywhere'],
  // %APPDATA% 既可能已展开（…/AppData/Roaming/…）也可能还是变量（$env:APPDATA、%APPDATA%）
  [/(?:appdata\/roaming|\$env:appdata|%appdata%)\/(?:github cli|gcloud|gnupg)(\/|$)/i, '%APPDATA% 下的 CLI 凭据', 'anywhere'],
  [/(?:appdata\/(?:roaming|local)|\$env:(?:local)?appdata|%(?:local)?appdata%)\/microsoft\/credentials(\/|$)/i, 'Windows 凭据管理器的落盘', 'anywhere'],
  [/(^|\/)(?:\.bash_history|\.zsh_history|consolehost_history\.txt)$/i, 'shell 命令历史', 'anywhere'],
]

const HOME_MARKER_RE = /^(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+|\/[a-z]\/Users\/[^/]+)\//i

/** 数据根里真正装凭据的那几个位置，相对数据根、已折成正斜杠（从 credential-paths 算，不手抄一份） */
function credentialDataRootEntries(): string[] {
  const root = getDataRoot()
  return getCredentialReadDenyPaths()
    .map(p => path.relative(root, p).split(path.sep).join('/'))
    .filter(rel => rel && !rel.startsWith('..'))
}

export function detectCredentialPathReference(text: string): string | null {
  if (!text) return null
  const dataRootName = path.basename(getDataRoot())
  const dataRootEntries = credentialDataRootEntries()
  for (const rawToken of shellTokens(text)) {
    const token = rawToken.replace(/\\/g, '/')
    for (const [re, label, where] of CREDENTIAL_PATH_PATTERNS) {
      if (!re.test(token)) continue
      if (where === 'home' && !HOME_MARKER_RE.test(token)) continue
      return label
    }
    // dotenv：`.env` / `.env.local` 拦，`.env.example` 这类模板放行（与结构化读工具同一条规则）
    const dotenv = token.match(/(?:^|\/)(\.env(?:\.[^/]+)?)$/i)
    if (dotenv && !isEnvTemplateBasename(dotenv[1])) return 'dotenv 文件'
    // ~/.openpipal 下的 config.json / oauth / tasks 等——数据根其余部分（workspace、skills、memory）照常可用
    const inDataRoot = token.match(new RegExp(`(?:^|/)${escapeRegExp(dataRootName)}/(.+)$`, 'i'))
    if (inDataRoot) {
      const rest = inDataRoot[1].toLowerCase()
      if (dataRootEntries.some(entry => rest === entry.toLowerCase() || rest.startsWith(`${entry.toLowerCase()}/`))) {
        return `~/${dataRootName} 里的配置与凭据文件`
      }
    }
  }
  return null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从工具参数中提取文件路径 */
function extractPath(args: any): string | null {
  if (!args || typeof args !== 'object') return null
  return args.path || args.file_path || args.filePath || args.directory || args.dir || null
}

/**
 * 核心分类器：评估单次工具调用的风险等级。
 */
export function classifyToolRisk(
  toolName: string,
  args: any,
  scope: Pick<ToolScope, 'workingDir' | 'origin'> = {}
): RiskAssessment {
  // A remote MCP server controls both the name and implementation of its
  // tools. Never let a name such as `read`, `save_memory`, or `get_account`
  // inherit a built-in auto-approval branch.
  if (scope.origin === 'mcp') {
    return { level: 'needs_confirmation', reason: `远程 MCP 工具需确认: ${toolName}` }
  }
  // mcp_execute: 沙箱隔离，内部 MCP 调用由 pi-mcp-bridge 的 buildToolsApi 安全检查
  // （旧版 call_mcp_tool 解包逻辑已移除，安全检查移至沙箱桥接层）

  // ---- Layer 3 硬性边界（路径检查优先）----
  const requestedFilePath = extractPath(args)
  // 工具真正会用的那个工作目录：显式 scope 优先，否则用全局配置的。相对路径解析、
  // discovery 的默认根、允许根判定三处必须用同一个值，否则会出现"按 A 解析、按 B 判"。
  const effectiveWorkingDir = scope.workingDir || getWorkingDir()
  // Discovery tools default to the active working directory when path is
  // omitted. Authorize the same effective path the tool will actually scan;
  // otherwise `grep({ pattern })` from the data root bypasses the explicit
  // config.json check by searching `.`.
  const discoveryRoot = DISCOVERY_FILE_TOOLS.has(toolName)
  const filePath = requestedFilePath || (discoveryRoot ? effectiveWorkingDir : null)
  const resolvedFilePath = filePath ? resolveAgentPath(filePath, scope.workingDir) : null
  if (filePath) {
    // 只读工具（read/read_file 与 ls/find/grep 这类发现）才享受 dotenv 模板放行；
    // write/edit 一律按凭据拦死，理由见 classifySensitivePath 里那段。
    const readOnlyAccess = READONLY_FILE_TOOLS.has(toolName)
    const sensitiveKind = classifySensitivePath(resolvedFilePath!, readOnlyAccess)
    if (sensitiveKind) {
      return { level: 'risky', reason: sensitivePathReason(sensitiveKind, resolvedFilePath!) }
    }
    if (discoveryRoot && containsSensitivePath(resolvedFilePath!)) {
      return {
        level: 'risky',
        reason: `${resolvedFilePath} 下面就是凭据目录，整个递归会把密钥一起读出来，禁止访问。换一个更具体的子目录。`
      }
    }
    if (isSystemPath(resolvedFilePath!)) {
      return { level: 'risky', reason: `路径 ${resolvedFilePath} 属于系统目录，禁止操作` }
    }
  }

  // ---- 只读工具 → safe ----
  if (READONLY_TOOLS.has(toolName)) {
    return { level: 'safe', reason: '只读工具' }
  }

  // ---- bash/shell/powershell 命令检查 ----
  if (toolName === 'bash' || toolName === 'shell' || toolName === 'powershell') {
    const command: string = args?.command || ''
    // artifact sidecar 旁路封锁（Layer 3 硬性边界，沙箱与否都拦）：见上方常量定义注释
    if (commandWritesArtifactSidecar(command)) {
      return { level: 'risky', reason: 'artifact 内容必须走 edit_artifact / create_artifact；bash 直写 sidecar 会绕过编译与完整性护栏（grep/cat/ls 只读核查不受限）' }
    }
    const destructive = assessDestructiveCommand(command, true)
    if (destructive?.tier === 'blocked') {
      // 不可逆 / 越过沙箱信任模型的那一档：有沙箱也拦（Layer 3 硬性边界）
      return { level: 'risky', reason: `检测到危险命令（${destructive.label}）: ${command.substring(0, 80)}` }
    }
    // Shell text is not a reliably parseable filesystem policy boundary: a
    // sensitive path can be assembled through variables, substitutions, or a
    // child interpreter. If the OS sandbox is unavailable, confirmation alone
    // cannot guarantee that OpenPipal credentials remain unreadable.
    //
    // 两种"没沙箱"要分开：macOS / Linux 本该有沙箱却没起来，是故障，fail-closed 整条禁掉；
    // Windows 根本没有可用的 OS 沙箱，禁掉等于这个平台永远没有 shell——那里改成
    // **每条命令交给用户裁决**（需确认，本次会话只记住完全相同的那一条），确认卡上写明
    // 边界是用户自己的账号权限；文本上认得出的凭据路径直接拦，不给「点允许」的机会。
    const unsandboxed = !isSandboxed()
    if (unsandboxed && osSandboxAvailableOnPlatform()) {
      return { level: 'risky', reason: '系统沙箱未启用，已安全禁用 Shell 执行' }
    }
    if (unsandboxed) {
      const credentialRef = detectCredentialPathReference(command)
      if (credentialRef) {
        return { level: 'risky', reason: `命令触到了凭据路径（${credentialRef}）。没有系统沙箱兜底时禁止执行；请换一个不涉及凭据文件的做法。` }
      }
    }
    // 破坏性但可逆的那一档放在沙箱判定之后：沙箱故障时 shell 整条已被禁，
    // 先判会得到「rm -rf 只要确认、ls 反而硬拒」的倒挂。
    if (destructive?.tier === 'confirm') {
      // alwaysConfirm：这一档是「交给用户裁决」的破坏性操作（rm -rf / git reset --hard /
      // git clean / 强推）。它们在编码工作里是日常操作所以没被硬拒，但**裁决人是用户**——
      // "完全允许"表达的是嫌弹框烦，不是授权 agent 自己决定要不要抹掉未提交的改动。
      // 少问这一次省下几秒，问漏一次可能是别人半天的活。
      return {
        level: 'needs_confirmation',
        reason: `${destructive.label}: ${command.substring(0, 80)}`,
        alwaysConfirm: true
      }
    }
    // 主目录/全盘遍历防线（2026-07-22 实案：模型找不到粘贴图 → `find /Users/xxx -name image.png`
    // 全盘扫描，触发 iCloud/桌面/音乐等 TCC 连环授权弹窗）。读操作虽无破坏性，但隐私暴露面 =
    // 整个主目录；**不因沙箱降级**——沙箱管写与网络，不管读隐私。升级为需用户确认；
    // 具体子目录（~/Documents/code 等）不受影响。
    const homeScan = detectHomeWideScan(command)
    if (homeScan) {
      // alwaysConfirm：隐私边界与"要不要每次问"无关，完全允许档也得问（见 RiskAssessment 注释）
      return { level: 'needs_confirmation', reason: homeScan, alwaysConfirm: true }
    }
    if (unsandboxed) {
      // 普通命令在无沙箱平台上：需确认，但**不带 alwaysConfirm**——用户选了"完全允许"就是在说
      // 「这台 Windows 上我信任它跑命令」，那是用户的决定；破坏性与隐私那两档在上面仍然每次问。
      return { level: 'needs_confirmation', reason: `${NO_SANDBOX_SHELL_NOTICE}: ${command.substring(0, 80)}` }
    }
    return { level: 'safe', reason: `沙箱保护下执行: ${command.substring(0, 80)}` }
  }

  // ---- ask_user / questions_v2 → safe（它们本身就是在问用户）----
  if (toolName === 'ask_user' || toolName === 'questions_v2') {
    return { level: 'safe', reason: '用户交互工具' }
  }

  // ---- save_memory → safe（写入自有数据目录）----
  if (toolName === 'save_memory') {
    return { level: 'safe', reason: '写入 OpenPipal 数据目录' }
  }

  // ---- create_artifact / create_visualizer / edit_artifact / render_artifact / update_todos → safe（生成/修改/自检前端预览；edit 只写 artifacts sidecar 目录，render 在隐藏沙箱窗口只读渲染；update_todos 只回写 todos artifact）----
  if (toolName === 'create_artifact' || toolName === 'create_visualizer' || toolName === 'edit_artifact' || toolName === 'render_artifact' || toolName === 'update_todos') {
    return { level: 'safe', reason: '生成前端预览内容' }
  }

  // ---- export_artifact → safe（参数只有 id + format 两个短字符串；只读已有 artifact、只写
  //      ~/.openpipal/outputs/ 自有目录，不接触敏感路径，非破坏性）----
  if (toolName === 'export_artifact') {
    return { level: 'safe', reason: '导出产物到 OpenPipal 输出目录' }
  }

  // ---- get_environment / present_to_user → safe（Phase 6d）----
  // get_environment 纯读状态；present_to_user 推到 OpenPipal 自己的 Presenter 窗口或通过 Cmd+V 触发
  // 用户可见的粘贴（用户正在看当前应用，能立刻感知结果），非后台破坏性操作
  if (toolName === 'get_environment' || toolName === 'present_to_user') {
    return { level: 'safe', reason: 'OpenPipal 展示工具（环境查询 / 内容推送）' }
  }

  // ---- subagent → safe（subagent 工具本身只是委派，真正执行子任务的工具由 child Agent
  //      自己经过同一套 classifyToolRisk 分级；这里把"委派"动作本身视为零副作用）----
  if (toolName === 'subagent') {
    return { level: 'safe', reason: '委派子 agent（子 agent 内部工具走自身风险分级）' }
  }

  // ---- 浏览器控制（chrome.debugger 作用于用户真实 Chrome profile）----
  // 读类零副作用 → safe；写类的"按站点放行 / 超出确认 + 对话内复用"由 Phase 4 站点轴策略接管。
  // 此处为 Phase 4 接管前的保守占位：写操作一律需确认。
  if (toolName === 'browser_list_tabs') {
    return { level: 'safe', reason: '浏览器只读：列标签（仅元数据）' }
  }
  if (toolName === 'browser_read_page' || toolName === 'browser_screenshot') {
    // 读默认免问;但拉黑站点是"完全不碰"的硬边界 —— 读取/截图也禁
    const { decision, host } = decideForCommand(toolName, args)
    if (decision === 'block') return { level: 'risky', reason: `站点已被拉黑，禁止读取：${host}` }
    return { level: 'safe', reason: '浏览器只读操作（读正文 / 截图）' }
  }
  if (toolName.startsWith('browser_')) {
    // 站点轴:持久 blocklist→硬拒;持久 allowlist→放行;其余→需确认。
    // 「本对话允许」过的 host 在 createSecurityHook 里(有 conversationId)再判一次。
    const { decision, host } = decideForCommand(toolName, args)
    if (decision === 'block') return { level: 'risky', reason: `站点已被拉黑：${host}` }
    if (decision === 'allow') return { level: 'safe', reason: `已信任站点：${host}` }
    return { level: 'needs_confirmation', reason: `浏览器操作 ${toolName}${host ? ' @ ' + host : ''}` }
  }

  // ---- execute_code → 沙箱可用时 safe，否则需确认 ----
  // 实案（2026-07-26）：bash rm 被危险命令拦截后，模型改用 python shutil.rmtree 清场，
  // 把前一会话的组件三件套删了；write 被回执门闩拦截后也曾改走 python 写文件。
  // 这里把删除类 API 与回执门闩提到 isSandboxed 之前——python/js 通道与 bash/write 同权。
  if (toolName === 'execute_code') {
    const code = String(args?.code || '')
    if (containsReceiptPlaceholder(code)) {
      return { level: 'risky', reason: `已拒绝：code 里包含"[内容已保存…]"占位回执——那是上下文压缩标记不是正文，请先 read 取回真实内容再写入。` }
    }
    const lang = normalizeCodeExecutionLanguage(args?.language)
    if (!lang) {
      return { level: 'risky', reason: `不支持的代码语言: ${String(args?.language || '(空)')}` }
    }
    // 与 bash 通道同一套判据、同一档结果——此前只有 lang==='bash' 才过危险命令表，
    // python 里 subprocess 调 git reset --hard 是静默放行的。
    const destructiveCode = assessDestructiveCommand(code, lang === 'bash')
    if (destructiveCode?.tier === 'blocked') {
      return { level: 'risky', reason: `代码包含危险操作（${destructiveCode.label}），已安全阻止` }
    }
    // Arbitrary Python/JavaScript/Bash can construct sensitive paths in ways a
    // source regex cannot soundly recognize. Fail closed unless the execution
    // backend has the denyRead sandbox that protects credential files.
    // 与 bash 分支同一套两分法：沙箱故障 → 禁；平台本无沙箱（Windows）→ 逐条确认 + 凭据路径文本闸。
    const unsandboxedCode = !isSandboxed()
    if (unsandboxedCode && osSandboxAvailableOnPlatform()) {
      return { level: 'risky', reason: '系统沙箱未启用，已安全禁用代码执行' }
    }
    if (unsandboxedCode) {
      const credentialRef = detectCredentialPathReference(code)
      if (credentialRef) {
        return { level: 'risky', reason: `代码触到了凭据路径（${credentialRef}）。没有系统沙箱兜底时禁止执行；请换一个不涉及凭据文件的做法。` }
      }
    }
    if (destructiveCode?.tier === 'confirm' || DESTRUCTIVE_CODE_RE.test(code)) {
      // 与 bash 同档同待遇：完全允许档也吃不掉（否则堵了 bash 这扇门又从代码执行开一扇窗）
      return {
        level: 'needs_confirmation',
        reason: `代码包含删除/破坏性操作${destructiveCode ? `（${destructiveCode.label}）` : ''}，与 bash 同级确认`,
        alwaysConfirm: true
      }
    }
    if (unsandboxedCode) {
      return { level: 'needs_confirmation', reason: `${NO_SANDBOX_SHELL_NOTICE}（${lang} 代码）` }
    }
    return { level: 'safe', reason: '沙箱保护下执行代码' }
  }

  // ---- generate_document → safe（只写 ~/.openpipal/outputs/，非破坏性）----
  if (toolName === 'generate_document') {
    return { level: 'safe', reason: '' }
  }

  // ---- manage_task → safe（只操作 ~/.openpipal/tasks/ 元数据）----
  // 任务执行本身会走 scheduler + role 归属，真实副作用通过 bash/tool 的权限链路
  if (toolName === 'manage_task') {
    return { level: 'safe', reason: '任务元数据管理（写 OpenPipal 数据目录）' }
  }

  // ---- 文件读写操作：按路径判断（分组定义见 READONLY_FILE_TOOLS / WRITE_FILE_TOOLS）----
  if (READONLY_FILE_TOOLS.has(toolName) || WRITE_FILE_TOOLS.has(toolName)) {
    const readOnly = READONLY_FILE_TOOLS.has(toolName)
    const builtinResource = !!filePath && isBuiltinResourcePath(resolvedFilePath!)
    // Built-in skills/system-agent resources are an explicit read-only mount,
    // even when a development checkout happens to sit under Documents or a
    // test fixture sits under an otherwise writable temp root.
    if (!readOnly && builtinResource) {
      return { level: 'risky', reason: `内置资源只读，路径 ${resolvedFilePath} 不在允许的工作目录内` }
    }
    if (filePath && !isAllowedPath(resolvedFilePath!, effectiveWorkingDir) && !(readOnly && builtinResource)) {
      // 理由要能让模型自己纠偏：告诉它当前工作目录是什么，而不是只说"不允许"。
      // 否则历史行为是降级去 bash cat/sed 硬读（2026-07-22 实案），丢行号与分页语义。
      return {
        level: 'risky',
        // 只陈述事实，不指定人机流程：定时任务面没有 ask_user（source-tool-policy 剔掉了），
        // ACP 面用户根本不在 OpenPipal 界面里——指路"去重新选目录"两边都是错的。
        // 确定性归代码，判断力归模型：告诉它边界在哪，下一步由它按手上有什么工具决定。
        reason: `路径 ${resolvedFilePath} 不在允许的工作目录内（当前工作目录：${effectiveWorkingDir}）。`
          + `请在当前工作目录内操作；确需其他目录时说明原因并停止本次操作。`
      }
    }
    if (READONLY_FILE_TOOLS.has(toolName)) {
      return { level: 'safe', reason: '只读文件访问（路径已验证）' }
    }
    // 回执门闩补齐文件通道：实案——上下文压缩把历史 write 的 content 换成回执后，模型照抄回执
    // 当正文重写文件（bow-os tokens ×2、教案 21552 字符被覆写成一行占位）。artifact 三工具已在
    // pi-tools 拦截（7313616），write/edit 是当时漏掉的第四扇门。edit 只检 newText：oldText 匹配
    // 回执是合法的修复动作（把已污染文件改回正文）。
    let parsedEdits: unknown = args?.edits
    if (typeof parsedEdits === 'string') {
      try { parsedEdits = JSON.parse(parsedEdits) } catch { parsedEdits = undefined }
    }
    const nestedReceipt = Array.isArray(parsedEdits)
      && parsedEdits.some((edit) => (
        !!edit
        && typeof edit === 'object'
        && typeof (edit as any).newText === 'string'
        && containsReceiptPlaceholder((edit as any).newText)
      ))
    const receiptField = typeof args?.content === 'string' && containsReceiptPlaceholder(args.content)
      ? 'content'
      : typeof args?.newText === 'string' && containsReceiptPlaceholder(args.newText)
        ? 'newText'
        : nestedReceipt ? 'edits[].newText' : null
    if (receiptField) {
      return { level: 'risky', reason: `已拒绝：${receiptField} 里包含"[内容已保存…]"占位回执——那是上下文压缩标记不是正文，文件真实内容仍在磁盘上。请先 read 该文件取回原文再修改；若要全新创作请直接写完整内容。` }
    }
    // 封死通用 write/edit 直写 artifact sidecar（Workstream B1）：实案——模型误诊后用 write 直写
    // .jsx，绕过 edit_artifact 的截断检测/dc 逻辑校验，也不触发 create_artifact 的 jsx 重编译，
    // .compiled.js 停在旧版。bash 路径先不拦（滑坡大、误伤多，留给按需收紧）。
    if (filePath && WRITE_FILE_TOOLS.has(toolName)) {
      const resolved = resolvedFilePath!
      if (isArtifactSidecarPath(resolved)) {
        return { level: 'risky', reason: 'artifact 内容必须走 edit_artifact / create_artifact（带编译与完整性护栏；write 直写会绕过截断检测且不重编译 sidecar）' }
      }
    }
    // 沙箱可用时，文件写入降级为 safe（沙箱已限制 allowWrite 范围）
    if (isSandboxed()) {
      return { level: 'safe', reason: `沙箱保护下写入: ${filePath || '(未指定路径)'}` }
    }
    return { level: 'needs_confirmation', reason: `文件写入: ${filePath || '(未指定路径)'}` }
  }

  // ---- MCP 工具：按名称前缀推断 ----
  const lowerName = toolName.toLowerCase()

  if (MCP_DESTRUCTIVE_PREFIXES.some(p => lowerName.startsWith(p))) {
    return { level: 'needs_confirmation', reason: `MCP 破坏性操作: ${toolName}` }
  }

  if (MCP_WRITE_PREFIXES.some(p => lowerName.startsWith(p))) {
    return { level: 'needs_confirmation', reason: `MCP 写操作: ${toolName}` }
  }

  // ---- 未知工具 → needs_confirmation ----
  return { level: 'needs_confirmation', reason: `未分类工具: ${toolName}` }
}

// =====================================================================
// Layer 2: 权限确认处理器
// =====================================================================

export interface PermissionRequest {
  requestId: string
  tool: string
  args: Record<string, any>
  risk: RiskLevel
  reason: string
  conversationId?: string
  approvalScope?: SessionApprovalScope
}

/**
 * 权限处理器签名。
 * 返回 true = 批准，false = 拒绝。
 */
export type PermissionHandler = (request: PermissionRequest) => Promise<boolean>

// autoApproveHandler 已废除——浏览器扩展模式也必须走权限确认流程。
// 如果没有注入 permissionHandler，默认拒绝所有 needs_confirmation 请求。

// =====================================================================
// beforeToolCall Hook 工厂
// =====================================================================

let requestCounter = 0

// ---- 会话级权限记忆 ----
const sessionApprovals = new Map<string, Set<string>>()
const ARGUMENT_SCOPED_SESSION_TOOLS = new Set([
  'bash', 'shell', 'powershell', 'execute_code',
  'write', 'edit', 'write_file', 'create_file'
])

export interface SessionApprovalScope {
  /** Separates otherwise identical tool names owned by different trust domains. */
  namespace?: string
  /** Bind approval to the canonical arguments instead of the whole tool. */
  argumentScoped?: boolean
}

/**
 * Bind local approvals to the canonical working directory that will execute
 * the operation. Symlink aliases resolve to the same identity; switching to a
 * different directory never reuses the grant.
 */
export function localSessionApprovalScope(workingDir = getWorkingDir()): SessionApprovalScope {
  return {
    namespace: `local:${resolveRealPath(resolveAgentPath(workingDir, getWorkingDir()))}`
  }
}

function stableApprovalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic approval arguments')
    seen.add(value)
    const serialized = `[${value.map(item => stableApprovalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return serialized
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic approval arguments')
    seen.add(value)
    const serialized = `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableApprovalJson((value as Record<string, unknown>)[key], seen)}`)
      .join(',')}}`
    seen.delete(value)
    return serialized
  }
  return JSON.stringify(`[${typeof value}]`)
}

function sessionApprovalKey(
  toolName: string,
  args?: Record<string, any>,
  scope: SessionApprovalScope = {}
): string | null {
  const namespace = scope.namespace || 'local'
  const prefix = `${stableApprovalJson(namespace)}:${stableApprovalJson(toolName)}`
  if (!scope.argumentScoped && !ARGUMENT_SCOPED_SESSION_TOOLS.has(toolName)) return `${prefix}:*`
  if (!args || typeof args !== 'object') return null
  try {
    const digest = createHash('sha256').update(stableApprovalJson(args)).digest('hex')
    return `${prefix}:${digest}`
  } catch {
    return null
  }
}

/** 会话级审批：记住本次会话中允许的工具 */
export function approveToolForSession(
  toolName: string,
  conversationId?: string,
  args?: Record<string, any>,
  scope: SessionApprovalScope = localSessionApprovalScope()
): void {
  if (!conversationId) {
    // 历史 bug（2026-07-29 修）：调用方漏传 cid 时这里静默 return，"本次会话允许"从来没生效过。
    // 现在出声——真出现就是上游没把请求的 conversationId 带下来，而不是用户点了没用。
    console.warn(`[Security] 会话级审批缺 conversationId,授权被丢弃: ${toolName}`)
    return
  }
  const approvalKey = sessionApprovalKey(toolName, args, scope)
  if (!approvalKey) {
    console.warn(`[Security] 会话级审批缺参数作用域,授权被丢弃: ${toolName}`)
    return
  }
  const approvedTools = sessionApprovals.get(conversationId) || new Set<string>()
  approvedTools.add(approvalKey)
  sessionApprovals.set(conversationId, approvedTools)
  console.log(`[Security] 会话级审批: ${conversationId} → ${toolName}`)
}

/** 会话级审批命中判定（requestUserConfirmation 与 createSecurityHook 共用同一份判断） */
export function isToolApprovedForSession(
  toolName: string,
  conversationId?: string,
  args?: Record<string, any>,
  scope: SessionApprovalScope = localSessionApprovalScope()
): boolean {
  if (!conversationId) return false
  const approvalKey = sessionApprovalKey(toolName, args, scope)
  return approvalKey !== null && sessionApprovals.get(conversationId)?.has(approvalKey) === true
}

/** 清空会话级审批（新建/切换对话时调用） */
export function clearSessionApprovals(conversationId?: string): void {
  if (conversationId) {
    sessionApprovals.delete(conversationId)
    console.log(`[Security] 已清空会话级审批: ${conversationId}`)
    return
  }
  sessionApprovals.clear()
  console.log('[Security] 会话级审批已全部清空')
}

/** 默认处理器：拒绝所有 needs_confirmation（安全兜底） */
const defaultDenyHandler: PermissionHandler = async (request) => {
  console.warn(`[Security] 无权限处理器，自动拒绝: ${request.tool} — ${request.reason}`)
  return false
}

/**
 * 独立的用户确认请求 — 供 mcp_execute 沙盒内的 tools.call 使用。
 *
 * 与 createSecurityHook 的 needs_confirmation 分支复用同一套 inline permission 机制:
 * - 会话级审批命中 → 直接返回 true
 * - 否则 → postMessage 到 renderer 弹权限气泡 → 等用户点允许/拒绝 → 1 小时超时 → false
 *
 * 沙盒 tools.call 里 await 这个函数:允许 → 执行工具;拒绝 → 抛错给 AI(AI 会切回文本建议)。
 */
export async function requestUserConfirmation(
  toolName: string,
  args: Record<string, any>,
  reason: string,
  conversationId?: string,
  signal?: AbortSignal,
  approvalScope: SessionApprovalScope = localSessionApprovalScope(),
  /**
   * 这次操作实际会跑在哪个目录。只给主进程侧的「本次会话允许」用（git 按项目授权），
   * 不进渲染层载荷。必须显式传：config-manager 的 getWorkingDir() 是全局值，
   * 而每条会话可以有自己的工作目录，拿错了就会把授权记到别的仓库上。
   */
  workingDir?: string
): Promise<boolean> {
  // A cancelled run must never consume a cached approval or create a new
  // permission request. The caller checks again before invoking the remote
  // tool, which closes the approval/abort race as well.
  if (signal?.aborted) return false

  // 会话级审批:用户之前点过"本次会话允许"的工具直接放行
  if (isToolApprovedForSession(toolName, conversationId, args, approvalScope)) {
    console.log(`[Security] 会话级放行: ${conversationId} → ${toolName}`)
    return true
  }

  if (!sendInlinePermissionRequestFn || !getWindowRef) {
    console.warn(`[Security] 无内联权限发送器,自动拒绝: ${toolName}`)
    return false
  }

  const requestId = `perm_${++requestCounter}_${Date.now()}`
  // MCP 写操作涉及远程服务(Linear / Notion 等),用户看清参数、可能切去其它 app 查资料、
  // 被打断再回来都是正常的。短超时会误导 AI 认为"用户拒绝"。
  // 这里设 1 小时安全上限 — 足够覆盖任何合理思考时间,也避免真被放弃后 QuickJS 运行时永不释放。
  // 用户可以随时点 AI 回合的"停止"按钮取消,或直接关闭会话。
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (
      approved: boolean,
      cause: PermissionRequestSettlementCause = 'response'
    ): void => {
      if (settled) return
      settled = true
      pendingPermissionResolvers.delete(requestId)
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (cause !== 'response') {
        notifyPermissionRequestSettlement(requestId, approved, cause)
      }
      resolve(approved)
    }
    const onAbort = (): void => settle(false, 'abort')

    pendingPermissionResolvers.set(requestId, settle)
    timer = setTimeout(() => {
      console.warn(`[Security] 内联权限请求 1 小时未响应,自动拒绝以释放资源: ${toolName}`)
      settle(false, 'timeout')
    }, MCP_PERMISSION_TIMEOUT_MS)

    if (signal) {
      if (signal.aborted) {
        settle(false)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      sendInlinePermissionRequestFn!(getWindowRef!, {
        requestId,
        tool: toolName,
        args,
        risk: 'needs_confirmation' as RiskLevel,
        reason,
        conversationId,
        approvalScope,
        workingDir,
      })
    } catch (error) {
      console.error(`[Security] 内联权限请求发送失败,自动拒绝: ${toolName}`, error)
      settle(false, 'send-failed')
    }
  })
}

/**
 * 创建安全 hook，挂载到 Pi Agent 的 beforeToolCall。
 * @param onConfirmation needs_confirmation 级别的处理器（desktop: dialog 弹窗）
 *   不再提供 autoApprove 模式——所有环境都必须有明确的权限处理器。
 */
/**
 * 权限档位 —— 只给编码助手用的会话级开关（不做全局：日常用户不该被逼着理解这个概念）。
 *
 * - `readonly` 只看不动：写类工具连 schema 都拿不到（`filterOpenPipalTools` 收窄），
 *   这里再拦一道纵深防御——万一某条路径漏了收窄，工具名不在白名单就直接拒。
 * - `auto` 自动审核：今天的行为，缺省值。
 * - `full` 完全允许：只短路 `needs_confirmation` 那一档的弹框。
 *
 * **不可破的不变量**：`full` 绝不放行 `risky`，也绝不越过 `assessToolScope` 的任务边界。
 * 那两层拦的是敏感目录、破坏性命令、沙箱未启用、跨租户越界——它们不是"要不要打扰用户"
 * 的问题，是"这件事本来就不该发生"。用户点"完全允许"表达的是"别再问我了"，
 * 不是"把安全层关掉"。回归在 tests/unit/permission-tier.test.ts。
 */
export type PermissionTier = 'readonly' | 'auto' | 'full'

/**
 * 只读档放行的工具白名单。**显式清单而不是"名字里带 read 就放行"**——
 * 后者会把 `read_page_content` 之外将来任何叫 `read_*` 的写工具误放进来。
 *
 * 刻意不含 `bash`：它能 `echo x > file`，而"命令是不是只读"没法可靠判定
 * （`git log; rm -rf` 这种拼接一破就破）。只读档因此跑不了 `git log`——
 * 这是第一版故意选的保守面，要跑命令就切 `auto`。
 * 也不含 `subagent`：子代理自己带一整套工具，档位不会跟着传下去。
 *
 * 浏览器三个读工具与 browser-tools.ts 的 BROWSER_READ_TOOLS 必须一致
 * （不 import 是为了不把 browser-control 那条依赖链拖进安全层，改由测试钉住）。
 */
export const READONLY_TIER_TOOLS: readonly string[] = [
  'read', 'ls', 'find', 'grep',
  'read_artifact',
  'read_screen', 'capture_screenshot',
  'web_search', 'read_page_content',
  'get_environment',
  'ask_user', 'update_todos',
  'browser_list_tabs', 'browser_read_page', 'browser_screenshot'
]

export interface ToolAuthorizationOptions {
  conversationId?: string
  onConfirmation?: PermissionHandler
  scope?: Omit<ToolScope, 'conversationId'>
  /** 会话级权限档位，缺省 'auto'（= 历史行为，不传等于没这个功能） */
  tier?: PermissionTier
}

/**
 * git 凭据的项目轴门。
 *
 * 为什么单开一道门，而不是塞进 classifyToolRisk：那里没有 conversationId、也没有
 * 「用户授权过这个项目」这个状态，而这道门的全部意义就是那两样。
 *
 * **这一条是收紧不是放宽**（2026-08-23 实测）：沙箱里钥匙串 helper 是通的，
 * 而 `git push origin main` 不在破坏性命令表里（表里只有强推）、沙箱下判 `safe`——
 * 也就是说这道门加上之前，模型可以拿用户已存的凭据直接推代码，一次都不问。
 *
 * 命令认得出来才拦，认不出就当普通命令走原路（detectGitRemoteUse 已刻意偏向多认）。
 */
async function enforceGitProjectGrant(
  toolName: string,
  args: Record<string, any>,
  context: { conversationId?: string; tier: PermissionTier; workingDir?: string },
  signal?: AbortSignal
): Promise<BeforeToolCallResult | undefined> {
  if (toolName !== 'bash' && toolName !== 'shell' && toolName !== 'powershell' && toolName !== 'execute_code') return undefined
  const command = String(
    (toolName === 'execute_code' ? args?.code : args?.command) || ''
  )
  const use = detectGitRemoteUse(command)
  if (!use) return undefined

  const workingDir = context.workingDir || getWorkingDir()
  const decision = decideGitAccess(context.tier, {
    granted: hasGitGrant(workingDir, context.conversationId)
  })
  if (decision === 'allow') {
    // 完全允许档也要把授权记下来：执行层（openpipal-execution-env）按同一份授权决定
    // 要不要把 GITHUB_TOKEN 发给子进程。不记的话「完全允许」对用 gh 的人是空的。
    if (context.conversationId) grantSessionProject(context.conversationId, workingDir)
    return undefined
  }
  if (decision === 'deny') {
    const reason = `只读档不动远端：${use.label} 会用你的 git 凭据联网。要跑就请用户切到"自动审核"。`
    writeAuditLog(toolName, args, { level: 'risky', reason })
    console.warn(`[Security] 只读档阻止 git 远端操作: ${use.label}`)
    return { block: true, reason }
  }

  const project = resolveProjectKey(workingDir)
  const reason = `${use.label} 会用你的 git 凭据访问远端。允许「${project}」这个项目使用你的 git 凭据吗？`
  const approved = await requestUserConfirmation(
    toolName,
    args,
    reason,
    context.conversationId,
    signal,
    localSessionApprovalScope(workingDir),
    workingDir
  )
  if (!approved) {
    console.log(`[Security] 用户拒绝 git 项目授权: ${project}`)
    return { block: true, reason: '用户没有授权这个项目使用 git 凭据' }
  }
  // 只记本对话。持久授权走「本次会话允许」那个按钮（ipc-handlers 里落盘），
  // 免得一次误点就把某个仓库永久授权出去。
  if (context.conversationId) grantSessionProject(context.conversationId, workingDir)
  console.log(`[Security] 用户授权 git 项目: ${project}`)
  return undefined
}

/** Runtime-neutral authorization entrypoint shared by low-level Agent and AgentHarness. */
export async function authorizeToolCall(
  toolName: string,
  args: Record<string, any>,
  options: ToolAuthorizationOptions = {},
  signal?: AbortSignal
): Promise<BeforeToolCallResult | undefined> {
  const { conversationId, onConfirmation, scope, tier = 'auto' } = options
  // 本次调用用的工作根要进沙箱 allowWrite，否则分类器放行了 OS 那层还拦着。
  noteActiveWorkspaceRoot(scope?.workingDir)
  const handler = onConfirmation || defaultDenyHandler
  const approvalScope = scope?.origin === 'mcp'
    ? { namespace: 'mcp:unscoped', argumentScoped: true }
    : localSessionApprovalScope(scope?.workingDir)

  const scopeAssessment = assessToolScope(toolName, args, { ...scope, conversationId })
    if (scopeAssessment) {
      writeAuditLog(toolName, args, scopeAssessment)
      console.warn(`[Security] 任务边界阻止: ${toolName} — ${scopeAssessment.reason}`)
      return { block: true, reason: scopeAssessment.reason }
    }

    // 只读档纵深防御：正常路径上写类工具的 schema 根本不会发给模型
    // （filterOpenPipalTools 已收窄），这里兜住"某条组装路径漏了收窄"的情况。
    // 理由写清楚是给模型看的——让它知道不是工具坏了，而是这一档就不给动手，
    // 于是它会去汇报发现而不是换个工具再试一遍。
    if (tier === 'readonly' && !READONLY_TIER_TOOLS.includes(toolName)) {
      const reason = `只读档：${toolName} 会改动东西，本档只放行读取类工具。把结论告诉用户，需要动手就请用户切到"自动审核"。`
      writeAuditLog(toolName, args, { level: 'risky', reason })
      console.warn(`[Security] 只读档阻止: ${toolName}`)
      return { block: true, reason }
    }

    // git 项目轴授权：这条命令要用用户的 git 凭据吗？
    const gitBlock = await enforceGitProjectGrant(toolName, args, {
      conversationId, tier, workingDir: scope?.workingDir
    }, signal)
    if (gitBlock) return gitBlock

    // 分类
    const assessment = classifyToolRisk(toolName, args, scope)

    // 审计日志（非阻塞）
    writeAuditLog(toolName, args, assessment)

    switch (assessment.level) {
      case 'safe':
        return undefined // 放行

      case 'risky':
        console.warn(`[Security] 阻止: ${toolName} — ${assessment.reason}`)
        return { block: true, reason: assessment.reason }

      case 'needs_confirmation': {
        // 完全允许档：用户已经说过"这段活别再问我"。只吃掉这一档的弹框——
        // 上面的 risky 与 assessToolScope 走不到这里，安全层没有被关掉。
        // **远程 MCP 工具除外**：它的名字和实现都由对方控制，classifyToolRisk 把它无条件
        // 判成 needs_confirmation 正是为了不让它继承内置工具的自动放行，这里跟着守住。
        if (tier === 'full' && scope?.origin !== 'mcp' && !assessment.alwaysConfirm) {
          console.log(`[Security] 完全允许档: ${toolName}`)
          return undefined
        }

        // 浏览器站点轴:本对话已对该 host 授权 → 放行(丝滑:同站点不反复弹)
        if (toolName.startsWith('browser_') && conversationId) {
          const { decision } = decideForCommand(toolName, args, conversationId)
          if (decision === 'allow') {
            console.log(`[Security] 浏览器站点轴本对话放行: ${conversationId} → ${toolName}`)
            return undefined
  }
}

        // 会话级审批检查：用户之前选过"本次会话允许"
        if (isToolApprovedForSession(toolName, conversationId, args, approvalScope)) {
          console.log(`[Security] 会话级放行: ${conversationId} → ${toolName}`)
          return undefined
        }

        const requestId = `perm_${++requestCounter}_${Date.now()}`

        // 优先尝试内联权限请求（会话流模式）
        let approved: boolean
        if (sendInlinePermissionRequestFn && getWindowRef) {
          approved = await new Promise<boolean>((resolve) => {
            // 超时自动拒绝的窗口拉长到 30 分钟——权限卡持续显示"等你授权"，用户离开一会儿回来也还在，
            // 不会因 60s 太赶被误自动拒绝。仍设上限(非无限)：避免被阻塞的 agent 永久占用运行槽成僵尸。
            const confirmTimeoutMs = 1_800_000
            let settled = false
            let timer: ReturnType<typeof setTimeout> | null = null
            // 单一收尾:用户响应(resolvePermissionRequest 会先删 map 再调本函数)、超时、abort 都走这里,
            // 用 settled 防重复 resolve(而非依赖 map.has —— resolvePermissionRequest 已先删了 map)。
            const settle = (
              val: boolean,
              cause: PermissionRequestSettlementCause = 'response'
            ): void => {
              if (settled) return
              settled = true
              pendingPermissionResolvers.delete(requestId)
              if (timer) clearTimeout(timer)
              if (signal) signal.removeEventListener('abort', onAbort)
              if (cause !== 'response') {
                notifyPermissionRequestSettlement(requestId, val, cause)
              }
              resolve(val)
            }
            // 连接断开 / 用户点停止 → agent run abort:立刻收尾,别让生成器卡在权限 await 直到 300s
            // (Bug:连接被掐后前端已显示结束,服务端却还在僵尸等待 → "实际还在处理中")。
            const onAbort = (): void => settle(false, 'abort')

            pendingPermissionResolvers.set(requestId, settle)
            timer = setTimeout(() => {
              console.warn(`[Security] 内联权限请求超时(${confirmTimeoutMs / 1000}s)，自动拒绝:`, toolName)
              settle(false, 'timeout')
            }, confirmTimeoutMs)
            if (signal) {
              if (signal.aborted) {
                settle(false, 'abort')
                return
              }
              signal.addEventListener('abort', onAbort, { once: true })
            }
            // 发送内联权限请求到前端(浏览器走 SSE,桌面走 IPC)
            try {
              sendInlinePermissionRequestFn!(getWindowRef!, {
                requestId,
                tool: toolName,
                args,
                risk: assessment.level,
                reason: assessment.reason,
                conversationId,
                approvalScope,
              })
            } catch (error) {
              console.error(`[Security] 内联权限请求发送失败,自动拒绝: ${toolName}`, error)
              settle(false, 'send-failed')
            }
          })
        } else {
          // 回退到弹窗模式（如果有 permissionHandler）
          approved = await handler({
            requestId,
            tool: toolName,
            args,
            risk: assessment.level,
            reason: assessment.reason,
            conversationId,
            approvalScope,
          })
        }

        if (!approved) {
          console.log(`[Security] 用户拒绝: ${toolName}`)
          return { block: true, reason: '用户拒绝执行此操作' }
        }
        console.log(`[Security] 用户批准: ${toolName}`)
        return undefined // 放行
      }
    }
}

export function createSecurityHook(
  conversationId?: string,
  onConfirmation?: PermissionHandler,
  scope?: Omit<ToolScope, 'conversationId'>,
  tier?: PermissionTier
) {
  return (context: BeforeToolCallContext, signal?: AbortSignal) => authorizeToolCall(
    context.toolCall.name,
    context.args as Record<string, any>,
    { conversationId, onConfirmation, scope, tier },
    signal
  )
}

/**
 * Internal unattended agents need to write their assigned workspace without a
 * confirmation UI, but must never bypass Layer 3 or tenant boundaries. This
 * hook allows safe/confirm-class operations while hard-blocking those two
 * invariant layers and retaining the same structural audit trail.
 */
const ASSIGNMENT_SCOPED_FILE_TOOLS = new Set([
  'read', 'read_file', 'write', 'write_file', 'create_file', 'edit',
  'grep', 'find', 'ls'
])

/** Resolve the same effective path used by structured file/discovery tools. */
function assignedToolPath(
  toolName: string,
  args: Record<string, any>,
  scope: Pick<ToolScope, 'workingDir'>
): string | null {
  if (!ASSIGNMENT_SCOPED_FILE_TOOLS.has(toolName)) return null
  const requested = extractPath(args)
  if (!requested && !['grep', 'find', 'ls'].includes(toolName)) return null
  return resolveAgentPath(requested || scope.workingDir || getWorkingDir(), scope.workingDir)
}

export function createHardBoundaryHook(
  scope: Omit<ToolScope, 'conversationId'> & { assignedRoot: string }
) {
  const assignedRoot = resolveRealPath(scope.assignedRoot)
  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context?.toolCall?.name
    const args = context?.args
    if (typeof toolName !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return { block: true, reason: '工具安全上下文缺失，已阻止执行' }
    }
    const requestedPath = assignedToolPath(toolName, args as Record<string, any>, scope)
    if (requestedPath && !pathWithin(resolveRealPath(requestedPath), assignedRoot)) {
      return { block: true, reason: '内部 Agent 只能访问本次分配的工作目录' }
    }
    const scoped = assessToolScope(toolName, args, scope)
    if (scoped) {
      writeAuditLog(toolName, args as Record<string, any>, scoped)
      return { block: true, reason: scoped.reason }
    }
    const assessment = classifyToolRisk(toolName, args, scope)
    writeAuditLog(toolName, args as Record<string, any>, assessment)
    return assessment.level === 'risky'
      ? { block: true, reason: assessment.reason }
      : undefined
  }
}

// =====================================================================
// 审计日志
// =====================================================================

const AUDIT_LOG_PATH = getAuditLogPath()

/**
 * Create or repair an audit file without truncating it. The no-follow open
 * also refuses a substituted symlink instead of chmod/append following it.
 * Exported with a path parameter so tests never touch the user's real log.
 */
export function ensurePrivateAuditLogFile(filePath: string): boolean {
  const dir = path.dirname(filePath)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const flags = fs.constants.O_CREAT
      | fs.constants.O_APPEND
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0)
    const fd = fs.openSync(filePath, flags, 0o600)
    try {
      if (!fs.fstatSync(fd).isFile()) return false
      fs.fchmodSync(fd, 0o600)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Repair the authoritative audit log as part of application startup, rather
 * than waiting for the first audited tool call after an upgrade.
 */
export function initializeSecurityStorage(filePath = AUDIT_LOG_PATH): boolean {
  return ensurePrivateAuditLogFile(filePath)
}

/** Append through the no-follow descriptor so a path swap cannot redirect it. */
export async function appendPrivateAuditLogLine(filePath: string, line: string): Promise<boolean> {
  const dir = path.dirname(filePath)
  let handle: fs.promises.FileHandle | undefined
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const flags = fs.constants.O_CREAT
      | fs.constants.O_APPEND
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0)
    handle = await fs.promises.open(filePath, flags, 0o600)
    if (!(await handle.stat()).isFile()) return false
    await handle.chmod(0o600)
    await handle.writeFile(line, { encoding: 'utf8' })
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * 写入审计日志（非阻塞）。
 * 格式: [timestamp] TOOL=bash ARGS="ls -la" RESULT=safe SANDBOX=true
 */
function auditLengthBucket(length: number): string {
  if (length === 0) return '0'
  if (length <= 8) return '1-8'
  if (length <= 32) return '9-32'
  if (length <= 128) return '33-128'
  if (length <= 512) return '129-512'
  if (length <= 2048) return '513-2048'
  return '2049+'
}

function summarizeAuditValue(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') {
    return { type: 'string', lengthBucket: auditLengthBucket(value.length) }
  }
  if (Array.isArray(value)) return { type: 'array', lengthBucket: auditLengthBucket(value.length) }
  if (typeof value === 'object') {
    return {
      type: 'object',
      lengthBucket: auditLengthBucket(Object.keys(value as Record<string, unknown>).length)
    }
  }
  return { type: typeof value }
}

/** @internal Structural audit summary that never persists argument values. */
export function summarizeAuditArgs(args: Record<string, any>): string {
  try {
    const summary: Record<string, Record<string, unknown>> = {}
    for (const key of Object.keys(args || {}).sort().slice(0, 48)) {
      summary[key] = summarizeAuditValue(args[key])
    }
    return JSON.stringify(summary)
  } catch {
    return JSON.stringify({ _summary: { type: 'unavailable' } })
  }
}

function writeAuditLog(toolName: string, args: Record<string, any>, assessment: RiskAssessment): void {
  const timestamp = new Date().toISOString()
  const sandboxed = isSandboxed()
  // Keep only argument type and coarse length buckets. Exact lengths and
  // unhashed/unsalted fingerprints can disclose or enable guessing low-entropy
  // values such as PINs and phone numbers, so neither is persisted.
  const argsStr = summarizeAuditArgs(args).substring(0, 1000)
  const line = `[${timestamp}] TOOL=${toolName} ARGS=${argsStr} RESULT=${assessment.level} SANDBOX=${sandboxed}\n`
  // appendFile 非阻塞，不等待结果
  void appendPrivateAuditLogLine(AUDIT_LOG_PATH, line)
}

// =====================================================================
// 导出辅助（供测试和文档使用）
// =====================================================================

export { SENSITIVE_DIRS, SENSITIVE_READ_GLOBS, SYSTEM_DIRS, ALLOWED_DIRS }
