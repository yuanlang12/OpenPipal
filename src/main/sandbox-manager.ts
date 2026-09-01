/**
 * Sandbox Manager — OS 级沙箱隔离
 *
 * 使用 @anthropic-ai/sandbox-runtime (SRT) 在 macOS 上通过 Seatbelt (sandbox-exec)
 * 实现进程级别的文件系统和网络隔离。
 *
 * 设计原则：
 * - 初始化失败时 graceful fallback 到现有三层安全模型
 * - 不阻塞应用启动
 * - 配置可通过环境变量覆盖
 */

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { SENSITIVE_DIRS, ALLOWED_DIRS, listWorkspaceRoots, registerWorkspaceRoot } from './pi-security'
import { getWorkingDir } from './config-manager'
import {
  buildEnvTemplateReadAllowGlobs,
  buildGitDotenvExcludeBody,
  getCredentialReadDenyPaths,
  SENSITIVE_READ_GLOBS
} from './credential-paths'
import { dataPath } from './data-root'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * 工具链缓存目录——不是"工作范围"，但不给写 `npm install` / `pip install` / `cargo build`
 * 全都 EPERM 失败。以前是靠 allowWrite 里那个 '.' 在装机版展开成整盘可写才碰巧能跑；
 * 去掉 '.' 之后必须显式列出来，否则收紧的代价直接落在最常用的那条命令上。
 * 注意 bash 在沙箱下判 safe 且不做路径检查，OS 拒绝只会回一句裸 EPERM，模型看不懂也纠不了偏。
 */
const TOOLCHAIN_CACHE_DIRS = [
  '.npm', '.cache', '.cargo', '.rustup', '.pnpm-store', '.bun', '.yarn', '.gradle', '.m2',
  path.join('Library', 'Caches'),
].map(d => path.join(os.homedir(), d))

// 延迟加载 ESM-only 模块，避免 Electron CJS 主进程的 require() 报错
let _SRT: any = null
async function getSRT() {
  if (!_SRT) {
    const mod = await import('@anthropic-ai/sandbox-runtime')
    _SRT = mod.SandboxManager
  }
  return _SRT
}

// =====================================================================
// 状态
// =====================================================================

let _initialized = false
let _enabled = false

// =====================================================================
// 配置
// =====================================================================

/** 模型服务：不通这些就没法对话 */
const AI_API_DOMAINS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.deepseek.com',
  'generativelanguage.googleapis.com',
  'api.tavily.com',
]

/**
 * 取包与取代码：编码场景的最低要求。
 *
 * 实测（cwd=/ 真沙箱）：只放 registry.npmjs.org 时，`curl https://github.com` 与
 * `git ls-remote https://github.com/...` 都被代理挡成 `CONNECT tunnel failed, response 403`——
 * 装个 git 依赖、看眼上游代码全做不了。补齐后同样的命令回 200 / 拿到真实 commit sha，
 * 而未授权域（example.com）仍然 403，白名单该拦的照拦。
 *
 * 注意 SSH 走不通且补不了：SRT 只代理 HTTP/HTTPS，沙箱里 DNS 也不放行，
 * `ssh git@github.com` 直接卡在 "Could not resolve hostname"。git 只能走 HTTPS。
 */
const PACKAGE_AND_SOURCE_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  'codeload.github.com',           // npm/pip 装 git 依赖时下载 tarball 的实际主机
  'objects.githubusercontent.com', // release 附件与 LFS
  'raw.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
]

function splitDomainList(value: string | undefined): string[] {
  return (value || '').split(',').map(d => d.trim()).filter(Boolean)
}

/**
 * 允许出站的域名。
 *
 * 两个环境变量语义不同，别混：
 * - `OPENPIPAL_ALLOWED_DOMAINS` **整表替换**（历史行为，用来收窄——想只放行两个域就设它）
 * - `OPENPIPAL_EXTRA_ALLOWED_DOMAINS` **在默认表上追加**（想加一个公司私有 registry 用它）
 *
 * 分成两个而不是把前者改成追加：改语义会让"用它收窄"的人静默失去收窄效果，
 * 那是安全方向的回归；而只有前者时，想加一个域就得把整张默认表重抄一遍，抄漏一个
 * AI API 域就是整个应用连不上模型。
 */
