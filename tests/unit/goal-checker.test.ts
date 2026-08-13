import { describe, it, expect, vi } from 'vitest'
import {
  checkGoal,
  createGoal,
  parseCheckerResponse,
  compactTranscript,
  buildContinuationHint,
  GOAL_CHECKER_SYSTEM_PROMPT,
  type ConversationGoal,
  type GoalCheckerLLM
} from '../../src/main/goal-checker'

// 工具函数 ---------------------------------------------------------------

function makeLLM(reply: string | Error): GoalCheckerLLM {
  return vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return reply
  })
}

function activeGoal(text = '完成单元测试'): ConversationGoal {
  return createGoal(text)
}

// createGoal --------------------------------------------------------------

describe('createGoal', () => {
  it('返回默认 maxTurns=8 / status=active / turnsUsed=0', () => {
    const g = createGoal('修复登录 bug')
    expect(g.text).toBe('修复登录 bug')
    expect(g.maxTurns).toBe(8)
    expect(g.turnsUsed).toBe(0)
    expect(g.status).toBe('active')
    expect(g.consecutiveBlocks).toBe(0)
    expect(g.createdAt).toBeGreaterThan(0)
  })

  it('允许自定义 maxTurns', () => {
    const g = createGoal('x', { maxTurns: 3 })
    expect(g.maxTurns).toBe(3)
  })

  it('trim 输入文本', () => {
    const g = createGoal('   带空格的目标  \n')
    expect(g.text).toBe('带空格的目标')
  })
})

// parseCheckerResponse ----------------------------------------------------

describe('parseCheckerResponse', () => {
  it('解析纯 JSON', () => {
    const r = parseCheckerResponse('{"ok": true, "reason": "done"}')
    expect(r).toEqual({ ok: true, reason: 'done' })
  })

  it('解析 ```json 代码块包裹', () => {
    const r = parseCheckerResponse('```json\n{"ok": false, "reason": "缺测试"}\n```')
    expect(r).toEqual({ ok: false, reason: '缺测试' })
  })

  it('解析无语言标签代码块', () => {
    const r = parseCheckerResponse('```\n{"ok":true,"reason":""}\n```')
    expect(r).toEqual({ ok: true, reason: '' })
  })

  it('从含解释文字的回复中提取首个 JSON 对象', () => {
    const r = parseCheckerResponse('好的,我判定如下:{"ok": false, "reason": "未跑测试"}')
    expect(r).toEqual({ ok: false, reason: '未跑测试' })
  })

  it('reason 不是字符串时返回空串', () => {
    const r = parseCheckerResponse('{"ok": true, "reason": 123}')
    expect(r.ok).toBe(true)
    expect(r.reason).toBe('')
  })

  it('reason 超过 500 字符时截断', () => {
    const long = 'x'.repeat(600)
    const r = parseCheckerResponse(`{"ok": false, "reason": "${long}"}`)
    expect(r.reason.length).toBe(500)
  })

  it('完全无法解析时走 fallback (ok=true)', () => {
    const r = parseCheckerResponse('随便写点东西,不是 JSON')
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
    expect(r.reason).toContain('unparseable')
  })

  it('JSON 缺少 ok 字段时走 fallback (ok=true)', () => {
    const r = parseCheckerResponse('{"reason": "缺 ok"}')
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
  })

  it('JSON 中 ok 非 boolean 时走 fallback', () => {
    const r = parseCheckerResponse('{"ok": "yes", "reason": ""}')
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
  })
})

// compactTranscript -------------------------------------------------------

describe('compactTranscript', () => {
  it('截取最近 N 条', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `msg-${i}`
    }))
    const out = compactTranscript(msgs, { maxMessages: 5 })
    expect(out).toContain('msg-29')
    expect(out).toContain('msg-25')
    expect(out).not.toContain('msg-24')
  })

  it('截断单条超长内容', () => {
    const longMsg = 'a'.repeat(2000)
    const out = compactTranscript([{ role: 'user', content: longMsg }], {
      maxCharsPerMessage: 100
    })
    expect(out).toContain('[truncated]')
    expect(out.length).toBeLessThan(200)
  })

  it('标注 role', () => {
    const out = compactTranscript([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])
    expect(out).toContain('[user] hi')
    expect(out).toContain('[assistant] hello')
  })
})

// checkGoal — 短路条件 ----------------------------------------------------

