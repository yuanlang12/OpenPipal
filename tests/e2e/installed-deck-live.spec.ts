import { chromium, expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * 装机版真机验收：deck 任务写成工作区文件时，模型是拷预制件（copy_starter_component）还是全盘 find。
 * 2026-09-11 实撞：技能只写 `./deck-stage.js` 相对路径、磁盘上从来没有这文件，模型两次触发主目录遍历确认。
 * 判据落磁盘和工具轨迹：工作目录里出现 deck-stage.js / support.js、工具轨迹里有 copy_starter_component、
 * 没有一张「遍历主目录/全盘」的确认卡（出现了就点拒绝并记下来，不让它真搜）。
 *   OPENPIPAL_INSTALLED_LIVE=1 OPENPIPAL_LIVE_PRESET=deepseek npx playwright test installed-deck-live
 *   OPENPIPAL_DECK_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build），装机前先验
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const DEV = !!process.env.OPENPIPAL_DECK_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/installed-deck'
const DATA_DIR = '.openpipal'

const TASK = [
  '在当前工作目录里做一份 3 页的幻灯片 deck，文件名 intro.dc.html，主题「OpenPipal 是什么」，用 deck-stage 舞台。',
  '要求：写成工作目录里的普通文件，我要在本地用浏览器双击打开看，不要用 create_artifact 交付。',
  '做完把文件路径告诉我。'
].join('')

test.describe('装机版：deck 写成工作区文件', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('模型拷预制件进工作目录，不去全盘 find', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-installed-deck-'))
    const work = join(home, 'deck-work')
    mkdirSync(work, { recursive: true })
    const data = join(home, DATA_DIR)
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'config.json'), JSON.stringify({
      configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, modelConfig
    }, null, 2), 'utf8')
    mkdirSync(ARTIFACTS, { recursive: true })
    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }
    say(`起跑 模型=${(modelConfig as { model?: string })?.model} 工作目录=${work}`)

    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3137' } })
    const proc = app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    try {
      const page = await app.firstWindow()
      page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })
      await page.screenshot({ path: join(ARTIFACTS, '01-launched.png') })

      // 欢迎页固定从「通用」开始，config.role 不算数，得真点头像
      await page.locator('[title="设计助手"]').first().click()
      await page.evaluate((dir: string) => {
        const state = (window as unknown as {
          __chatStore?: { getState(): { setConversationWorkingDir(d: string): void; setConversationPermissionTier(t: string): void } }
        }).__chatStore?.getState()
        state?.setConversationWorkingDir(dir)
        state?.setConversationPermissionTier('auto')
      }, work)
      // 设计助手的欢迎页不显示工作目录芯片，直接读 store 核对
      const setDir = await page.evaluate(() => (window as unknown as {
        __chatStore?: { getState(): { conversationConfig?: { workingDir?: string } } }
      }).__chatStore?.getState().conversationConfig?.workingDir)
      expect(setDir, '工作目录没设上').toBe(work)

      const preflow = page.locator('[data-testid="preflow-input"]')
      const usePreflow = await preflow.count() > 0
      const input = usePreflow ? preflow.first() : page.locator('textarea').first()
      await input.waitFor({ state: 'visible', timeout: 60_000 })
      await input.fill(TASK)
      await page.screenshot({ path: join(ARTIFACTS, '02-task-typed.png') })
      await (usePreflow ? page.locator('[data-testid="preflow-start-btn"]') : page.locator('[data-testid="send-btn"]')).first().click()

      const deadline = Date.now() + 10 * 60 * 1000
      const allowed: string[] = []
      const denied: string[] = []
      const isHomeScan = (card: string): boolean => /遍历主目录|全盘|find \/Users|find ~|find \/ /.test(card)
      void drivePermissions(page, allowed, deadline, isHomeScan, denied).catch(() => undefined)
      await waitForTurn(page, deadline)
      await page.screenshot({ path: join(ARTIFACTS, '03-turn-done.png'), fullPage: true })
      // 设计助手按流程先访谈（questions_v2）再动手；文件还没写出来就替用户答一句，最多再跑两轮
      for (let round = 0; round < 2 && !existsSync(join(work, 'intro.dc.html')); round++) {
        say(`[追问] 第 ${round + 1} 轮：文件还没写出来，回一句「按默认做」`)
        await send(page, '不用问了，都按你的默认判断做，直接把 intro.dc.html 写到工作目录。')
        await waitForTurn(page, deadline)
        await page.screenshot({ path: join(ARTIFACTS, `04-round-${round + 1}.png`), fullPage: true })
      }

      const trail = await toolTrail(page)
      for (const t of trail) say(`[tool] ${t.toolName}: ${t.content.replace(/\s+/g, ' ').slice(0, 200)}`)
      for (const c of allowed) say(`[允许] ${c}`)
      for (const c of denied) say(`[拒绝] ${c}`)
      say(`[回话] ${(await lastReply(page)).slice(0, 600)}`)

      const toolNames = trail.map(t => t.toolName)
      say(`[工具序列] ${toolNames.join(' → ')}`)
      expect(toolNames, '模型没调 copy_starter_component').toContain('copy_starter_component')
      expect(denied, '模型还是去全盘/主目录 find 了').toEqual([])
      expect(existsSync(join(work, 'deck-stage.js')), 'deck-stage.js 没落到工作目录').toBe(true)
      expect(existsSync(join(work, 'support.js')), 'support.js 没落到工作目录').toBe(true)
      expect(existsSync(join(work, 'intro.dc.html')), 'intro.dc.html 没写出来').toBe(true)
      const html = readFileSync(join(work, 'intro.dc.html'), 'utf8')
      expect(html).toContain('from="./deck-stage.js"')
      // 2026-09-11 实测：只拷文件不预载，本地打开一片空白且无报错——support.js 不会自己去取 from 文件
      expect(html, 'deck-stage.js 没在 support.js 之前用 <script src> 预载').toMatch(/<script src="\.\/deck-stage\.js"><\/script>[\s\S]*<script src="\.\/support\.js">/)
      expect(html, 'vendor react 没在 support.js 之前预载').toMatch(/vendor\/react\.production\.min\.js[\s\S]*<script src="\.\/support\.js">/)

      // 真按用户的用法开一次：file:// 直接打开，得渲染出 3 页
      const browser = await chromium.launch()
      try {
        const local = await browser.newPage({ viewport: { width: 1600, height: 900 } })
        const errors: string[] = []
        local.on('pageerror', e => errors.push(e.message))
        await local.goto('file://' + join(work, 'intro.dc.html'))
        await local.waitForTimeout(3000)
        await local.screenshot({ path: join(ARTIFACTS, '05-local-open.png') })
        const sections = await local.locator('section').count()
        say(`[本地打开] section=${sections} pageerror=${errors.length}`)
        expect(errors).toEqual([])
        expect(sections, '本地 file:// 打开没渲染出页').toBeGreaterThanOrEqual(3)
      } finally {
        await browser.close()
      }
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
