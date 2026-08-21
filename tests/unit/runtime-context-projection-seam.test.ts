import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { toApiMessages } from '../../src/renderer/src/stores/chatStore'
import {
  convertHistoryToPiMessages,
  buildRuntimeContextMessage
} from '../../src/main/agent-runtime/pi-message-conversion'

/**
 * 跨"渲染层历史投影 → 主进程消息转换"这道缝的回归测试。
 *
 * 为什么需要它：runtime-context 快照落盘回放的两份既有测试各站在缝的一侧——
 * runtime-context-dedicated-message.test.ts 手工构造带 messageKind 的历史直接喂主进程，
 * e2e 只验证渲染层把隐藏消息插进了 store。中间那道把 ChatMessage 投影成模型载荷的
 * 手续（toApiMessages）谁都没覆盖，而它恰恰会把 messageKind 丢掉，于是主进程认不出
 * 快照、走进普通用户消息分支，回放字节与实发差一个前导空白——前缀缓存照旧从这里断。
 *
 * 这份测试把两侧接起来跑，钉住"落盘副本经投影后仍与实发字节一致"这个前缀缓存的前提。
 */

/** buildOpenPipalRuntimeContext 的真实形状：带前导 \n\n（历史上它是要被拼在用户消息尾部的） */
const SNAPSHOT = '\n\n<runtime-context>\n当前真实时间：2026年8月18日星期二 10:30。\n用户当前正在使用 Safari。\n</runtime-context>'

function textOf(message: any): string | undefined {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
}

describe('runtime-context 快照跨投影缝的字节一致性', () => {
  const history = [
    { id: 'u1', role: 'user', content: '第一问', timestamp: 1 },
    { id: 'rc-u1', role: 'user', content: SNAPSHOT, messageKind: 'runtime-context', timestamp: 2 },
    { id: 'a1', role: 'assistant', content: '第一答', timestamp: 3 },
    { id: 'u2', role: 'user', content: '第二问', timestamp: 4 }
  ]

  it('渲染层投影必须保留 messageKind，否则主进程认不出快照', () => {
    const projected = toApiMessages(history as any)
    const snapshot = projected.find(m => m.content === SNAPSHOT)
    expect(snapshot, '快照被投影丢弃了').toBeDefined()
    expect((snapshot as any).messageKind).toBe('runtime-context')
  })

  it('投影后回放的快照与当轮实发逐字节一致（前缀缓存的前提）', () => {
    const pi = convertHistoryToPiMessages(toApiMessages(history as any) as any)
    const sent = buildRuntimeContextMessage(SNAPSHOT)

    const replayed = pi.filter(m => (m as any).role === 'user' && textOf(m) === textOf(sent))
    expect(replayed, '回放的快照与实发字节不一致').toHaveLength(1)
    expect((replayed[0] as any).content).toEqual((sent as any).content)
  })

  it('快照独立成条，不与相邻用户消息合并', () => {
    const pi = convertHistoryToPiMessages(toApiMessages(history as any) as any)
    const snapshotText = textOf(buildRuntimeContextMessage(SNAPSHOT))
    const merged = pi.find(m => {
      const t = textOf(m)
      return !!t && t !== snapshotText && t.includes('<runtime-context>')
    })
    expect(merged, '快照被拼进了别的消息').toBeUndefined()
  })
})

/**
 * 上面那个测试只跑得到桌面这一条投影。另外两条（定时任务、ACP/插件）一个是模块私有
 * 函数、一个是内联 map，单测够不着——但它们与桌面那条犯的是同一个错，且历史上是同时
 * 犯的。这里按仓库既有做法（agent-runtime-boundary.test.ts / prompt-policy.test.ts）
 * 直接钉源码：三条投影都必须把 messageKind 带过缝。新增第四条投影不会被这份清单发现，
 * 所以清单本身也是给下一个人看的——投影历史进模型载荷，就得带上这个字段。
 */
describe('三处历史投影都必须携带 messageKind', () => {
  const PROJECTIONS = [
    { name: '桌面（渲染层）', file: 'src/renderer/src/stores/chatStore.ts', fragment: 'messageKind: msg.messageKind' },
    { name: '定时任务', file: 'src/main/scheduler.ts', fragment: 'messageKind: message.messageKind' },
    { name: 'ACP / 浏览器插件', file: 'src/main/http-server.ts', fragment: 'messageKind: m.messageKind' }
  ]

  for (const { name, file, fragment } of PROJECTIONS) {
    it(`${name}：${file}`, () => {
      const source = readFileSync(resolve(file), 'utf-8')
      expect(source, `${file} 的历史投影丢了 messageKind——跨回合前缀缓存会静默失效`).toContain(fragment)
    })
  }
})
