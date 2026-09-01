/**
 * Runtime 自有的错误哨兵。
 *
 * 落盘的合成错误气泡必须语言中立：同一条会话在中英文界面下产生的记录要逐字节一致
 * （验收矩阵会跨 Runtime 比对记录，ACP 导出也依赖它），因此 Runtime 只写哨兵，
 * 由渲染层在展示时翻译——与 messageDisplay.ts 既有的 `[Error]` 前缀本地化同一口径。
 *
 * 放在 shared/ 是为了让主进程与渲染层共用同一个常量，避免两处各写一份字符串漂移。
 */

const MODEL_STALL_MARKER_PREFIX = 'openpipal:model-stall:'

/** Runtime 侧：把"模型 N 秒无响应"写成语言中立的哨兵 */
export function formatModelStallNotice(seconds: number): string {
  return `${MODEL_STALL_MARKER_PREFIX}${Math.max(0, Math.round(seconds))}`
}

/** 渲染层：识别哨兵并取出秒数；不是哨兵（例如网关原文）返回 null，按原样展示 */
export function parseModelStallNotice(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(MODEL_STALL_MARKER_PREFIX)) return null
  const seconds = Number(trimmed.slice(MODEL_STALL_MARKER_PREFIX.length))
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

const SUBAGENT_MAX_TURNS_MARKER_PREFIX = 'openpipal:subagent-max-turns:'

/** 子 agent 侧：把"撞到 maxTurns 主动停止"写成语言中立的哨兵 */
export function formatSubagentMaxTurnsNotice(maxTurns: number): string {
  return `${SUBAGENT_MAX_TURNS_MARKER_PREFIX}${Math.max(0, Math.round(maxTurns))}`
}

/** 渲染层：识别哨兵并取出上限；不是哨兵（例如模型原文）返回 null，按原样展示 */
export function parseSubagentMaxTurnsNotice(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(SUBAGENT_MAX_TURNS_MARKER_PREFIX)) return null
  const maxTurns = Number(trimmed.slice(SUBAGENT_MAX_TURNS_MARKER_PREFIX.length))
  return Number.isFinite(maxTurns) && maxTurns >= 0 ? maxTurns : null
}

const STREAM_RETRY_MARKER_PREFIX = 'openpipal:stream-retry:'

/** Runtime 侧：把"上游断流，正在第 N/M 次重连"写成语言中立的哨兵 */
export function formatStreamRetryNotice(attempt: number, maxRetries: number): string {
  return `${STREAM_RETRY_MARKER_PREFIX}${Math.max(1, Math.round(attempt))}/${Math.max(1, Math.round(maxRetries))}`
}

/** 渲染层：识别哨兵并取出第几次/共几次；不是哨兵返回 null，按原样展示 */
export function parseStreamRetryNotice(text: string): { attempt: number; maxRetries: number } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(STREAM_RETRY_MARKER_PREFIX)) return null
  const [rawAttempt, rawMax] = trimmed.slice(STREAM_RETRY_MARKER_PREFIX.length).split('/')
  const attempt = Number(rawAttempt)
  const maxRetries = Number(rawMax)
  if (!Number.isFinite(attempt) || !Number.isFinite(maxRetries)) return null
  if (attempt < 1 || maxRetries < 1) return null
  return { attempt, maxRetries }
}
