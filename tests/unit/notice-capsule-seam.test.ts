/**
 * 胶囊提醒（规则 / 记忆）的两条约定，按源码钉住：
 *   1. 长期可见：落成 inject-notice 消息、留在它发生的会话与位置——记忆不再是 8 秒消失的浮条；
 *   2. 不算对话历史：不进模型载荷（既有 inject-notice 规则）、不进"对话较长 / 保存为 Agent"的计数、
 *      不进 Evolver（记忆提取 / 保存 Agent / dream）看的对话正文。
 * 记忆胶囊的数据三边同一份 shared 契约；主进程四个来源经一个出口发事件、带会话 id，胶囊才落得到正确的会话。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { countDialogueMessages } from '../../src/renderer/src/chat/messages'
import { formatDialogue, isDialogueMessage } from '../../src/main/dialogue-format'

const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf-8')

describe('胶囊提醒', () => {
  it('记忆结论落成 inject-notice/memory 消息，与规则胶囊走同一个 persistNoticeMessage；浮条时代的状态没了', () => {
    const store = read('src/renderer/src/stores/chatStore.ts')
    expect(store).toMatch(/onMemoryUpdated\(\(cid: string \| null, notice: MemoryNotice\)/)
    expect(store).toMatch(/messageKind: 'inject-notice',\s*messageSubtype: 'memory',\s*memoryNotice: notice/)
    expect(store).toMatch(/persistNoticeMessage\(cid, \{/)
    expect(store).not.toMatch(/memoryNotification/)
    expect(read('src/renderer/src/components/ChatPanel.tsx')).not.toMatch(/MemoryNotice\b/)
  })

  it('两种胶囊共用一个壳（NoticeCapsule：居中、data-testid=inject-notice），MessageBubble 各自分流', () => {
    const bubble = read('src/renderer/src/components/MessageBubble.tsx')
    expect(bubble).toMatch(/messageSubtype === 'memory' && message\.memoryNotice[\s\S]*?<MemoryNoticeRow message=\{message\} \/>/)
    const capsule = read('src/renderer/src/components/messages/shared/NoticeCapsule.tsx')
    expect(capsule).toMatch(/className="flex justify-center my-2 animate-fade-in"/)
    expect(capsule).toMatch(/data-testid="inject-notice"/)
    for (const rel of ['src/renderer/src/components/messages/HookNoticeRow.tsx', 'src/renderer/src/components/messages/MemoryNoticeRow.tsx']) {
      expect(read(rel), rel).toMatch(/<NoticeCapsule\b/)
      expect(read(rel), rel).not.toMatch(/data-testid="inject-notice"/)
    }
  })

  it('不算对话历史：两处计数同一个 countDialogueMessages，Evolver 三处正文同一个 formatDialogue', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: '规则', messageKind: 'inject-notice', messageSubtype: 'hook' },
      { role: 'assistant', content: '记住', messageKind: 'inject-notice', messageSubtype: 'memory' }
    ] as never[]
    expect(countDialogueMessages(messages)).toBe(2)
    expect(read('src/renderer/src/components/ChatPanel.tsx')).toMatch(/useMemo\(\(\) => countDialogueMessages\(messages\), \[messages\]\)/)
    expect(read('src/renderer/src/components/StatusBar.tsx')).toMatch(/useChatStore\(s => countDialogueMessages\(s\.messages\)\)/)

    const notice = { role: 'assistant', content: '读成绩表前先遮名字', messageKind: 'inject-notice', timestamp: 1 } as never
    const snapshot = { role: 'user', content: '<runtime>', messageKind: 'runtime-context', timestamp: 1 } as never
    const said = { role: 'user', content: '以后都遮名字', timestamp: 1 } as never
    expect(isDialogueMessage(notice)).toBe(false)
    expect(isDialogueMessage(snapshot)).toBe(false)
    expect(formatDialogue([notice, snapshot, said], { maxMessages: 1, maxChars: 100 })).toBe('[用户] 以后都遮名字')
    for (const rel of ['src/main/evolver-agent.ts', 'src/main/agent-dreamer.ts', 'src/main/agent-extractor.ts']) {
      const source = read(rel)
      expect(source, rel).toMatch(/import \{ formatDialogue \} from '\.\/dialogue-format'/)
      expect(source, rel).not.toMatch(/m\.role === 'user' \|\| m\.role === 'assistant'/)
    }
    // 主进程读侧本来就不把 inject-notice 放进模型载荷
    expect(read('src/main/conversation-store.ts')).toMatch(/kind === 'inject-notice'[^\n]*return false/)
  })

  it('记忆胶囊的数据是 shared 那一份；主进程四个来源经一个 emitMemoryNotice 出口、都带会话 id', () => {
    expect(read('src/main/conversation-store.ts')).toMatch(/memoryNotice\?: MemoryNotice\b/)
    expect(read('src/main/conversation-store.ts')).toMatch(/import type \{ MemoryNotice \} from '\.\.\/shared\/memory-notice-contract'/)
    expect(read('src/renderer/src/types/index.ts')).toMatch(/memoryNotice\?: MemoryNotice\b/)
    expect(read('src/renderer/src/types/index.ts')).toMatch(/MemoryNotice \} from '\.\.\/\.\.\/\.\.\/shared\/memory-notice-contract'/)
    const ipc = read('src/main/ipc-handlers.ts')
    expect((ipc.match(/webContents\.send\('memory:updated'/g) || []).length).toBe(1)
    expect(ipc).toMatch(/webContents\.send\('memory:updated', conversationId \?\? null, notice\)/)
    expect((ipc.match(/emitMemoryNotice\(conversationId, \{ type: '(extracted|dreamed)'/g) || []).length).toBe(4)
    expect(read('src/preload/index.d.ts')).toMatch(/onMemoryUpdated\?: \(callback: \(conversationId: string \| null, notice: MemoryNotice\) => void\) => \(\) => void/)
  })
})
