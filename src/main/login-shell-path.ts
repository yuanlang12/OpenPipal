/**
 * 补齐登录 shell 的 PATH —— 双击图标启动时，App 拿到的 PATH 里没有 node/npm。
 *
 * 2026-08-25 实测（macOS 15.5，用一个最小 .app 分别经 `open` 和 Finder 启动对照）：
 * 让 **Finder** 拉起的进程只有 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`——
 * node / npm / uv / pnpm / cargo / go 一个都 command not found，
 * 只有 git 和 python3 因为正好躺在 /usr/bin 才活着。
 * 而终端里 `npm run dev` 起的进程继承的是终端那份完整 PATH（含 nvm、homebrew），
 * 所以**开发模式和全部自动化测试都看不见这个故障**——Playwright 也是从终端拉起 Electron 的。
 * （注意 `open xxx.app` 会把调用方环境带过去，拿它做对照会得到假阴性，必须让 Finder 启动。）
 *
 * 谁受影响：编码助手的 bash 工具（`openpipal-execution-env.ts` 把 `process.env` 透传给子进程）
 * 与 stdio MCP server（`mcp-manager.ts` 用 `{...process.env}` 起子进程，命令常是 `npx`）。
 * 两者都只认 PATH，PATH 里没有就是没有。
 *
 * **不是能力拐杖**：模型再完美也变不出一个不在 PATH 里的 npm，缺的是环境不是判断力
 * ——所以修在代码里，永久保留，不设日落条件。
 *
 * 探针失败（shell 卡住、超时、输出不含标记）一律**保持现状**：拿不到就不动 PATH，
 * App 顶多和今天一样坏，不会更坏。
 */
import { spawn } from 'node:child_process'

/** 把 PATH 从 rc 文件的噪声里夹出来：oh-my-zsh 横幅、nvm 提示、各种 echo 都在标记之外。 */
const BEGIN = '__OPENPIPAL_PATH_BEGIN__'
const END = '__OPENPIPAL_PATH_END__'

const SCRIPT = `echo ${BEGIN}; printenv PATH; echo ${END}`

/**
 * 先问交互登录 shell，问不到再退回只登录不交互。
 *
 * 为什么第一档要带 `-i`：nvm 的官方安装脚本默认只往 `.zshrc`（交互档）里写，
 * 不带 `-i` 就漏掉 node —— 而 node 恰好是最需要补的那个。
 * 为什么要有第二档：交互 shell 要 source 整套插件，本机实测 0.78s，但机器一忙就会飙。
 * 2026-08-25 实测：满载跑单测时它撞满 5s 上限返回 null——那一刻用户就白白拿到一个断的 PATH。
 * 只登录不交互实测 0.01s（快 78 倍），拿到的 PATH 通常也够用，宁可少补一点也别一点不补。
 */
const PROBES: { args: string[]; timeoutMs: number }[] = [
  { args: ['-l', '-i', '-c', SCRIPT], timeoutMs: 8000 },
  { args: ['-l', '-c', SCRIPT], timeoutMs: 5000 }
]

/**
 * 合并两份 PATH：登录 shell 那份在前，当前进程独有的补在后面，去重且保序。
 *
 * 登录那份代表用户自己的意图（PATH 的先后决定同名命令谁赢），所以它优先；
 * launchd 那四个系统目录本来就含在登录 PATH 里，合并后不会丢。
 */
export function mergePathEntries(current: string, incoming: string): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const entry of [...incoming.split(':'), ...current.split(':')]) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  return merged.join(':')
}

/** 从探针输出里取标记之间那段。取不到就返回 null（调用方据此保持现状）。 */
export function parseProbeOutput(stdout: string): string | null {
  const start = stdout.indexOf(BEGIN)
  const stop = stdout.indexOf(END, start + BEGIN.length)
  if (start < 0 || stop < 0) return null
  const value = stdout.slice(start + BEGIN.length, stop).trim()
  return value ? value : null
}

/**
 * 起一个 shell 问它的 PATH。全程异步、带硬超时、超时整组杀。
 *
 * stdin 必须 ignore：交互 shell 拿到一个开着的 stdin 可能坐等输入，永远不退出。
 * （同类教训见 `sandbox-network-probe-must-be-async`：同步探针会把主进程饿死。）
 */
function probeOnce(shell: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch {
      return resolve(null)
    }

    let out = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已经没了 */ }
      finish(null)
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.on('error', () => finish(null))
    child.on('close', () => finish(parseProbeOutput(out)))
  })
}

let cached: Promise<string | null> | null = null

/** 按 PROBES 的顺序逐档尝试，第一个问出结果的就算数。 */
export function resolveLoginShellPath(): Promise<string | null> {
  if (cached) return cached
  cached = (async () => {
    const shell = process.platform === 'win32' ? '' : process.env.SHELL || ''
    if (!shell) return null
    for (const { args, timeoutMs } of PROBES) {
      const value = await probeOnce(shell, args, timeoutMs)
      if (value) return value
    }
    return null
  })()
  return cached
}

export interface LoginShellPathReport {
  /** 有没有真的改动 process.env.PATH */
  applied: boolean
  /** 这次新加进来的目录 */
  added: string[]
}

/**
 * 问出登录 shell 的 PATH 并合并进 `process.env.PATH`。幂等，可重复调用。
 *
 * 修在 `process.env` 这一层而不是只修 bash 工具：stdio MCP server 也是拿
 * `{...process.env}` 起的子进程，命令常写成 `npx`，漏掉它等于只修了一半。
 */
export async function applyLoginShellPath(): Promise<LoginShellPathReport> {
  const loginPath = await resolveLoginShellPath()
  if (!loginPath) return { applied: false, added: [] }

  const current = process.env.PATH || ''
  const merged = mergePathEntries(current, loginPath)
  if (merged === current) return { applied: false, added: [] }

  const before = new Set(current.split(':').filter(Boolean))
  process.env.PATH = merged
  return { applied: true, added: merged.split(':').filter((entry) => !before.has(entry)) }
}

/** 仅供测试：清掉缓存，让下一次调用重新起探针。 */
export function resetLoginShellPathCache(): void {
  cached = null
}
