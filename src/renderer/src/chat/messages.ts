import { ChatMessage, ChatMessageKind, FileAttachmentData, PermissionRequestData } from '../types'

export const CHAT_MESSAGE_VERSION = 2

type MessageBaseInput = {
  id?: string
  timestamp?: number
  messageSubtype?: string
}

type UserMessageInput = MessageBaseInput & {
  content: string
  images?: string[]
  /** images 的磁盘落点（相对路径）——与 images 同序，见 ChatMessage.imagePaths */
  imagePaths?: string[]
  fileAttachments?: FileAttachmentData[]
  /** 可选 — 把 user 消息标记为系统内部消息(如 task-trigger),AI 仍然能读到,但 UI 不渲染。 */
  messageKind?: ChatMessageKind
}

type AssistantMessageInput = MessageBaseInput & {
  content: string
  thinkingContent?: string
  screenshot?: string
  images?: string[]
  messageKind?: Extract<ChatMessageKind, 'assistant' | 'incomplete'>
  syntheticErrorOffset?: number
}

type ThinkingMessageInput = MessageBaseInput & {
  thinkingContent: string
}

type ToolMessageInput = MessageBaseInput & {
  toolName: string
  questionsV2Version?: number
  toolCallId?: string
  content?: string
  screenshot?: string
  searchResults?: string
  toolArgs?: string
  modelToolArgs?: string
  visualizerHtml?: string
  visualizerHeight?: number
  artifactRef?: ChatMessage['artifactRef']
}

type AskUserMessageInput = MessageBaseInput & {
  question: string
  options?: { label: string; value: string }[]
  fields?: { label: string; placeholder?: string; type?: string; options?: string[]; required?: boolean }[]
}

type PermissionMessageInput = MessageBaseInput & {
  permissionRequest: PermissionRequestData
  content?: string
  permissionStatus?: 'pending' | 'approved' | 'denied'
}

type VoiceMessageInput = MessageBaseInput & {
  role: 'user' | 'assistant'
  content: string
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function withMessageMeta(message: ChatMessage, explicitKind?: ChatMessageKind): ChatMessage {
  const messageKind = explicitKind || inferMessageKind(message)
  return {
    ...message,
    messageVersion: message.messageVersion ?? CHAT_MESSAGE_VERSION,
    messageKind,
    messageSubtype: message.messageSubtype ?? inferMessageSubtype(messageKind, message)
  }
}

function inferMessageSubtype(messageKind: ChatMessageKind, message: ChatMessage): string | undefined {
  if (message.messageSubtype) return message.messageSubtype
  if (messageKind === 'tool') return message.toolName
  if (message.fileAttachments?.length) return 'file_attachment'
  return undefined
}

export function inferMessageKind(message: ChatMessage): ChatMessageKind {
  if (message.messageKind) return message.messageKind
  if (message.permissionRequest) return 'permission_request'
  if (message.askFields?.length || message.askOptions?.length || message.askQuestion) return 'ask_user'
  if (message.role === 'tool' || message.toolName || message.screenshot || message.searchResults || message.visualizerHtml) {
    return 'tool'
  }
  if (message.role === 'assistant' && !message.content && message.thinkingContent) return 'thinking'
  if (message.messageSubtype === 'voice') return 'voice'
  return message.role === 'user' ? 'user' : 'assistant'
}

export function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return withMessageMeta(message)
}

/**
 * 从工具调用参数 JSON 取目标文件路径——Pi schema 用 `path`,部分模型写 `file_path`/`filePath`。
 * 三键兼容口径唯一维护处(FileResultCard 展示与 ProcessGroup 文件聚合共用,分写会漂移)。
 */
export function toolArgsFilePath(toolArgs: string | undefined): string | null {
  try {
    const args = JSON.parse(toolArgs || '{}')
    return args.file_path || args.path || args.filePath || null
  } catch {
    return null
  }
}

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(normalizeChatMessage)
}

/**
 * 落盘投影：已卸载到附件 sidecar（有 ref）的消息剥掉内联大字段（截图 base64 / mcpApp payload）。
 * ⚠️ 只允许用在持久化路径（runSave / 切会话冲刷）——内存态与 toApiMessages 模型载荷
 * 必须继续看到内联内容，绝不能把这层剥离混进 normalizeChatMessages（两条路共用它）。
 */
export function stripOffloadedInline(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    const dropScreenshot = !!(message.screenshotRef && message.screenshot)
    const dropMcpApp = !!(message.mcpAppRef && message.mcpAppPayload)
    if (!dropScreenshot && !dropMcpApp) return message
    const next = { ...message }
    if (dropScreenshot) delete next.screenshot
    if (dropMcpApp) delete next.mcpAppPayload
    return next
  })
}

export function getMessageKind(message: ChatMessage): ChatMessageKind {
  return inferMessageKind(message)
}

