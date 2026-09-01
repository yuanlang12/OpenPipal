/**
 * Authoritative filesystem locations that may persist credentials.
 *
 * Keep this module free of Electron imports so authentication, persistence,
 * model-facing file policy, and the OS sandbox can share the same paths
 * without introducing main-process dependency cycles.
 */
import path from 'path'
import os from 'os'
import { dataPath, getDataRoot, getOpenPipalHome } from './data-root'

export function getOpenPipalConfigPath(): string {
  return dataPath('config.json')
}

export function getOpenPipalConfigBackupPath(): string {
  return dataPath('config.json.bak-pre-providers')
}

export function getAcpMcpTokenPath(): string {
  return dataPath('acp-mcp.token')
}

export function getMcpOAuthRootPath(): string {
  return dataPath('oauth')
}

export function getUserMcpConfigPath(): string {
  return dataPath('mcp-servers.json')
}

/** User grants for MCP App device/browser capabilities. */
export function getMcpAppPermissionsPath(): string {
  return dataPath('mcp-app-permissions.json')
}

/** Persistent browser allow/block policy; writing it changes authorization. */
export function getBrowserControlPolicyPath(): string {
  return dataPath('browser-control', 'policy.json')
}

/**
 * Persistent per-project git authorization; writing it grants credential use.
 * Holds no secret itself, but a model able to append to it could authorize its
 * own access to the user's git credentials, so it belongs on the deny list for
 * the same reason the browser policy does.
 */
export function getGitPolicyPath(): string {
  return dataPath('git-policy.json')
}

export function getTasksRootPath(): string {
  return dataPath('tasks')
}

export function getAuditLogPath(): string {
  return dataPath('audit.log')
}

export function getPluginsRootPath(): string {
  return dataPath('plugins')
}

/** The dotenv file loaded by src/main/env.ts during development. */
export function getDevelopmentEnvPath(): string {
  return path.resolve(__dirname, '../../.env')
}

/** Exact files/directories denied to model-facing reads and sandboxed code. */
export function getCredentialReadDenyPaths(): string[] {
  return [
    getOpenPipalConfigPath(),
    getOpenPipalConfigBackupPath(),
    getAcpMcpTokenPath(),
    getMcpOAuthRootPath(),
    getUserMcpConfigPath(),
    getMcpAppPermissionsPath(),
    getBrowserControlPolicyPath(),
    getGitPolicyPath(),
    getTasksRootPath(),
    getAuditLogPath(),
    getDevelopmentEnvPath(),
  ]
}

/** Credential directories whose descendants are all secret-bearing. */
export function getCredentialReadDenyRoots(): string[] {
  return [
    getMcpOAuthRootPath(),
    getTasksRootPath(),
  ]
}

/** Roots that must not be recursively enumerated because they contain exact credentials. */
export function getCredentialDiscoveryDenyRoots(): string[] {
  return [
    getDataRoot(),
    ...getCredentialReadDenyRoots(),
  ]
}

/**
 * 「一看就是模板」的 dotenv 文件名。这几个是跨语言跨框架的通用约定：它们**天生就是要提交进
 * 版本库、给别人看的**，里面放的是占位值（`API_KEY=your-key-here`），真密钥放同目录的 `.env`。
 *
 * 为什么要开这个口子：`.env*` 那条宽 glob 把它们一起拦了，代价在影子运行里量到过——
 * **60 次运行有 19 次（32%）撞上 `.env.example` 的 `Operation not permitted`**，横跨 10 道题。
 * 挡住的不是"读密钥"，是 `git stash` / `git status` / `git checkout` 这些例行操作：git 要把
 * 工作树打成 tree 就得读每个被跟踪的文件，读不了就整条命令失败。实案 `6919551@r1` 的原话是
 * 「stash 尝试因 `.env.example` 权限问题未执行任何回退」——它想回到基线做对照，被我们自己挡住了。
 *
 * 安全上这一步很浅：这些文件**已经在 git 里**，助手照样能 `git show HEAD:.env.example` 拿到内容
 * （`.git` 不在读拒表里）。所以宽 glob 对被跟踪的模板基本是安全戏，代价却是三分之一的运行受损。
 *
 * 三条克制：
 *   1. **只列这四个通用约定**，不含 `.env.test` / `.env.defaults` 这类可能真放值的；
 *   2. **只放开读，不放开写**——SRT 的 `denyWrite` 压过 `allowWrite`，所以写这一半原样保留，
 *      而助手本来也没有理由改别人的模板；
 *   3. **逐字节比，只认小写**。大写变体（`.ENV.EXAMPLE`）继续拦——沙箱那层的 glob 做不出
 *      大小写不敏感的例外，应用层要是折叠了就会两层不一致，那比严一点更糟。
 */
export const ENV_TEMPLATE_BASENAMES = ['.env.example', '.env.sample', '.env.template', '.env.dist'] as const

/**
 * 这个文件名是不是「一看就是模板」的 dotenv。**逐字节比，不做大小写折叠。**
 *
 * 不折叠是因为两层必须说同一句话：沙箱那层是 glob，写不出大小写不敏感的例外
 * （宽拒读规则用 `[eE][nN][vV]` 是因为只有三个字母，模板名逐字母展开会长到没法读）。
 * 应用层要是折叠了，`.ENV.EXAMPLE` 就会出现「`read` 工具能读、bash 读不到」的分裂——
 * 两层不一致的安全边界比严一点更糟。所以少见的写法一律按最严的算。
 */
export function isEnvTemplateBasename(basename: string): boolean {
  return (ENV_TEMPLATE_BASENAMES as readonly string[]).includes(basename)
}

