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
 * 例外:正在流式生成的最后一个 turn(streamingLastTurn)完全保留旧分类(不做以上收敛),
 * 避免生成过程中叙述文本先出现、完成后又被折叠消失的"内容闪烁"。
 */
import { ChatMessage } from '../types'
import { getMessageKind } from './messages'

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

export interface ConversationTurn {
  /** 稳定 key — 起始 user msg id(无 user 时用第一条消息 id) */
  id: string
  /** 用户消息(turn 开头);对话开头无 user 时为 null */
  userMsg: ChatMessage | null
  /** 过程性消息(thinking + tool + 已收敛的中间叙述/已解决 ask-permission)— 整轮汇总,用于耗时计算/向后兼容 */
  processMsgs: ChatMessage[]
  /** 独立显示消息(收敛后)— 整轮汇总,用于耗时计算/向后兼容 */
  finalMsgs: ChatMessage[]
  /** 按真实顺序的渲染片段(交错保序)— 渲染走它,不走上面两桶 */
  segments: TurnSegment[]
  /** turn 内最后一条纯文本 assistant 消息(结论);纯工具收尾无文本结论时为 null */
  conclusion: ChatMessage | null
  /** 结论之前产出的交付物(visualizerHtml / mcpAppPayload / artifactRef 的工具卡)— 常显,不折叠,按真实顺序 */
  deliverables: ChatMessage[]
  /** 结论**之后**才产出的交付物(先说结语再补产物的时序)— focus 模式必须排在结论后面,否则时间倒置 */
  lateDeliverables: ChatMessage[]
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
  items: RawItem[]
}

function classifyRaw(msg: ChatMessage, hasLaterUser: boolean): RawTag {
  const kind = getMessageKind(msg)
  if (kind === 'thinking') return 'process'
  if (kind === 'tool') {
    // 富产物(可视化 / MCP App 内联渲染 / artifact 引用)是用户要看的「成品」,独立常显,
    // 不折进会自动收起的过程组;否则 turn 结束时 ProcessGroup 自动折叠会把它收进「已处理」,
    // 用户再也看不到(体验 bug)。其余过程细节(思考/搜索结果/截图)仍折叠。
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

/** 某条消息在(仅在 streamingLastTurn 生效的)active turn 里,还是走旧分类(全部 final,除了 process) */
function isFinalTag(tag: RawTag, isConclusionMsg: boolean, isActive: boolean): boolean {
  if (isActive) return tag !== 'process'
  switch (tag) {
    case 'process': return false
    case 'ask-process': return false
    case 'deliverable': return true
    case 'ask-final': return true
    case 'fixed-final': return true
    case 'conclusion-candidate': return isConclusionMsg
  }
}

function finalizeTurn(rt: RawTurn, isActive: boolean): ConversationTurn {
  const { id, userMsg, items } = rt

  // 结论:turn 内最后一条纯文本 assistant 消息(不管 active 与否都算——用于 conclusion 字段,
  // 供 focus 模式收敛渲染读取;是否真的从 segments 里"摘出去"由 isFinalTag 决定)。
  let conclusionIdx = -1
  items.forEach((it, i) => { if (it.tag === 'conclusion-candidate') conclusionIdx = i })
  const conclusion = conclusionIdx >= 0 ? items[conclusionIdx].msg : null

  // 交付物按与结论的相对位置分两桶:focus 收敛渲染是"过程 → 交付物 → 结论 → 晚到交付物",
  // 不能把结论之后才产出的成品卡提前到结论前面(时间倒置会误导叙事)。
  const deliverables: ChatMessage[] = []
  const lateDeliverables: ChatMessage[] = []
  items.forEach((it, i) => {
    if (it.tag !== 'deliverable') return
    if (conclusionIdx >= 0 && i > conclusionIdx) lateDeliverables.push(it.msg)
    else deliverables.push(it.msg)
  })

  const processMsgs: ChatMessage[] = []
  const finalMsgs: ChatMessage[] = []
  const segments: TurnSegment[] = []

  const pushProcess = (msg: ChatMessage): void => {
    processMsgs.push(msg)
    const last = segments[segments.length - 1]
    if (last && last.kind === 'process') last.messages.push(msg)
    else segments.push({ kind: 'process', id: msg.id, messages: [msg] })
  }
  const pushFinal = (msg: ChatMessage): void => {
    finalMsgs.push(msg)
    segments.push({ kind: 'final', id: msg.id, message: msg })
  }

  items.forEach((it, i) => {
    const final = isFinalTag(it.tag, i === conclusionIdx, isActive)
    if (final) pushFinal(it.msg)
    else pushProcess(it.msg)
  })

  return { id, userMsg, processMsgs, finalMsgs, segments, conclusion, deliverables, lateDeliverables }
}

/**
 * 分组规则:
 * - user 消息开启新 turn
 * - thinking / tool(无交付物标记)→ 过程
 * - tool 带 visualizerHtml/mcpAppPayload/artifactRef → 交付物,常显
 * - ask_user / permission_request:已解决(后续有 user 回复 / approved·denied)→ 过程;未解决 → 常显
 * - voice / inject-notice → 保持现状,常显
 * - assistant 纯文本 → 只有 turn 内最后一条是结论(常显),之前的并入过程
 * - task-trigger → 跳过(UI 不渲染)
 * - streamingLastTurn 为 true 时,最后一个 turn 完全走旧分类(不做收敛,一个字节不变)
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
  return rawTurns.map((rt, ti) => finalizeTurn(rt, lastTurnActive && ti === rawTurns.length - 1))
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