describe('checkGoal 短路条件', () => {
  it('goal 非 active 时直接返回 fallback,不调 LLM', async () => {
    const g = { ...activeGoal(), status: 'done' as const }
    const llm = makeLLM('{"ok": false, "reason": "should not be called"}')
    const r = await checkGoal({
      goal: g,
      recentMessages: [{ role: 'user', content: 'x' }],
      llm
    })
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
    expect(llm).not.toHaveBeenCalled()
  })

  it('recentMessages 为空时直接返回 fallback', async () => {
    const llm = makeLLM('{"ok": true, "reason": ""}')
    const r = await checkGoal({
      goal: activeGoal(),
      recentMessages: [],
      llm
    })
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
    expect(llm).not.toHaveBeenCalled()
  })
})

// checkGoal — 正常路径 ----------------------------------------------------

describe('checkGoal 正常路径', () => {
  it('LLM 判 ok=true → 返回 ok=true 不带 fallback', async () => {
    const llm = makeLLM('{"ok": true, "reason": "测试已通过"}')
    const r = await checkGoal({
      goal: activeGoal(),
      recentMessages: [{ role: 'assistant', content: '测试已运行' }],
      llm
    })
    expect(r.ok).toBe(true)
    expect(r.fallback).toBeUndefined()
    expect(r.reason).toBe('测试已通过')
  })

  it('LLM 判 ok=false → 返回 ok=false + reason', async () => {
    const llm = makeLLM('{"ok": false, "reason": "数据库迁移未完成"}')
    const r = await checkGoal({
      goal: activeGoal(),
      recentMessages: [{ role: 'user', content: 'x' }],
      llm
    })
    expect(r.ok).toBe(false)
    expect(r.fallback).toBeUndefined()
    expect(r.reason).toBe('数据库迁移未完成')
  })

  it('LLM 调用收到正确的 system prompt 和 user prompt', async () => {
    let captured: { systemPrompt: string; userPrompt: string } | null = null
    const llm: GoalCheckerLLM = async (params) => {
      captured = params
      return '{"ok": true, "reason": ""}'
    }
    await checkGoal({
      goal: activeGoal('修复登录 bug'),
      recentMessages: [{ role: 'user', content: '帮我' }],
      llm
    })
    expect(captured).not.toBeNull()
    expect(captured!.systemPrompt).toBe(GOAL_CHECKER_SYSTEM_PROMPT)
    expect(captured!.userPrompt).toContain('GOAL:')
    expect(captured!.userPrompt).toContain('修复登录 bug')
    expect(captured!.userPrompt).toContain('RECENT CONVERSATION:')
    expect(captured!.userPrompt).toContain('[user] 帮我')
  })
})

// checkGoal — 容错路径 ----------------------------------------------------

describe('checkGoal 容错路径', () => {
  it('LLM 抛错时 → 返回 ok=true + fallback=true', async () => {
    const llm = makeLLM(new Error('network timeout'))
    const r = await checkGoal({
      goal: activeGoal(),
      recentMessages: [{ role: 'user', content: 'x' }],
      llm
    })
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
    expect(r.reason).toContain('network timeout')
  })

  it('LLM 返回无法解析的内容 → 返回 ok=true + fallback=true', async () => {
    const llm = makeLLM('我无法判断')
    const r = await checkGoal({
      goal: activeGoal(),
      recentMessages: [{ role: 'user', content: 'x' }],
      llm
    })
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
  })

  it('LLM 抛非 Error 对象 → 仍走 fallback', async () => {
    const llm: GoalCheckerLLM = async () => {
      throw 'string error'
    }
    const r = await checkGoal({
      goal: activeGoal(),
      recentMessages: [{ role: 'user', content: 'x' }],
      llm
    })
    expect(r.ok).toBe(true)
    expect(r.fallback).toBe(true)
    expect(r.reason).toContain('string error')
  })
})

// buildContinuationHint ---------------------------------------------------

describe('buildContinuationHint', () => {
  it('包含目标 / 评估 reason / 已用轮次', () => {
    const goal = { ...activeGoal('修复登录 bug'), turnsUsed: 3, maxTurns: 8 }
    const hint = buildContinuationHint(goal, { ok: false, reason: '未跑测试' })
    expect(hint).toContain('修复登录 bug')
    expect(hint).toContain('未跑测试')
    expect(hint).toContain('3/8')
    expect(hint).toContain('Goal Checker')
  })

  it('当 reason 为空时显示兜底文案', () => {
    const goal = activeGoal()
    const hint = buildContinuationHint(goal, { ok: false, reason: '' })
    expect(hint).toContain('尚未达成验收标准')
  })
})
