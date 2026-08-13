/**
 * questions_v2 流式增量提取（W5 条款B）：extractStreamingQuestions 从不完整的工具参数 JSON
 * 中按括号深度提取「已成型的完整问题」——首个问题闭合即可见，未写完的最后一个问题被丢弃。
 *
 * 纯函数、无副作用；这是流式提速的核心逻辑层，UI 只是把它的输出喂给 QuestionsV2Panel 渐进渲染。
 */
import { describe, it, expect } from 'vitest'
import { extractStreamingQuestions } from '../../src/main/pi-event-adapter'

// 逐字符喂入，模拟 toolcall_delta 累积过程，返回每个前缀的提取结果序列
function scan(full: string): { title?: string; count: number }[] {
  const out: { title?: string; count: number }[] = []
  for (let i = 1; i <= full.length; i++) {
    const { title, questions } = extractStreamingQuestions(full.slice(0, i))
    out.push({ title, count: questions.length })
  }
  return out
}

const FULL = JSON.stringify({
  title: '关于首页设计的几个问题',
  questions: [
    { id: 'goal', kind: 'text-options', title: '主要目标是什么？', options: ['转化', '品牌', '信息'] },
    { id: 'palette', kind: 'svg-options', title: '色板偏好', options: [{ value: 'a', label: '深绿', svg: '<svg viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"/></svg>' }] },
    { id: 'radius', kind: 'slider', title: '圆角', min: 0, max: 24, step: 2, default: 8 },
    { id: 'notes', kind: 'freeform', title: '其它说明', placeholder: '随便写' }
  ]
})

describe('extractStreamingQuestions', () => {
  it('解析完整 JSON 得到全部问题与顶层标题', () => {
    const { title, questions } = extractStreamingQuestions(FULL)
    expect(title).toBe('关于首页设计的几个问题')
    expect(questions).toHaveLength(4)
    expect(questions.map((q: any) => q.id)).toEqual(['goal', 'palette', 'radius', 'notes'])
    expect(questions[3].placeholder).toBe('随便写')
  })

  it('增量：完整问题数单调不减，首个问题在整段完成前就可见', () => {
    const seq = scan(FULL)
    // 单调不减
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i].count).toBeGreaterThanOrEqual(seq[i - 1].count)
    }
    // 首个问题可见的位置远早于整段结束（提速的量化证据）
    const firstVisibleAt = seq.findIndex(s => s.count >= 1)
    expect(firstVisibleAt).toBeGreaterThanOrEqual(0)
    expect(firstVisibleAt).toBeLessThan(FULL.length - 1)
    // 终态四个问题全到
    expect(seq[seq.length - 1].count).toBe(4)
  })

  it('顶层标题不被问题对象内嵌套的 title 覆盖', () => {
    // 只截到第一个问题的嵌套 title 处
    const cut = FULL.slice(0, FULL.indexOf('主要目标是什么') + 4)
    const { title } = extractStreamingQuestions(cut)
    expect(title).toBe('关于首页设计的几个问题')
  })

  it('未成型的最后一个问题被丢弃（只返回已闭合对象）', () => {
    // 截断在第二个问题中途（svg 字符串未闭合）
    const cut = FULL.slice(0, FULL.indexOf('svg') + 3)
    const { questions } = extractStreamingQuestions(cut)
    expect(questions).toHaveLength(1)
    expect(questions[0].id).toBe('goal')
  })

  it('svg 值里的花括号/尖括号不影响括号深度计数', () => {
    const withBraces = JSON.stringify({
      title: 'x',
      questions: [
        { id: 'p', kind: 'svg-options', title: 't', options: [{ value: 'a', svg: '<svg>{}{{}}</svg>' }] },
        { id: 'q', kind: 'freeform', title: 't2' }
      ]
    })
    const { questions } = extractStreamingQuestions(withBraces)
    expect(questions).toHaveLength(2)
    expect(questions.map((q: any) => q.id)).toEqual(['p', 'q'])
  })

  it('尚无 questions 字段时返回空数组但可拿到标题', () => {
    const { title, questions } = extractStreamingQuestions('{"title":"仅标题先到"')
    expect(title).toBe('仅标题先到')
    expect(questions).toHaveLength(0)
  })

  it('空/垃圾输入安全降级', () => {
    expect(extractStreamingQuestions('').questions).toHaveLength(0)
    expect(extractStreamingQuestions('{').questions).toHaveLength(0)
    expect(extractStreamingQuestions('not json').questions).toHaveLength(0)
  })

  it('转义引号的字符串值不破坏对象边界识别', () => {
    const esc = JSON.stringify({
      title: 't',
      questions: [
        { id: 'a', kind: 'freeform', title: '他说\"你好\"然后}离开', placeholder: 'p' },
        { id: 'b', kind: 'freeform', title: 'ok' }
      ]
    })
    const { questions } = extractStreamingQuestions(esc)
    expect(questions).toHaveLength(2)
    expect(questions[0].title).toBe('他说"你好"然后}离开')
  })

  it('中文与 emoji 不破坏字符级扫描（非 ASCII 多字节字符按普通字符处理）', () => {
    const full = JSON.stringify({
      title: '🎨 关于配色的问题',
      questions: [
        { id: 'a', kind: 'text-options', title: '喜欢暖色🔥还是冷色🧊？', options: ['暖色🔥', '冷色🧊'] },
        { id: 'b', kind: 'freeform', title: '备注：随便写点😊' }
      ]
    })
    // 逐字符截断到第一个问题闭合处，验证增量阶段也不崩
    const cut = full.slice(0, full.indexOf('冷色🧊？') + 8)
    const cutResult = extractStreamingQuestions(cut)
    expect(cutResult.title).toBe('🎨 关于配色的问题')
    expect(cutResult.questions.length).toBeGreaterThanOrEqual(0) // 未闭合时不 throw，闭合后才计入

    const { title, questions } = extractStreamingQuestions(full)
    expect(title).toBe('🎨 关于配色的问题')
    expect(questions).toHaveLength(2)
    expect(questions[0].title).toBe('喜欢暖色🔥还是冷色🧊？')
    expect(questions[1].title).toBe('备注：随便写点😊')
  })
})
