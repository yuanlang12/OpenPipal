/**
 * Turn 分组 — 把扁平 messages 按对话轮次分组,每轮二分"过程"和"最终输出"
 *
 * 借鉴 Codex 的过程/结果二分交互:
 *   - 过程性消息(thinking / tool)折叠到 ProcessGroup("已处理 X ›")
 *   - 最终输出(assistant 文本)+ 交互类(ask_user / permission / inject-notice)独立显示
 *
 * 纯 view 层逻辑 — 不改 messages 数据,只在渲染时分组。
 *
 * Focus 模式升级(turn 完成态收敛):一个 turn 内 assistant 纯文本消息可能有多条
 * (说一句 → 调工具 → 再说一句 → 结论),旧规则把它们全部归为 final,完成后与结论
 * 平铺交错,造成台面拥挤。新规则:只有 turn 内**最后一条**纯文本消息是结论(conclusion),
 * 之前的叙述文本并入过程段(与 thinking/tool 按真实顺序合并折叠)。
 * ask_user / permission_request 同理:已被后续用户消息"盖过"或已 approved/denied 的
 * 视为已解决,折进过程;仍 pending 的留在台面上(需要用户处理)。
 *
 * 交付物外置(2026-08 修订):交付物(可视化/MCP App/artifact)是用户点名要看的成品。
 * 它不能折进会自动收起的过程段(focus 下直接看不见 —— 上一版的体验 bug),所以自成一类
 * 'deliverable' 段,**留在消息流里的真实位置**。曾经的做法是统一挪到轮尾,代价是模型说
 * "卡片已生成在上面 👆"、卡片却排在那段文字下面 —— 为了排版去改写消息顺序,等于把模型
 * 说的话变成了假话(2026-08-18 用户实锤)。
 *
 * 它切不断过程,是因为**一轮至多一个过程段**(见 finalizeTurn 的 processSeg):过程消息
 * 一律并进第一次出现的那一段,中间插了交付物/结论/语音都不另起一段。这条结构性不变量
 * 取代了此前一个个打的补丁,"两条分割线"整类 bug 到此为止。
 * 台面顺序:user / 分割线(全部过程)/ 线下按真实顺序的成品与结论。
 *
 * 分类**不随生成阶段变化**:曾经"流式中的最后一个 turn 完全保留旧分类",结果同一轮在
 * 生成中是两条分割线(叙述文本当 final 把过程劈开)、生成完又变回一条 —— 用户实锤
 * (2026-08-18)。现在流式与完成走同一套判定,唯一的差别是"已完成的轮次不许折到线下
 * 一片空白"(见 finalizeTurn 的兜底闸)。
 */
import { ChatMessage } from '../types'
import { getMessageKind, isBlankAssistantMessage } from './messages'

/**
 * Turn 内的有序片段 —— 保留消息在 messages[] 里的真实先后。
 * - process: 一段「连续的」过程性消息(thinking/tool/已解决的 ask-permission/被收敛的中间叙述),折叠成一个 ProcessGroup
 * - final:   一条独立显示的消息(结论 / 交付物 / 未解决的 ask_user·permission / voice / inject-notice)
 *
 * 为什么需要它:文字模式下过程总在最终答案之前,两桶(processMsgs/finalMsgs)够用;
 * 但语音模式一轮内是交错的(AI 说话→调工具→继续说),按桶渲染会把工具卡冒到语音流最上面。
 * segments 按数组顺序产出,文字模式自然塌缩为 [process-run, final…],与旧行为一致;
 * 语音模式则保持交错顺序。
 */
export type TurnSegment =
  | { kind: 'process'; id: string; messages: ChatMessage[] }
  | { kind: 'final'; id: string; message: ChatMessage }
  /** 成品(可视化 / MCP App / artifact):不进过程段(会被折叠藏起来),但**留在真实位置**。
   *  曾经把它统一挪到轮尾,结果模型说"卡片已生成在上面 👆"、卡片却在文字下面 ——
   *  强行改顺序就是在改写消息流本身(2026-08-18 用户实锤)。 */
  | { kind: 'deliverable'; id: string; message: ChatMessage }

