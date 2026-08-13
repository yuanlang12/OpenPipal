/**
 * Goal Checker — 单次 turn 结束后的"目标完成度判定器"
 *
 * 设计要点:
 * 1. 纯逻辑、无外部副作用:通过依赖注入收一个 LLM 调用函数(GoalCheckerLLM),
 *    跟 Pi/OpenAI/Anthropic 框架解耦,方便单测,也方便未来换模型。
 * 2. 失败一律放过(fallback=true):任何异常(网络/JSON 解析/超时)都返回 ok=true,
 *    防止 GoalChecker 故障把主对话卡死。这是"安全闸"的核心。
 * 3. 不修改 messages,不存状态:状态由调用方(P2 的 agent loop)持有,
 *    GoalChecker 只是一个"问一次、答一次"的函数。
 */

/** 会话级 goal 状态,作为 ConversationConfig.goal 持久化 */
export interface ConversationGoal {
  /** 用户输入的目标文本 */
  text: string
  /** 最大允许的 continuation 轮次,默认 8(对齐 Claude Code Stop hook BLOCK_CAP) */
  maxTurns: number
  /** 已经触发 continuation 的轮次 */
  turnsUsed: number
  /**
   * - active:  正在追逐目标
   * - paused:  用户暂停(预留)
   * - done:    GoalChecker 判定完成
   * - exceeded: 达到 maxTurns 强停
   */
  status: 'active' | 'paused' | 'done' | 'exceeded'
  /** 上次评估结果,供 UI 显示 */
  lastCheck?: {
    ok: boolean
    reason: string
    timestamp: number
    fallback?: boolean
  }
  /** 连续判 false 的次数,用于防 GoalChecker 永远拒判的二级保险 */
  consecutiveBlocks: number
  createdAt: number
}

/** GoalChecker 调用返回 */
export interface GoalCheckResult {
  ok: boolean
  reason: string
  /** true 表示走了 fallback(错误/解析失败/未激活),调用方应据此决定是否计入 turnsUsed */
  fallback?: boolean
}

/**
 * 依赖注入的 LLM 调用契约。
 * 返回字符串原文(GoalChecker 内部负责 JSON 解析与容错)。
 * 实现方(P2 接入时)负责选择主会话模型 + cache breakpoint 标记。
 */
export type GoalCheckerLLM = (params: {
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}) => Promise<string>

export interface GoalCheckerOptions {
  goal: ConversationGoal
  /** 用于判定的对话历史(P2 接入时由 agent loop 提供最近 N 条) */
  recentMessages: Array<{ role: string; content: string }>
  /** LLM 调用函数 */
  llm: GoalCheckerLLM
  signal?: AbortSignal
}

/**
 * 固定的 GoalChecker system prompt — 设计成稳定 prefix 以便 prompt cache 命中。
 * P2 接入真实 LLM 时,这段会作为可缓存的 prefix。
 */
export const GOAL_CHECKER_SYSTEM_PROMPT = `You are a goal completion judge for an AI assistant conversation.

Your job: read a GOAL and a recent CONVERSATION transcript, then decide whether the goal is FULLY complete based ONLY on evidence visible in the transcript.

Reply with strict JSON only — no markdown, no commentary, no code fences:
{"ok": boolean, "reason": string}

Rules:
- ok=true:  the goal is fully achieved and verified in the transcript
- ok=false: more work is needed; reason should briefly state what's left (max 100 chars)
- Be skeptical: if the assistant claims "done" without concrete evidence (no test run, no file shown, no result quoted), return ok=false
- Do not invent or assume actions not visible in the transcript
- If the goal is fundamentally underspecified or asks for something impossible, return ok=true with reason explaining the limitation (don't loop forever on impossible goals)
- Keep reason concise — it will be shown to the assistant as a continuation hint`.trim()

/**
 * 主入口:判定 goal 是否完成。
 *
 * 短路条件(直接返回 fallback=true,不调 LLM):
 *   - goal.status !== 'active'
 *   - recentMessages 为空
 *
 * 容错路径(返回 fallback=true):
 *   - llm() 抛出任何异常
 *   - 返回内容无法解析为合法 JSON
 *
 * 上层(P2 agent loop)应判断:
 *   - result.ok === true → 停止 continuation
 *   - result.ok === false → push continuation hint,turnsUsed++,再跑一轮
 *   - result.fallback === true → 不增加 turnsUsed,认为 GoalChecker 本身失效
 */
