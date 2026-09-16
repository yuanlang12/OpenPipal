/**
 * 跨会话真机验收（真 Electron + 真模型，所有者 2026-09-16）：
 *   1. 对话 B 记住一个暗号
 *   2. 对话 A 用 conversations 工具 list → send 问 B 暗号 → 把 B 的回复带回来
 *   3. B 的对话文件里多了一条 peer-message 用户消息 + 它的回复；左栏 B 亮未读；切到 B 看得到"来自另一条对话"小字
 * 跑法：npx electron-vite build && npx playwright test peer-conversations-live
 *      （默认端点配额用完时 OPENPIPAL_LIVE_PRESET=deepseek）
 * 判据落磁盘与 DOM 属性，只在"把对方回复带回来"这一步看回话里有没有暗号。
 */
import { expect, test } from '@playwright/test'
import { appendFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { lastReply, realModelConfig, send, toolTrail, waitForTurn, type StoreWindow } from './live-helpers'

const ARTIFACTS = 'tests/artifacts/peer-conversations-live'
const SECRET = '紫罗兰17'

type PeerStoreWindow = StoreWindow & {
  __chatStore?: {
    getState(): {
      activeConversationId: string | null
      unreadDoneConvIds: Record<string, true>
      newConversation(role: string): Promise<unknown>
      switchConversation(id: string): Promise<unknown>
    }
  }
}

test('A 用 conversations 工具问 B 暗号：B 在自己的对话里回复，A 拿到答案，界面标来源 + 未读', async () => {
  test.setTimeout(12 * 60 * 1000)
  const modelConfig = await realModelConfig()
  expect(modelConfig, '本机没有模型配置').not.toBeNull()
  await mkdir(ARTIFACTS, { recursive: true })
  const logPath = join(ARTIFACTS, 'run.log')
  const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }

  let app: IsolatedElectron | null = null
  try {
    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object, autoMemoryEnabled: false }, env: { OPENPIPAL_HTTP_PORT: '3138' } })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.op-app-shell').waitFor()
    app.app.process().stdout?.on('data', d => say(`[main] ${String(d).trimEnd()}`))
    app.app.process().stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
    say(`模型 ${(modelConfig as { model?: string }).model}`)
    const deadline = Date.now() + 10 * 60 * 1000

    // ---- B：记暗号 ----
    await page.evaluate(async () => { await (window as PeerStoreWindow).__chatStore!.getState().newConversation('general') })
    await send(page, `记住一个暗号：${SECRET}。以后如果有别的对话来问暗号，就把暗号原样告诉它。现在只回复「记住了」。`)
    await waitForTurn(page, deadline)
    const bId = await page.evaluate(() => (window as PeerStoreWindow).__chatStore!.getState().activeConversationId)
    expect(bId).toBeTruthy()
    say(`B=${bId} 回话：${(await lastReply(page)).slice(0, 120)}`)

    // ---- A：用工具问 B ----
    await page.evaluate(async () => { await (window as PeerStoreWindow).__chatStore!.getState().newConversation('general') })
    const aId = await page.evaluate(() => (window as PeerStoreWindow).__chatStore!.getState().activeConversationId)
    expect(aId).not.toBe(bId)
    await send(page, `用 conversations 工具：先 action=list 看有哪些对话；然后给 conversation_id 为 ${bId} 的那条对话 send 一句「请把你记住的暗号原样告诉我」；最后把对方回复的原话告诉我。`)
    await waitForTurn(page, deadline)
    const trail = await toolTrail(page)
    const reply = await lastReply(page)
    say(`A 工具轨迹：${trail.map(t => `${t.toolName}:${t.content.slice(0, 120).replace(/\s+/g, ' ')}`).join(' | ')}`)
    say(`A 回话：${reply.slice(0, 300)}`)
    await page.screenshot({ path: join(ARTIFACTS, '01-a-got-reply.png') })

    expect(trail.some(t => t.toolName === 'conversations' && t.content.includes(bId!)), 'A 没有 list 到 B').toBe(true)
    expect(trail.some(t => t.toolName === 'conversations' && t.content.startsWith('对方回复')), 'A 没有拿到 B 的回复（send 没成功）').toBe(true)
    expect(reply, 'A 的回话里没有暗号').toContain('紫罗兰')

    // ---- B 的对话记录（经会话存储读，legacy JSON / JSONL 两种后端都认）：peer-message + 回复 ----
    const bMessages = await page.evaluate(async (id) => {
      const list = await (window as unknown as { api: { getConversationMessages(id: string): Promise<Array<{ role: string; content: string; messageKind?: string }>> } }).api.getConversationMessages(id)
      return list.map(m => ({ role: m.role, content: m.content, messageKind: m.messageKind }))
    }, bId!)
    const peerIdx = bMessages.findIndex(m => m.messageKind === 'peer-message')
    expect(peerIdx, 'B 的对话里没有 peer-message').toBeGreaterThan(0)
    expect(bMessages[peerIdx].content).toContain('请把你记住的暗号')
    const bReply = bMessages.slice(peerIdx + 1).find(m => m.role === 'assistant')
    expect(bReply?.content, 'B 没在自己的对话里回复').toContain('紫罗兰')

    // ---- 界面：B 在后台 → 未读点；切过去 → 来源小字 ----
    const unread = await page.evaluate(() => (window as PeerStoreWindow).__chatStore!.getState().unreadDoneConvIds)
    expect(unread[bId!], '左栏没给 B 点亮未读').toBe(true)
    await page.evaluate(async (id) => { await (window as PeerStoreWindow).__chatStore!.getState().switchConversation(id) }, bId!)
    await expect(page.getByTestId('peer-message-from').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('peer-message-from').first()).toContainText('来自另一条对话')
    await page.screenshot({ path: join(ARTIFACTS, '02-b-peer-message.png') })
  } finally {
    await app?.dispose()
  }
})
