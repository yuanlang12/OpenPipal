/**
 * groupTurns focus 收敛规则回归(2026-07-10):
 * turn 完成后台面只留 user / 过程摘要条 / 交付物卡 / 结论 —— 中间叙述文本、已解决的
 * ask_user·permission 都应折进过程段;正在流式的最后一个 turn 完全保留旧分类(不收敛)。
 */
import { describe, it, expect } from 'vitest'
import { groupTurns } from '../../src/renderer/src/chat/groupTurns'
import { ChatMessage } from '../../src/renderer/src/types'

let seq = 0
function msg(partial: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
  seq += 1
  return {
    id: partial.id || `m${seq}`,
    role: partial.role,
    content: partial.content ?? '',
    timestamp: partial.timestamp ?? seq * 100,
    ...partial
  } as ChatMessage
}

function user(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({ role: 'user', content, messageKind: 'user', ...extra })
}
function assistantText(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({ role: 'assistant', content, messageKind: 'assistant', ...extra })
}
function thinking(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({ role: 'assistant', content: '', thinkingContent: text, messageKind: 'thinking', ...extra })
}
function tool(toolName: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({ role: 'tool', content: `${toolName} 结果`, toolName, messageKind: 'tool', ...extra })
}
function askUser(question: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({
    role: 'assistant',
    content: question,
    askQuestion: question,
    askOptions: [{ label: '是', value: 'yes' }],
    messageKind: 'ask_user',
    ...extra
  })
}
function permission(status: 'pending' | 'approved' | 'denied', extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({
    role: 'assistant',
    content: '请求执行操作',
    permissionRequest: { requestId: 'r1', tool: 'shell', args: {} } as any,
    permissionStatus: status,
    messageKind: 'permission_request',
    ...extra
  })
}

