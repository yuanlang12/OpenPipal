/**
 * UI-only payload compaction.
 *
 * Model-visible tool arguments/results are no longer reduced here. They remain
 * in the append-only conversation until the whole-history token compactor runs.
 * The helpers below only keep the expandable subagent card reasonably sized and
 * recognize receipt placeholders written by older OpenPipal versions.
 */

/**
 * 回执占位识别——实案：模型把上下文里的回执当正文复制进 create_artifact，把 11KB 场景
 * 覆写成 73 字节占位（同会话 6 个产物受损）。所有会持久化"生成内容"的工具入口都要用
 * 它做门闩；文案匹配按前缀，兼容历史会话里的旧回执。
 */
const RECEIPT_PLACEHOLDER_RE = /\[内容已保存，\d+ 字符/
export function containsReceiptPlaceholder(text: string | undefined | null): boolean {
  return !!text && RECEIPT_PLACEHOLDER_RE.test(text)
}

// ---- subagent 卡片数据压缩 ----

/**
 * SubagentCard 展开态只需要可读的过程预览；完整 child transcript 动辄上百 KB，
 * 会随每次自动保存整文件重写、并在展开时整段 JSON.parse。逐条收窄文本与工具参数、
 * 丢弃 thinking/图片（SubagentCard 本就不渲染），保留 role/toolCallId 等结构把手。
 */
const SUBAGENT_CARD_MAX_MESSAGES = 60
const SUBAGENT_CARD_TEXT_LIMIT = 1200
const SUBAGENT_CARD_ARG_CHARS = 400
const SUBAGENT_CARD_FINAL_TEXT_LIMIT = 600

function capText(textValue: string, limit: number): string {
  if (textValue.length <= limit) return textValue
  return `${textValue.slice(0, limit)}\n…[已截断，原 ${textValue.length} 字符]`
}

function capLongStrings(value: unknown, limit: number): { value: unknown; capped: boolean } {
  if (typeof value === 'string') {
    if (value.length <= limit) return { value, capped: false }
    return { value: `${value.slice(0, limit)}…[截断，原 ${value.length} 字符]`, capped: true }
  }
  if (Array.isArray(value)) {
    let capped = false
    const next = value.map(item => {
      const r = capLongStrings(item, limit)
      capped = capped || r.capped
      return r.value
    })
    return { value: next, capped }
  }
  if (value && typeof value === 'object') {
    let capped = false
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const r = capLongStrings(child, limit)
      next[key] = r.value
      capped = capped || r.capped
    }
    return { value: next, capped }
  }
  return { value, capped: false }
}

function capArgStrings(value: unknown, limit: number): unknown {
  return capLongStrings(value, limit).value
}

export function compactSubagentCardMessages(messages: unknown[]): unknown[] {
  const recent = messages.length > SUBAGENT_CARD_MAX_MESSAGES
    ? messages.slice(-SUBAGENT_CARD_MAX_MESSAGES)
    : messages
  return recent.map(raw => {
    const msg = raw as { role?: string; content?: unknown }
    if (!msg || typeof msg !== 'object') return msg
    const content = msg.content
    if (typeof content === 'string') {
      return content.length > SUBAGENT_CARD_TEXT_LIMIT
        ? { ...msg, content: capText(content, SUBAGENT_CARD_TEXT_LIMIT) }
        : msg
    }
    if (!Array.isArray(content)) return msg
    const blocks: unknown[] = []
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') { blocks.push(block); continue }
      if (block.type === 'thinking') continue
      if (block.type === 'image') { blocks.push({ type: 'text', text: '[图片已省略]' }); continue }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > SUBAGENT_CARD_TEXT_LIMIT) {
        blocks.push({ ...block, text: capText(block.text, SUBAGENT_CARD_TEXT_LIMIT) })
        continue
      }
      if (block.type === 'toolCall' && block.arguments) {
        blocks.push({ ...block, arguments: capArgStrings(block.arguments, SUBAGENT_CARD_ARG_CHARS) })
        continue
      }
      blocks.push(block)
    }
    return { ...msg, content: blocks }
  })
}

export function compactSubagentCardData<T extends { messages?: unknown[]; finalText?: string }>(card: T): T {
  return {
    ...card,
    messages: Array.isArray(card.messages) ? compactSubagentCardMessages(card.messages) : card.messages,
    finalText: typeof card.finalText === 'string'
      ? capText(card.finalText, SUBAGENT_CARD_FINAL_TEXT_LIMIT)
      : card.finalText
  }
}
