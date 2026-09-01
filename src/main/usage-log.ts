/**
 * 用量落盘 —— 把 [Usage] / [Usage:turn] 从 console 引到 ~/.openpipal/usage.jsonl。
 *
 * 为什么要落盘（永久架构，不是拐杖）：多轮对话的成本是 N² 形状——一次"对话轮"里
 * 每个工具调用都是一次完整重发，长会话累计重发能到内容量的几百倍。这笔账唯一的
 * 减法是前缀缓存，而缓存命中率**不可推断、只能实测**（网关是否做隐式缓存、TTL 多长、
 * 前缀有没有被哪次改写打断，都不写在任何文档里）。没有这份记录，"工具轨迹预算该不该
 * 是 8000"这类问题只能靠猜。
 *
 * 纪律：只观测不改行为；写失败一律吞掉（用量记录不值得影响一次真实对话）；
 * 单文件封顶滚一代，不做索引不做查询——分析交给 jq/脚本，此处只负责如实记账。
 */
import { appendFile, readFile, stat, rename } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { getDataRoot } from './data-root'

const OPENPIPAL_DIR = getDataRoot()
const USAGE_LOG_PATH = join(OPENPIPAL_DIR, 'usage.jsonl')
/** 单文件上限：超了滚一代（usage.jsonl.1），只留两代——用量记录的价值在近期，不做归档 */
const MAX_BYTES = 8 * 1024 * 1024

export interface UsageCallRecord {
  kind: 'call'
  /** 会话 id 前 8 位，与 [Usage] 日志同口径 */
  conv: string
  model: string
  /** 本轮内第几次 LLM 调用（agentic 一轮会有多次） */
  seq: number
  /** 未命中缓存的新增 input */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 真实 prompt tokens = input + cacheRead + cacheWrite */
  prompt: number
  /** 缓存命中率 % */
  hit: number
  /** 本次载荷里工具轨迹占了多少 token（估算，回答"8000 预算配得对不对"） */
  trailTok: number
  /** 进入载荷的 tool 消息条数 */
  trailMsgs: number
  /** 进入载荷的历史消息总条数 */
  histMsgs: number
  /** 本轮是否触发了保近压远 */
  compacted: boolean
  /** 本次调用实报成本（服务商有定价数据时>0，未知为 0）——用量卡"今日"分区用 */
  cost?: number
}

export interface UsageTurnRecord {
  kind: 'turn'
  conv: string
  model: string
  calls: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  hit: number
}

export type RuntimeTurnPhase =
  | 'started'
  | 'stream_fn_called'
  | 'stream_opened'
  | 'first_stream_next'
  | 'first_model_event'
  | 'stream_retry'
  | 'external_abort'
  | 'watchdog'
  | 'settled'

/**
 * 运行时一轮执行的最小可归因轨迹。
 *
 * 不记录 prompt、响应正文、凭据或底层异常，以便在真实供应商静默时仍能区分：
 * 本地流函数是否已被调用、是否收到过模型事件、是外部取消还是看门狗中断、以及最终如何结束。
 * `stream_*` 仅代表客户端本地边界，不能证明服务商已收到 HTTP 请求。
 */
export interface RuntimeTurnRecord {
  kind: 'runtime_turn'
  runtime: 'legacy' | 'pi-core'
  conv: string
  model: string
  source: string
  sequence: number
  phase: RuntimeTurnPhase
  elapsedMs: number
  firstModelEvent: boolean
  /** 同一 OpenPipal turn 内第几个 Provider StreamFn 尝试；仅 stream_* 阶段存在。 */
  streamAttempt?: number
  outcome?: 'completed' | 'provider_error' | 'agent_aborted' | 'external_abort' | 'watchdog' | 'event_mapping_failed' | 'lifecycle_abort' | 'failed_before_assistant'
}

let _dirChecked = false
/** 进程内的文件大小水位：行长已知，没必要每次 append 前都 stat 一次磁盘
 *  （一轮 agentic 能有十来次调用，全生命周期是几千次可省的 syscall）。
 *  -1 = 尚未播种，首次写入时 stat 一次拿到起点，之后纯内存累加。 */
let _bytes = -1

/** 满了就滚一代。失败不影响记账——大不了这一代长一点 */
async function rotate(): Promise<void> {
  try {
    await rename(USAGE_LOG_PATH, USAGE_LOG_PATH + '.1')
    _bytes = 0
  } catch { /* 改名失败就继续往原文件写 */ }
}

async function writeLine(line: string): Promise<void> {
  if (_bytes < 0) {
    _bytes = await stat(USAGE_LOG_PATH).then(s => s.size).catch(() => 0)
  }
  if (_bytes >= MAX_BYTES) await rotate()
  await appendFile(USAGE_LOG_PATH, line, 'utf-8')
  _bytes += Buffer.byteLength(line)
}

/** 追加一条用量记录（fire-and-forget，绝不 throw、绝不阻塞对话） */
export function appendUsageRecord(record: UsageCallRecord | UsageTurnRecord | RuntimeTurnRecord): void {
  if (!_dirChecked) {
    try { mkdirSync(OPENPIPAL_DIR, { recursive: true }) } catch { /* 忽略 */ }
    _dirChecked = true
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'
  void writeLine(line).catch(() => { /* 用量记录不值得影响一次真实对话 */ })
}

export interface TodayModelUsage {
  model: string
  /** 真实 prompt tokens 累计 = input + cacheRead + cacheWrite */
  prompt: number
  output: number
  cacheRead: number
  calls: number
  /** 实报成本累计（服务商未知定价时为 0） */
  cost: number
}

/**
 * 今日（本地时区）按模型聚合的调用量——用量信息卡"今日用量"分区的数据源。
 * 只在卡片展开时读一次，不进任何热路径。日志是严格追加的，时间戳单调递增：
 * 因此从文件末尾倒着扫，遇到第一条早于今日零点的记录即停——今日记录永远是
 * 尾部的一小段，8MB 封顶的日志绝大部分行连 JSON.parse 都不必做。只有当前
 * 一代整个文件都在今日之内时才需要继续翻上一代。读失败按空处理：卡片少一
 * 栏比报错强。前提是 ts 单调——系统时钟向后跳（NTP 校正/改时区）会让这里少
 * 算一段，对一张展示用的卡片是可接受的代价，不值得为它放弃早停。
 */
export async function readTodayUsageByModel(): Promise<TodayModelUsage[]> {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayStartMs = dayStart.getTime()
  const byModel = new Map<string, TodayModelUsage>()
  for (const path of [USAGE_LOG_PATH, USAGE_LOG_PATH + '.1']) {
    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    let reachedYesterday = false
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.startsWith('{"ts"')) continue
      let record: any
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const ts = Date.parse(record?.ts || '')
      if (!Number.isFinite(ts)) continue
      if (ts < dayStartMs) { reachedYesterday = true; break }
      if (record?.kind !== 'call') continue
      const entry = byModel.get(record.model) || {
        model: record.model, prompt: 0, output: 0, cacheRead: 0, calls: 0, cost: 0
      }
      entry.prompt += record.prompt || 0
      entry.output += record.output || 0
      entry.cacheRead += record.cacheRead || 0
      entry.calls += 1
      entry.cost += record.cost || 0
      byModel.set(record.model, entry)
    }
    if (reachedYesterday) break
  }
  // Array.from 而不是展开：tsconfig target 低于 es2015，展开 Map 迭代器过不了 tsc
  return Array.from(byModel.values()).sort((a, b) => b.prompt - a.prompt)
}
