/**
 * 安全层的平台路径表（纯函数，不碰磁盘）。
 *
 * pi-security.ts 里的系统目录禁写表、工作根禁区、凭据目录原来全是 POSIX 字面量——
 * Windows 上 `C:\Windows`、`C:\Users`、`%APPDATA%` 一条都命中不了，应用层那道防线缺一角；
 * 而 Windows 又恰恰没有 OS 沙箱兜底（见 `osSandboxAvailableOnPlatform`）。
 * 表按平台参数化、单独成模块，是为了在 macOS 上也能对 Windows 那一套跑单测。
 *
 * 这里只回答"哪些目录"，不做 realpath、不折叠大小写——那是 pi-security 的事。
 */
import path from 'path'

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * 这个平台有没有 OS 级沙箱可用。镜像 `@anthropic-ai/sandbox-runtime` 的 `isSupportedPlatform`
 * （macOS Seatbelt、Linux bubblewrap）。WSL1 那条例外不复刻：WSL 里 process.platform 也是
 * linux，留给 SRT 自己在初始化时判——这里只回答"这个平台**本该**有沙箱吗"。
 *
 * 不放进 sandbox-manager：那个模块被多个测试整体 mock 掉，多一个导出就多一圈要补的 mock，
 * 而这只是一个平台常量。
 */
export function osSandboxAvailableOnPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/**
 * 路径比较要不要折叠大小写。
 *
 * macOS 默认 APFS 同样不区分大小写，但那边 `realpathSync.native` 能拿到磁盘真实大小写，
 * 之后字节比较即可；Windows 的 realpath 对**不存在**的路径原样返回、盘符大小写随调用方
 * （`c:\Users` 与 `C:\Users`），只能在比较时折叠。
 */
export function isCaseInsensitivePathPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/** `C:\` / `D:/` 这类盘根。posix 没有盘符，一律 false。 */
export function isDriveRoot(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /^[A-Za-z]:[\\/]?$/.test(p)
}

/** 取一个 Windows 环境变量里的目录，去掉尾部分隔符；没设就用约定默认值。 */
function windowsEnvDir(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim()
  return value ? path.win32.normalize(value).replace(/[\\/]+$/, '') : fallback
}

function windowsSystemDirs(env: NodeJS.ProcessEnv): string[] {
  // 盘符不能过 normalize：`D:` 会被当成"D 盘的当前目录"变成 `D:.`
  const systemDrive = (env.SystemDrive?.trim() || 'C:').replace(/[\\/]+$/, '')
  const dirs = [
    windowsEnvDir(env, 'SystemRoot', `${systemDrive}\\Windows`),
    windowsEnvDir(env, 'ProgramFiles', `${systemDrive}\\Program Files`),
    windowsEnvDir(env, 'ProgramFiles(x86)', `${systemDrive}\\Program Files (x86)`),
    windowsEnvDir(env, 'ProgramData', `${systemDrive}\\ProgramData`),
  ]
  // 32 位进程里 ProgramFiles 指向 (x86)，真正的 64 位目录只在 ProgramW6432 里
  if (env.ProgramW6432?.trim()) dirs.push(windowsEnvDir(env, 'ProgramW6432', ''))
  return Array.from(new Set(dirs.filter(Boolean)))
}

const POSIX_SYSTEM_DIRS = [
  '/etc', '/System', '/usr', '/sbin', '/bin',
  '/Library/LaunchDaemons', '/Library/LaunchAgents',
  '/private/etc',
]

/** 系统目录——禁止写入。 */
export function systemDirsFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return platform === 'win32' ? windowsSystemDirs(env) : [...POSIX_SYSTEM_DIRS]
}

export interface DeniedWorkspaceRoots {
  /** 本身就等于"整台机器"，但子目录是正常项目位置，只能等值拒 */
  equal: string[]
  /** 整棵树都是配置 / 凭证 / 可执行体，按子树拒 */
  subtree: string[]
}