export interface ConversationTurn {
  /** 稳定 key — 起始 user msg id(无 user 时用第一条消息 id) */
  id: string
  /** 用户消息(turn 开头);对话开头无 user 时为 null */
  userMsg: ChatMessage | null
  /** agent 真正开跑这一轮的时刻(ms)—— 取本轮 runtime-context 快照的时间戳。
   *  它和用户按下回车之间可能隔着**没有产出的等待**(供应商 429 失败后换端点重试、排队),
   *  用 userMsg.timestamp 算耗时会把那段计进"处理中",于是台面上写着 23 秒、
   *  展开却只有一步 2 秒的思考(2026-08-18 实锤)。快照由主进程在 turn 开始时广播、
   *  重试会覆盖旧的,所以它天然指向"最后真正跑起来的那一次"。缺失(旧会话/插件侧)时
   *  渲染层回落 userMsg.timestamp。 */
  agentStartTs?: number
  /** 过程性消息(thinking + tool + 已收敛的中间叙述/已解决 ask-permission)— 整轮汇总,用于耗时计算/向后兼容 */
  processMsgs: ChatMessage[]
  /** 独立显示消息(收敛后)— 整轮汇总,用于耗时计算/向后兼容 */
  finalMsgs: ChatMessage[]
  /** 按真实顺序的渲染片段(交错保序)— 渲染走它,不走上面两桶 */
  segments: TurnSegment[]
  /** 这一轮 AI 侧有没有产出过**任何**东西(思考/工具/正文/成品/报错)。
   *  计时分割线的渲染条件就是它:只要 AI 开过口,这一轮就该有一条"处理到此为止"的收口线,
   *  哪怕一步过程都没有(模型直接作答)、哪怕产出的是一条服务报错。
   *  为假的只有"发了 prompt 但一个字节都没回来"——那时候画一条线是无中生有。 */
  hasAiOutput: boolean
  /** turn 内最后一条纯文本 assistant 消息(结论);纯工具收尾无文本结论时为 null */
  conclusion: ChatMessage | null
  /** 本轮全部交付物(visualizerHtml / mcpAppPayload / artifactRef 的工具卡),按真实顺序 — 分类记录。
   *  渲染走 segments 里的 'deliverable' 段(位置正确),这一桶只是分类结果的出口。 */
  deliverables: ChatMessage[]
}

export interface GroupTurnsOptions {
  /** 最后一个 turn 是否正在流式生成中 —— true 时该 turn 完全保留旧分类(全量交错渲染,一个字节不变),
   *  不做"中间叙述归并到过程组"的收敛处理。 */
  streamingLastTurn?: boolean
}

type RawTag =
  | 'process'            // thinking / 无交付物标记的 tool
  | 'deliverable'         // 带 visualizerHtml/mcpAppPayload/artifactRef 的 tool —— 常显成品卡
  | 'ask-final'           // 未解决的 ask_user / permission_request —— 需要用户处理,常显
  | 'ask-process'         // 已解决的 ask_user / permission_request —— 折进过程
  | 'fixed-final'         // voice / inject-notice —— 保持现状,常显
  | 'conclusion-candidate' // 纯文本 assistant 消息 —— 只有 turn 内最后一条才是结论

interface RawItem {
  msg: ChatMessage
  tag: RawTag
}

interface RawTurn {
  id: string
  userMsg: ChatMessage | null
  agentStartTs?: number
  items: RawItem[]
}

function classifyRaw(msg: ChatMessage, hasLaterUser: boolean): RawTag {
  const kind = getMessageKind(msg)
  if (kind === 'thinking') return 'process'
  if (kind === 'tool') {
    // 富产物(可视化 / MCP App 内联渲染 / artifact 引用)是用户要看的「成品」,永远常显:
    // 完成态被 finalizeTurn 移出 segments、改挂轮尾(见文件头「交付物外置」)。绝不能折进
    // 会自动收起的过程组 —— 那样 turn 一结束用户就再也看不到图了。其余过程细节(思考/
    // 搜索结果/截图)仍折叠。
    if (msg.visualizerHtml || (msg as any).mcpAppPayload || (msg as any).mcpAppRef || msg.artifactRef) return 'deliverable'
    return 'process'
  }
  if (kind === 'ask_user') {
    return hasLaterUser ? 'ask-process' : 'ask-final'
  }
  if (kind === 'permission_request') {
    const resolved = msg.permissionStatus === 'approved' || msg.permissionStatus === 'denied'
    return resolved ? 'ask-process' : 'ask-final'
  }
  if (kind === 'assistant') return 'conclusion-candidate'
  // voice / inject-notice(以及任何未知类型兜底)—— 保持现状,常显
  return 'fixed-final'
}

/** 这条消息该留在台面(final)还是折进过程组。流式与完成同一套判定 —— 差异只在
 *  isConclusionMsg 的算法里(见 finalizeTurn),不在这里分叉。 */