function getAllowedDomains(): string[] {
  const replaced = splitDomainList(process.env.OPENPIPAL_ALLOWED_DOMAINS)
  const base = replaced.length > 0 ? replaced : [...AI_API_DOMAINS, ...PACKAGE_AND_SOURCE_DOMAINS]
  return Array.from(new Set([...base, ...splitDomainList(process.env.OPENPIPAL_EXTRA_ALLOWED_DOMAINS)]))
}

/** 构建沙箱运行时配置 */
export function buildSandboxConfig(): SandboxRuntimeConfig {
  return {
    filesystem: {
      denyRead: [...SENSITIVE_DIRS, ...SENSITIVE_READ_GLOBS],
      // 把 `.env.example` 这类模板从上面那条宽 `.env*` 拒读里放回来，**只在已登记的
      // 工作目录内**。allowRead 压过 denyRead，不限范围就会连 `~/.ssh` / `~/.aws` /
      // `~/.openpipal` 的拒读一起打穿（理由与实案见 credential-paths.ts 那两个函数）。
      // **只放读不放写**：下面 denyWrite 里的 `.env*` 原样保留，而 denyWrite 压过
      // allowWrite，所以写这一半没有被这条削弱。
      allowRead: buildEnvTemplateReadAllowGlobs(listWorkspaceRoots()),
      // 不要写 '.'：SRT 的 normalizePathForSandbox 用 process.cwd() 解析它
      // （sandbox-utils.js:170,181），而装机版从 Finder 启动时 cwd 是 '/' ——
      // 那会展开成 (allow file-write* (subpath "/")) 整盘可写，等于沙箱白装。
      // 工作目录要放行就显式登记（registerWorkspaceRoot），拿到的是已解析的绝对路径。
      allowWrite: [...ALLOWED_DIRS, ...TOOLCHAIN_CACHE_DIRS, ...listWorkspaceRoots()],
      denyWrite: [
        // 同样不能用相对写法：'.env' / '.git/hooks' 会按 process.cwd() 解析，装机版
        // 打成 '/.env'、'/.git/hooks'，等于这两条从来没生效过。改成绝对 glob，与
        // SENSITIVE_READ_GLOBS 里 '/**/.[eE][nN][vV]*' 同一套写法。
        // （.env 已被 SENSITIVE_READ_GLOBS 覆盖，这里只补 git hooks——它是"改一个文件
        //   就能在下次 commit 时执行任意代码"的逃逸面。）
        // 不能写 '/**/.git/hooks/**'：SRT 的 stripWriteGlobs 会先剥掉尾部 '/**'，
        // 结果只 deny 了 hooks 目录这个 inode，目录里的钩子文件照样能写。
        // '/*' 不会被剥，globToRegex 得到 ^/(.*/)?\.git/hooks/[^/]*$，正好是钩子脚本本身。
        '/**/.git/hooks/*',
        ...getCredentialReadDenyPaths(),
        ...SENSITIVE_READ_GLOBS,
      ],
    },
    network: {
      allowedDomains: getAllowedDomains(),
      deniedDomains: [],
      allowLocalBinding: true, // 允许绑定本地端口（dev server 等）
    },
  }
}

/**
 * 沙箱下给 git 用的空模板目录。
 *
 * 上面 denyWrite 里那条 hooks 拒写 glob 是防"写个钩子，下次 commit 就执行任意代码"，
 * 必须留着。但 `git init` 和 `git clone` 每次都会把默认模板里的 `hooks/*.sample`
 * 拷进新仓库，于是这两条命令在沙箱里 **100% 失败**（2026-08-23 实测）：
 *
 *     fatal: cannot copy '.../git-core/templates/hooks/commit-msg.sample'
 *            to '.../.git/hooks/commit-msg.sample': Operation not permitted
 *
 * 那些 `.sample` 文件是给人看的示例，git 永远不会执行它们，少了没有任何功能损失。
 * 指一个空目录，git 就什么都不拷 —— 拒写规则一个字都不用松。
 */
export function getGitTemplateDir(): string {
  const dir = dataPath('git-empty-template')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // 建不出来就算了：大不了回到"沙箱里 clone 不了"的老样子，不该因此让整条命令起不来
  }
  return dir
}

