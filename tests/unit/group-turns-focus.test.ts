/**
 * groupTurns 收敛规则回归(2026-07-10):
 * turn 完成后台面只留 user / 计时分割线 / 结论 —— 中间叙述文本、已解决的
 * ask_user·permission 都应折进过程段;正在流式的最后一个 turn 完全保留旧分类(不收敛)。
 *
 * 交付物外置(2026-08 修订):交付物(可视化/MCP App/artifact)既不进过程段(会被折叠藏起来),
 * 也不留在原位当 final(会把过程切成两截 = 两条分割线)—— 而是移出 segments、由
 * tailDeliverables 交给渲染层挂在轮尾常显。**流式中同样如此**:曾经只对已完成 turn 生效,
 * 结果执行到一半会冒出两条分割线(其中一条是零点几秒的碎片),真机上被用户抓到。
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
function runtimeContext(timestamp: number): ChatMessage {
  return msg({ role: 'user', content: '<runtime-context>…</runtime-context>', messageKind: 'runtime-context', timestamp })
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


/** segments 的形状 —— 断言"谁在谁前面"时比逐段掏内容清楚 */
function shape(turn: { segments: { kind: string }[] }): string[] {
  return turn.segments.map(s => s.kind)
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

  it('3. 交付物(visualizerHtml/mcpAppPayload/artifactRef)移出 segments,由 tailDeliverables 轮尾常显', () => {
    const messages = [
      user('帮我做个可视化'),
      thinking('构思一下图表结构'),
      tool('create_chart', { visualizerHtml: '<svg></svg>' }),
      assistantText('图表做好了')
    ]
    const [turn] = groupTurns(messages)
    expect(turn.deliverables).toHaveLength(1)
    expect(turn.deliverables[0].visualizerHtml).toBe('<svg></svg>')
    // 交付物自成一段,排在结论**之前**(它就是先产出的)——顺序即消息流本身
    expect(shape(turn)).toEqual(['process', 'deliverable', 'final'])
    // 它既不在 final 段,也不在过程段
    const finalIds = turn.segments.filter(s => s.kind === 'final').map(s => s.id)
    expect(finalIds).not.toContain(turn.deliverables[0].id)
    const processIds = turn.segments
      .filter(s => s.kind === 'process')
      .flatMap(s => (s as any).messages.map((m: ChatMessage) => m.id))
    expect(processIds).not.toContain(turn.deliverables[0].id)

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

  it('7. 流式中与完成后分类一致 —— 中间叙述两种状态下都归过程(不会先两条线再变一条)', () => {
    // 用户实锤(2026-08-18):同一轮生成中画两条分割线、生成完又变回一条。根因就是
    // 旧规则"流式中的最后一个 turn 完全保留旧分类",叙述文本当 final 把过程劈成两截。
    const messages = [
      user('帮我查一下天气'),
      assistantText('让我先查一下'),
      tool('web_search'),
      assistantText('北京今天晴,25°C')
    ]
    for (const opts of [{ streamingLastTurn: true }, {}]) {
      const [turn] = groupTurns(messages, opts)
      const finalContents = turn.segments.filter(s => s.kind === 'final').map(s => (s as any).message.content)
      expect(finalContents).toEqual(['北京今天晴,25°C'])
      expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1)
      expect(turn.conclusion?.content).toBe('北京今天晴,25°C')
    }
  })

  it('7b. 结论后面还有过程步骤时归过程 —— 一轮永远只有一条分割线(真机第三次两条线的回归)', () => {
    // 真机形态:思考 → 工具 → "下面先快速验证例子计算" → 跑 Python → 又一段思考(仍在生成)。
    // 那条叙述夹在过程中间,旧规则里是 final,于是 [过程] | 叙述 | [过程] = 两条线。
    const messages = [
      user('帮我查一下特征值分解'),
      thinking('先看看环境'),
      tool('get_environment'),
      assistantText('下面先快速验证例子计算,再做卡片:'),
      tool('execute_code'),
      thinking('组织讲解')
    ]
    const [turn] = groupTurns(messages, { streamingLastTurn: true })
    expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1)
    expect(turn.segments.filter(s => s.kind === 'final')).toHaveLength(0)
    expect(turn.processMsgs).toHaveLength(5)
  })

  it('7c. 兜底闸:已完成的轮次不许折到线下一片空白(结论后有工具收尾时留在台面)', () => {
    const messages = [user('写个文件'), thinking('想'), assistantText('好的,我来写'), tool('write')]
    // 已完成:线下本来什么都不剩 → 结论提回台面(宁可多一条线,也不要一条线加一片空白)
    const done = groupTurns(messages)[0]
    expect(done.segments.filter(s => s.kind === 'final')).toHaveLength(1)
    // 流式中不设闸:后面还有内容要来,过程组此刻展开着,文字没有消失
    const live = groupTurns(messages, { streamingLastTurn: true })[0]
    expect(live.segments.filter(s => s.kind === 'final')).toHaveLength(0)
    expect(live.segments.filter(s => s.kind === 'process')).toHaveLength(1)
  })

  it('7d. 有交付物垫底时不触发兜底闸 —— 结论照折,成品挂轮尾', () => {
    const messages = [
      user('做张卡片'),
      assistantText('好的,我来做'),
      tool('create_artifact', { artifactRef: { id: 'a1', type: 'html', title: '卡片', path: '/tmp/a1.html' } as any }),
      tool('write')
    ]
    const [turn] = groupTurns(messages)
    expect(turn.segments.filter(s => s.kind === 'final')).toHaveLength(0)
    expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1)
    expect(turn.deliverables).toHaveLength(1)
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

  it('9. 结论前后的交付物都按真实顺序进 deliverables,统一挂轮尾(顺序不乱)', () => {
    const messages = [
      user('做个图并总结'),
      tool('create_visualizer', { visualizerHtml: '<svg>early</svg>' }), // 结论前交付物
      assistantText('总结:图已生成'),                                    // 结论
      tool('create_artifact', { artifactRef: { id: 'a-late', type: 'code', title: 'late.jsx', path: '/tmp/late.jsx' } as any }) // 结论后补的产物
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion?.content).toBe('总结:图已生成')
    expect(turn.deliverables).toHaveLength(2)
    expect(turn.deliverables[0].visualizerHtml).toBe('<svg>early</svg>')
    expect(turn.deliverables[1].artifactRef?.id).toBe('a-late')
    // 台面顺序按真实产出:早的那张图 → 结论 → 晚的那张 artifact。
    // 曾经两张都被挪到轮尾,于是模型说"图已生成在上面"时图却在文字下面。
    // 这一轮没有任何过程步骤(两个工具都是交付物),所以没有过程段 ——
    // 渲染层会另外给它补一条零步骤分割线(ChatPanel 的 bareDivider)
    expect(shape(turn)).toEqual(['deliverable', 'final', 'deliverable'])
    const finalContents = turn.segments.filter(s => s.kind === 'final').map(s => (s as any).message.content)
    expect(finalContents).toEqual(['总结:图已生成'])
  })

  it('10. 无结论的纯工具 turn:交付物照样常显(自成一段,不折进过程)', () => {
    const messages = [
      user('生成一个组件'),
      tool('create_artifact', { artifactRef: { id: 'a1', type: 'code', title: 's.jsx', path: '/tmp/s.jsx' } as any })
    ]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion).toBeNull()
    expect(turn.deliverables).toHaveLength(1)
    expect(shape(turn)).toEqual(['deliverable'])
  })

  it('11. 交付物夹在过程中间也只切出一条分割线(它整个不进 segments)', () => {
    const messages = [
      user('帮我做个可视化'),
      thinking('构思一下图表结构'),
      tool('create_chart', { visualizerHtml: '<svg></svg>' }),
      tool('web_search'),
      assistantText('图表做好了')
    ]
    const [turn] = groupTurns(messages)
    // 唯一的 final 段是结论
    const finalSegs = turn.segments.filter(s => s.kind === 'final')
    expect(finalSegs).toHaveLength(1)
    expect((finalSegs[0] as any).message.content).toBe('图表做好了')
    // 交付物被摘出去后,它前后的过程消息接成一段 —— 整轮一条分割线
    expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1)
    const processIds = turn.segments
      .filter(s => s.kind === 'process')
      .flatMap(s => (s as any).messages.map((m: ChatMessage) => m.id))
    expect(processIds).not.toContain(turn.deliverables[0].id)
    // 成品自成一段,夹在过程段之后(它产出于两段过程之间,过程合并后它就落在线下第一位)
    expect(shape(turn)).toEqual(['process', 'deliverable', 'final'])
  })

  it('12. 流式中的 turn 交付物同样自成一段(不进过程、不当结论)', () => {
    const messages = [
      user('帮我做个可视化'),
      tool('create_chart', { visualizerHtml: '<svg></svg>' }),
      assistantText('图表做好了')
    ]
    const [turn] = groupTurns(messages, { streamingLastTurn: true })
    const segIds = turn.segments.flatMap(s =>
      s.kind === 'process' ? (s as any).messages.map((m: ChatMessage) => m.id) : []
    )
    expect(segIds).not.toContain(turn.deliverables[0].id)
    expect(shape(turn)).toEqual(['deliverable', 'final'])
  })

  it('12b. 流式中交付物夹在过程中间也只切出一条过程段(真机两条分割线的回归)', () => {
    // 真机复现:思考 → 工具 → 交付物(artifact) → 又一段思考 → 结论流式中。
    // 旧规则里交付物在 active turn 是 final 段,把过程劈成两截 → 画出两条分割线,
    // 其中后一截只有一条消息、耗时不足 1 秒,标签被 opacity-0 藏掉,台面上只剩一个孤零零的 chevron。
    const messages = [
      user('查一下特征值分解,顺便做张卡片'),
      thinking('先算一下'),
      tool('execute_code'),
      tool('create_artifact', { artifactRef: { id: 'a1', type: 'html', title: '卡片', path: '/tmp/a1.html' } as any }),
      thinking('再组织一下讲解'),
      assistantText('已生成知识卡片 ✅')
    ]
    const [turn] = groupTurns(messages, { streamingLastTurn: true })
    expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1)
    expect(turn.deliverables).toHaveLength(1)
    // 交付物在两段思考之间产出 —— 过程合并成一段后,它就是线下的第一件东西
    expect(shape(turn)).toEqual(['process', 'deliverable', 'final'])
  })

  it('12c. 纯空白的 assistant 文本整条丢掉,不切断过程(真机第二次两条分割线的回归)', () => {
    // 真机会话实录(2026-08-17):模型在调 get_environment 之前先吐了 "\n\n",
    // onToolStart 把它 flush 成一条 content='\n\n' 的 assistant 消息。它在 active turn 里
    // 是 final 段,于是 [thinking] | 空气泡 | [tool, thinking] —— 两条分割线,
    // 前一条只有一条消息、跨度 0ms,标签被 opacity-0 藏掉,看上去就是一条无来由的横线。
    const messages = [
      user('帮我查一下特征值分解'),
      thinking('先看看环境'),
      assistantText('\n\n'),
      tool('get_environment'),
      thinking('组织讲解')
    ]
    const [turn] = groupTurns(messages, { streamingLastTurn: true })
    expect(turn.segments.filter(s => s.kind === 'process')).toHaveLength(1)
    expect(turn.segments.filter(s => s.kind === 'final')).toHaveLength(0)
    expect(turn.processMsgs).toHaveLength(3)
  })

  it('12d. 空白 assistant 不是结论,真正的结论仍然是最后一条有字的文本', () => {
    const messages = [user('问题'), thinking('想'), assistantText('   \n '), assistantText('答案')]
    const [turn] = groupTurns(messages)
    expect(turn.conclusion?.content).toBe('答案')
    expect(turn.finalMsgs).toHaveLength(1)
  })

  it('12e. 空内容但带图片/附件的 assistant 消息不算空,照常保留', () => {
    const messages = [
      user('看这个'),
      assistantText('', { images: ['base64data'] })
    ]
    const [turn] = groupTurns(messages)
    expect(turn.finalMsgs).toHaveLength(1)
  })

  it('14. runtime-context 的时间戳被摘成 agentStartTs(计时锚点),消息本身仍不渲染', () => {
    // 真机会话 496041e6(2026-08-18):用户 10:05:58 按下回车,供应商 429 失败后换端点重试,
    // agent 到 10:06:17 才真正开跑,10:06:21 出答案。用 userMsg 当起点 → "处理完成 23 秒",
    // 展开却只有一步 2 秒的思考;用 agentStartTs → 4 秒,与主进程 settled elapsedMs=3969 对得上。
    const messages = [
      user('你可以做什么', { timestamp: 1787018758371 }),
      runtimeContext(1787018777416),
      thinking('', { timestamp: 1787018778898, thinkingMs: 2486 }),
      assistantText('当然可以!', { timestamp: 1787018781403 })
    ]
    const [turn] = groupTurns(messages)
    expect(turn.agentStartTs).toBe(1787018777416)
    // 快照自身不进任何桶 —— 它是隐藏消息,只贡献一个时间戳
    expect(turn.processMsgs).toHaveLength(1)
    expect(turn.finalMsgs).toHaveLength(1)
    expect(turn.userMsg?.timestamp).toBe(1787018758371)
  })

  it('14b. 没有 runtime-context 时 agentStartTs 缺席(渲染层回落用户消息时间戳)', () => {
    const [turn] = groupTurns([user('问'), thinking('想'), assistantText('答')])
    expect(turn.agentStartTs).toBeUndefined()
  })

  it('14c. 同一轮重试落下多张快照时取最后一张(真正跑起来的那次)', () => {
    const messages = [
      user('问', { timestamp: 1000 }),
      runtimeContext(2000),
      runtimeContext(9000),
      assistantText('答', { timestamp: 11000 })
    ]
    const [turn] = groupTurns(messages)
    expect(turn.agentStartTs).toBe(9000)
  })

  it('15. hasAiOutput:AI 开过口就为真 —— 直接作答 / 只出成品 / 服务报错都算', () => {
    // 计时分割线的渲染条件。用户明确要求"只要有 AI 的内容就带,哪怕发了 prompt 之后
    // AI 服务本身报错了"(2026-08-18)。
    expect(groupTurns([user('问'), assistantText('答')])[0].hasAiOutput).toBe(true)
    // 服务报错:落成 messageKind='incomplete' + messageSubtype='stream-error' 的 assistant 消息
    expect(groupTurns([
      user('问'),
      assistantText('请求失败:429 quota exhausted', { messageKind: 'incomplete', messageSubtype: 'stream-error' })
    ])[0].hasAiOutput).toBe(true)
    // 只出了一件成品(交付物已移出 segments,一条过程段都没有)
    expect(groupTurns([
      user('画个图'),
      tool('visualizer', { visualizerHtml: '<div/>' })
    ])[0].hasAiOutput).toBe(true)
  })

  it('15b. hasAiOutput:一个字节都没回来的空转轮次为假(不画无中生有的线)', () => {
    expect(groupTurns([user('问')])[0].hasAiOutput).toBe(false)
    // 用户自己的语音转写不算 AI 产出
    const voiceUser = msg({ role: 'user', content: '我说的话', messageKind: 'voice' })
    expect(groupTurns([user('问'), voiceUser])[0].hasAiOutput).toBe(false)
  })

  it('16. 兜底闸对"更早还有一条叙述"的轮次同样生效(评审 #2 回归)', () => {
    // 轮次里有两条文本:早的那条会被折进过程,晚的那条是结论、但后面还跟着工具。
    // 旧判据自己抄了一份 tag 名单、漏掉 conclusion-candidate,于是把那条"会被折走"的叙述
    // 当成"线下还剩东西",闸不触发 → 结论也一起折走 → 一条分割线下面一片空白。
    const messages = [
      user('写个文件'),
      thinking('想想'),
      assistantText('让我先看看'),
      tool('read'),
      assistantText('好的,我来写'),
      tool('write')
    ]
    const [turn] = groupTurns(messages)
    expect(turn.segments.filter(s => s.kind === 'final')).toHaveLength(1)
    expect(turn.conclusion?.content).toBe('好的,我来写')
    // 早的那条叙述照旧折进过程
    expect(turn.processMsgs.map(m => m.content)).toContain('让我先看看')
  })

  it('17. 晚于本轮产出的 runtime-context 快照不算本轮起点(评审 #4 回归)', () => {
    // 没有自己用户消息的轮次(定时任务响应)会把快照掉进上一个已完成轮次里,还会覆盖掉
    // 那一轮原本的快照 —— 那一轮于是拿到一个晚于自己结束时间的起点,耗时被夹成 0。
    const messages = [
      user('问', { timestamp: 1000 }),
      runtimeContext(50000),          // 明显晚于下面的产出:不是这一轮的
      thinking('想', { timestamp: 2000 }),
      assistantText('答', { timestamp: 3000 })
    ]
    const [turn] = groupTurns(messages)
    expect(turn.agentStartTs).toBeUndefined()
    // 正常顺序的快照仍然照收
    const ok = groupTurns([
      user('问', { timestamp: 1000 }),
      runtimeContext(1500),
      thinking('想', { timestamp: 2000 }),
      assistantText('答', { timestamp: 3000 })
    ])[0]
    expect(ok.agentStartTs).toBe(1500)
  })

  it('13. pending 权限气泡仍留在台面(不吞交互)', () => {
    const messages = [user('帮我删个文件'), permission('pending')]
    const [turn] = groupTurns(messages)
    expect(turn.segments.filter(s => s.kind === 'final')).toHaveLength(1)
  })
})
