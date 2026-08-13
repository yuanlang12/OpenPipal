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
 * 详细文档：docs/SECURITY.md
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { isSandboxed } from './sandbox-manager'
import { decideForCommand } from './browser-policy-store'
import { getWorkingDir } from './config-manager'
import { containsReceiptPlaceholder } from './tool-content-compactor'
import { dataPath, getDataRoot } from './data-root'
import { normalizeCodeExecutionLanguage } from './code-execution-language'
import {
  discoveryRootContainsPluginMcpConfig,
  getAuditLogPath,
  getCredentialDiscoveryDenyRoots,
  getCredentialReadDenyPaths,
  getPluginsRootPath,
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

/** 敏感目录——即使在 homedir 内也绝对拒绝访问 */
const SENSITIVE_DIRS = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud',
  '.docker', '.kube', '.npmrc', '.netrc',
  '.bash_history', '.zsh_history',
  '.env', '.credentials', '.password-store',
].map(d => path.join(HOME, d)).concat([
  // Keep the rest of the data root available for legitimate memories and
  // artifacts while hard-denying every authoritative credential location.
  ...getCredentialReadDenyPaths(),
])

/** 系统目录——禁止写入 */
const SYSTEM_DIRS = [
  '/etc', '/System', '/usr', '/sbin', '/bin',
  '/Library/LaunchDaemons', '/Library/LaunchAgents',
  '/private/etc',
]

/** 允许操作的目录白名单 */
const ALLOWED_DIRS = [
  getDataRoot(),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Downloads'),
  '/tmp',
  os.tmpdir(),
]

