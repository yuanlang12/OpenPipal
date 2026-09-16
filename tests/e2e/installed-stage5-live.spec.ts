import { expect, test, _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastReply, realModelConfig, send, waitForTurn, type StoreWindow } from './live-helpers'

/**
 * 装机版真机验收（统一身份第 5 段）：驱动 /Applications 里的正式包（隔离 home，真模型）。
 * 启动前在 home 里放：一个老模板（agent-templates/<id>.json）、一条指向它的老会话（只有 agentId）、一个指向它的老任务。
 * 看：启动后模板变成 Pal（我的 Pal 页有它、原文件改名 .migrated）；老会话点开是这个 Pal 的会话；自动化页把任务归到它名下；
 * 在这条老会话里接着聊，回话带着模板的人设。
 *   OPENPIPAL_INSTALLED_LIVE=1 npx playwright test installed-stage5-live
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const APP = process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal'
const ARTIFACTS = 'tests/artifacts/installed-stage5'
const DATA_DIR = '.openpipal'
const TEMPLATE = 'e5e5e5e5-0000-4000-8000-000000000015'
const CONV = 'c5c5c5c5-0000-4000-8000-000000000016'
const TASK = 'a5a5a5a5-0000-4000-8000-000000000017'

test.describe('装机版：模板并入 Pal', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(10 * 60 * 1000)

  test('老模板启动即成 Pal；老会话 / 老任务认得出它；在老会话里接着聊带着它的人设', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-installed5-'))
    const data = join(home, DATA_DIR)
    mkdirSync(join(data, 'agent-templates'), { recursive: true })
    mkdirSync(join(data, 'conversations'), { recursive: true })
    mkdirSync(join(data, 'tasks'), { recursive: true })
    writeFileSync(join(data, 'config.json'), JSON.stringify({ configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, modelConfig }, null, 2), 'utf8')
    writeFileSync(join(data, 'agent-templates', `${TEMPLATE}.json`), JSON.stringify({
      id: TEMPLATE, name: '海盗船长', description: '说话像海盗', icon: '🏴‍☠️',
      systemPrompt: '你是一位海盗船长。每句话都要以"呀嗬！"开头，自称"本船长"。回答简短。', createdAt: 1, updatedAt: 1
    }, null, 2), 'utf8')
    const t0 = Date.now() - 60_000
    writeFileSync(join(data, 'conversations', `${CONV}.json`), JSON.stringify({
      id: CONV, title: '和船长的老对话', role: 'general', agentId: TEMPLATE, createdAt: t0, updatedAt: t0,
      messages: [
        { id: 'u1', role: 'user', content: '你好', timestamp: t0 },
        { id: 'a1', role: 'assistant', content: '呀嗬！本船长在此。', timestamp: t0 + 1000 }
      ]
    }, null, 2), 'utf8')
    writeFileSync(join(data, 'tasks', `${TASK}.json`), JSON.stringify({
      id: TASK, name: '船长每周汇报', enabled: false, agentId: TEMPLATE,
      trigger: { type: 'schedule', schedule: { type: 'cron', cron: '0 9 * * 1' } }, prompt: '写周报', conversationMode: 'per-run', createdAt: t0, updatedAt: t0
    }, null, 2), 'utf8')
    mkdirSync(ARTIFACTS, { recursive: true })
    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }
    const app = await electron.launch({ executablePath: APP, args: [], env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3136' } })
    const proc = app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    try {
      const page = await app.firstWindow()
      page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })
      const deadline = Date.now() + 8 * 60 * 1000

      // 1. 磁盘：模板并入 Pal，原文件改名留底
      expect(existsSync(join(data, 'agents', TEMPLATE, 'meta.json'))).toBe(true)
      expect(existsSync(join(data, 'agent-templates', `${TEMPLATE}.json.migrated`))).toBe(true)
      expect(existsSync(join(data, 'agent-templates', `${TEMPLATE}.json`))).toBe(false)
      const agentMd = readFileSync(join(data, 'agents', TEMPLATE, 'agent.md'), 'utf8')
      say(`agent.md：${agentMd.slice(0, 60)}`)
      expect(agentMd).toContain('海盗船长')

      // 2. 我的 Pal 页：它在「我的 Pal」组里（没分类），带描述
      await page.getByRole('button', { name: '我的 Pal' }).click()
      await expect(page.getByTestId('agents-search')).toBeVisible()
      const row = page.locator('[data-testid="agent-row"][data-agent-kind="pal"]', { hasText: '海盗船长' })
      await expect(row).toBeVisible()
      await expect(row).toContainText('说话像海盗')
      await expect(page.locator('[data-testid="agent-row"]')).toHaveCount(8)   // 7 内置 + 1 迁来的
      await page.screenshot({ path: join(ARTIFACTS, '01-my-pals-migrated.png') })

      // 3. 自动化页：老任务归到它名下
      await page.getByRole('button', { name: '自动化' }).click()
      await expect(page.getByText('船长每周汇报')).toBeVisible()
      await expect(page.getByText('🤖 海盗船长')).toBeVisible()
      await page.screenshot({ path: join(ARTIFACTS, '02-tasks-scope.png') })

      // 4. 老会话：点开就是这个 Pal 的会话（activeWorkspaceId = 模板 id），历史里显示老消息
      await page.evaluate(async (id) => { await (window as StoreWindow).__chatStore!.getState().switchConversation(id) ; (window as StoreWindow).__appStore!.getState().setActiveView('chat') }, CONV)
      await page.waitForTimeout(800)
      const state = await page.evaluate(() => { const s = (window as StoreWindow).__chatStore!.getState(); return { ws: s.activeWorkspaceId, n: s.messages.length, role: (window as StoreWindow).__appStore!.getState().currentRole?.name } })
      say(`老会话状态：${JSON.stringify(state)}`)
      expect(state.ws).toBe(TEMPLATE)
      expect(state.role).toBe('general')
      expect(state.n).toBeGreaterThanOrEqual(2)
      await expect(page.getByText('呀嗬！本船长在此。')).toBeVisible()
      await page.screenshot({ path: join(ARTIFACTS, '03-old-conversation.png') })

      // 5. 接着聊：回话带着模板的人设（真模型）
      await send(page, '用一句话介绍你自己。不要调用工具。')
      await waitForTurn(page, deadline)
      const reply = await lastReply(page)
      say(`回话：${reply.slice(0, 200)}`)
      expect(reply).toMatch(/呀嗬|船长/)
      await page.screenshot({ path: join(ARTIFACTS, '04-chat-in-old-conversation.png') })
    } finally {
      await app.close().catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  })
})
