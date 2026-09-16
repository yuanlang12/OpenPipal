import { expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * 真机验收：eval / exec 从硬拒降成"沙箱在就交用户裁决"（2026-09-12 规则盘点）。
 * 判据：模型跑 `eval "…"` 时弹的是普通确认卡（琥珀色，理由带"转手执行"），不是红卡也不是拒绝；
 * 会话档位设成"完全允许"仍然弹（alwaysConfirm）；点允许后命令真跑了，输出回到模型手里。
 *   OPENPIPAL_INSTALLED_LIVE=1 OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test indirect-exec-live
 *   OPENPIPAL_DECK_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build）
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const DEV = !!process.env.OPENPIPAL_DECK_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/indirect-exec'
const DATA_DIR = '.openpipal'
const MARK = 'hello-from-eval-2026'

const TASK = `用 bash 原样跑这一条命令（不要改写成别的写法）：eval "echo ${MARK}"，然后把输出告诉我。`

test.describe('转手执行：eval 弹普通确认卡，完全允许档也弹', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('eval → 琥珀色确认卡（理由带"转手执行"）→ 允许后命令真跑', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-indirect-exec-'))
    const work = join(home, 'eval-work')
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

    const mainLog: string[] = []
    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3142' } })
    const proc = app.process()
    const onMain = (tag: string) => (d: Buffer): void => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue
        mainLog.push(line)
        say(`[${tag}] ${line.trimEnd()}`)
      }
    }
    proc.stdout?.on('data', onMain('main:out'))
    proc.stderr?.on('data', onMain('main:err'))
    try {
      const page = await app.firstWindow()
      page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })

      // 完全允许档：普通确认不再问，只有 alwaysConfirm 的还问——eval 必须属于后者
      await page.evaluate((dir: string) => {
        const state = (window as unknown as {
          __chatStore?: { getState(): { setConversationWorkingDir(d: string): void; setConversationPermissionTier(t: string): void } }
        }).__chatStore?.getState()
        state?.setConversationWorkingDir(dir)
        state?.setConversationPermissionTier('full')
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

      const evalRan = async (): Promise<boolean> => (await toolTrail(page)).some(t => t.toolName === 'bash' && t.content.includes(MARK))
      for (let round = 0; round < 2 && !(await evalRan()); round++) {
        say(`[追问] 第 ${round + 1} 轮：还没原样跑 eval，再说一次`)
        await send(page, `不要改写，就用 bash 原样执行：eval "echo ${MARK}"`)
        await waitForTurn(page, deadline)
      }

      const trail = await toolTrail(page)
      for (const t of trail) say(`[tool] ${t.toolName}: ${t.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const c of allowed) say(`[允许] ${c}`)
      for (const c of denied) say(`[拒绝] ${c}`)
      say(`[回话] ${(await lastReply(page)).slice(0, 600)}`)
      say(`[工具序列] ${trail.map(t => t.toolName).join(' → ')}`)

      expect(denied, '有权限卡被拒').toEqual([])
      // 没有被老规则硬拒
      const hardBlocked = trail.filter(t => /检测到危险命令|安全策略阻止|已安全阻止/.test(t.content))
      expect(hardBlocked, 'eval 仍被硬拒').toEqual([])
      // 弹了确认卡，理由是转手执行，且是普通卡不是红卡；完全允许档下仍弹 = alwaysConfirm 生效
      const evalCards = allowed.filter(c => c.includes('转手执行'))
      expect(evalCards, '没弹出"转手执行"的确认卡（完全允许档下应仍弹）').not.toEqual([])
      expect(evalCards[0]).toContain('shell eval')
      expect(evalCards[0]).not.toContain('需要确认：高风险操作')
      expect(evalCards[0]).toContain('需要确认')
      // 允许之后命令真跑了
      expect(await evalRan(), 'eval 没跑出输出').toBe(true)
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
