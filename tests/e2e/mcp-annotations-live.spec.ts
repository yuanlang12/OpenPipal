import { expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * 真机验收：MCP 工具按服务器自述的协议注解分级（2026-09-12，add14f6）。
 * 起一个带注解的最小 MCP 服务器（tests/fixtures/mcp-notes-server.mjs），让模型经 mcp_execute 调它：
 *   list_notes（readOnlyHint）  → 不弹确认
 *   delete_note（destructiveHint）→ 弹"可能删除或覆盖数据"的高风险确认
 * 判据落在服务器自己的调用日志、主进程日志和权限卡文案，不靠模型措辞。
 *   OPENPIPAL_INSTALLED_LIVE=1 OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test mcp-annotations-live
 *   OPENPIPAL_DECK_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build）
 */
const LIVE = !!process.env.OPENPIPAL_INSTALLED_LIVE
const DEV = !!process.env.OPENPIPAL_DECK_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/mcp-annotations'
const DATA_DIR = '.openpipal'
const SERVER_SCRIPT = resolve('tests/fixtures/mcp-notes-server.mjs')

const TASK = [
  '用 mcp_execute 调 notes 这个 MCP 服务器：先 list_notes 列出全部笔记，',
  '然后 delete_note 删掉标题以「草稿」开头的那条，最后再 list_notes 一次确认。',
  '把删之前和删之后的清单都告诉我。'
].join('')

test.describe('MCP 注解分级：只读免确认，删除弹高风险确认', () => {
  test.skip(!LIVE, '驱动装机版、真调模型，默认不跑')
  test.setTimeout(12 * 60 * 1000)

  test('list_notes 不弹卡，delete_note 弹 destructiveHint 高风险卡', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    const home = await mkdtemp(join(tmpdir(), 'openpipal-mcp-annotations-'))
    const work = join(home, 'notes-work')
    mkdirSync(work, { recursive: true })
    const data = join(home, DATA_DIR)
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'config.json'), JSON.stringify({
      configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, modelConfig
    }, null, 2), 'utf8')
    mkdirSync(ARTIFACTS, { recursive: true })
    const callLog = resolve(ARTIFACTS, 'calls.log')
    rmSync(callLog, { force: true })
    // 用户级 MCP 配置：主进程用 process.execPath 之外的 node 起 stdio 服务器，env 原样透传
    writeFileSync(join(data, 'mcp-servers.json'), JSON.stringify({
      notes: { command: process.execPath, args: [SERVER_SCRIPT], env: { NOTES_CALL_LOG: callLog } }
    }, null, 2), 'utf8')
    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }
    say(`起跑 模型=${(modelConfig as { model?: string })?.model} 工作目录=${work}`)

    const mainLog: string[] = []
    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3140' } })
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

      // 等 notes 服务器真连上（用户级 server 排在内置 server 批次之后，内置的 npx 冷缓存要几秒）
      await expect.poll(() => mainLog.some(l => l.includes('[MCP] notes 已连接')), { timeout: 120_000, message: 'notes 服务器没连上' }).toBe(true)
      const connected = mainLog.find(l => l.includes('[MCP] notes 已连接')) || ''
      expect(connected, '工具清单不对').toContain('list_notes')
      expect(connected).toContain('delete_note')

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

      const calls = (): string[] => existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : []
      for (let round = 0; round < 2 && !calls().some(l => l.startsWith('delete_note')); round++) {
        say(`[追问] 第 ${round + 1} 轮：还没删，回一句「按默认做」`)
        await send(page, '不用问了，按你的默认判断做：用 mcp_execute 调 notes 服务器，list_notes → delete_note 删「草稿」那条 → list_notes。')
        await waitForTurn(page, deadline)
      }

      const trail = await toolTrail(page)
      for (const t of trail) say(`[tool] ${t.toolName}: ${t.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const c of allowed) say(`[允许] ${c}`)
      for (const c of denied) say(`[拒绝] ${c}`)
      say(`[服务器调用] ${calls().join(' → ')}`)
      say(`[回话] ${(await lastReply(page)).slice(0, 800)}`)
      say(`[工具序列] ${trail.map(t => t.toolName).join(' → ')}`)

      expect(denied, '有权限卡被拒').toEqual([])
      expect(trail.some(t => t.toolName === 'mcp_execute'), '模型没走 mcp_execute').toBe(true)

      // 服务器自己的账：先列、再删 n2、再列
      const seq = calls()
      expect(seq, '服务器没收到 list_notes').toContain('list_notes')
      const deleteAt = seq.findIndex(l => l.startsWith('delete_note'))
      expect(deleteAt, '服务器没收到 delete_note').toBeGreaterThan(-1)
      expect(seq[deleteAt], '删错了笔记').toBe('delete_note n2')
      expect(seq.slice(0, deleteAt), '删之前没先列').toContain('list_notes')

      // 主进程：只有 delete_note 走了确认，理由是服务器自述的 destructiveHint；list_notes 一次都没问
      const waited = mainLog.filter(l => l.includes('[MCP] sandbox call:') && l.includes('等待用户确认'))
      for (const w of waited) say(`[主进程确认] ${w}`)
      expect(waited.some(l => l.includes('delete_note') && l.includes('destructiveHint')), 'delete_note 没按 destructiveHint 走确认').toBe(true)
      expect(waited.some(l => l.includes('list_notes')), 'list_notes（readOnlyHint）不该弹确认').toBe(false)
      expect(waited.some(l => l.includes('远程 MCP 工具需确认')), '注解没读到，退回了"远程 MCP 工具需确认"').toBe(false)

      // 权限卡：文案带 destructiveHint，且是红色高风险卡（理由含"删除"）
      const deleteCards = allowed.filter(c => c.includes('destructiveHint'))
      expect(deleteCards, '没弹出 destructiveHint 的权限卡').not.toEqual([])
      expect(deleteCards[0]).toContain('需要确认：高风险操作')
      expect(deleteCards[0]).toContain('Delete Note')
      expect(allowed.some(c => c.includes('list_notes') || c.includes('List Notes')), 'list_notes 弹了卡').toBe(false)
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