/**
 * 不能当工作根的目录。
 *
 * 分两类：
 * - equal：本身就等于"整台机器"（盘根、家目录、/Users 或 C:\Users），但它们的**子目录**是正常
 *   项目位置（~/xxx、/Volumes/Disk/repo、D:\code\repo），所以只能等值拒绝，不能按子树拒。
 * - subtree：整棵树都是配置 / 凭证 / 可执行体，里面没有合法的"项目目录"。必须按子树拒，
 *   否则用户选到 ~/Library/Application Support 或 %APPDATA%\Code 这类更深的目录就绕过了根判定。
 *
 * 为什么 ~/Library、%APPDATA% 这类要单列：它们既不等于家目录（逃过 equal），也不在敏感目录
 * 那张固定表里（逃过敏感判定），而里面装着钥匙串、浏览器 Cookie、LaunchAgents / 启动项——
 * 一旦成为允许根，读就是 safe、写在沙箱下也是 safe，等于把持久化后门开成免确认操作。
 */
export function deniedWorkspaceRootsFor(
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): DeniedWorkspaceRoots {
  const p = pathApiFor(platform)
  const equal = [p.parse(home).root, home, p.dirname(home)]
  if (platform === 'win32') {
    return {
      equal,
      subtree: Array.from(new Set([
        p.join(home, 'AppData'),
        // 漫游配置被重定向到别处时 %APPDATA% 不在家目录下，也要盖住
        windowsEnvDir(env, 'APPDATA', p.join(home, 'AppData', 'Roaming')),
        windowsEnvDir(env, 'LOCALAPPDATA', p.join(home, 'AppData', 'Local')),
        ...windowsSystemDirs(env),
      ])),
    }
  }
  return {
    equal: [...equal, '/Volumes', '/home', '/mnt', '/media'],
    subtree: [
      p.join(home, 'Library'),
      p.join(home, '.config'),
      p.join(home, '.local'),
      p.join(home, '.cache'),
      '/Library',
      '/Applications',
      '/opt',
      '/private/var',
      '/var',
    ],
  }
}

/** 家目录下的凭据位置（相对家目录），各平台通用——Git Bash / WSL 会把同一套点目录带到 Windows。 */
const HOME_CREDENTIAL_ENTRIES = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud',
  '.docker', '.kube', '.npmrc', '.netrc',
  '.bash_history', '.zsh_history',
  '.env', '.credentials', '.password-store',
  // git / GitHub 凭证。2026-08-21 复核发现这几条一直没被覆盖——既不在这张表里、
  // 也不在沙箱 denyRead 里，模型一条 `cat ~/.git-credentials` 就能拿走用户已有的
  // git 凭证（配了 store helper 时是明文 https://user:token@host）。
  // 做「按项目授权再放行凭证」之前必须先堵这道门，否则那套设计从一开始就绕得过去。
  '.git-credentials',            // credential.helper=store 的默认落点
  '.config/git/credentials',     // 同上的 XDG 位置
  '.config/gh',                  // gh CLI 的 hosts.yml（含 oauth token）
  '.config/hub',                 // hub CLI 的老位置
  '.gitconfig.local',            // 常见的"把 token 塞进 url.insteadOf"私有配置
]

/** Windows 上同一批工具把凭据放在 %APPDATA% 下，点目录那套盖不到。 */
function windowsCredentialDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const p = path.win32
  const appData = windowsEnvDir(env, 'APPDATA', p.join(home, 'AppData', 'Roaming'))
  const localAppData = windowsEnvDir(env, 'LOCALAPPDATA', p.join(home, 'AppData', 'Local'))
  return [
    p.join(appData, 'GitHub CLI'),                                   // gh 的 hosts.yml（oauth token）
    p.join(appData, 'gcloud'),                                       // gcloud 凭据
    p.join(appData, 'gnupg'),                                        // Gpg4win 的私钥
    p.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'),  // 命令历史 ≈ .bash_history
    p.join(appData, 'Microsoft', 'Credentials'),                     // 凭据管理器落盘（DPAPI 块）
    p.join(localAppData, 'Microsoft', 'Credentials'),
  ]
}

/** 敏感目录——即使在家目录内也绝对拒绝访问（绝对路径）。 */
export function sensitiveDirsFor(
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const p = pathApiFor(platform)
  const base = HOME_CREDENTIAL_ENTRIES.map(entry => p.join(home, entry))
  return platform === 'win32' ? [...base, ...windowsCredentialDirs(home, env)] : base
}