/**
 * 沙箱下发给 git 的排除清单文件（内容与理由见 credential-paths.ts 的
 * `buildGitDotenvExcludeBody`）。和上面的空模板目录是同一类东西：拒读/拒写规则一个字不松，
 * 只是别让 git 一头撞上去。
 *
 * **用户自己的全局 ignore 一并带上**。`core.excludesFile` 是整体替换，不叠加；
 * 直接换掉会把用户 `~/.config/git/ignore` 里的 `.DS_Store` 之类全丢了，
 * `git status` 突然多出一堆噪音。这里读默认位置拼在前面，用户的规则仍然生效。
 * （用户若在 gitconfig 里把 `core.excludesFile` 指到了别处，沙箱期间会被我们这份顶掉——
 * 代价是那份自定义清单暂时失效，换的是 git 能跑起来。已在机制台账里记这一笔。）
 *
 * 每次调用都比对内容再决定写不写：用户改了自己的 ignore，下一条命令就能跟上，
 * 而没改时不会平白多一次磁盘写。
 */
export function getGitDotenvExcludesFile(): string {
  const target = dataPath('git-dotenv-exclude')
  const userGlobal = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'git', 'ignore'
  )
  let inherited = ''
  try {
    inherited = fs.readFileSync(userGlobal, 'utf8')
    if (inherited && !inherited.endsWith('\n')) inherited += '\n'
  } catch {
    // 没有全局 ignore 是常态，不是错误
  }
  const desired = inherited + buildGitDotenvExcludeBody()
  let current = ''
  try {
    current = fs.readFileSync(target, 'utf8')
  } catch {
    // 首次运行还没有这个文件——和「内容需要更新」走同一条写入路径，不必分开处理
  }
  if (current !== desired) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, desired)
    } catch {
      // 写不出来就退回今天的样子：git 在「.env 未被忽略」的仓库里仍会撞墙，
      // 但不该因为一个辅助文件写失败就让整条命令起不来
    }
  }
  return target
}

// =====================================================================
// 敏感环境变量过滤
// =====================================================================

/** 需要从沙箱环境中移除的敏感环境变量 */
const SENSITIVE_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
  'TAVILY_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'CLASSIN_SID',
]

/**
 * CLI 工具认的 git token 变量。用户已有什么就用什么 —— 不新造
 * OPENPIPAL_GIT_TOKEN 之类的自有概念，那要配、要存、要在设置页露脸，
 * 而它解决的问题这几个现成变量已经解决了。
 *
 * **`git` 自己不读这些变量**（2026-08-23 实测：Xcode 的 git 二进制里
 * `GIT_TERMINAL_PROMPT` 命中 2 次、`GITHUB_TOKEN`/`GH_TOKEN` 命中 0 次）。
 * 受益的是 `gh` / `glab` / `hub` —— 它们此前被无条件抹 token，等于完全不可用。
 * 裸 `git push` 走的是凭据 helper（macOS 上是钥匙串），那条通道本来就通，
 * 这个 Phase 给它加的是授权门，不是通道。
 */
const GIT_CREDENTIAL_ENV_KEYS = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GIT_TOKEN',
  // 主进程注入的那份（git-credential-bridge）。它结尾也是 `_TOKEN`，
  // 不登记在这儿就会被下面的宽泛正则删掉，整套凭据桥就是死的。
  'OPENPIPAL_GIT_TOKEN',
] as const

/** 从一份环境里挑出 git token 变量（只挑真的是字符串的）。 */
export function pickGitCredentialEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {}
  for (const key of GIT_CREDENTIAL_ENV_KEYS) {
    if (typeof source[key] === 'string') picked[key] = source[key]
  }
  return picked
}

export interface SanitizeEnvironmentOptions {
  /**
   * 放行 git token 变量。只有"用户已授权这个项目 + 这条命令真的要连远端"
   * 两条同时成立时才传 true（判定在 git-policy / git-policy-store）。
   */
  allowGitCredentials?: boolean
}

/** Filter sensitive credentials from an arbitrary environment patch. */
export function sanitizeEnvironment(
  source: NodeJS.ProcessEnv,
  options: SanitizeEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const env = { ...source }
  // 先留底再删：GITHUB_TOKEN 既在 SENSITIVE_ENV_KEYS 里、又匹配下面的 _TOKEN$，
  // 想"放行时跳过删除"就得在两处各开一个口子，漏一处这个开关就是死的。
  // 删干净再把留底盖回去，只有一个地方决定放不放行。
  const restore = options.allowGitCredentials ? pickGitCredentialEnv(source) : {}
  for (const key of SENSITIVE_ENV_KEYS) {
    delete env[key]
  }
  // 也移除所有包含 _KEY、_SECRET、_TOKEN 的变量（宽泛匹配）
  for (const key of Object.keys(env)) {
    if (/_(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)$/i.test(key)) {
      delete env[key]
    }
  }
  return { ...env, ...restore }
}

