import { expect, test } from '@playwright/test'
import { cp, mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn, type StoreWindow } from './live-helpers'

/**
 * 独立 Pal 整体验收（真模型）——2026-09-09 两个真机实撞的场景，从头到尾走一遍：
 *   1. 在 Pal 里定规则 → 文件落到 Pal 自己的 hooks/（不是 local-rules）→ 胶囊 → 规则页列在这个 Pal 名下
 *      （1.1.3 里写手缺 workspaceId 被租户边界拒，一个文件都写不出来）
 *   2. 在 Pal 里要一个 demo 页面 → 直接出产物，不再借设计助手的 DC 闸门去猜 dc-authoring 的路径、翻目录、要搜全盘
 *      （Pal 以前借的是 App 当时选中的全局角色）
 *   3. 下一轮读文件 → 这条规则确实装进了这个 Pal 的对话（主进程日志「生效 1 条规则：agent:<id>/…」）。
 *      规则本身是提示词型（before_agent_start 加一句"读前先说正在读"），模型听不听是它的事，
 *      强制型规则的拦截效果由 hook-rule-live 验（tool_result 遮名字），这里不重复
 *
 * 真调模型 = 花钱，默认不跑：OPENPIPAL_HOOKS_LIVE=1 npx playwright test pal-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const ARTIFACTS = 'tests/artifacts/pal-live'
const PAL_ID = '7b60beb5-live-4000-8000-000000000001'
const PAL_NAME = '物理教案专家'

const RULE_REQUEST = '以后每次读文件之前，先告诉我一句"正在读：文件名"，再读。这条规则以后一直生效。'
const DEMO_REQUEST = '给我写一个简单的 demo 页面，内容随便，一个标题一段话就行。'

async function preserveEvidence(home: string): Promise<void> {
  for (const rel of ['conversations', 'plugins', 'agents']) {
    await cp(join(home, '.openpipal', rel), join(ARTIFACTS, rel), { recursive: true }).catch(() => undefined)
  }
}

test.describe('独立 Pal 整体验收（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_HOOKS_LIVE=1 npx playwright test pal-live')
  test.setTimeout(15 * 60 * 1000)

  let app: IsolatedElectron | null = null
  let fixture = ''

  test.afterEach(async () => {
    if (app) await preserveEvidence(app.home)
    await app?.dispose()
    app = null
    if (fixture) await rm(fixture, { recursive: true, force: true })
  })

  test('在 Pal 里定规则落到 Pal 自己目录 → 要 demo 页面直接出产物 → 读文件时规则在跑', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()

    fixture = await mkdtemp(join(tmpdir(), 'openpipal-pal-live-'))
    const notes = join(fixture, '教学笔记.md')
    await writeFile(notes, '# 牛顿第一定律\n\n惯性：物体保持原有运动状态的性质。\n', 'utf8')
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object }, env: { OPENPIPAL_HTTP_PORT: '3134' } })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Pal 放进隔离 home：meta + agent.md + 工具配置（工作目录指到夹具，模型读文件不用猜路径）
    const palDir = join(app.home, '.openpipal', 'agents', PAL_ID)
    await mkdir(join(palDir, 'memory'), { recursive: true })
    await mkdir(join(palDir, 'skills'), { recursive: true })
    await mkdir(join(palDir, 'tools'), { recursive: true })
    await writeFile(join(palDir, 'meta.json'), JSON.stringify({ id: PAL_ID, name: PAL_NAME, icon: '📐', description: '初中物理完整教案撰写', createdAt: Date.now(), updatedAt: Date.now() }), 'utf8')
    await writeFile(join(palDir, 'agent.md'), '# 物理教案撰写专家\n\n这是一位专注于初中物理教学的教案撰写 Agent。回答简洁。\n', 'utf8')
    await writeFile(join(palDir, 'tools', 'config.json'), JSON.stringify({ workingDir: fixture }), 'utf8')

    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    const proc = app.app.process()
    const mainLog: string[] = []
    proc.stdout?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:out] ${line}`) })
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
    say(`模型 ${(modelConfig as { model?: string }).model}`)

    const deadline = Date.now() + 13 * 60 * 1000
    const permissions: string[] = []
    const denied: string[] = []
    // 搜全盘 / 翻 ~/.openpipal 就是迷路的征兆：拒掉并记下来，最后当失败判
    const driver = drivePermissions(page, permissions, deadline, text => /find \/|find ~|\.openpipal/.test(text), denied)

    // 用这个 Pal 开一条对话（与「试一下」同一条路，role 槽位由渲染层固定成中性值）
    await page.evaluate(async ({ id, name }) => {
      await (window as StoreWindow).__chatStore!.getState().newConversationFromWorkspace(id, name)
      ;(window as StoreWindow).__appStore!.getState().setActiveView('chat')
    }, { id: PAL_ID, name: PAL_NAME })
    await page.waitForTimeout(1500)

    // ---- 第一轮：定规则，文件必须落在 Pal 自己的 hooks/ ----
    await send(page, RULE_REQUEST)
    await waitForTurn(page, deadline)
    say(`第一轮回话：${(await lastReply(page)).slice(0, 300)}`)
    const notice = page.locator('[data-testid="inject-notice"][data-subtype="hook"]').first()
    await expect(notice, '对话流里没有出现「已定下规则」胶囊（后台没写、或写完没送到渲染层）').toBeVisible({ timeout: 4 * 60_000 })
    await expect(notice).toHaveAttribute('data-hook-state', 'ok', { timeout: 15_000 })
    const palHooks = await readdir(join(palDir, 'hooks')).catch(() => [] as string[])
    const globalHooks = await readdir(join(app.home, '.openpipal', 'plugins', 'local-rules', 'hooks')).catch(() => [] as string[])
    say(`Pal hooks：${palHooks.join(', ') || '（无）'}；local-rules hooks：${globalHooks.join(', ') || '（无）'}`)
    expect(palHooks.filter(f => /\.(ts|js|mjs|cjs)$/.test(f)), '规则没有写到 Pal 自己的 hooks/').not.toHaveLength(0)
    expect(globalHooks.filter(f => /\.(ts|js|mjs|cjs)$/.test(f)), '在 Pal 里定的规则跑到了全局 local-rules').toHaveLength(0)
    await page.screenshot({ path: join(ARTIFACTS, '01-rule-in-pal.png') })

    // 规则页：列在这个 Pal 名下，不在「所有 Pal」里
    await page.evaluate(() => (window as StoreWindow).__appStore!.getState().openToolsHub('rules'))
    const palGroup = page.locator(`[data-rules-group="agent:${PAL_ID}"]`).first()
    await expect(palGroup, '规则页没有把这条规则列在这个 Pal 名下').toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-rules-group="global"]')).toHaveCount(0)
    await page.screenshot({ path: join(ARTIFACTS, '02-rules-tab.png') })
    await page.evaluate(() => (window as StoreWindow).__appStore!.getState().setActiveView('chat'))

    // ---- 第二轮：要 demo 页面，不能去找 dc-authoring、不能搜盘 ----
    await send(page, DEMO_REQUEST)
    await waitForTurn(page, deadline)
    const trail = await toolTrail(page)
    say(`第二轮工具轨迹：${trail.map(t => `${t.toolName}:${t.content.slice(0, 80).replace(/\s+/g, ' ')}`).join(' | ')}`)
    say(`第二轮回话：${(await lastReply(page)).slice(0, 300)}`)
    await page.screenshot({ path: join(ARTIFACTS, '03-demo-page.png') })
    expect(denied, `模型迷路去搜盘 / 翻数据目录了：${denied.join(' | ')}`).toHaveLength(0)
    expect(trail.some(t => /dc-authoring/.test(t.content) && /ENOENT|Cannot resolve/.test(t.content)), '模型又去猜 dc-authoring 的路径了').toBe(false)
    expect(trail.some(t => t.toolName === 'create_artifact' && !/已拒绝/.test(t.content)), '没有产出 demo 页面（create_artifact 没成功）').toBe(true)

    // ---- 第三轮：读文件；这条规则必须装进了这个 Pal 的对话 ----
    await send(page, `读一下 ${notes}，把内容原样给我。`)
    await waitForTurn(page, deadline)
    const reply = await lastReply(page)
    say(`第三轮回话：${reply.slice(0, 300)}`)
    say(`第三轮有没有先说"正在读"：${/正在读/.test(reply) ? '有' : '没有（提示词型规则，看模型）'}`)
    await page.screenshot({ path: join(ARTIFACTS, '04-rule-active.png') })
    const armed = mainLog.filter(l => l.includes('[Hooks] conv=') && l.includes(`agent:${PAL_ID}/`))
    expect(armed, '这条规则没有装进 Pal 的对话（主进程没有「生效 … agent:<id>/…」日志）').not.toHaveLength(0)
    expect(reply).toContain('惯性')

    say(`权限卡 ${permissions.length} 张：${permissions.join(' | ')}`)
    await Promise.race([driver, new Promise(r => setTimeout(r, 100))])
  })
})
