/**
 * 自检预览卡纯逻辑锁：结论解析 / 设备外框选择 / 目标产物与结果的消息回溯。
 * 结论文案与 main/pi-tools.ts render_artifact 的 text 拼装一一对应，那边改文案这里必须跟着改。
 */
import { describe, it, expect } from 'vitest'
import {
  pickFrame, parseSelfCheckVerdict, resolveSelfCheckTarget, latestSelfCheckResult, FRAME_SPEC
} from '../../src/renderer/src/chat/selfCheck'
import type { ChatMessage } from '../../src/renderer/src/types'

let seq = 0
function toolMsg(toolName: string, content: string, artifactRef?: { id: string }): ChatMessage {
  return {
    id: `t${++seq}`, role: 'assistant', content, timestamp: seq,
    toolName, toolCallId: `c${seq}`, ...(artifactRef ? { artifactRef } : {})
  } as ChatMessage
}
function userMsg(): ChatMessage {
  return { id: `u${++seq}`, role: 'user', content: '再改改', timestamp: seq } as ChatMessage
}

describe('parseSelfCheckVerdict', () => {
  it('渲染干净 → ok', () => {
    const v = parseSelfCheckVerdict('渲染干净：无 console 错误、无未解析空穴。\n截图已存盘: /x.png')
    expect(v).toEqual({ ok: true, kind: 'clean' })
  })

  it('发现问题 → 带数量的不通过', () => {
    const v = parseSelfCheckVerdict('渲染发现 3 个问题（修完再交）：\n- TypeError: x')
    expect(v).toEqual({ ok: false, kind: 'issues', count: 3 })
  })

  it('文案不认识 → 原样保留首行，不送进翻译层', () => {
    expect(parseSelfCheckVerdict('Model verdict 그대로')).toEqual({
      ok: null,
      kind: 'raw',
      label: 'Model verdict 그대로',
    })
    expect(parseSelfCheckVerdict(`RAW-${'x'.repeat(80)}`)).toEqual({
      ok: null,
      kind: 'raw',
      label: `RAW-${'x'.repeat(36)}`,
    })
    expect(parseSelfCheckVerdict('')).toEqual({ ok: null, kind: 'complete' })
  })

  it('只识别首行开头的稳定工具标记，避免把模型叙述误判成通过', () => {
    expect(parseSelfCheckVerdict('说明：渲染干净但仍需人工确认')).toEqual({
      ok: null,
      kind: 'raw',
      label: '说明：渲染干净但仍需人工确认',
    })
  })
})

describe('pickFrame', () => {
  it('手机原型（ios-frame / IOSDevice）→ phone', () => {
    expect(pickFrame('<x-import from="./ios-frame.jsx">')).toBe('phone')
    expect(pickFrame('component-from-global-scope="IOSDevice"')).toBe('phone')
  })

  it('幻灯舞台 → wide（16:9）', () => {
    expect(pickFrame('<deck-stage></deck-stage>')).toBe('wide')
    expect(pickFrame('<script src="./deck-stage.js">')).toBe('laptop') // src= 不是 from=，按普通页处理
  })

  it('普通网页/文档 → laptop', () => {
    expect(pickFrame('<div>hello</div>')).toBe('laptop')
  })

  it('三种外框的逻辑视口都是真机比例（缩放基准，别改成小尺寸触发响应式断点）', () => {
    expect(FRAME_SPEC.laptop.vw).toBe(1280)
    expect(FRAME_SPEC.phone.vw).toBe(402)
    expect(FRAME_SPEC.wide.vh / FRAME_SPEC.wide.vw).toBeCloseTo(9 / 16, 3)
  })
})

describe('目标产物解析', () => {
  const store = (...ids: Array<[string, string]>): Array<{ id: string; type?: string }> =>
    ids.map(([id, type]) => ({ id, type }))

  it('取本轮最近一条带 artifactRef 的 id（后写的覆盖先写的）', () => {
    const msgs = [
      userMsg(),
      toolMsg('create_artifact', 'ok', { id: 'a1' }),
      toolMsg('edit_artifact', 'ok', { id: 'a2' }),
      toolMsg('read', 'ok')
    ]
    expect(resolveSelfCheckTarget(msgs, store(['a1', 'html'], ['a2', 'html']))).toBe('a2')
  })

  it('todos/questions 这类非画面产物跳过，继续往前找真正的设计稿', () => {
    const msgs = [
      userMsg(),
      toolMsg('create_artifact', 'ok', { id: 'page' }),
      toolMsg('update_todos', 'ok', { id: 'todos-1' })   // 更晚，但它是任务清单不是画面
    ]
    expect(resolveSelfCheckTarget(msgs, store(['page', 'html'], ['todos-1', 'todos']))).toBe('page')
  })

  it('本轮只有 todos → null，不拿 JSON 冒充画面', () => {
    const msgs = [userMsg(), toolMsg('update_todos', 'ok', { id: 'todos-1' })]
    expect(resolveSelfCheckTarget(msgs, store(['todos-1', 'todos']))).toBeNull()
  })

  it('产物工具没回填 ref（落盘失败）→ 退到最近一个可视产物（跳过 todos）', () => {
    const msgs = [userMsg(), toolMsg('create_artifact', 'ok')]
    expect(resolveSelfCheckTarget(msgs, store(['page', 'html'], ['todos-1', 'todos']))).toBe('page')
  })

  it('本轮没碰产物（path 模式自检设计系统）→ null，不弹卡；跨轮旧产物不算数', () => {
    const msgs = [
      toolMsg('create_artifact', 'ok', { id: 'old' }), // 上一轮的
      userMsg(),
      toolMsg('render_artifact', '')
    ]
    expect(resolveSelfCheckTarget(msgs, store(['old', 'html']))).toBeNull()
  })

  it('只认已返回内容的 render_artifact 结果', () => {
    const pending = toolMsg('render_artifact', '')
    expect(latestSelfCheckResult([pending])).toBeNull()
    const done = toolMsg('render_artifact', '渲染干净：无 console 错误')
    expect(latestSelfCheckResult([pending, done])).toContain('渲染干净')
  })
})