function isFinalTag(tag: RawTag, isConclusionMsg: boolean): boolean {
  switch (tag) {
    case 'process': return false
    case 'ask-process': return false
    case 'deliverable': return true // 不可达:交付物在上面就被摘出 segments 了
    case 'ask-final': return true
    case 'fixed-final': return true
    case 'conclusion-candidate': return isConclusionMsg
  }
}

function finalizeTurn(rt: RawTurn, isActive: boolean): ConversationTurn {
  const { id, userMsg, items } = rt

  // runtime-context 快照由 chatStore 插在**末条用户消息**之后。没有自己用户消息的轮次
  // (定时任务 / 系统触发的响应)会把快照掉进上一个已完成轮次里,还会覆盖掉那一轮原本的
  // 快照 —— 于是那一轮拿到一个晚于自己结束时间的起点,耗时被 Math.max(0, …) 夹成 0,
  // 一个跑了几秒的轮次静默变成不带秒数的「处理完成」。
  // 这里按时间反查一次:起点晚于本轮第一条产出的,一定不是本轮的,丢掉回落用户消息时间戳。
  const firstOutputTs = items[0]?.msg.timestamp
  const agentStartTs =
    rt.agentStartTs !== undefined &&
    (firstOutputTs === undefined || rt.agentStartTs <= firstOutputTs)
      ? rt.agentStartTs
      : undefined

  // 结论:turn 内最后一条纯文本 assistant 消息(不管 active 与否都算——用于 conclusion 字段,
  // 供 focus 模式收敛渲染读取;是否真的从 segments 里"摘出去"由 isFinalTag 决定)。
  let conclusionIdx = -1
  items.forEach((it, i) => { if (it.tag === 'conclusion-candidate') conclusionIdx = i })
  const conclusion = conclusionIdx >= 0 ? items[conclusionIdx].msg : null

  // 交付物按真实顺序单独收一桶 —— 完成态它们不进 segments,由渲染层挂在轮尾常显。
  const deliverables = items.filter(it => it.tag === 'deliverable').map(it => it.msg)

  // 结论若被过程步骤"包在中间",它就会把本轮过程切成两截 —— 台面上是两条分割线。
  // 真机实录(2026-08-18):模型先说"下面先快速验证例子计算,再做卡片:",接着跑 Python,
  // 于是生成中出现两条线;等模型又吐出正文,那段叙述才归并回过程,线又变回一条。
  // 同一轮的结构不该随生成阶段来回变 —— 只要**后面还有过程步骤**,这条文本就归过程。
  let lastProcessIdx = -1
  items.forEach((it, i) => { if (it.tag === 'process' || it.tag === 'ask-process') lastProcessIdx = i })
  const conclusionBuried = conclusionIdx >= 0 && conclusionIdx < lastProcessIdx

  // 兜底闸(只对**已完成**的轮次):这么一折要是线下什么都不剩了,那还是把结论留在台面上 ——
  // 一条分割线加一片空白比多一条线更糟。流式中不设闸:后面还有内容要来,而且过程组此刻
  // 是展开的,那段文字并没有消失,只是从"整栏正文"变成了过程清单里的一行。
  // 判据直接问 isFinalTag —— 早先这里自己抄了一份"哪些 tag 会留在线下"的名单,漏掉了
  // conclusion-candidate:轮次里但凡还有一条**更早的**叙述文本,它虽然会被折进过程,
  // 却被这份名单当成"线下还剩东西",闸于是永远不触发。
  // 传 false 是在问"假设它不是结论,这条会留在台面上吗" —— 名单只有一份,不会再漂。
  const nothingWouldRemain =
    deliverables.length === 0 &&
    !items.some((it, i) => i !== conclusionIdx && isFinalTag(it.tag, false))
  const conclusionIsFinal =
    conclusionIdx >= 0 && (!conclusionBuried || (!isActive && nothingWouldRemain))

  const processMsgs: ChatMessage[] = []
  const finalMsgs: ChatMessage[] = []
  const segments: TurnSegment[] = []

  // **一轮至多一个过程段**:过程消息一律并进第一次出现的那个段,中间插了什么都不另起一段。
  // 这条不变量把"两条分割线"整类 bug 从结构上根除了 —— 此前是逐个补丁(交付物移出、空白
  // 消息丢掉、结论归过程),每次都还剩下一种没堵住的插入物。台面语义也更干净:
  // 线以上是这一轮做过的事(全部),线以下是它拿出来的东西(按真实顺序)。
  let processSeg: Extract<TurnSegment, { kind: 'process' }> | null = null
  const pushProcess = (msg: ChatMessage): void => {
    processMsgs.push(msg)
    if (processSeg) { processSeg.messages.push(msg); return }
    processSeg = { kind: 'process', id: msg.id, messages: [msg] }
    segments.push(processSeg)
  }
  const pushFinal = (msg: ChatMessage): void => {
    finalMsgs.push(msg)
    segments.push({ kind: 'final', id: msg.id, message: msg })
  }

  items.forEach((it, i) => {
    // 交付物自成一段,留在真实位置:不折进过程组(turn 一结束就看不见了),
    // 也不再被挪到轮尾(模型说"在上面"、东西却在下面)。它切不断过程 —— 过程只有一段。
    if (it.tag === 'deliverable') {
      segments.push({ kind: 'deliverable', id: it.msg.id, message: it.msg })
      return
    }
    const final = isFinalTag(it.tag, i === conclusionIdx && conclusionIsFinal)
    if (final) pushFinal(it.msg)
    else pushProcess(it.msg)
  })

  // items 里装的全是"用户那条消息之后的东西"。role==='user' 的只可能是语音转写(用户自己说的话),
  // 不算 AI 产出;runtime-context / task-trigger 在分组阶段就没进来。
  const hasAiOutput = items.some(it => it.msg.role !== 'user')

  return { id, userMsg, agentStartTs, hasAiOutput, processMsgs, finalMsgs, segments, conclusion, deliverables }
}