/**
 * 只有空白字符的 assistant 文本消息 —— 模型在调工具/换阶段前吐的那两个换行被 flush 成了一条消息。
 * 它对用户和模型都是零信息,却在渲染层占一条 final 段:台面上是个空气泡带「复制」按钮,
 * 更糟的是它把本轮过程切成两截,于是画出两条分割线(前一条还因为跨度不足 1 秒而没有文字)。
 * 产生侧已经堵住(chatStore 的 flush 点都过 hasFlushableText),这里是历史会话的兜底。
 */
export function isBlankAssistantMessage(message: ChatMessage): boolean {
  const kind = getMessageKind(message)
  if (kind !== 'assistant' && kind !== 'incomplete') return false
  if ((message.content || '').trim()) return false
  // 有任何一种「正文之外的内容」就不算空:它们各自有自己的渲染分支。
  // audioPath 是后补的(setVoiceMessageAudio 在音频落盘后回挂),漏了它会让一条只带 TTS 音频、
  // 正文为空的消息被整条丢掉 —— 连带回听按钮一起消失,而它并不是模型吐的那两个换行。
  return !message.thinkingContent &&
    !message.screenshot && !message.screenshotRef &&
    !message.images?.length && !message.imagePaths?.length &&
    !message.fileAttachments?.length && !message.artifactRef &&
    !message.audioPath && !message.visualizerHtml
}

/**
 * 检测 NO_REPLY 静默回复(同 main/scheduler.ts parseSilentReply 的格式)。
 * 匹配示例:`NO_REPLY: [cave] 学生未回应,保持沉默`
 * 用于把 AI 主动选择不打扰的回复从 chat UI 里过滤掉(不持久化、不渲染)。
 */
export function isSilentReply(content: string): boolean {
  return /^\s*NO_REPLY\s*:/i.test(content || '')
}

export function createUserMessage(input: UserMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('user'),
    role: 'user',
    content: input.content,
    images: input.images,
    imagePaths: input.imagePaths,
    fileAttachments: input.fileAttachments,
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: input.messageSubtype
  }, input.messageKind || 'user')
}

export function createAssistantMessage(input: AssistantMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('assistant'),
    role: 'assistant',
    content: input.content,
    thinkingContent: input.thinkingContent,
    screenshot: input.screenshot,
    images: input.images,
    syntheticErrorOffset: input.syntheticErrorOffset,
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: input.messageSubtype
  }, input.messageKind || 'assistant')
}

export function createThinkingMessage(input: ThinkingMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('thinking'),
    role: 'assistant',
    content: '',
    thinkingContent: input.thinkingContent,
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: input.messageSubtype || 'reasoning'
  }, 'thinking')
}

export function createToolMessage(input: ToolMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('tool'),
    role: 'tool',
    content: input.content || '',
    screenshot: input.screenshot,
    searchResults: input.searchResults,
    toolName: input.toolName,
    questionsV2Version: input.questionsV2Version,
    toolCallId: input.toolCallId,
    toolArgs: input.toolArgs,
    modelToolArgs: input.modelToolArgs,
    visualizerHtml: input.visualizerHtml,
    visualizerHeight: input.visualizerHeight,
    artifactRef: input.artifactRef,
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: input.messageSubtype
  }, 'tool')
}

export function createAskUserMessage(input: AskUserMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('ask'),
    role: 'assistant',
    content: input.question,
    askQuestion: input.question,
    askOptions: input.options?.length ? input.options : undefined,
    askFields: input.fields?.length ? input.fields : undefined,
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: input.messageSubtype
  }, 'ask_user')
}

export function createPermissionRequestMessage(input: PermissionMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('permission'),
    role: 'assistant',
    content: input.content || `请求执行操作：${input.permissionRequest.tool}`,
    permissionRequest: input.permissionRequest,
    permissionStatus: input.permissionStatus || 'pending',
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: input.messageSubtype
  }, 'permission_request')
}

export function createVoiceMessage(input: VoiceMessageInput): ChatMessage {
  return withMessageMeta({
    id: input.id || makeId('voice'),
    role: input.role,
    content: input.content,
    timestamp: input.timestamp ?? Date.now(),
    messageSubtype: 'voice'
  }, 'voice')
}

export function isRenderableToolMessage(message: ChatMessage): boolean {
  const normalized = normalizeChatMessage(message)
  if (normalized.messageKind !== 'tool') return false
  // 注意：normalized.content 实际上就是 mcpResult（通用工具的文本结果通道）
  // —— 这里只需要检查 content，其它字段是更具体的卡片类型，content 已覆盖
  return Boolean(
    normalized.content ||
    normalized.screenshot ||
    normalized.searchResults ||
    normalized.visualizerHtml ||
    normalized.mcpAppPayload ||
    // 附件已卸载(内联被落盘投影剥离)的消息同样可渲染——渲染层按 ref 懒加载
    normalized.screenshotRef ||
    normalized.mcpAppRef
  )
}

