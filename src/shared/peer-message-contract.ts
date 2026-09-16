/**
 * 跨会话消息的跨进程形状（主进程拼、渲染层拆）：发到对方对话里的那条用户消息。
 * 模型读到的是整段（头一行说明来自谁、末一行说明怎么回）；界面只显示正文，来源另起一行小字。
 */
export const PEER_MESSAGE_KIND = 'peer-message'

const HEADER = /^\[来自另一条对话 (.+?) 的消息 · 对话 id ([0-9a-zA-Z-]+)\]\n/
const FOOTER = /\n（直接在这里回答即可[^\n]*）$/

export function composePeerMessage(fromLabel: string, fromId: string, text: string): string {
  return [
    `[来自另一条对话 ${fromLabel} 的消息 · 对话 id ${fromId}]`,
    text.trim(),
    `（直接在这里回答即可，发送方会收到你这一轮的回复；要再联系它，用 conversations 工具 send 到 ${fromId}。）`
  ].join('\n')
}

export interface ParsedPeerMessage {
  /** 发送方的标签，如 「落地页设计」（设计助手） */
  from: string
  fromId: string
  /** 去掉头尾说明后的正文 */
  body: string
}

export function parsePeerMessage(content: string): ParsedPeerMessage | null {
  const head = HEADER.exec(content)
  if (!head) return null
  const body = content.slice(head[0].length).replace(FOOTER, '')
  return { from: head[1], fromId: head[2], body }
}