describe('groupTurns — focus 收敛规则', () => {
  it('1. turn 内中间叙述文本归入过程段,不再与结论平铺', () => {
    const messages = [
      user('帮我查一下天气'),
      assistantText('让我先查一下'),   // 中间叙述 —— 应归过程
      tool('web_search'),
      assistantText('北京今天晴,25°C')  // 最后一条 —— 结论
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion?.content).toBe('北京今天晴,25°C')
    // 中间叙述应出现在某个 process 段里,而不是独立 final 段
    const finalContents = turn.segments.filter(s => s.kind === 'final').map(s => (s as any).message.content)
    expect(finalContents).not.toContain('让我先查一下')
    const processTexts = turn.segments
      .filter(s => s.kind === 'process')
      .flatMap(s => (s as any).messages.map((m: ChatMessage) => m.content))
    expect(processTexts).toContain('让我先查一下')
  })

  it('2. 只有最后一条纯文本 assistant 消息是结论(final),之前的都在 process', () => {
    const messages = [
      user('帮我写一份周报'),
      assistantText('好的,我先看看素材'),
      assistantText('素材看完了,开始整理'),
      assistantText('周报写好了,请查收')
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion?.content).toBe('周报写好了,请查收')
    const finalSegs = turn.segments.filter(s => s.kind === 'final')
    expect(finalSegs).toHaveLength(1)
    expect((finalSegs[0] as any).message.content).toBe('周报写好了,请查收')
  })

  it('3. 交付物(visualizerHtml/mcpAppPayload/artifactRef)常显,不折叠', () => {
    const messages = [
      user('帮我做个可视化'),
      thinking('构思一下图表结构'),
      tool('create_chart', { visualizerHtml: '<svg></svg>' }),
      assistantText('图表做好了')
    ]
    const [turn] = groupTurns(messages)
    expect(turn.deliverables).toHaveLength(1)
    expect(turn.deliverables[0].visualizerHtml).toBe('<svg></svg>')
    const finalIds = turn.segments.filter(s => s.kind === 'final').map(s => s.id)
    expect(finalIds).toContain(turn.deliverables[0].id)

    const messagesArtifact = [
      user('生成一个组件'),
      tool('create_artifact', { artifactRef: { id: 'a1', type: 'html', title: 'demo', path: '/tmp/a1.html' } }),
      assistantText('组件做好了')
    ]
    const [turn2] = groupTurns(messagesArtifact)
    expect(turn2.deliverables).toHaveLength(1)
    expect(turn2.deliverables[0].artifactRef?.id).toBe('a1')
  })

  it('4a. 未解决的 ask_user 保留在台面上(final)', () => {
    const messages = [
      user('帮我订机票'),
      thinking('需要先问清楚出发日期'),
      askUser('你想哪天出发?')
    ]
    const [turn] = groupTurns(messages)
    const finalKinds = turn.segments.filter(s => s.kind === 'final')
    expect(finalKinds).toHaveLength(1)
    expect((finalKinds[0] as any).message.askQuestion).toBe('你想哪天出发?')
  })

  it('4b. 已被后续用户消息回答的 ask_user 折进过程(不再常显)', () => {
    const messages = [
      user('帮我订机票'),
      askUser('你想哪天出发?'),
      user('下周三'),
      assistantText('好的,已帮你查好下周三的航班')
    ]
    const turns = groupTurns(messages)
    expect(turns).toHaveLength(2)
    const [turn1] = turns
    const finalKinds1 = turn1.segments.filter(s => s.kind === 'final')
    expect(finalKinds1).toHaveLength(0) // ask_user 已被下一轮 user 回复"盖过",折进过程
    const processMsgs1 = turn1.segments.filter(s => s.kind === 'process').flatMap(s => (s as any).messages)
    expect(processMsgs1.some((m: ChatMessage) => m.askQuestion === '你想哪天出发?')).toBe(true)
  })

  it('4c. pending 的 permission_request 留在台面;approved/denied 折进过程', () => {
    const pendingMsgs = [user('帮我删个文件'), permission('pending')]
    const [pendingTurn] = groupTurns(pendingMsgs)
    expect(pendingTurn.segments.filter(s => s.kind === 'final')).toHaveLength(1)

    const approvedMsgs = [user('帮我删个文件'), permission('approved'), assistantText('已删除')]
    const [approvedTurn] = groupTurns(approvedMsgs)
    const finalContents = approvedTurn.segments.filter(s => s.kind === 'final').map(s => (s as any).message.content)
    expect(finalContents).toEqual(['已删除']) // permission 卡片不在 final 里了,只剩结论
  })

  it('5. 纯工具收尾无文本结论的 turn:conclusion 为空,台面只有过程条 + 交付物', () => {
    const messages = [
      user('帮我整理一下这些文件'),
      thinking('先看看文件列表'),
      tool('list_files'),
      tool('move_files')
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion).toBeNull()
    expect(turn.segments.filter(s => s.kind === 'final')).toHaveLength(0)
    expect(turn.deliverables).toHaveLength(0)
    expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1) // 全部合并成一条过程段
  })

  it('6. 连续多 turn 边界正确 —— 每个 turn 各自独立收敛', () => {
    const messages = [
      user('第一个问题'),
      assistantText('中间叙述 A'),
      assistantText('结论 A'),
      user('第二个问题'),
      thinking('思考 B'),
      assistantText('结论 B')
    ]
    const turns = groupTurns(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0].conclusion?.content).toBe('结论 A')
    expect(turns[0].segments.filter(s => s.kind === 'final')).toHaveLength(1)
    expect(turns[1].conclusion?.content).toBe('结论 B')
    expect(turns[1].segments.filter(s => s.kind === 'final')).toHaveLength(1)
  })

  it('7. streamingLastTurn=true 时,最后一个 turn 完全保留旧分类(不收敛,一个字节不变)', () => {
    const messages = [
      user('帮我查一下天气'),
      assistantText('让我先查一下'),
      tool('web_search'),
      assistantText('北京今天晴,25°C')
    ]
    const [turn] = groupTurns(messages, { streamingLastTurn: true })
    // 旧分类:两条 assistant 文本都是 final,不做收敛合并
    const finalContents = turn.segments.filter(s => s.kind === 'final').map(s => (s as any).message.content)
    expect(finalContents).toEqual(['让我先查一下', '北京今天晴,25°C'])
    // conclusion 字段仍然可用(供 focus 模式潜在读取),指向最后一条
    expect(turn.conclusion?.content).toBe('北京今天晴,25°C')
  })

  it('8. streamingLastTurn=true 只影响最后一个 turn,之前已完成的 turn 仍然收敛', () => {
    const messages = [
      user('第一个问题'),
      assistantText('中间叙述 A'),
      assistantText('结论 A'),
      user('第二个问题(仍在生成)'),
      assistantText('中间叙述 B')
    ]
    const turns = groupTurns(messages, { streamingLastTurn: true })
    expect(turns).toHaveLength(2)
    // turn1 已完成 —— 正常收敛:中间叙述 A 折进 process
    expect(turns[0].segments.filter(s => s.kind === 'final')).toHaveLength(1)
    expect(turns[0].conclusion?.content).toBe('结论 A')
    // turn2 是流式中的最后一个 turn —— 旧分类,中间叙述 B 仍是 final(唯一一条,本身也是"结论候选")
    expect(turns[1].segments.filter(s => s.kind === 'final')).toHaveLength(1)
  })

  it('9. 结论之后才产出的交付物进 lateDeliverables,不被提前到结论前(时序回归)', () => {
    const messages = [
      user('做个图并总结'),
      tool('create_visualizer', { visualizerHtml: '<svg>early</svg>' }), // 结论前交付物
      assistantText('总结:图已生成'),                                    // 结论
      tool('create_artifact', { artifactRef: { id: 'a-late', type: 'code', title: 'late.jsx', path: '/tmp/late.jsx' } as any }) // 结论后补的产物
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion?.content).toBe('总结:图已生成')
    expect(turn.deliverables).toHaveLength(1)
    expect(turn.deliverables[0].visualizerHtml).toBe('<svg>early</svg>')
    expect(turn.lateDeliverables).toHaveLength(1)
    expect(turn.lateDeliverables[0].artifactRef?.id).toBe('a-late')
  })

  it('10. 无结论的纯工具 turn:交付物全部留在 deliverables,lateDeliverables 为空', () => {
    const messages = [
      user('生成一个组件'),
      tool('create_artifact', { artifactRef: { id: 'a1', type: 'code', title: 's.jsx', path: '/tmp/s.jsx' } as any })
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion).toBeNull()
    expect(turn.deliverables).toHaveLength(1)
    expect(turn.lateDeliverables).toHaveLength(0)
  })
})