/**
 * 模型流在 toolcall_start 之后断开时，前端已经持久化了空工具锚点，但永远收不到 tool_end。
 * 只收敛当前用户回合内、且完全没有任何结果载荷的工具卡；历史成功卡和已生成 artifact 不动。
 */
export function failUnfinishedToolMessages(messages: ChatMessage[], error: string): ChatMessage[] {
  if (!error) return messages
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIndex = i; break }
  }
  const failure = `失败：${error.replace(/\s+/g, ' ').trim().slice(0, 240)}`
  let changed = false
  const next = messages.map((message, index) => {
    const unfinished = index > lastUserIndex &&
      getMessageKind(message) === 'tool' &&
      !isRenderableToolMessage(message) &&
      !message.artifactRef
    if (!unfinished) return message
    changed = true
    return { ...message, content: failure }
  })
  return changed ? next : messages
}

export function isThinkingMessage(message: ChatMessage): boolean {
  return getMessageKind(message) === 'thinking'
}

/** 流式失败时 onStreamEnd 落盘的 OpenPipal 合成错误。不按文本猜，避免吞掉模型真实输出。 */
function isSyntheticErrorBubble(message: ChatMessage): boolean {
  const tagged = message.role === 'assistant' &&
    message.messageKind === 'incomplete' &&
    message.messageSubtype === 'stream-error'
  if (tagged) return true
  // Strict compatibility for the oldest full-bubble records, written before
  // messageKind/subtype metadata existed. A normal modern assistant message
  // containing the same text must remain part of the model transcript.
  return message.role === 'assistant' &&
    message.messageVersion === undefined &&
    message.messageKind === undefined &&
    message.messageSubtype === undefined &&
    /^\[Error\] [^\r\n]+$/.test(message.content || '')
}

/**
 * 丢掉当前这一轮的"连接中断，正在重试"提示。重连救回来了就不该留——它的价值只在
 * 解释"为什么等了这么久还失败"。返回原数组表示无需改动（调用方据此跳过落盘）。
 */
export function dropStreamRetryNotices(messages: ChatMessage[]): ChatMessage[] {
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIndex = i; break }
  }
  const kept = messages.filter((m, i) => i <= lastUserIndex || m.messageSubtype !== 'stream-retry')
  return kept.length === messages.length ? messages : kept
}

export function shouldSendMessageToModel(message: ChatMessage): boolean {
  if (isSyntheticErrorBubble(message)) return false
  const normalized = normalizeChatMessage(message)
  if (normalized.messageKind === 'tool' || normalized.messageKind === 'thinking' || normalized.messageKind === 'permission_request' || normalized.messageKind === 'inject-notice' || normalized.messageKind === 'incomplete') {
    // 工具轨迹跨轮回放：finalized 的 role:'tool' 消息（内容在 pi-event-adapter 发射时已压缩）
    // 随历史发送，主进程按 token 预算三档衰减（tool-trail.ts）后还原成 Pi 原生消息对。
    // 只放行 role:'tool' 且有 toolName 的——assistant 带 screenshot 等误判进 tool kind 的
    // 消息、以及未完成的空锚点维持原状不进载荷；thinking / 权限 / 注入提示照旧过滤。
    if (normalized.messageKind === 'tool' && normalized.role === 'tool' && normalized.toolName) {
      return Boolean(normalized.content?.trim())
    }
    return false
  }
  // 合成错误气泡只服务 UI 提示：进模型历史会污染后续摘要。
  // 只认 OpenPipal 写入的 subtype，用户/模型自己写的 `[Error]` 必须原样回放。
  return Boolean(normalized.content?.trim())
}

export function isRegeneratableAssistantMessage(message: ChatMessage): boolean {
  const normalized = normalizeChatMessage(message)
  if (normalized.role !== 'assistant') return false
  if (normalized.messageSubtype === 'runtime-interrupted') return false
  if (normalized.messageKind === 'thinking' || normalized.messageKind === 'permission_request' || normalized.messageKind === 'inject-notice') return false
  return Boolean(normalized.content?.trim())
}

export function shouldIncludeInTranscriptExport(message: ChatMessage): boolean {
  const normalized = normalizeChatMessage(message)
  if (normalized.messageSubtype === 'runtime-interrupted') return false
  if (normalized.messageKind === 'tool' || normalized.messageKind === 'thinking' || normalized.messageKind === 'permission_request' || normalized.messageKind === 'inject-notice') {
    return false
  }
  return Boolean((normalized.askQuestion || normalized.content || '').trim())
}

export function getTranscriptText(message: ChatMessage): string {
  const normalized = normalizeChatMessage(message)
  return normalized.askQuestion || normalized.content || ''
}
