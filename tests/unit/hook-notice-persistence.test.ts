/**
 * 「已定下规则」提醒在三条没有活跃渲染层的路上也要落盘：
 *   后台会话（用户切走了）→ chatStore 走 enqueueBackgroundPersistence + appendMessages；
 *   定时任务 / ACP → createTranscriptCollector 收 hook_notice，scheduler / http-server 用
 *   hookNoticeToStoredMessage 落成与渲染层同形的 inject-notice/hook 消息。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createTranscriptCollector, hookNoticeToStoredMessage } from '../../src/main/pi-event-adapter'

const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf-8')
const notice = { status: 'ok' as const, hookId: 'local-rules/mask', source: { kind: 'plugin' as const, id: 'local-rules', name: 'local-rules' }, file: '/p/hooks/mask.ts', description: '读成绩表前先遮名字' }

describe('规则提醒的落盘', () => {
  it('collector 把 hook_notice 收成独立条目，且不打断正文分段', () => {
    const collector = createTranscriptCollector()
    collector.feed({ type: 'text', content: '我来定规则。' })
    collector.feed({ type: 'hook_notice', notice })
    collector.feed({ type: 'text', content: '定好了。' })
    collector.feed({ type: 'text_flush' })
    const entries = collector.finishTranscript()
    expect(entries.map((e) => e.kind)).toEqual(['text', 'hook', 'text'])
    expect(entries[1]).toEqual({ kind: 'hook', notice })
  })

  it('hookNoticeToStoredMessage 与渲染层落的消息同形：inject-notice/hook + hookNotice', () => {
    const stored = hookNoticeToStoredMessage(notice, 123)
    expect(stored).toMatchObject({ role: 'assistant', messageKind: 'inject-notice', messageSubtype: 'hook', hookNotice: notice, content: '读成绩表前先遮名字', timestamp: 123 })
    const failed = hookNoticeToStoredMessage({ ...notice, status: 'error', error: '第 3 行坏了' }, 1)
    expect(failed.content).toBe('第 3 行坏了')
  })

  it('scheduler 与 ACP 两条落盘路都接了 hook 条目；chatStore 不是当前会话的一律 appendMessages 到它自己的会话', () => {
    expect(read('src/main/scheduler.ts')).toMatch(/entry\.kind === 'hook'[\s\S]*?hookNoticeToStoredMessage\(entry\.notice/)
    expect(read('src/main/http-server.ts')).toMatch(/entry\.kind === 'hook'[\s\S]*?hookNoticeToStoredMessage\(entry\.notice/)
    const store = read('src/renderer/src/stores/chatStore.ts')
    const helper = store.slice(store.indexOf('const persistNoticeMessage = '))
    // 当前会话：进内存 + 常规落盘；其它（切走了 / 后台 / 事件没带会话则落当前）：直接追加到那个会话
    expect(helper.slice(0, 1500)).toMatch(/const target = cid \|\| get\(\)\.activeConversationId[\s\S]*?debouncedSave\(get\)[\s\S]*?enqueueBackgroundPersistence\(target[\s\S]*?appendMessages\(target/)
    const block = store.slice(store.indexOf('onHookNotice((cid: string | null, notice: HookNoticePayload)'))
    expect(block.slice(0, 1200)).toMatch(/persistNoticeMessage\(cid, \{/)
  })
})