/** 返回过滤后的进程环境变量（移除敏感 key） */
export function getSanitizedEnv(): NodeJS.ProcessEnv {
  return sanitizeEnvironment(process.env)
}

// =====================================================================
// 初始化
// =====================================================================

/**
 * 初始化沙箱。应在应用启动时调用一次。
 * 如果平台不支持或初始化失败，会 graceful fallback。
 */
export async function initSandbox(): Promise<boolean> {
  if (_initialized) return _enabled

  try {
    const SRT = await getSRT()

    // 检查平台支持
    if (!SRT.isSupportedPlatform()) {
      console.log('[Sandbox] 当前平台不支持沙箱，降级到应用层安全模型')
      _initialized = true
      _enabled = false
      return false
    }

    // 上次用的工作目录先登记进来，否则首屏那个会话的仓库（若在 ALLOWED_DIRS 之外）
    // 要等到第一次切目录才被沙箱放行。
    registerWorkspaceRoot(getWorkingDir())

    const config = buildSandboxConfig()
    await SRT.initialize(config)
    _initialized = true
    _enabled = SRT.isSandboxingEnabled()

    if (_enabled) {
      console.log('[Sandbox] 沙箱已启用（macOS Seatbelt）')
    } else {
      console.warn('[Sandbox] 沙箱初始化完成但未启用，降级到应用层安全模型')
    }

    return _enabled
  } catch (err: any) {
    console.error('[Sandbox] 初始化失败，降级到应用层安全模型:', err.message)
    _initialized = true
    _enabled = false
    return false
  }
}

/**
 * 工作目录变了之后把新的工作根同步进沙箱的 allowWrite。
 *
 * 沙箱是进程级的、启动时配一次，而工作目录是会话级的、随时能换。SRT 提供
 * updateConfig（见 sandbox-manager.d.ts ISandboxManager），下一条 wrapWithSandbox
 * 就会用新配置，已经在跑的命令不受影响——这正是我们要的语义：不打断当前这条，
 * 下一条开始放行新目录。
 *
 * 沙箱没起来时是 no-op：那种情况下 bash/execute_code 本来就被分类器整条禁掉。
 */
export async function syncSandboxWorkspaceRoots(): Promise<boolean> {
  if (!_enabled) return false
  try {
    const SRT = await getSRT()
    SRT.updateConfig(buildSandboxConfig())
    return true
  } catch (err: any) {
    // 同步失败只意味着新目录少了 OS 那层放行，分类器与既有配置都还在，不该炸掉调用方。
    console.warn('[Sandbox] 工作目录同步失败，沿用既有沙箱配置:', err.message)
    return false
  }
}

// =====================================================================
// 命令包装
// =====================================================================

/**
 * 用沙箱包装 bash 命令。
 * 如果沙箱不可用，原样返回命令。
 */
export async function wrapCommand(command: string): Promise<string> {
  if (!_enabled) return command
  try {
    const SRT = await getSRT()
    return await SRT.wrapWithSandbox(command)
  } catch (err: any) {
    console.warn('[Sandbox] 命令包装失败，回退到原始命令:', err.message)
    return command
  }
}

/**
 * Wrap a command for a security boundary that has already auto-approved the
 * operation because sandboxing is active. Unlike the legacy helper above, a
 * wrapper failure must reject instead of silently executing the raw command.
 */
export async function wrapCommandStrict(command: string): Promise<string> {
  if (!_enabled) return command
  const SRT = await getSRT()
  return SRT.wrapWithSandbox(command)
}

// =====================================================================
// 查询接口
// =====================================================================

/** 沙箱是否已启用 */
export function isSandboxed(): boolean {
  return _enabled
}

/** 获取当前沙箱配置（调试用） */
export async function getSandboxConfig(): Promise<SandboxRuntimeConfig | undefined> {
  const SRT = await getSRT()
  return SRT.getConfig()
}

/** 清理沙箱资源 */
export async function resetSandbox(): Promise<void> {
  if (_enabled) {
    const SRT = await getSRT()
    await SRT.reset()
    _enabled = false
    _initialized = false
  }
}
