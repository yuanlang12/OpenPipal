/**
 * 2026-09-10 实撞：deepseek 官方端点在同一轮里给了两个工具调用同一个 call id → 渲染层两张工具卡同 id →
 * JSONL 存储对重复 id 永久拒绝 → 渲染层每次重试都撞同一堵墙 → 连"新建对话 / 切换会话"都卡在等落盘上。
 * 两道修：① 消息 id 入库前在会话内去重；② 追加被拒就整段 replace 重写，不再无限重试同一批。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { uniqueMessageId } from '../../src/renderer/src/chat/messages'

describe('uniqueMessageId', () => {
  it('没撞就原样；撞了加 -2 / -3 后缀，跳过已占用的后缀', () => {
    expect(uniqueMessageId([], 'tool-call_00_x')).toBe('tool-call_00_x')
    expect(uniqueMessageId([{ id: 'tool-call_00_x' }], 'tool-call_00_x')).toBe('tool-call_00_x-2')
    expect(uniqueMessageId([{ id: 'tool-call_00_x' }, { id: 'tool-call_00_x-2' }], 'tool-call_00_x')).toBe('tool-call_00_x-3')
  })
})

describe('chatStore 接线', () => {
  const src = readFileSync('src/renderer/src/stores/chatStore.ts', 'utf8')
  it('工具卡与 flush 的 id 都过 uniqueMessageId（tool_start 与 create_artifact 锚点两处）', () => {
    expect(src).toMatch(/id: uniqueMessageId\(flushedAssistant \? \[\.\.\.updated, flushedAssistant\] : updated, toolCallId \? `tool-\$\{toolCallId\}` : `tool-\$\{Date\.now\(\)\}`\)/)
    expect(src).toMatch(/id: uniqueMessageId\(updated, `tool-\$\{toolCallId\}`\)/)
    expect(src).not.toMatch(/id: toolCallId \? `tool-\$\{toolCallId\}`/)
  })
  it('追加被拒 → 立 dirty 并当场整段 replace，不是原批重试', () => {
    expect(src).toMatch(/catch \(err\) \{\n\s*\/\/ 追加被拒[\s\S]*?dirty = true[\s\S]*?window\.api\.replaceMessages\(activeConversationId, stripOffloadedInline\(normalizeChatMessages\(messages\)\)\)/)
  })
})
