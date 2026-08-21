/**
 * ACP 落盘契约锁：无渲染层的路径（ACP / scheduler）从事件流还原出的一轮记录
 * 必须同时含正文与工具轨迹，且落盘形状能被统一回放判据认成"可回放"。
 *
 * 背景：读侧放行了 role:'tool' 的历史，写侧却只落 user/assistant 文本——
 * ACP 会话磁盘上永远没有工具行，跨轮工具记忆在这条路径上完全落空。
 *
 * 同一模式第二次发作（2026-08-18）：runtime-context 快照的读侧（三处历史投影携带
 * messageKind + pi-message-conversion 的原样回放分支）全部就位，写侧却只有桌面齐——
 * 快照由渲染层落盘，ACP/scheduler 没有渲染层，磁盘上根本没有这条消息可回放，
 * 跨回合前缀缓存在这两条路上照旧从这里断。下面第三组用例钉的就是写侧。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createTranscriptCollector } from '../../src/main/pi-event-adapter'
import { isReplayableToolMessage } from '../../src/main/tool-trail'
import { normalizeStoredMessage, shouldReplayStoredMessage } from '../../src/main/conversation-store'
import {
  convertHistoryToPiMessages,
  buildRuntimeContextMessage
} from '../../src/main/agent-runtime/pi-message-conversion'

describe('createTranscriptCollector', () => {
  it('正文与工具按事件顺序交错，工具带齐回放三要素', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'text', content: '先看一眼文件' })
    c.feed({ type: 'text_flush' })
    c.feed({ type: 'tool_start', name: 'read', toolCallId: 'call_1' })
    c.feed({ type: 'tool_end', name: 'read', toolCallId: 'call_1', mcpResult: '（已读 42 行）', mcpArgs: '{"path":"/a.ts"}' })
    c.feed({ type: 'text', content: '改完了' })

    expect(c.finishTranscript()).toEqual([
      { kind: 'text', content: '先看一眼文件' },
      { kind: 'tool', toolName: 'read', toolCallId: 'call_1', content: '（已读 42 行）', toolArgs: '{"path":"/a.ts"}', searchResults: undefined },
      { kind: 'text', content: '改完了' }
    ])
  })

  it('落盘形状被统一判据认成可回放（读写两侧同口径）', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'tool_end', name: 'write', toolCallId: 'call_2', mcpResult: '已创建: /tmp/x.html' })
    const tool = c.finishTranscript().find(e => e.kind === 'tool')!
    const stored = { role: 'tool', ...tool, kind: undefined } as any

    expect(isReplayableToolMessage(stored)).toBe(true)
    expect(stored.content).toBe('已创建: /tmp/x.html')
  })

  it('无载荷 / 无名的工具事件不落盘（否则会话里留一张空卡）', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'tool_end', name: 'capture_screenshot', toolCallId: 'call_3' })
    c.feed({ type: 'tool_end', name: '', toolCallId: 'call_4', mcpResult: '有内容但没名字' })
    expect(c.finishTranscript()).toEqual([])
  })

  it('search 类只有 searchResults 也落盘（渲染层同款可见性口径）', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'tool_end', name: 'web_search', toolCallId: 'call_5', searchResults: '[]' })
    expect(c.finishTranscript()).toEqual([
      { kind: 'tool', toolName: 'web_search', toolCallId: 'call_5', content: '[]', toolArgs: undefined, searchResults: '[]' }
    ])
  })

  it('finish() 仍是纯文本且相邻段合并——无工具的一轮落盘形状不变（scheduler 零影响）', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'text', content: '第一段' })
    c.feed({ type: 'text_flush' })
    c.feed({ type: 'text', content: '第二段' })
    expect(c.finishTranscript()).toEqual([{ kind: 'text', content: '第一段\n\n第二段' }])
    expect(c.finish()).toBe('第一段\n\n第二段')
  })

  it('包含式去重仍然生效：message_end 的 fallback 全文不再记第二份', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'text', content: '流式片段' })
    c.feed({ type: 'text_flush' })
    c.feed({ type: 'text', content: '流式片段的完整版本' })
    c.feed({ type: 'text_flush' })
    expect(c.finish()).toBe('流式片段')
  })
})

/**
 * 读侧口径：磁盘重建历史时哪些消息进模型载荷。
 * 逐条对齐 renderer shouldSendMessageToModel——手写的 role+content 判据挡不住
 * 权限气泡（role:'assistant' + "请求执行操作：bash"）与 [Error] 合成气泡。
 */
