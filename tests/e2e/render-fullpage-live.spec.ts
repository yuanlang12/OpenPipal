import { expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * 真机验收：render_artifact 对可滚动的长页要截整页，不是只截首屏。
 * 2026-09-11 实撞：鹈鹕那次模型看到了首屏截图，却看不到首屏以下，于是去找 Playwright、翻对话目录要整页图。
 * 判据落在工具结果与磁盘：render_artifact 的结果写"整页 1280×N"，.self-check 里的 PNG 高度明显超过一屏；
 * 同时它也是 macOS 窗口钳位的回归（没 enableLargerThanScreen 时 1512×982 的屏只截得到 1280×839）。
 *   OPENPIPAL_INSTALLED_LIVE=1 OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test render-fullpage-live
 *   OPENPIPAL_DECK_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build）
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const DEV = !!process.env.OPENPIPAL_DECK_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/render-fullpage'
const DATA_DIR = '.openpipal'

const TASK = [
  '在当前工作目录写一个 report.html：一篇讲「OpenPipal 是什么」的长文网页，至少 8 个 <section>，每节 150 字以上正文，',
  '普通的可上下滚动网页（不要 deck-stage、不要幻灯片、不要 create_artifact）。',
  '写完用 render_artifact 自检一次，然后把文件路径和你从截图里看到的东西告诉我。'
].join('')

const pngSize = (file: string): { width: number; height: number } => {
  const buf = readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

test.describe('render_artifact：长页截整页', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('可滚动长页的自检截图是整页，不是首屏', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-render-fullpage-'))
    const work = join(home, 'report-work')
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

    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3138' } })
    const proc = app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    try {
      const page = await app.firstWindow()
      page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })

      // 通用角色（欢迎页默认），只设工作目录和自动档
      await page.evaluate((dir: string) => {
        const state = (window as unknown as {
          __chatStore?: { getState(): { setConversationWorkingDir(d: string): void; setConversationPermissionTier(t: string): void } }
        }).__chatStore?.getState()
        state?.setConversationWorkingDir(dir)
        state?.setConversationPermissionTier('auto')
      }, work)
      const setDir = await page.evaluate(() => (window as unknown as {
        __chatStore?: { getState(): { conversationConfig?: { workingDir?: string } } }
      }).__chatStore?.getState().conversationConfig?.workingDir)
      expect(setDir, '工作目录没设上').toBe(work)

      const preflow = page.locator('[data-testid="preflow-input"]')
      const usePreflow = await preflow.count() > 0
      const input = usePreflow ? preflow.first() : page.locator('textarea').first()
      await input.waitFor({ state: 'visible', timeout: 60_000 })
      await input.fill(TASK)
      await (usePreflow ? page.locator('[data-testid="preflow-start-btn"]') : page.locator('[data-testid="send-btn"]')).first().click()

      const deadline = Date.now() + 10 * 60 * 1000
      const allowed: string[] = []
      const denied: string[] = []
      const isHomeScan = (card: string): boolean => /遍历主目录|全盘|find \/Users|find ~|find \/ /.test(card)
      void drivePermissions(page, allowed, deadline, isHomeScan, denied).catch(() => undefined)
      await waitForTurn(page, deadline)
      await page.screenshot({ path: join(ARTIFACTS, '01-turn-done.png'), fullPage: true })
      for (let round = 0; round < 2 && !existsSync(join(work, 'report.html')); round++) {
        say(`[追问] 第 ${round + 1} 轮：文件还没写出来，回一句「按默认做」`)
        await send(page, '不用问了，按你的默认判断做，直接把 report.html 写到工作目录并用 render_artifact 自检。')
        await waitForTurn(page, deadline)
      }

      const trail = await toolTrail(page)
      for (const t of trail) say(`[tool] ${t.toolName}: ${t.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const c of denied) say(`[拒绝] ${c}`)
      say(`[回话] ${(await lastReply(page)).slice(0, 800)}`)
      say(`[工具序列] ${trail.map(t => t.toolName).join(' → ')}`)

      expect(denied, '模型去全盘/主目录 find 了').toEqual([])
      expect(existsSync(join(work, 'report.html')), 'report.html 没写出来').toBe(true)
      const renders = trail.filter(t => t.toolName === 'render_artifact')
      expect(renders.length, '模型没调 render_artifact').toBeGreaterThan(0)
      const first = renders[0].content
      expect(first, 'render_artifact 结果没写成整页').toMatch(/整页 1280×\d+/)
      // 长页按 ≤1200 高切段随结果附上；一张缩成整图会超上限被跳过，模型只好自己 cp 出来裁（2026-09-11 实撞）
      expect(first, '整页截图没切段附上').toMatch(/自上而下切成 \d+ 段/)
      expect(first).toContain('已随本结果附上——看图核对版式')
      expect(first).not.toContain('只附上了前')
      // 一次最多 5400 高；结果说"N 以下没截到"时，模型该像翻页验收一样传 scroll_y 接着看（用户 2026-09-12 定的做法）
      const cut = renders.find(r => /(\d+) 以下没截到/.test(r.content))
      if (cut) {
        const next = Number(cut.content.match(/传 scroll_y: (\d+)/)?.[1])
        say(`[截断] ${cut.content.match(/页面总高 \d+，\d+ 以下没截到/)?.[0]} → 期待续截 scroll_y=${next}`)
        expect(renders.some(r => r.content.includes(`本段 ${next}–`)), `结果说 ${next} 以下没截到，模型没传 scroll_y 接着看`).toBe(true)
      } else {
        say('[截断] 页面没超过 5400，本次没触发续截')
      }

      // 截图落本会话的产物目录 outputs/<会话id>/.self-check/（2026-09-12 起），根下的 .self-check 是老布局
      const outputsRoot = join(data, 'outputs')
      const convDirs = existsSync(outputsRoot)
        ? readdirSync(outputsRoot, { withFileTypes: true }).filter(d => d.isDirectory() && /^[0-9a-f-]{36}$/i.test(d.name)).map(d => join(outputsRoot, d.name))
        : []
      say(`[产物目录] ${convDirs.join(', ') || '（无会话目录）'}`)
      expect(convDirs, 'outputs 下没有按会话分的目录').not.toEqual([])
      expect(existsSync(join(outputsRoot, '.self-check')), '截图落回了 outputs 根下的老位置').toBe(false)
      const shotDir = join(convDirs[0], '.self-check')
      const pngs = existsSync(shotDir) ? readdirSync(shotDir).filter(f => f.endsWith('.png')) : []
      expect(pngs, '.self-check 里没有 PNG').not.toEqual([])
      const sizes = pngs.map(f => ({ f, ...pngSize(join(shotDir, f)) }))
      for (const s of sizes) say(`[截图] ${s.f} ${s.width}x${s.height}`)
      // 2× Retina 下首屏是 1280×900 → 2560×1800；整页至少要明显长过一屏（1× 屏也成立：> 900）
      const tallest = Math.max(...sizes.map(s => s.height / (s.width / 1280)))
      expect(tallest, '截图高度没超过一屏，整页没截到').toBeGreaterThan(1300)
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
