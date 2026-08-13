/**
 * 主进程日志落盘 —— 把 console.log/warn/error 同时写到 ~/.openpipal/logs/main.log。
 *
 * 为什么要（永久架构，不是拐杖）：打包后的 app 没有终端，console 输出直接进虚空。
 * 实案（2026-07-29）：用户的模型服务额度用尽、对话卡在"深度思考"，事后想查服务方到底
 * 返了什么——**查不到**，因为那次运行的日志根本没留下来。诊断的前提是现场还在。
 *
 * 纪律照抄 usage-log.ts：只旁路不改行为（console 原样继续输出）；写失败一律吞掉
 * （日志不值得影响一次真实对话）；单文件封顶滚一代，不做索引不做查询。
 */
import { appendFile, stat, rename } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { dataPath } from './data-root'

const LOG_DIR = dataPath('logs')
const LOG_PATH = join(LOG_DIR, 'main.log')
/** 单文件上限：超了滚一代（main.log.1），只留两代——日志的价值在近期 */
const MAX_BYTES = 8 * 1024 * 1024
/** 单行上限：截图 base64、大 HTML 载荷进日志毫无意义，还会瞬间撑爆文件 */
const MAX_LINE_CHARS = 4000

let _installed = false
let _dirChecked = false
let _bytes = -1
let _fatalExitScheduled = false
/** 串行化写入：console 是同步调用、append 是异步，不排队会交错出乱行 */
let _chain: Promise<void> = Promise.resolve()

/**
 * 落盘前脱敏。现在的日志**没有**任何一行打印密钥值（已实测：全仓 console 只出现变量名不出现值），
 * 但"日志上磁盘"这件事把未来任何一次手滑的代价从"终端一闪而过"变成"永久留档"——
 * 这道过滤是给未来的自己上的保险，不是给现在的 bug 打的补丁。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|gsk|pplx)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    // JSON/对象里的 apiKey/token/secret/authorization 字段值
    // 排除类里必须含 & 和 ;——否则 URL 上的 ?api_key=xxx&model=glm 会被从 & 一路吃到行尾
    .replace(/("?(?:api[_-]?key|apikey|token|secret|authorization)"?\s*[:=]\s*"?)([^"'\s,;&}\]]{8,})/gi, '$1***')
    // URL 查询串里的 key/token 参数
    .replace(/([?&](?:key|api_key|access_token|token)=)([^&\s]{8,})/gi, '$1***')
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`
      try { return JSON.stringify(a) } catch { return String(a) }
    })
    .join(' ')
}

async function writeLine(line: string): Promise<void> {
  try {
    if (!_dirChecked) { mkdirSync(LOG_DIR, { recursive: true }); _dirChecked = true }
    if (_bytes < 0) _bytes = await stat(LOG_PATH).then((s) => s.size).catch(() => 0)
    if (_bytes >= MAX_BYTES) {
      await rename(LOG_PATH, LOG_PATH + '.1').catch(() => { /* 改名失败就继续往原文件写 */ })
      _bytes = 0
    }
    await appendFile(LOG_PATH, line, 'utf-8')
    _bytes += Buffer.byteLength(line)
  } catch { /* 日志写失败不影响任何真实行为 */ }
}

/**
 * Node 的 uncaughtException / unhandledRejection 监听器会接管默认的崩溃行为。
 * 先等刚刚写入的 fatal 日志落盘，最多等一秒，随后明确以失败码退出；不能只记日志后让
 * 已经不可信的主进程继续运行。
 */
function exitAfterFatalError(): void {
  if (_fatalExitScheduled) return
  _fatalExitScheduled = true

  let exited = false
  const exit = () => {
    if (exited) return
    exited = true
    process.exit(1)
  }
  const deadline = setTimeout(exit, 1000)
  deadline.unref()
  void _chain.finally(() => {
    clearTimeout(deadline)
    exit()
  })
}

/**
 * 安装日志旁路。幂等；只在主进程启动时调一次。
 * console 原有行为完全不变（仍然打到 stdout/stderr），这里只是多抄一份到磁盘。
 */
export function installMainLog(): void {
  if (_installed) return
  _installed = true

  const tap = (level: 'LOG' | 'WARN' | 'ERROR', orig: (...a: any[]) => void) =>
    (...args: any[]): void => {
      orig(...args)
      let text = redactSecrets(fmt(args))
      if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + `…(截断 ${text.length - MAX_LINE_CHARS} 字符)`
      const line = `${new Date().toISOString()} [${level}] ${text}\n`
      _chain = _chain.then(() => writeLine(line))
    }

  console.log = tap('LOG', console.log.bind(console))
  console.warn = tap('WARN', console.warn.bind(console))
  console.error = tap('ERROR', console.error.bind(console))

  // 未捕获异常/未处理 rejection 是最该留档的一类——它们平时连 console 都不一定看得见
  process.on('uncaughtException', (err) => {
    console.error('[Uncaught]', err?.message || err, err?.stack || '')
    exitAfterFatalError()
  })
  process.on('unhandledRejection', (reason: any) => {
    console.error('[UnhandledRejection]', reason?.message || String(reason), reason?.stack || '')
    exitAfterFatalError()
  })

  console.log(`[Log] 主进程日志落盘: ${LOG_PATH}`)
}

export function mainLogPath(): string {
  return LOG_PATH
}

// 模块求值即安装（index.ts 把本模块列为第一个 import）——比"在某个函数里调一次"更早，
// 能盖住其它模块顶层代码与启动链路的输出。installMainLog 幂等，重复 import 无副作用。
// 只在真 Electron 主进程里装：单测 import 本模块只为拿 redactSecrets，不该劫持 console、
// 更不该往用户的真实日志文件里写测试噪音。
if (process.versions?.electron) installMainLog()