/** 解析真实路径（追踪符号链接） */
function resolveRealPath(filePath: string): string {
  const visitedLinks = new Set<string>()

  const resolveAddressedPath = (input: string): string => {
    const addressed = path.resolve(input)
    try {
      return fs.realpathSync(addressed)
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
          return path.join(fs.realpathSync(cursor), ...tail)
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

function pathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/** 检查路径是否触及敏感目录 */
function isSensitivePath(filePath: string): boolean {
  const real = resolveRealPath(filePath)
  const addressed = path.resolve(filePath)
  // Provider dotenv files can live in any user-selected workspace. Treat both
  // the addressed and canonical basenames as credentials so symlink aliases
  // cannot bypass the structured read tools' boundary.
  const isDotEnv = [addressed, real].some(candidate => /^\.env/i.test(path.basename(candidate)))
  const pluginsRoot = getPluginsRootPath()
  const isPluginCredential = isPluginMcpConfigPath(addressed, pluginsRoot)
    || isPluginMcpConfigPath(real, resolveRealPath(pluginsRoot))
  return isDotEnv || isPluginCredential || SENSITIVE_DIRS.some(d => (
    pathWithin(addressed, path.resolve(d))
    || pathWithin(real, resolveRealPath(d))
  ))
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

/** 检查路径是否在允许目录内 */
function isAllowedPath(filePath: string): boolean {
  if (!filePath) return false
  const real = resolveRealPath(filePath)
  return ALLOWED_DIRS.some(d => pathWithin(real, resolveRealPath(d)))
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
  return roots.some(d => real.startsWith(d + path.sep) || real === d)
}

// =====================================================================
// Layer 1: 工具风险分类器
// =====================================================================

export type RiskLevel = 'safe' | 'risky' | 'needs_confirmation'

export interface RiskAssessment {
  level: RiskLevel
  reason: string
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
 * 遍历类命令（find/rg/du/tree、grep -r、ls -R）的目标是否是主目录根 / /Users / 全盘。
 * 命中返回提示语（needs_confirmation 用），未命中 null。只认"遍历根 = 主目录本身或更上层"，
 * 明确子目录（~/Documents/code、~/Desktop/xx）不拦——防线对准的是隐私暴露面，不是读操作本身。
 */
export function detectHomeWideScan(command: string): string | null {
  const traversal = /\b(?:find|rg|du|tree)\b/.test(command) ||
    /\bgrep\b[^|;&]*\s-[A-Za-z]*[rR]/.test(command) ||
    /\bls\b[^|;&]*\s-[A-Za-z]*R/.test(command)
  if (!traversal) return null
  // 目标 token：独立出现的 ~ / $HOME / /Users[/<name>] / 裸 /（后面紧跟空白、引号、命令分隔或行尾才算）
  const tokens = command.match(/(?:^|[\s"'`=])(~|\$HOME|\/Users(?:\/[A-Za-z0-9._-]+)?\/?|\/)(?=[\s"'`;|&)]|$)/g) || []
  for (const raw of tokens) {
    const t = raw.replace(/^[\s"'`=]+/, '')
    const resolved = path.resolve(expandHome(t === '$HOME' ? '~' : t))
    if (resolved === '/' || resolved === '/Users' || resolved === HOME) {
      return `命令要遍历主目录/全盘（${t}）——会触达桌面、iCloud、照片、音乐等隐私目录并触发系统授权弹窗。如确有必要请确认；若在找随消息发来的图片，存盘路径已在消息中注明，无需搜索`
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

  if (toolName !== 'bash' && toolName !== 'shell') return null
  const command = String(args?.command || '')
  if (!command) return null
  const broadDiscovery = /\b(?:find|rg|grep|ls)\b/.test(command)

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
const READONLY_FILE_TOOLS = new Set(['read', 'read_file', 'ls', 'find', 'grep'])
const WRITE_FILE_TOOLS = new Set(['write', 'edit', 'write_file', 'create_file'])

// ---- MCP 工具名前缀分类 ----
const MCP_WRITE_PREFIXES = ['create_', 'add_', 'edit_', 'modify_', 'update_', 'set_']
const MCP_DESTRUCTIVE_PREFIXES = ['delete_', 'remove_', 'drop_', 'stop_', 'end_']

// ---- 代码执行中的删除类 API（execute_code 的 python/js 与 bash rm 同权确认）----
const DESTRUCTIVE_CODE_RE = /\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\.unlink\s*\(|\bsend2trash\b|\bfs\.(rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir)\b|\brimraf\b/

// ---- 危险 bash 命令模式 ----
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[rRfF]+\s+|--recursive\s+)/,
  /\bsudo\b/,
  /\b(chmod|chown)\b.*\b777\b/,
  /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[fdx])/,
  /\bfind\b.*\b-delete\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(curl|wget)\b.*\|\s*(ba)?sh/,
  /\beval\b/,
  /\bexec\s+[^&|;]/,
]

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
    const executable = path.basename(tokens[commandIndex] || '')
    const args = tokens.slice(commandIndex + 1)
    const operands = args.filter(arg => arg !== '--' && !arg.startsWith('-'))

    if (executable === 'cp' || executable === 'mv') {
      // cp/mv 的最后一个操作数是目标；前面的 sidecar 路径都只是来源。
      if (artifactPathIn(operands.at(-1))) return true
    } else if (executable === 'tee' || executable === 'mkdir' || executable === 'touch' || executable === 'rm') {
      if (operands.some(artifactPathIn)) return true
    } else if (executable === 'sed' && args.some(arg => arg === '-i' || arg.startsWith('-i'))) {
      // sed -i 会原地改写文件，出现的 sidecar 文件就是写入目标。
      if (args.some(artifactPathIn)) return true
    }
  }
  return false
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
  // Discovery tools default to the active working directory when path is
  // omitted. Authorize the same effective path the tool will actually scan;
  // otherwise `grep({ pattern })` from the data root bypasses the explicit
  // config.json check by searching `.`.
  const filePath = requestedFilePath || (
    toolName === 'ls' || toolName === 'find' || toolName === 'grep'
      ? (scope.workingDir || getWorkingDir())
      : null
  )
  const resolvedFilePath = filePath ? resolveAgentPath(filePath, scope.workingDir) : null
  if (filePath) {
    const discoveryRoot = toolName === 'ls' || toolName === 'find' || toolName === 'grep'
    if (isSensitivePath(resolvedFilePath!) || (discoveryRoot && containsSensitivePath(resolvedFilePath!))) {
      return { level: 'risky', reason: `路径 ${resolvedFilePath} 属于敏感目录（如 .ssh、.aws），禁止访问` }
    }
    if (isSystemPath(resolvedFilePath!)) {
      return { level: 'risky', reason: `路径 ${resolvedFilePath} 属于系统目录，禁止操作` }
    }
  }

  // ---- 只读工具 → safe ----
  if (READONLY_TOOLS.has(toolName)) {
    return { level: 'safe', reason: '只读工具' }
  }

  // ---- bash/shell 命令检查 ----
  if (toolName === 'bash' || toolName === 'shell') {
    const command: string = args?.command || ''
    // artifact sidecar 旁路封锁（Layer 3 硬性边界，沙箱与否都拦）：见上方常量定义注释
    if (commandWritesArtifactSidecar(command)) {
      return { level: 'risky', reason: 'artifact 内容必须走 edit_artifact / create_artifact；bash 直写 sidecar 会绕过编译与完整性护栏（grep/cat/ls 只读核查不受限）' }
    }
    const matched = DANGEROUS_BASH_PATTERNS.find(p => p.test(command))
    if (matched) {
      // 危险命令即使有沙箱也阻止（Layer 3 硬性边界）
      return { level: 'risky', reason: `检测到危险命令: ${command.substring(0, 80)}` }
    }
    // Shell text is not a reliably parseable filesystem policy boundary: a
    // sensitive path can be assembled through variables, substitutions, or a
    // child interpreter. If the OS sandbox is unavailable, confirmation alone
    // cannot guarantee that OpenPipal credentials remain unreadable.
    if (!isSandboxed()) {
      return { level: 'risky', reason: '系统沙箱未启用，已安全禁用 Shell 执行' }
    }
    // 主目录/全盘遍历防线（2026-07-22 实案：模型找不到粘贴图 → `find /Users/xxx -name image.png`
    // 全盘扫描，触发 iCloud/桌面/音乐等 TCC 连环授权弹窗）。读操作虽无破坏性，但隐私暴露面 =
    // 整个主目录；**不因沙箱降级**——沙箱管写与网络，不管读隐私。升级为需用户确认；
    // 具体子目录（~/Documents/code 等）不受影响。
    const homeScan = detectHomeWideScan(command)
    if (homeScan) {
      return { level: 'needs_confirmation', reason: homeScan }
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
    if (DESTRUCTIVE_CODE_RE.test(code) || (lang === 'bash' && DANGEROUS_BASH_PATTERNS.some((re) => re.test(code)))) {
      return isSandboxed()
        ? { level: 'needs_confirmation', reason: '代码包含删除/危险操作（与 bash 同级确认）' }
        : { level: 'risky', reason: '代码包含删除/危险操作，且系统沙箱未启用，已安全阻止' }
    }
    // Arbitrary Python/JavaScript/Bash can construct sensitive paths in ways a
    // source regex cannot soundly recognize. Fail closed unless the execution
    // backend has the denyRead sandbox that protects credential files.
    if (!isSandboxed()) {
      return { level: 'risky', reason: '系统沙箱未启用，已安全禁用代码执行' }
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
    if (filePath && !isAllowedPath(resolvedFilePath!) && !(readOnly && builtinResource)) {
      return { level: 'risky', reason: `路径 ${resolvedFilePath} 不在允许的工作目录内` }
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
  'bash', 'shell', 'execute_code',
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
  approvalScope: SessionApprovalScope = localSessionApprovalScope()
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
export interface ToolAuthorizationOptions {
  conversationId?: string
  onConfirmation?: PermissionHandler
  scope?: Omit<ToolScope, 'conversationId'>
}

/** Runtime-neutral authorization entrypoint shared by low-level Agent and AgentHarness. */
export async function authorizeToolCall(
  toolName: string,
  args: Record<string, any>,
  options: ToolAuthorizationOptions = {},
  signal?: AbortSignal
): Promise<BeforeToolCallResult | undefined> {
  const { conversationId, onConfirmation, scope } = options
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
  scope?: Omit<ToolScope, 'conversationId'>
) {
  return (context: BeforeToolCallContext, signal?: AbortSignal) => authorizeToolCall(
    context.toolCall.name,
    context.args as Record<string, any>,
    { conversationId, onConfirmation, scope },
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
