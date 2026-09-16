import { expect, test } from '@playwright/test'
import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn, type StoreWindow } from './live-helpers'

/**
 * 组建团队 = 跟组长聊（真模型）：点 ＋ → 跟默认组长说清团队做什么、要哪些角色 →
 * 组长用 manage_team 起名、写章程、建成员——一句话过去，team.md 与 agents/ 里就该有东西。
 * 验：团队名不再是「新团队」、章程非空、名单 ≥ 3（组长 + 两个新成员）、左栏团队行显示新名字。
 *
 * 真调模型 = 花钱，默认不跑：OPENPIPAL_HOOKS_LIVE=1 npx playwright test team-founding-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const ARTIFACTS = 'tests/artifacts/team-founding-live'
const REQUEST = '我们是初中物理教研组，团队就叫"物理教研组"。需要两个成员：一个出题 Pal（专门出练习题，题目短、答案明确），一个批改 Pal（批作业，给分要有依据）。规矩：练习题先出后审，产物都放共享文件夹。请把名字、章程、成员都建好，建完告诉我名单。'

test.describe('组建团队（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_HOOKS_LIVE=1 npx playwright test team-founding-live')
  test.setTimeout(12 * 60 * 1000)

  let app: IsolatedElectron | null = null

  test.afterEach(async () => {
    if (app) {
      for (const rel of ['conversations', 'teams', 'agents']) {
        await cp(join(app.home, '.openpipal', rel), join(ARTIFACTS, rel), { recursive: true }).catch(() => undefined)
      }
    }
    await app?.dispose()
    app = null
  })

  test('点 ＋ → 一句话说清团队 → 组长起名、写章程、建成员', async ({}) => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object }, env: { OPENPIPAL_HTTP_PORT: '3136' } })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    const proc = app.app.process()
    const mainLog: string[] = []
    proc.stdout?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:out] ${line}`) })
    proc.stderr?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:err] ${line}`) })
    say(`模型 ${(modelConfig as { model?: string }).model}`)

    const deadline = Date.now() + 10 * 60 * 1000
    const permissions: string[] = []
    const driver = drivePermissions(page, permissions, deadline)

    // 左栏「团队」标题旁的 ＋：不弹窗，直接开一条跟组长的话题
    await expect(page.getByTestId('sidebar-create-team')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('sidebar-create-team').click()
    await expect(page.getByTestId('team-dialog')).toHaveCount(0)
    await expect(page.getByTestId('team-badge')).toHaveText(/新团队/, { timeout: 30_000 })
    await expect(page.getByTestId('team-onboarding')).toContainText('团队刚成立')
    await page.screenshot({ path: join(ARTIFACTS, '01-founding-empty.png') })

    await send(page, REQUEST)
    await waitForTurn(page, deadline)
    const trail = await toolTrail(page)
    const reply = await lastReply(page)
    say(`工具轨迹：${trail.map(t => `${t.toolName}:${t.content.slice(0, 100).replace(/\s+/g, ' ')}`).join(' | ')}`)
    say(`组长回话：${reply.slice(0, 500)}`)
    await page.screenshot({ path: join(ARTIFACTS, '02-after-founding.png') })

    // 磁盘上的事实：team.md 改了名、有章程、名单 ≥ 3
    const teamsRoot = join(app.home, '.openpipal', 'teams')
    const [teamId] = await readdir(teamsRoot)
    const teamMd = await readFile(join(teamsRoot, teamId, 'team.md'), 'utf8')
    say(`team.md：\n${teamMd}`)
    expect(trail.some(t => t.toolName === 'manage_team'), '组长没有用 manage_team').toBe(true)
    expect(teamMd, '团队还叫「新团队」——组长没改名').toMatch(/^name: 物理教研组$/m)
    const members = teamMd.match(/^members: (.+)$/m)?.[1].split(',').map(s => s.trim()).filter(Boolean) ?? []
    expect(members.length, `名单只有 ${members.length} 人：${members.join(', ')}`).toBeGreaterThanOrEqual(3)
    const charter = teamMd.split(/^---$/m).slice(2).join('').trim()
    expect(charter.length, '章程是空的').toBeGreaterThan(10)
    // 新成员是普通 Pal：agents/ 下有目录、有人设；头像是捏出来的（mark.json），不是 emoji
    for (const id of members) {
      const agentMd = await readFile(join(app.home, '.openpipal', 'agents', id, 'agent.md'), 'utf8').catch(() => '')
      expect(agentMd.length, `成员 ${id} 没有人设`).toBeGreaterThan(5)
      const mark = JSON.parse(await readFile(join(app.home, '.openpipal', 'agents', id, 'mark.json'), 'utf8').catch(() => 'null'))
      expect(mark, `成员 ${id} 没有捏好的头像`).toMatchObject({ accessory: expect.any(String), hue: expect.any(String), shape: expect.any(String) })
      say(`成员 ${id.slice(0, 8)} 头像：${mark.accessory} / ${mark.hue} / ${mark.shape}`)
    }
    // 团队话题里没有通用子 agent：组建过程中不该出现没有 pal 的 subagent 调用
    expect(trail.filter(t => t.toolName === 'subagent' && /只做交接/.test(t.content)), '组长试图派通用子 agent').toHaveLength(0)
    // 左栏团队行显示新名字（话题跑完自动刷新）
    await expect(page.getByTestId('sidebar-teams').locator('[data-testid="sidebar-team"]').first()).toContainText('物理教研组', { timeout: 15_000 })
    await expect(page.getByTestId('team-badge')).toHaveText(/物理教研组/)

    // 话题跑完的自动整理落团队记忆。整理引擎看的是请求里的历史（上一轮的回话 + 这一轮的问），第二轮起才有 ≥2 条，
    // 所以再聊一句让它跑起来；模型决定记不记，只硬断言"跑了、走的团队路径、没写进组长私人记忆"
    await send(page, '就这样定了。再记一条团队规矩：以后练习题都必须带答案和一两句解析。')
    await waitForTurn(page, deadline)
    say(`第二轮回话：${(await lastReply(page)).slice(0, 300)}`)
    const dreamDeadline = Date.now() + 90_000
    while (Date.now() < dreamDeadline && !mainLog.some(l => l.includes('[AgentDreamer]'))) await new Promise(r => setTimeout(r, 1000))
    const dreamLines = mainLog.filter(l => l.includes('[AgentDreamer]'))
    say(`整理引擎：${dreamLines.join(' | ') || '（90 秒内没跑完）'}`)
    expect(dreamLines.length, '话题跑完后整理引擎没有跑').toBeGreaterThan(0)
    expect(dreamLines[0], '整理引擎没走团队路径').toContain('团队')
    const teamMemories = (await readdir(join(teamsRoot, teamId, 'memory')).catch(() => [] as string[])).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    const leadMemories = (await readdir(join(app.home, '.openpipal', 'agents', members[0], 'memory')).catch(() => [] as string[])).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    say(`团队记忆：${teamMemories.join(', ') || '（无）'}；组长私人记忆：${leadMemories.join(', ') || '（无）'}`)
    expect(leadMemories, '团队话题的整理写到了组长私人记忆').toHaveLength(0)
    // 引擎真写了才有胶囊（组长自己用 write 记的那条不算引擎的）
    if (dreamLines.some(l => /\d+ memories/.test(l))) await expect(page.getByTestId('team-memory-notice')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(ARTIFACTS, '03-after-dreaming.png') })

    say(`权限卡 ${permissions.length} 张：${permissions.join(' | ')}`)
    await Promise.race([driver, new Promise(r => setTimeout(r, 100))])
  })
})