/**
 * 给 git 的排除清单：**沙箱下 git 读不到的那些 dotenv，让它干脆别看。**
 *
 * 病灶不在"读密钥"，在**遍历**。SRT 把 `denyRead` 一律翻成 Seatbelt 的
 * `(deny file-read* …)`，而 `file-read*` 连 `file-read-metadata` 一起拒——于是
 * `lstat(".env")` 也回 EPERM。git 走工作树时必须 lstat 每一个条目，撞上就整条命令挂掉。
 * 2026-08-28 实测（生产配置、真沙箱、五种仓库形态各跑 9 条 git 命令）：
 *
 *     .env 未被 gitignore 也未被 track    →  `git stash -u` / `git add -A .` 双双失败
 *                                            原文 `error: lstat(".env"): Operation not permitted`
 *
 * 那条原文就是当初立案的那句。让 git 把这些文件当成"忽略掉的"，它连 lstat 都不会发，
 * 上面两条立刻变绿，而**沙箱规则一个字没动**——`cat .env` 照样 Operation not permitted。
 *
 * 三点说明：
 *   1. **四个模板名逐条放回来**。它们是读得到的（见 `isEnvTemplateBasename`），
 *      排掉反而会让新建的 `.env.example` 对 `git add` 隐身。只藏 git 真读不到的。
 *   2. **只对未跟踪的文件有效**，这是 gitignore 的语义。已经被提交进版本库的 `.env`
 *      不受影响——那种仓库里 `git show HEAD:.env` 本来就能读到内容，密钥早已不设防，
 *      不是这条清单该解决的问题（已在 mechanism-registry.md 单独记账）。
 *   3. 副作用是 `git add -A` 会**静默跳过** `.env` 而不是整条失败。这是我们要的方向：
 *      它本来也提交不了（git 读不到内容），跳过一个文件好过让整条命令挂掉。
 *
 * 日落条件：哪天 dotenv 的宽拒读规则不再覆盖 metadata（比如 SRT 支持 `file-read-data`
 * 粒度、或我们换掉沙箱实现），这份清单就该删掉。
 */
export function buildGitDotenvExcludeBody(): string {
  return [
    '# OpenPipal 自动生成：沙箱下 git 读不到这些文件，遍历到就整条命令失败。',
    '# 模板逐条放回来——它们是读得到的。改这里请同步 credential-paths.ts。',
    '.env',
    '.env.*',
    ...ENV_TEMPLATE_BASENAMES.map(name => `!${name}`),
    '',
  ].join('\n')
}

/**
 * 沙箱 `allowRead` 用的 glob，**限定在传进来的工作目录里**。
 *
 * SRT 的语义是 allowRead 压过 denyRead（`macos-sandbox-utils.js` 原文：
 * "In Seatbelt profiles, later rules take precedence"，发规则的顺序是
 * allow-all → deny → re-allow）。所以这几条**必须限定范围**：第一版写成不限范围的
 * `/**​/.env.example`，那就不只是把宽 `.env*` 拒读打开一个口子，而是连
 * `SENSITIVE_DIRS`（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gcloud`）和
 * `getCredentialReadDenyPaths()`（`~/.openpipal` 下的 oauth/tasks/config）一起打穿——
 * 沙箱里 `cat ~/.ssh/.env.example` 就成立了。是评审逮到的，改前的版本已装过一次机。
 *
 * 传空数组 = 一条都不放行（**fail-closed**）：没登记工作目录时本来也没有仓库要 git 操作。
 * 写侧不需要对应机制，denyWrite 压过 allowWrite，那一半原样拦死。
 */
export function buildEnvTemplateReadAllowGlobs(workspaceRoots: string[]): string[] {
  return workspaceRoots.flatMap(root =>
    ENV_TEMPLATE_BASENAMES.map(name => path.join(root, '**', name)))
}

/**
 * Sandbox-only globs. Do not feed these through path.resolve/realpath policy
 * helpers: SRT expands them (or translates them to Seatbelt regex rules).
 */
export function buildSensitiveReadGlobs(
  openpipalHome = getOpenPipalHome(),
  systemHome = os.homedir(),
  pluginsRoot = getPluginsRootPath()
): string[] {
  return [
    ...Array.from(new Set([openpipalHome, systemHome].map(home => path.join(home, '**', '.env*')))),
    // workingDir can be /tmp, /Volumes, or another user-selected root. Shell
    // and code tools do not pass through the structured basename filter, so
    // the OS sandbox must cover dotenv files independent of their parent.
    '/**/.[eE][nN][vV]*',
    path.join(pluginsRoot, '*', 'mcp.json'),
  ]
}

export const SENSITIVE_READ_GLOBS = buildSensitiveReadGlobs()

/** Exact persisted plugin MCP config: <plugins>/<one plugin>/mcp.json. */
export function isPluginMcpConfigPath(
  candidatePath: string,
  pluginsRoot = getPluginsRootPath()
): boolean {
  const relative = path.relative(path.resolve(pluginsRoot), path.resolve(candidatePath))
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return false
  }
  const segments = relative.split(path.sep)
  return segments.length === 2
    && segments[0].length > 0
    && segments[1].toLowerCase() === 'mcp.json'
}

/** Whether a discovery root can enumerate one or more plugin MCP configs. */
export function discoveryRootContainsPluginMcpConfig(
  candidatePath: string,
  pluginsRoot = getPluginsRootPath()
): boolean {
  const relative = path.relative(path.resolve(pluginsRoot), path.resolve(candidatePath))
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  if (!relative) return true
  const segments = relative.split(path.sep)
  return segments.length === 1 && segments[0].length > 0
}
