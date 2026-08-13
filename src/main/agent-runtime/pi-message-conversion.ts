import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { dirname } from 'path'
import { loadConversationAttachment } from '../attachment-store'
import { conversationUploadsDir } from '../chat-uploads'
import { buildToolPairMessages } from '../tool-trail'
import type { ChatMessage, RuntimeUserInput } from './contracts'

/** Convert a stored base64/data-URL image into pi-ai's public image shape. */
export function toPiImageBlock(img: string): { type: 'image'; data: string; mimeType: string } {
  let data = img
  let mimeType = 'image/jpeg'
  const dataUrl = /^data:(image\/[a-z.+-]+);base64,(.*)$/i.exec(img)
  if (dataUrl) {
    mimeType = dataUrl[1]
    data = dataUrl[2]
  } else if (img.startsWith('iVBOR')) {
    mimeType = 'image/png'
  } else if (img.startsWith('R0lGOD')) {
    mimeType = 'image/gif'
  } else if (img.startsWith('UklGR')) {
    mimeType = 'image/webp'
  }
  return { type: 'image', data, mimeType }
}

export function toPiImages(images?: string[]): Array<{ type: 'image'; data: string; mimeType: string }> | undefined {
  return images?.length ? images.map(toPiImageBlock) : undefined
}

/** Product input -> low-level message, retained only for the legacy adapter. */
export function buildPiUserMessage(text: string, images?: string[]): AgentMessage {
  const content: any[] = []
  if (images?.length) {
    content.push(...images.map(toPiImageBlock))
    content.push({ type: 'text', text: text || '请分析这些图片' })
  } else {
    content.push({ type: 'text', text })
  }
  return { role: 'user', content, timestamp: Date.now() } as AgentMessage
}

export function runtimeInputToPrompt(input: RuntimeUserInput): {
  text: string
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
} {
  return {
    text: input.text || (input.images?.length ? '请分析这些图片' : ''),
    images: toPiImages(input.images)
  }
}

/**
 * Convert OpenPipal's durable transcript into pi-mono's public AgentMessage
 * contract. Both Runtime implementations share this projection so switching
 * the process-lifetime flag cannot silently change history semantics.
 */
export function convertHistoryToPiMessages(
  history: ChatMessage[],
  conversationId?: string
): AgentMessage[] {
  const messages: AgentMessage[] = []
  const pendingText: string[] = []
  let toolSeq = 0

  const takePendingBlocks = (): Array<{ type: 'text'; text: string }> => {
    if (pendingText.length === 0) return []
    return [{ type: 'text', text: pendingText.splice(0).join('\n\n') }]
  }
  const flushPendingText = (): void => {
    const blocks = takePendingBlocks()
    if (blocks.length > 0) {
      messages.push({ role: 'assistant', content: blocks, timestamp: Date.now() } as AgentMessage)
    }
  }

  for (const msg of history) {
    if (msg.role === 'system') continue

    if (msg.role === 'tool') {
      const replay = !msg.screenshot && msg.screenshotRef && conversationId
        ? { ...msg, screenshot: loadConversationAttachment(conversationId, msg.screenshotRef) || undefined }
        : msg
      const [assistantMsg, toolResultMsg] = buildToolPairMessages(
        replay,
        toolSeq++,
        takePendingBlocks()
      )
      messages.push(assistantMsg as unknown as AgentMessage, toolResultMsg as unknown as AgentMessage)
      continue
    }

    if (msg.role === 'user') {
      flushPendingText()
      let text = msg.content
      if (msg.fileAttachments?.length) {
        const fileHints = msg.fileAttachments
          .filter((file) => file.path)
          .map((file) => `📎 ${file.fileName} (${(file.sizeBytes / 1024).toFixed(1)}KB): ${file.path}`)
          .join('\n')
        if (fileHints) text = `${fileHints}\n\n${text}\n\n用 read 或 bash 工具读取上述文件。`
      }

      if (msg.imagePaths?.length) {
        const absoluteDir = conversationId ? dirname(conversationUploadsDir(conversationId)) : ''
        const list = msg.imagePaths
          .map((path) => `🖼 ${path}${absoluteDir ? `（绝对路径 ${absoluteDir}/${path}）` : ''}`)
          .join('\n')
        text = `${text}\n\n[随消息图片已存盘，可直接作为文件引用：\n${list}\ndc 文档配图用相对路径（如 src="${msg.imagePaths[0]}"）引用即可；不要在磁盘上搜寻其他副本。]`
      }

      const images = msg.images?.length ? msg.images : (msg.screenshot ? [msg.screenshot] : [])
      messages.push(buildPiUserMessage(text || (images.length ? '请分析这些图片' : ''), images))
      continue
    }

    if (msg.role === 'assistant') pendingText.push(msg.content)
  }

  flushPendingText()
  return messages
}

/** Append volatile per-turn facts without adding or reordering content blocks. */
export function appendRuntimeContext(message: AgentMessage, runtimeContext: string): void {
  const content = (message as any).content
  if (typeof content === 'string') {
    ;(message as any).content = content + runtimeContext
    return
  }
  if (!Array.isArray(content)) return
  for (let index = content.length - 1; index >= 0; index--) {
    if (content[index]?.type === 'text') {
      content[index].text = (content[index].text || '') + runtimeContext
      return
    }
  }
}