/**
 * 分组规则:
 * - user 消息开启新 turn
 * - thinking / tool(无交付物标记)→ 过程
 * - tool 带 visualizerHtml/mcpAppPayload/artifactRef → 交付物,永远移出 segments 挂轮尾常显
 * - ask_user / permission_request:已解决(后续有 user 回复 / approved·denied)→ 过程;未解决 → 常显
 * - voice / inject-notice → 保持现状,常显
 * - assistant 纯文本 → 只有 turn 内最后一条是结论(常显),之前的并入过程
 * - task-trigger → 跳过(UI 不渲染)
 * - assistant 纯文本:后面还有过程步骤时归过程(否则它会把过程切成两截 = 两条分割线)
 * - streamingLastTurn 只影响"已完成才生效的兜底闸",不再改变分类本身
 */
export function groupTurns(messages: ChatMessage[], opts: GroupTurnsOptions = {}): ConversationTurn[] {
  const n = messages.length
  // 全局后缀信息:第 i 条消息之后(不含自身)是否还存在 user 消息 —— 判定 ask_user 是否已被后续提问"盖过"解决。
  // 单趟反向扫描,O(n),不引入二次扫描。
  const laterHasUser = new Array<boolean>(n)
  let seenUser = false
  for (let i = n - 1; i >= 0; i--) {
    laterHasUser[i] = seenUser
    if (getMessageKind(messages[i]) === 'user') seenUser = true
  }

  const rawTurns: RawTurn[] = []
  let current: RawTurn | null = null

  messages.forEach((msg, idx) => {
    const kind = getMessageKind(msg)
    if (kind === 'task-trigger') return
    // runtime-context 快照本身不渲染,但它的时间戳是本轮唯一可靠的"agent 开跑"锚点,
    // 摘下来给计时分割线用(见 ConversationTurn.agentStartTs)。重试会覆盖快照,
    // 这里也照样取最后一次的值。
    if (kind === 'runtime-context') {
      if (current) current.agentStartTs = msg.timestamp
      return
    }
    // 纯空白的 assistant 文本整条丢掉 —— 它会占一条 final 段把过程切成两截(见
    // isBlankAssistantMessage)。放在 turn 划分之前,连 items 都不进,后面的分段逻辑不用知道它。
    if (isBlankAssistantMessage(msg)) return

    if (kind === 'user') {
      if (current) rawTurns.push(current)
      current = { id: msg.id, userMsg: msg, items: [] }
      return
    }

    if (!current) {
      // 对话开头就是非 user 消息(罕见)— 建 headless turn
      current = { id: msg.id, userMsg: null, items: [] }
    }
    current.items.push({ msg, tag: classifyRaw(msg, laterHasUser[idx]) })
  })
  if (current) rawTurns.push(current)

  const lastTurnActive = !!opts.streamingLastTurn
  return rawTurns.map((rt, ti) =>
    finalizeTurn(rt, lastTurnActive && ti === rawTurns.length - 1)
  )
}

/** 格式化耗时:1230ms → "1.2s",90000ms → "1m 30s" */
export function formatTurnDuration(ms: number): string {
  const safe = ms > 0 ? ms : 0
  const totalSec = Math.round(safe / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}