export async function checkGoal(opts: GoalCheckerOptions): Promise<GoalCheckResult> {
  const { goal, recentMessages, llm, signal } = opts

  if (goal.status !== 'active') {
    return { ok: true, reason: `goal status is "${goal.status}", not active`, fallback: true }
  }

  if (recentMessages.length === 0) {
    return { ok: true, reason: 'empty conversation, nothing to judge', fallback: true }
  }

  const transcript = compactTranscript(recentMessages)
  const userPrompt = `GOAL:\n${goal.text}\n\n---\n\nRECENT CONVERSATION:\n${transcript}`

  let raw: string
  try {
    raw = await llm({
      systemPrompt: GOAL_CHECKER_SYSTEM_PROMPT,
      userPrompt,
      signal
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: true, reason: `checker error: ${msg}`, fallback: true }
  }

  return parseCheckerResponse(raw)
}

/**
 * 解析 GoalChecker LLM 的回复。
 * 兼容三种情况:
 *   1. 纯 JSON
 *   2. ```json ... ``` 包裹的 JSON
 *   3. 前后有少量解释文字的 JSON(用正则提取第一个 {...} 对象)
 */
export function parseCheckerResponse(text: string): GoalCheckResult {
  const trimmed = text.trim()

  // 去掉可能的代码块包裹
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  // 优先直接解析
  let parsed: unknown = null
  try {
    parsed = JSON.parse(stripped)
  } catch {
    // 退而求其次,提取第一个 {...}
    const match = stripped.match(/\{[\s\S]*?\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {
        parsed = null
      }
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    return {
      ok: true,
      reason: `unparseable checker response: ${trimmed.slice(0, 120)}`,
      fallback: true
    }
  }

  const obj = parsed as Record<string, unknown>
  const okRaw = obj.ok
  const reasonRaw = obj.reason

  if (typeof okRaw !== 'boolean') {
    return {
      ok: true,
      reason: `missing or non-boolean "ok" field in response: ${trimmed.slice(0, 120)}`,
      fallback: true
    }
  }

  return {
    ok: okRaw,
    reason: typeof reasonRaw === 'string' ? reasonRaw.slice(0, 500) : ''
  }
}

/**
 * 把消息历史压成 GoalChecker 容易消化的纯文本。
 * 不调 LLM 做摘要(P1 阶段简单截断够用),后续若 transcript 过长可在此扩展。
 */
export function compactTranscript(
  messages: Array<{ role: string; content: string }>,
  opts?: { maxMessages?: number; maxCharsPerMessage?: number }
): string {
  const maxMessages = opts?.maxMessages ?? 20
  const maxCharsPerMessage = opts?.maxCharsPerMessage ?? 800
  const recent = messages.slice(-maxMessages)
  return recent
    .map((m) => {
      const content = m.content.length > maxCharsPerMessage
        ? m.content.slice(0, maxCharsPerMessage) + '...[truncated]'
        : m.content
      return `[${m.role}] ${content}`
    })
    .join('\n\n')
}

/** 工厂函数:用户敲 `/goal <text>` 时调用,产生一个全新的 active goal */
export function createGoal(text: string, opts?: { maxTurns?: number }): ConversationGoal {
  return {
    text: text.trim(),
    maxTurns: opts?.maxTurns ?? 8,
    turnsUsed: 0,
    status: 'active',
    consecutiveBlocks: 0,
    createdAt: Date.now()
  }
}

/**
 * 给 agent 看的 continuation hint 模板。
 * P2 接入时,GoalChecker 判 ok=false → 在 messages 末尾 append role=user 的这条文本。
 * 注意:文本要简短稳定,避免每次轮次更新都让 prefix 后半段大变(虽然这条只在末尾,
 * 但仍要避免噪音 token)。
 */
export function buildContinuationHint(goal: ConversationGoal, checkResult: GoalCheckResult): string {
  return `[Goal Checker] 你的会话目标仍未完成。

目标:${goal.text}
当前评估:${checkResult.reason || '尚未达成验收标准'}
已用轮次:${goal.turnsUsed}/${goal.maxTurns}

请继续推进。如果确实无法继续(例如缺少必要信息或权限),请明确说明阻塞原因,我会停止 goal 追逐。`
}