describe('shouldReplayStoredMessage', () => {
  const base = { id: 'm', timestamp: 0 }

  it('放行普通对话与 finalized 工具轨迹', () => {
    expect(shouldReplayStoredMessage({ ...base, role: 'user', content: '帮我改一下' })).toBe(true)
    expect(shouldReplayStoredMessage({ ...base, role: 'assistant', content: '好的' })).toBe(true)
    expect(shouldReplayStoredMessage({ ...base, role: 'tool', content: '（已读 42 行）', toolName: 'read' })).toBe(true)
  })

  it('挡掉权限气泡（这条正是手写 role+content 判据的漏网之鱼）', () => {
    expect(shouldReplayStoredMessage({
      ...base, role: 'assistant', content: '请求执行操作：bash',
      permissionRequest: { requestId: 'r1', tool: 'bash', args: {}, risk: 'high', reason: '' }
    })).toBe(false)
  })

  it('挡掉合成错误气泡——否则"请重试"进历史被永久复读', () => {
    const legacy = { ...base, role: 'assistant' as const, content: '[Error] 请重试' }
    expect(shouldReplayStoredMessage(legacy)).toBe(false)
    const migrated = normalizeStoredMessage(legacy)
    expect(migrated).toMatchObject({
      messageVersion: 2,
      messageKind: 'incomplete',
      messageSubtype: 'stream-error',
      syntheticErrorOffset: 0
    })
    expect(shouldReplayStoredMessage(migrated)).toBe(false)
    expect(normalizeStoredMessage({
      ...base,
      role: 'assistant',
      content: '[Error] 旧版 v2 错误',
      messageVersion: 2,
      messageKind: 'incomplete'
    })).toMatchObject({
      messageVersion: 2,
      messageKind: 'incomplete',
      messageSubtype: 'stream-error',
      syntheticErrorOffset: 0
    })
    expect(shouldReplayStoredMessage({
      ...base,
      role: 'assistant',
      content: '[Error] 模型正文',
      messageVersion: 2,
      messageKind: 'assistant'
    })).toBe(true)
  })

  it('挡掉用户 Stop 后持久化的 incomplete 部分回复', () => {
    expect(shouldReplayStoredMessage({
      ...base, role: 'assistant', content: '尚未生成完', messageKind: 'incomplete'
    })).toBe(false)
  })

  it('挡掉 thinking 与未完成/空内容的工具锚点', () => {
    expect(shouldReplayStoredMessage({ ...base, role: 'assistant', content: '', thinkingContent: '让我想想' })).toBe(false)
    expect(shouldReplayStoredMessage({ ...base, role: 'tool', content: '', toolName: 'read' })).toBe(false)
    expect(shouldReplayStoredMessage({ ...base, role: 'tool', content: '有内容但没名字' })).toBe(false)
  })

  it('assistant 带截图被 kind 推断归到 tool 的消息不放行（与渲染层同款处理）', () => {
    expect(shouldReplayStoredMessage({ ...base, role: 'assistant', content: '看这张图', screenshot: 'iVBOR...' })).toBe(false)
  })
})

/**
 * 写侧：无渲染层的两条路必须自己把本轮 RC 快照落进磁盘，否则读侧再正确也取不到材料。
 */
const SNAPSHOT = '\n\n<runtime-context>\n当前真实时间：2026年8月18日星期二 10:30。\n</runtime-context>'

