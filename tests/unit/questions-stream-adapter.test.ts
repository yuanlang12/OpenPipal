/**
 * questions_v2 流式链路（W5 条款B）：PiEventAdapter 把 Pi 的 toolcall_start / toolcall_delta /
 * tool_execution_end 序列翻译成前端事件。验证两件事：
 *
 * 1. 增量：toolcall_delta 阶段边生成边发 questions_v2_delta，完整问题数单调递增
 *    （首个问题在整段 JSON 完成前就已发出 → 提速的行为证据）。
 * 2. 终态语义不变：tool_execution_end 仍发出一次权威 questions_v2（loop break 靠它，未被触碰）。
 */
import { describe, it, expect } from 'vitest'
import { PiEventAdapter } from '../../src/main/pi-event-adapter'

const FINAL = {
  title: '关于首页设计的几个问题',
  questions: [
    { id: 'goal', kind: 'text-options', title: '主要目标？', options: ['转化', '品牌'] },
    { id: 'palette', kind: 'svg-options', title: '色板', options: [{ value: 'a', svg: '<svg viewBox="0 0 80 56"><rect fill="#0F3D2E"/></svg>' }] },
    { id: 'radius', kind: 'slider', title: '圆角', min: 0, max: 24, default: 8 },
    { id: 'notes', kind: 'freeform', title: '说明' }
  ]
}
const ARGS_JSON = JSON.stringify(FINAL)

// 模拟 Pi 逐块下发工具参数：toolcall_start → 若干 toolcall_delta → tool_execution_end
function drive(adapter: PiEventAdapter, chunkSize: number): any[] {
  const out: any[] = []
  // toolcall_start（partial.content[0].name = 工具名）
  out.push(...adapter.adapt({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ name: 'questions_v2' }] } }
  } as any))
  // toolcall_delta：按 chunkSize 切块喂参数
  for (let i = 0; i < ARGS_JSON.length; i += chunkSize) {
    out.push(...adapter.adapt({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', delta: ARGS_JSON.slice(i, i + chunkSize) }
    } as any))
  }
  // tool_execution_end：权威终态
  out.push(...adapter.adapt({
    type: 'tool_execution_end',
    toolName: 'questions_v2',
    result: { details: { questionsV2: { title: FINAL.title, questions: FINAL.questions } } }
  } as any))
  return out
}

describe('PiEventAdapter · questions_v2 流式', () => {
  it('toolcall_delta 阶段增量发出 questions_v2_delta，问题数单调递增', () => {
    const adapter = new PiEventAdapter()
    const events = drive(adapter, 8)
    const deltas = events.filter(e => e.type === 'questions_v2_delta')

    // 开场有一个空占位 delta（触发前端开 tab）
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas[0].questions).toHaveLength(0)

    // 问题数单调不减，且中途就出现过「部分问题」状态（不是最后一口气全到）
    const counts = deltas.map(d => d.questions.length)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
    expect(counts.some(c => c >= 1 && c < 4)).toBe(true) // 首个问题先于整段可见
    expect(counts[counts.length - 1]).toBe(4)            // 流式末尾四题齐

    // delta 用稳定的 streaming id
    const ids = new Set(deltas.map(d => d.id))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(/^streaming-/)
  })

  it('终态语义不变：tool_execution_end 仍发出权威 questions_v2（loop break 依据）', () => {
    const adapter = new PiEventAdapter()
    const events = drive(adapter, 8)
    const terminal = events.filter(e => e.type === 'questions_v2')
    expect(terminal).toHaveLength(1)
    expect(terminal[0].title).toBe(FINAL.title)
    expect(terminal[0].questions).toHaveLength(4)

    // questions_v2（终态）必须出现在所有 questions_v2_delta 之后
    const lastDelta = events.map(e => e.type).lastIndexOf('questions_v2_delta')
    const terminalIdx = events.map(e => e.type).indexOf('questions_v2')
    expect(terminalIdx).toBeGreaterThan(lastDelta)
  })

  it('不同分块粒度下终态一致（对块边界鲁棒）', () => {
    for (const size of [1, 3, 16, 512]) {
      const adapter = new PiEventAdapter()
      const events = drive(adapter, size)
      const terminal = events.filter(e => e.type === 'questions_v2')
      expect(terminal).toHaveLength(1)
      expect(terminal[0].questions).toHaveLength(4)
      // 末个 delta 也应收敛到 4 题
      const deltas = events.filter(e => e.type === 'questions_v2_delta')
      expect(deltas[deltas.length - 1].questions).toHaveLength(4)
    }
  })

  it('节流：签名（问题数|标题）不变时不重复发 questions_v2_delta（不是每 token 都发）', () => {
    const adapter = new PiEventAdapter()
    const events: any[] = []
    events.push(...adapter.adapt({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ name: 'questions_v2' }] } }
    } as any))
    // 第一个字符 '{' 让签名从初始空串变成 "0|"（title 仍未解析出来）——这一步必然触发一次 delta。
    events.push(...adapter.adapt({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', delta: '{' }
    } as any))
    const deltasAfterFirstByte = events.filter(e => e.type === 'questions_v2_delta').length

    // 之后连续喂入既不闭合问题、也凑不出完整 "title" 键值对的字节——签名一直停在 "0|"，
    // 不应再产生新的 questions_v2_delta（这就是"不是每 token 都发"的证据）。
    const stall = '"tit'
    for (const ch of stall) {
      events.push(...adapter.adapt({
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_delta', delta: ch }
      } as any))
    }
    const deltasAfterStall = events.filter(e => e.type === 'questions_v2_delta')
    expect(deltasAfterStall).toHaveLength(deltasAfterFirstByte)
    expect(deltasAfterStall[deltasAfterStall.length - 1].questions).toHaveLength(0)
  })

  it('title 首次解析成型的瞬间必发一次 delta（即使 questions 数组还是空的）', () => {
    const adapter = new PiEventAdapter()
    const events: any[] = []
    events.push(...adapter.adapt({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ name: 'questions_v2' }] } }
    } as any))
    // 一次性喂入到 title 值刚闭合、questions 数组还没写的位置
    events.push(...adapter.adapt({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', delta: '{"title":"关于配色的问题"' }
    } as any))
    const deltas = events.filter(e => e.type === 'questions_v2_delta')
    const withTitle = deltas.find(d => d.title === '关于配色的问题')
    expect(withTitle).toBeDefined()
    expect(withTitle.questions).toHaveLength(0)
  })

  it('create_artifact 仍走原 artifact_delta 路径，不受影响（无回归）', () => {
    const adapter = new PiEventAdapter()
    const start = adapter.adapt({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ name: 'create_artifact' }] } }
    } as any)
    expect(start.some(e => e.type === 'artifact_delta')).toBe(true)
    expect(start.some(e => e.type === 'questions_v2_delta')).toBe(false)
  })
})
