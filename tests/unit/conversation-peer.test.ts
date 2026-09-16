/**
 * 跨会话（所有者 2026-09-16）：一条对话里的 AI 列 / 读 / 发消息到这台机器上的其他单对话。
 *   - list 不含团队话题；read 只给文字、工具压一行；send 对方空闲就在它那边跑一轮、回复带回，正忙就排队
 *   - 乒乓保护：超过 PEER_MAX_HOPS 跳拒发
 *   - 开关：内置角色默认有；独立 Pal 要在 tools/config.json 的 enabledTools 点名；子代理拿不到；无会话身份的路径拿不到
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-peer-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

// 假 Runtime：记录每次跑的是哪条对话、收到什么历史；按 forward 表模拟"对方在回复里又 send 给第三条"
const runs: Array<{ conversationId?: string; source?: string; last?: { content: string; messageKind?: string } }> = []
const forward = new Map<string, string>()
const fakeRuntime = {
    async *agentChat(history: Array<{ content: string; messageKind?: string }>, _signal: AbortSignal, source: string, overrides?: { conversationId?: string }) {
      const cid = overrides?.conversationId
      runs.push({ conversationId: cid, source, last: history[history.length - 1] })
      const next = cid ? forward.get(cid) : undefined
      if (cid && next) {
        const peer = await import('../../src/main/conversation-peer')
        const r = await peer.sendPeerMessage({ fromConversationId: cid, toConversationId: next, text: '接力' })
        yield { type: 'text', content: `转发:${r.status}${r.status === 'error' ? ':' + r.error : ''}` }
      } else {
        yield { type: 'text', content: `收到，我是 ${cid?.slice(0, 4)}` }
      }
      yield { type: 'text_flush' }
    }
}

// 一条团队话题（写老格式文件即可：list 只看 teamId）
mkdirSync(join(DATA, 'conversations'), { recursive: true })
const TEAM_THREAD = 'aaaaaaaa-0000-4000-8000-00000000000a'
writeFileSync(join(DATA, 'conversations', `${TEAM_THREAD}.json`), JSON.stringify({ id: TEAM_THREAD, title: '团队话题', role: 'general', teamId: 'bbbbbbbb-0000-4000-8000-00000000000b', createdAt: 1, updatedAt: 9, messages: [] }), 'utf8')
// 两个 Pal：一个点了 enabledTools，一个没点
const PAL_ON = 'c1c1c1c1-0000-4000-8000-0000000000c1'
const PAL_OFF = 'c2c2c2c2-0000-4000-8000-0000000000c2'
for (const [id, name, cfg] of [[PAL_ON, '开了的 Pal', { enabledTools: ['conversations'] }], [PAL_OFF, '没开的 Pal', { workingDir: '/tmp/x' }]] as const) {
  mkdirSync(join(DATA, 'agents', id, 'tools'), { recursive: true })
  writeFileSync(join(DATA, 'agents', id, 'meta.json'), JSON.stringify({ id, name, icon: '🤖', description: '', createdAt: 1, updatedAt: 1 }), 'utf8')
  writeFileSync(join(DATA, 'agents', id, 'agent.md'), `# ${name}\n`, 'utf8')
  writeFileSync(join(DATA, 'agents', id, 'tools', 'config.json'), JSON.stringify(cfg), 'utf8')
}

const conv = await import('../../src/main/conversation-service')
const peer = await import('../../src/main/conversation-peer')
const tools = await import('../../src/main/openpipal-product-tools')
const registry = await import('../../src/main/agent-registry')
const { COMMON_TOOLS, PAL_OPT_IN_TOOLS } = await import('../../src/main/role-manager')
const coordinator = await import('../../src/main/conversation-execution-coordinator')
peer.setPeerRuntime(async () => fakeRuntime as never)
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const text = async (tool: { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }> }, params: Record<string, unknown>): Promise<string> =>
  (await tool.execute('call', params)).content[0].text
const waitFor = async (check: () => Promise<boolean>, ms = 3000): Promise<void> => {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('等超时')
}

describe('conversations 工具', () => {
  it('list 列其他单对话、标当前；团队话题不出现。read 给文字、工具压一行、团队话题拒读', async () => {
    const a = await conv.createConversation('general', 'A 对话')
    const b = await conv.createConversation('general', 'B 对话')
    await conv.appendMessages(b.id, [
      { id: 'm1', role: 'user', content: '你在做什么', timestamp: 1 },
      { id: 'm2', role: 'tool', content: 'x'.repeat(500), timestamp: 2, toolName: 'web_search', toolCallId: 't1' },
      { id: 'm3', role: 'assistant', content: '在查资料', timestamp: 3 }
    ])
    const tool = tools.buildOpenPipalProductTools('desktop', async () => null, { systemPrompt: '', conversationId: a.id } as never).find(t => t.name === 'conversations')!
    expect(tool).toBeDefined()

    const list = await text(tool, { action: 'list' })
    expect(list).toContain(`${b.id} · B 对话 · OpenPipal`)
    expect(list).toContain(`${a.id} · A 对话`)
    expect(list).toContain('（当前对话）')
    expect(list).not.toContain('团队话题')

    const read = await text(tool, { action: 'read', conversation_id: b.id })
    expect(read).toContain('「B 对话」')
    expect(read).toContain('[用户] 你在做什么')
    expect(read).toContain('[工具 web_search] ' + 'x'.repeat(160) + '…')
    expect(read).toContain('[OpenPipal] 在查资料')
    expect(await text(tool, { action: 'read', conversation_id: TEAM_THREAD })).toContain('团队话题不在跨会话范围')
    expect(await text(tool, { action: 'read', conversation_id: 'nope' })).toContain('不存在')
    expect(await text(tool, { action: 'send', conversation_id: a.id, message: '自言自语' })).toContain('不能发给当前对话自己')
  })

  it('send：对方空闲 → 在它那边跑一轮（无头 source）、消息与回复落进它的对话、回复带回发送方', async () => {
    const a = await conv.createConversation('general', '发送方')
    const b = await conv.createConversation('general', '接收方')
    runs.length = 0
    const r = await peer.sendPeerMessage({ fromConversationId: a.id, toConversationId: b.id, text: '进度到哪了？' })
    expect(r).toEqual({ status: 'replied', reply: `收到，我是 ${b.id.slice(0, 4)}` })
    expect(runs).toHaveLength(1)
    expect(runs[0].conversationId).toBe(b.id)
    expect(runs[0].source).toBe('scheduler')
    expect(runs[0].last?.messageKind).toBe(peer.PEER_MESSAGE_KIND)
    expect(runs[0].last?.content).toContain('来自另一条对话 「发送方」（OpenPipal）')
    expect(runs[0].last?.content).toContain('进度到哪了？')

    const stored = await conv.getConversationMessages(b.id)
    expect(stored.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(stored[0].messageKind).toBe(peer.PEER_MESSAGE_KIND)
    expect(stored[1].content).toBe(`收到，我是 ${b.id.slice(0, 4)}`)
    // 发送方自己的对话没被动
    expect(await conv.getConversationMessages(a.id)).toEqual([])
  })

  it('send：对方正忙 → 立即返回 queued，忙完再送达', async () => {
    const a = await conv.createConversation('general', '发送方 2')
    const b = await conv.createConversation('general', '忙着的接收方')
    const lease = await coordinator.acquireConversationExecution({ conversationId: b.id, owner: { entrypoint: 'desktop', ownerId: 'test' }, policy: 'reject' })
    runs.length = 0
    const r = await peer.sendPeerMessage({ fromConversationId: a.id, toConversationId: b.id, text: '忙完看一眼' })
    expect(r).toEqual({ status: 'queued' })
    expect(runs).toHaveLength(0)
    lease.release()
    await waitFor(async () => (await conv.getConversationMessages(b.id)).length === 2)
    expect(runs[0].conversationId).toBe(b.id)
  })

  it('乒乓保护：接力超过 PEER_MAX_HOPS 跳就拒发，链上最后一条不会被触发', async () => {
    const ids: string[] = []
    for (const name of ['甲', '乙', '丙', '丁', '戊', '己']) ids.push((await conv.createConversation('general', name)).id)
    forward.clear()
    for (let i = 1; i < ids.length - 1; i++) forward.set(ids[i], ids[i + 1]) // 乙→丙→丁→戊→己
    runs.length = 0
    const r = await peer.sendPeerMessage({ fromConversationId: ids[0], toConversationId: ids[1], text: '开始接力' })
    expect(r.status).toBe('replied')
    const ran = runs.map(x => x.conversationId)
    expect(ran).toEqual([ids[1], ids[2], ids[3], ids[4]]) // 甲→乙(1)→丙(2)→丁(3)→戊(4)；戊→己是第 5 跳，拒
    const wu = await conv.getConversationMessages(ids[4])
    expect(wu[1].content).toContain(`转发:error:对话之间已经来回 ${peer.PEER_MAX_HOPS} 跳`)
    expect(await conv.getConversationMessages(ids[5])).toEqual([])
    forward.clear()
  })
})

describe('开关', () => {
  it('内置角色默认有；独立 Pal 要在 tools/config.json 点名 enabledTools 才有', () => {
    expect(COMMON_TOOLS).toContain('conversations')
    expect(PAL_OPT_IN_TOOLS).toContain('conversations')
    expect(registry.getAgent('general')!.tools).toContain('conversations')
    expect(registry.getAgent(PAL_ON)!.tools).toContain('conversations')
    expect(registry.getAgent(PAL_OFF)!.tools).not.toContain('conversations')
    expect(registry.getAgent(PAL_OFF)!.tools).toEqual(COMMON_TOOLS.filter(t => t !== 'conversations'))

    const built = tools.buildOpenPipalProductTools('desktop', async () => null, { systemPrompt: '', conversationId: 'conv-x' } as never)
    const names = (ws: string): string[] => tools.filterOpenPipalTools(built, { workspaceId: ws } as never).map(t => t.name)
    expect(names(PAL_ON)).toContain('conversations')
    expect(names(PAL_OFF)).not.toContain('conversations')
  })

  it('没有会话身份的路径（语音桥等）拿不到；定时任务面拿得到', () => {
    const voiceLike = tools.buildOpenPipalProductTools('desktop', async () => null, { systemPrompt: '' } as never)
    expect(voiceLike.find(t => t.name === 'conversations')).toBeUndefined()
    const scheduled = tools.buildOpenPipalProductTools('scheduler', async () => null, { systemPrompt: '', conversationId: 'conv-y' } as never)
    expect(scheduled.find(t => t.name === 'conversations')).toBeDefined()
  })
})
