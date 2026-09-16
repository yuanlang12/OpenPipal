import { expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn, type StoreWindow } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * 真机验收：模型用 bash 直接改产物文件不再被拦，改由产物库对账（2026-09-12）。
 * 判据：bash 没被"artifact 内容必须走 edit_artifact"挡下；磁盘上的产物文件真改了；bash 结果尾部
 * 附了"已按磁盘内容同步到产物面板"；主进程记了对账日志；对话里多了一条挂着同一产物的锚点消息
 * （渲染端收到 artifact 事件的落点，说明面板拿到了新内容）。
 *   OPENPIPAL_INSTALLED_LIVE=1 OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test sidecar-reconcile-live
 *   OPENPIPAL_DECK_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build）
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const DEV = !!process.env.OPENPIPAL_DECK_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/sidecar-reconcile'
const DATA_DIR = '.openpipal'

const TASK = [
  '用 create_artifact 做一个 html 类型的小页面，标题「对账测试」，正文里有一行原文「版本一」。',
  '做好之后不要用 edit_artifact：用 bash 的 sed -i 直接把产物文件里的「版本一」改成「版本二」',
  '（产物文件的完整路径在 create_artifact 的结果里）。最后把 bash 结果里系统附加的那句话原样告诉我。'
].join('')

test.describe('产物库直写对账：bash 改产物文件不拦、面板同步', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('sed -i 改产物文件 → 不拦、磁盘改了、结果附对账、对话多一条锚点', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-sidecar-reconcile-'))
    const work = join(home, 'reconcile-work')
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
    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3141' } })
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

      // 渲染端存的是 sed 的输出（-i 没输出），看不到命令本身：只要跑过 bash 就算做了
      const bashRan = async (): Promise<boolean> => (await toolTrail(page)).some(t => t.toolName === 'bash')
      for (let round = 0; round < 2 && !(await bashRan()); round++) {
        say(`[追问] 第 ${round + 1} 轮：还没用 bash 改文件，回一句「按默认做」`)
        await send(page, '不用问了：直接用 bash 的 sed -i 把那个产物文件里的「版本一」改成「版本二」，然后把结果里系统附加的话告诉我。')
        await waitForTurn(page, deadline)
      }

      const trail = await toolTrail(page)
      for (const t of trail) say(`[tool] ${t.toolName}: ${t.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const c of allowed) say(`[允许] ${c}`)
      for (const c of denied) say(`[拒绝] ${c}`)
      say(`[回话] ${(await lastReply(page)).slice(0, 800)}`)
      say(`[工具序列] ${trail.map(t => t.toolName).join(' → ')}`)
      for (const l of mainLog.filter(l => l.includes('[Artifacts]'))) say(`[对账日志] ${l}`)

      expect(denied, '有权限卡被拒').toEqual([])
      // 没有一次被老规则挡下
      const blocked = trail.filter(t => t.content.includes('artifact 内容必须走'))
      expect(blocked, 'bash 直写 sidecar 仍被拦').toEqual([])

      // 渲染端存的 create_artifact 结果是展示版（"预览: 标题 (id: …)"），路径要按 id 去 sidecar 目录找
      const created = trail.find(t => t.toolName === 'create_artifact' && /\(id: artifact-/.test(t.content))
      expect(created, 'create_artifact 没有带 id 的结果').toBeTruthy()
      const artifactId = created!.content.match(/\(id: (artifact-[\w-]+)\)/)?.[1] || ''
      const artifactsRoot = join(data, 'conversations', 'artifacts')
      const file = (existsSync(artifactsRoot) ? readdirSync(artifactsRoot) : [])
        .flatMap(conv => {
          const dir = join(artifactsRoot, conv)
          return existsSync(dir) && statSync(dir).isDirectory()
            ? readdirSync(dir).filter(f => f.startsWith(`${artifactId}.`) && !f.endsWith('.compiled.js')).map(f => join(dir, f))
            : []
        })[0] || ''
      say(`[产物] id=${artifactId} 文件=${file}`)
      expect(existsSync(file), '产物文件不存在').toBe(true)
      const onDisk = readFileSync(file, 'utf8')
      expect(onDisk, '磁盘上的产物没被改成版本二').toContain('版本二')
      expect(onDisk).not.toContain('版本一')

      // bash 结果尾部附了对账的那句事实；主进程记了对账日志
      const reconciledNote = trail.find(t => t.toolName === 'bash' && t.content.includes('已按磁盘内容同步到产物面板'))
      expect(reconciledNote, 'bash 结果没附"已按磁盘内容同步到产物面板"').toBeTruthy()
      expect(reconciledNote!.content).toContain(artifactId)
      expect(mainLog.some(l => l.includes('[Artifacts]') && l.includes('直写对账') && l.includes(artifactId)), '主进程没记对账日志').toBe(true)

      // 渲染端收到 artifact 事件的落点：对话里多了一条挂着同一产物的锚点（原 create_artifact 之外再一条）
      const anchors = await page.evaluate((id: string) => {
        const msgs = (window as StoreWindow).__chatStore?.getState().messages || []
        return msgs.filter(m => m.role === 'tool' && (m as { artifactRef?: { id?: string } }).artifactRef?.id === id).length
      }, artifactId)
      say(`[锚点数] ${anchors}`)
      expect(anchors, '对话里没有第二条产物锚点，面板没拿到直写后的内容').toBeGreaterThanOrEqual(2)
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