describe('RC 快照的服务端落盘（ACP / 定时任务）', () => {
  it('收得住快照，时间戳取事件到达时刻（同时是 UI 的 agent 开跑锚点）', () => {
    const before = Date.now()
    const c = createTranscriptCollector()
    c.feed({ type: 'runtime_context', text: SNAPSHOT })
    const rc = c.finishRuntimeContext()!
    expect(rc.text).toBe(SNAPSHOT)
    expect(rc.timestamp).toBeGreaterThanOrEqual(before)
    expect(rc.timestamp).toBeLessThanOrEqual(Date.now())
  })

  it('快照不混进 transcript / finish——"模型这轮什么都没产出"的判据不能被它污染', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'runtime_context', text: SNAPSHOT })
    // scheduler 靠 `!fullResponse.trim() && transcript.length === 0` 判失败，
    // ACP 靠 `transcript.length` 决定落不落盘：快照进了这两个口径就会静默改行为
    expect(c.finishTranscript()).toEqual([])
    expect(c.finish()).toBe('')
  })

  it('没有快照事件（或文本为空）时返回 undefined，不落空消息', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'text', content: '只有正文' })
    expect(c.finishRuntimeContext()).toBeUndefined()
    const empty = createTranscriptCollector()
    empty.feed({ type: 'runtime_context', text: '' })
    expect(empty.finishRuntimeContext()).toBeUndefined()
  })

  it('按落盘形状走完读侧，回放字节与当轮实发一致（前缀缓存的前提）', () => {
    const c = createTranscriptCollector()
    c.feed({ type: 'runtime_context', text: SNAPSHOT })
    c.feed({ type: 'text', content: '好的' })
    const rc = c.finishRuntimeContext()!

    // 两处写侧构造的落盘顺序：user 消息在前，快照紧随其后，然后才是 transcript
    const stored = [
      { id: 'u1', role: 'user' as const, content: '帮我看看', timestamp: 1 },
      { id: 'rc1', role: 'user' as const, content: rc.text, timestamp: rc.timestamp, messageKind: 'runtime-context' },
      { id: 'a1', role: 'assistant' as const, content: c.finish(), timestamp: 2 }
    ]
    expect(stored.every(shouldReplayStoredMessage)).toBe(true)

    const pi = convertHistoryToPiMessages(stored as any)
    const sent = buildRuntimeContextMessage(SNAPSHOT)
    const replayed = pi.filter(m => JSON.stringify((m as any).content) === JSON.stringify((sent as any).content))
    expect(replayed, '回放的快照与实发字节不一致').toHaveLength(1)
    // 快照必须独立成条，不能被拼进用户消息（拼进去等于回到 bug 之前）
    expect(pi.some(m => JSON.stringify((m as any).content).includes('帮我看看') &&
      JSON.stringify((m as any).content).includes('<runtime-context>'))).toBe(false)
  })
})

/**
 * 两处写侧一个在 http handler 里内联、一个在 scheduler 私有分支里，单测够不着实调用。
 * 按仓库既有做法直接钉源码——这份清单同时是给下一个人看的：新增"无渲染层"的路径，
 * 落盘时就得自己补这条快照。
 */
describe('无渲染层的路径都必须落盘 RC 快照', () => {
  const WRITERS = [
    { name: 'ACP', file: 'src/main/http-server.ts', hook: 'acpCollector.finishRuntimeContext()' },
    { name: '定时任务', file: 'src/main/scheduler.ts', hook: 'collector.finishRuntimeContext()' }
  ]

  for (const { name, file, hook } of WRITERS) {
    it(`${name}：${file}`, () => {
      const source = readFileSync(resolve(file), 'utf-8')
      expect(source, `${file} 没接住快照——跨回合前缀缓存在这条路上静默失效`).toContain(hook)
      expect(source, `${file} 落盘时没打 runtime-context 标记——读侧认不出，回放会退化成普通用户消息`)
        .toContain("messageKind: 'runtime-context'")
    })
  }
})
