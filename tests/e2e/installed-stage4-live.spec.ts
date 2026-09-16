import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastReply, realModelConfig, send, waitForTurn, type StoreWindow } from './live-helpers'

/**
 * 装机版真机验收（统一身份第 4 段 + 我的 Pal 页分类 / 搜索）：驱动 /Applications 里的正式包（隔离 home，真模型）。
 *   OPENPIPAL_INSTALLED_LIVE=1 npx playwright test installed-stage4-live
 * 判据落 store 状态、磁盘文件和截图，不靠回话措辞。
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const APP = process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal'
const ARTIFACTS = 'tests/artifacts/installed-stage4'
const DATA_DIR = '.openpipal'

test.describe('装机版：角色跟着会话走 + 我的 Pal 页分类', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('欢迎页选角色 → 老会话角色跟着走 → 我的 Pal 页分类/搜索/复制 → Pal 副本能聊', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-installed-'))
    await mkdir(join(home, DATA_DIR), { recursive: true })
    await writeFile(join(home, DATA_DIR, 'config.json'), JSON.stringify({ configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, modelConfig }, null, 2), 'utf8')
    await mkdir(ARTIFACTS, { recursive: true })
    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }
    const app = await electron.launch({ executablePath: APP, args: [], env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3135' } })
    const proc = app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    try {
      const page = await app.firstWindow()
      page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })
      const roleNow = () => page.evaluate(() => (window as StoreWindow).__appStore!.getState().currentRole?.name)
      const deadline = Date.now() + 10 * 60 * 1000

      // 1. 启动：通用助手；点设计助手头像 → 前置页出来、currentRole=design
      expect(await roleNow()).toBe('general')
      await page.locator('button[title="设计助手"]').click()
      await expect(page.getByTestId('preflow-composer')).toBeVisible({ timeout: 10_000 })
      expect(await roleNow()).toBe('design')
      await page.screenshot({ path: join(ARTIFACTS, '01-pick-design.png') })

      // 2. 在办公助手会话里真聊一句（无前置页），角色钉进会话
      await page.evaluate(async () => { await (window as StoreWindow).__chatStore!.getState().newConversation('general') })
      await page.locator('button[title="办公助手"]').click()
      expect(await roleNow()).toBe('office')
      await send(page, '用一句话说你是谁，不要调用工具。')
      await waitForTurn(page, deadline)
      say(`办公助手回话：${(await lastReply(page)).slice(0, 200)}`)
      const officeConv = await page.evaluate(() => (window as StoreWindow).__chatStore!.getState().activeConversationId)
      const convRecord = await page.evaluate(() => { const s = (window as StoreWindow).__chatStore!.getState(); return s.conversations.find(c => c.id === s.activeConversationId) })
      say(`会话记录 role=${convRecord?.role} agent=${(convRecord as { agent?: string } | undefined)?.agent}`)
      expect(convRecord?.role).toBe('office')
      await page.screenshot({ path: join(ARTIFACTS, '02-office-chat.png') })

      // 3. 新建对话 → 通用；从历史点回办公助手那条 → currentRole 跟着变 office（第 4 段后半的核心）
      await page.getByRole('button', { name: '新建对话' }).click()
      await page.waitForTimeout(500)
      expect(await roleNow()).toBe('general')
      await page.evaluate(async (id) => { await (window as StoreWindow).__chatStore!.getState().switchConversation(id!) }, officeConv)
      await page.waitForTimeout(500)
      expect(await roleNow()).toBe('office')
      await page.screenshot({ path: join(ARTIFACTS, '03-reopen-office.png') })

      // 4. 我的 Pal 页：分类片、内置带分类标签、搜索、复制编码助手 → 副本落在「编码」组
      await page.getByRole('button', { name: '我的 Pal' }).click()
      await expect(page.getByTestId('agents-search')).toBeVisible()
      await expect(page.getByTestId('agents-builtin').locator('[data-testid="agent-row"]')).toHaveCount(7)
      await page.screenshot({ path: join(ARTIFACTS, '04-my-pals-all.png') })
      const codingRow = page.locator('[data-testid="agent-row"][data-agent-kind="builtin"]', { hasText: '编码助手' })
      await codingRow.hover()
      await codingRow.getByTestId('agent-copy').click()
      await expect(page.locator('[data-section="category:coding"] [data-testid="agent-row"]', { hasText: '编码助手 副本' })).toBeVisible({ timeout: 10_000 })
      const copyMeta = await page.evaluate(() => (window as StoreWindow).__appStore!.getState().agents.find(a => a.name === '编码助手 副本'))
      say(`副本摘要：${JSON.stringify(copyMeta)}`)
      await page.screenshot({ path: join(ARTIFACTS, '05-copied-into-coding.png') })
      await page.getByTestId('agents-search').fill('副本')
      expect(await page.locator('[data-testid="agent-row"] h3').allTextContents()).toEqual(['编码助手 副本'])
      await page.screenshot({ path: join(ARTIFACTS, '07-search.png') })

      // 5. 副本能聊：试一下 → 真模型回一句；会话是 Pal 的（activeWorkspaceId），role 槽位中性
      await page.locator('[data-testid="agent-row"]', { hasText: '编码助手 副本' }).getByTestId('agent-try').click()
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 20_000 })
      const state = await page.evaluate(() => { const s = (window as StoreWindow).__chatStore!.getState(); return { ws: s.activeWorkspaceId, role: (window as StoreWindow).__appStore!.getState().currentRole?.name } })
      say(`副本会话：${JSON.stringify(state)}`)
      expect(state.ws).toBeTruthy()
      expect(state.role).toBe('general')
      const agentMd = await readFile(join(home, DATA_DIR, 'agents', String(state.ws), 'agent.md'), 'utf8')
      say(`副本 agent.md 头：${agentMd.slice(0, 120).replace(/\n/g, ' | ')}`)
      expect(agentMd).toMatch(/^permission-tier: allowed$/m)
      await send(page, '用一句话说你是谁，不要调用工具。')
      await waitForTurn(page, deadline)
      say(`副本回话：${(await lastReply(page)).slice(0, 200)}`)
      expect((await lastReply(page)).length).toBeGreaterThan(0)
      await page.screenshot({ path: join(ARTIFACTS, '08-copy-chat.png') })
    } finally {
      await app.close().catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  })
})
