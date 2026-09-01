/**
 * 对照实验的 A 臂：裸 `pi` CLI。（B 臂走 headless-driver，那边已有。）
 *
 * 目的不是刷分，是量**这层壳值多少分**。所以两条臂必须共享：同一个模型、同一个端点、
 * 同一把凭据、同一份仓库快照、同一套判分。差别只允许来自「壳」本身——系统提示词、
 * 工具集、技能、权限与沙箱、上下文注入。
 *
 * A 臂的隔离做法（每次运行一个一次性 HOME）：
 *   - `-ne` 关掉扩展发现，用户自己装的 pi 扩展不许混进来（我们量的是出厂的 pi，不是他的 pi）；
 *   - `--no-session` + 临时 HOME，会话文件不落进 `~/.pi`；
 *   - 端点与模型靠一个临时扩展注册进去，凭据只经环境变量传，不进命令行（`ps` 看得见命令行）。
 *
 * 注意一处**结构性差异，不是 bug**：pi 官方明说自己没有内置沙箱、非交互模式也不弹授权
 * （其 docs/security.md），而我们这层有沙箱与权限档位。auto 档 + /tmp 下的工作目录时我们
 * 这边同样一张卡都不弹（深度验收里实测过），所以这一轮两条臂都是「不受阻」地跑，可比。
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ArmResult {
  /** 助手最后说的话（A 臂从 json 事件里取，B 臂从 SSE 累） */
  reply: string
  /** 事件条数 —— 0 就是根本没跑起来 */
  events: number
  /** 调了几次工具 */
  tools: number
  ms: number
  /** normal / timeout / exit_N */
  stopReason: string
  /** 事件类型直方图 —— 排查"跑了但一个字没说"时看这个 */
  types: Record<string, number>
}

/** ModelConfig 的 apiFormat → pi 的 api id */
function piApi(apiFormat?: string): string {
  if (apiFormat === 'anthropic') return 'anthropic-messages'
  if (apiFormat === 'openai-responses') return 'openai-responses'
  return 'openai-completions'
}

/**
 * 直接喂给 node，不走 `node_modules/.bin/pi` 那个软链。
 * 那条软链指向一个带 shebang 的 cli.js，spawn 它要靠 `/usr/bin/env node` 解析——
 * 实测在 vitest 起的子进程里会 ENOENT。用 `process.execPath` 就没有这层依赖。
 */
const PI_CLI = join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
const PROVIDER = 'openpipal-bench'

/**
 * 临时扩展：把用户那套端点注册成一个 provider。
 * 一切取自环境变量——文件本身不含任何连接信息，可以安全落盘。
 *
 * `thinkingLevelMap` 不是可选项：这家网关上的模型**关不掉思考**，不带档位直接
 * 400 `[1210] This model always engages in thinking and cannot be disabled`，
 * 裸 pi 会连试三次然后交白卷（实测 events=32 / tools=0 / reply=""）。我们这层
 * 早就替用户填平了（config-manager 的 GLM_ALWAYS_THINKING_LEVEL_MAP）——这是壳的价值，
 * 但如果不给 A 臂补上，量到的就只是"接线没接通"，不是"agent 干活能力"，对照就没意义了。
 * 所以这里补齐，让两条臂都在同一个思考档位上比。
 */
