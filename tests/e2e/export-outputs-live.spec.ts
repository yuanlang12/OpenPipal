import { expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * 真机验收：模型产物按会话分目录（outputs/<会话id>/，2026-09-12）。
 * export_artifact 的 PDF、generate_document 的 Markdown 都要落本会话目录，结果里带路径；
 * 模型 ls 自己的产物目录不被拦（以前 outputs 下任何目录都拦，模型只好猜路径）。
 *   OPENPIPAL_INSTALLED_LIVE=1 OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test export-outputs-live
 *   OPENPIPAL_DECK_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build）
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const DEV = !!process.env.OPENPIPAL_DECK_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/export-outputs'
const DATA_DIR = '.openpipal'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TASK = [
  '用 create_artifact 做一页「OpenPipal 是什么」的 HTML 说明页（html 类型，正文 300 字左右），',
  '然后用 export_artifact 把它导出成 pdf；再用 generate_document 生成一份 200 字左右的 Markdown 摘要。',
  '最后用 bash ls 一下你的产物目录，把目录里有什么、以及两份文件的完整路径告诉我。'
].join('')

test.describe('export_artifact / generate_document：产物落本会话目录', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('PDF 与 Markdown 都落 outputs/<会话id>/，模型 ls 自己的目录不被拦', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-export-outputs-'))
    const work = join(home, 'export-work')
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

    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3139' } })
    const proc = app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    try {
      const page = await app.firstWindow()
      page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })

      await page.evaluate((dir: string) => {
        const state = (window as unknown as {
          __chatStore?: { getState(): { setConversationWorkingDir(d: string): void; setConversationPermissionTier(t: string): void } }
        }).__chatStore?.getState()
        state?.setConversationWorkingDir(dir)
        state?.setConversationPermissionTier('auto')
      }, work)

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

      const outputsRoot = join(data, 'outputs')
      const convDirs = (): string[] => existsSync(outputsRoot)
        ? readdirSync(outputsRoot, { withFileTypes: true }).filter(d => d.isDirectory() && UUID_RE.test(d.name)).map(d => d.name)
        : []
      for (let round = 0; round < 2 && convDirs().length === 0; round++) {
        say(`[追问] 第 ${round + 1} 轮：还没导出，回一句「按默认做」`)
        await send(page, '不用问了，按你的默认判断做：create_artifact → export_artifact(pdf) → generate_document，然后 ls 产物目录把路径告诉我。')
        await waitForTurn(page, deadline)
      }

      const trail = await toolTrail(page)
      for (const t of trail) say(`[tool] ${t.toolName}: ${t.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const c of denied) say(`[拒绝] ${c}`)
      say(`[回话] ${(await lastReply(page)).slice(0, 800)}`)
      say(`[工具序列] ${trail.map(t => t.toolName).join(' → ')}`)

      expect(denied, '有权限卡被拒（模型去扫主目录了）').toEqual([])
      const dirs = convDirs()
      say(`[产物目录] ${dirs.join(', ') || '（无）'}`)
      expect(dirs, 'outputs 下没有按会话分的目录').toHaveLength(1)
      const own = join(outputsRoot, dirs[0])
      const files = readdirSync(own).filter(f => !f.startsWith('.'))
      say(`[目录内容] ${files.join(', ')}`)
      expect(files.some(f => f.endsWith('.pdf')), 'PDF 没落本会话目录').toBe(true)
      expect(files.some(f => f.endsWith('.md')), 'Markdown 没落本会话目录').toBe(true)
      // 根下不能再新增模型产物（老布局）
      const rootFiles = readdirSync(outputsRoot, { withFileTypes: true }).filter(d => d.isFile() && !d.name.startsWith('.')).map(d => d.name)
      expect(rootFiles, 'outputs 根下出现了模型产物（老布局）').toEqual([])

      // 工具结果里带的路径就是这个目录
      const exportResult = trail.find(t => t.toolName === 'export_artifact' && t.content.includes('已导出'))
      expect(exportResult, 'export_artifact 没有成功结果').toBeTruthy()
      expect(exportResult!.content).toContain(own)
      const docResult = trail.find(t => t.toolName === 'generate_document' && t.content.includes('保存位置'))
      expect(docResult, 'generate_document 没有成功结果').toBeTruthy()
      expect(docResult!.content).toContain(own)

      // 模型 ls 自己的目录：至少有一次 bash 结果里列出了 pdf 文件名，且没有"禁止枚举"
      const pdfName = files.find(f => f.endsWith('.pdf'))!
      const lsHit = trail.some(t => t.toolName === 'bash' && t.content.includes(pdfName))
      const blocked = trail.filter(t => t.content.includes('禁止枚举'))
      for (const b of blocked) say(`[被拦] ${b.toolName}: ${b.content.slice(0, 200)}`)
      expect(blocked, '模型列自己的产物目录被拦了').toEqual([])
      expect(lsHit, '没有一次 bash 结果列出了产物目录里的 PDF').toBe(true)

      // 模型回话里带路径
      expect(await lastReply(page)).toContain(dirs[0])
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
