/**
 * ACP 连接的"此刻"状态。**纯内存，进程重启即清空**——它回答的是"现在谁在跑、
 * 上次活动是什么时候"，落盘只会留下过期的假象。
 *
 * 描述性字段（cwd / 编辑器 / 协议版本）不在这里：适配器早就把它们写进了会话存储的
 * `config.acp`，再存一份就是两个真相。这里只记会话存储答不出来的那两件事。
 */

interface AcpLiveEntry {
  lastActivityAt: number
  streaming: boolean
}

const live = new Map<string, AcpLiveEntry>()
let lastHandshakeAt: number | null = null
let statusListener: (() => void) | null = null

/**
 * 设置页要即时看到"有人在等你点头"，所以状态变化用推的，不用轮询。
 * 只推"变了"这一个信号，快照仍由渲染层主动来取——避免把状态复制到两处。
 */
export function setAcpStatusListener(listener: (() => void) | null): void {
  statusListener = listener
}

export function notifyAcpStatusChanged(): void {
  statusListener?.()
}

/** 适配器 initialize 时会拉 /api/agents/list——本进程见过适配器的唯一凭据 */
export function noteAcpHandshake(at: number = Date.now()): void {
  lastHandshakeAt = at
  notifyAcpStatusChanged()
}

export function noteAcpActivity(conversationId: string, at: number = Date.now()): void {
  const entry = live.get(conversationId)
  if (entry) entry.lastActivityAt = at
  else live.set(conversationId, { lastActivityAt: at, streaming: false })
  notifyAcpStatusChanged()
}

export function startAcpStream(conversationId: string, at: number = Date.now()): void {
  noteAcpActivity(conversationId, at)
  live.get(conversationId)!.streaming = true
  notifyAcpStatusChanged()
}

export function endAcpStream(conversationId: string, at: number = Date.now()): void {
  const entry = live.get(conversationId)
  if (!entry) return
  entry.streaming = false
  entry.lastActivityAt = at
  notifyAcpStatusChanged()
}

export function forgetAcpSession(conversationId: string): void {
  if (live.delete(conversationId)) notifyAcpStatusChanged()
}

export function getAcpLiveEntry(conversationId: string): AcpLiveEntry | undefined {
  const entry = live.get(conversationId)
  return entry ? { ...entry } : undefined
}

export function getAcpLastHandshakeAt(): number | null {
  return lastHandshakeAt
}

/** 测试用：把进程级状态清回出厂 */
export function resetAcpLiveState(): void {
  live.clear()
  lastHandshakeAt = null
  statusListener = null
}