const PROVIDER_EXT = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.registerProvider("${PROVIDER}", {
    name: "OpenPipal Bench",
    baseUrl: process.env.BENCH_BASE_URL!,
    apiKey: "$BENCH_SECRET",
    api: process.env.BENCH_API as any,
    models: [
      {
        id: process.env.BENCH_MODEL!,
        name: process.env.BENCH_MODEL!,
        reasoning: process.env.BENCH_REASONING === "1",
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(process.env.BENCH_CTX),
        maxTokens: 32768
      }
    ]
  })
}
`

function textOf(message: any): string {
  const c = message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
  return ''
}

/**
 * 跑一次裸 pi。`mc` 原样来自用户配置，本函数不打印它的任何字段。
 */
export async function runPiArm(opts: {
  mc: Record<string, unknown>
  workingDir: string
  task: string
  maxMs: number
  /** 两条臂必须一致 —— 思考档位直接决定成绩，不对齐就不是同一个实验 */
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'max'
  verbose?: boolean
}): Promise<ArmResult> {
  const { mc } = opts
  const home = await mkdtemp(join(tmpdir(), 'openpipal-bench-pi-'))
  // 扩展文件放在一次性 HOME 里，**不能**放进被测仓库——agent 会读到它，等于泄题 + 污染 diff
  const ext = join(home, 'provider.ts')
  await writeFile(ext, PROVIDER_EXT, 'utf8')

  const t0 = Date.now()
  const child = spawn(
    process.execPath,
    [PI_CLI, '--mode', 'json', '-p', '--no-session', '-ne', '--provider', PROVIDER,
      '--model', String(mc.model), '--thinking', opts.thinking ?? 'low', '-e', ext, opts.task],
    {
      cwd: opts.workingDir,
      env: {
        ...process.env,
        HOME: home,
        // 凭据只走环境变量：命令行参数在 `ps` 里全机器可见
        BENCH_SECRET: String(mc.apiKey),
        BENCH_BASE_URL: String(mc.baseUrl),
        BENCH_MODEL: String(mc.model),
        BENCH_API: piApi(mc.apiFormat as string | undefined),
        BENCH_REASONING: mc.supportsThinking ? '1' : '0',
        BENCH_CTX: String(mc.contextWindow || 131072)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 自成进程组，超时才杀得干净 —— 见下面 timer 处的注释
      detached: true
    }
  )

  let reply = ''
  let events = 0
  let tools = 0
  let buf = ''
  let stderr = ''
  const types: Record<string, number> = {}
  // 排查用：BENCH_DUMP=<file> 时把原始事件流落盘。默认不开——事件里带连接信息。
  const dump = process.env.BENCH_DUMP
  const onLine = (line: string): void => {
    if (!line.trim()) return
    if (dump) appendFileSync(dump, line + '\n')
    events++
    let e: any
    try { e = JSON.parse(line) } catch { return }
    types[e.type ?? '?'] = (types[e.type ?? '?'] ?? 0) + 1
    if (e.type === 'tool_execution_start') tools++
    // 助手正文可能落在好几种事件上（版本间会变），逐个兜住，最后一条为准
    for (const m of [e.message, ...(Array.isArray(e.messages) ? e.messages : [])]) {
      if (m?.role !== 'assistant') continue
      const txt = textOf(m)
      if (txt) reply = txt
    }
  }
  child.stdout.on('data', (d) => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) onLine(l)
  })
  child.stderr.on('data', (d) => { stderr += d.toString() })

  let stopReason = 'normal'
  await new Promise<void>((resolve) => {
    /**
     * 超时要杀**整个进程组**，只杀 pi 自己不够。
     *
     * agent 是用 bash 工具起测试的，那些 pytest 是 pi 的孙进程。只 `child.kill()` 的话
     * 它们变成孤儿继续跑，而它们的工作目录**正是随后判分、还原、B 臂要用的那一个**——
     * 于是 A 臂超时的题会把污染漏给 B 臂。40 道里有 5 条 A 臂走了这条路。
     */
    const timer = setTimeout(() => {
      stopReason = 'timeout'
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, opts.maxMs)
    const finish = (why: string): void => { clearTimeout(timer); stopReason = why; resolve() }
    // spawn 失败（ENOENT 等）只发 'error'，**不发 'close'**——不接这个事件的话
    // 这个 Promise 永远不 resolve，症状是整条用例挂到超时才死（实测白等了 300s）。
    child.on('error', (err) => { stderr += String(err); finish('spawn_error') })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stopReason === 'normal' && code !== 0) stopReason = `exit_${code}`
      resolve()
    })
  })
  if (buf.trim()) onLine(buf)
  await rm(home, { recursive: true, force: true })
  if (opts.verbose && stopReason !== 'normal') console.log(`[armA] ${stopReason}: ${stderr.slice(-600)}`)

  return { reply, events, tools, ms: Date.now() - t0, stopReason, types }
}
