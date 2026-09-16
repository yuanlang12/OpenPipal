import { expect, test } from '@playwright/test'
import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'

/**
 * 一个团队从零到干活的真实场景（真模型，一条链走完）：
 *   1. 点 ＋ 组建 → 一句话说清团队 → 组长起名、写章程、建出题 / 批改两个成员
 *   2. 同一条话题里派活 → 组长交接给刚建的出题专家 → 成员把练习题写进共享文件夹 → 组长回报路径
 *   3. 让组长把一条规矩写进团队记忆 → teams/<id>/memory/ 里多一个带 frontmatter 的文件
 *   4. 在这个团队开第二条话题 → 组长靠"频道最近话题"索引 + 共享文件夹 + 团队记忆索引，答出上次的题在哪、规矩是什么
 *
 * 真调模型 = 花钱，默认不跑：OPENPIPAL_HOOKS_LIVE=1 npx playwright test team-scenario-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const ARTIFACTS = 'tests/artifacts/team-scenario-live'

const FOUNDING = '我们是初中物理教研组，团队就叫"物理教研组"。需要两个成员：出题专家（专门出练习题，题目短、答案明确）和批改专家（批作业，给分要有依据）。规矩：练习题先出后审，产物都放共享文件夹。把名字、章程、成员都建好，建完告诉我名单。'
const TASK = '现在派第一个活：让出题专家出 2 道关于牛顿第一定律的选择题（带答案），写到团队共享文件夹里的 练习题.md。做完把文件的完整路径告诉我。'
const REMEMBER = '记住一条团队规矩：以后所有练习题都必须带答案和一两句解析。把它写进团队记忆。'
const RECALL = '上一条话题里出的练习题文件在哪？把第 1 题原样贴给我。另外团队记忆里对练习题有什么要求？'

test.describe('团队真实场景（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_HOOKS_LIVE=1 npx playwright test team-scenario-live')
  test.setTimeout(20 * 60 * 1000)

  let app: IsolatedElectron | null = null

  test.afterEach(async () => {
    if (app) {
      for (const rel of ['conversations', 'teams', 'agents', 'audit.log']) {
        await cp(join(app.home, '.openpipal', rel), join(ARTIFACTS, rel), { recursive: true }).catch(() => undefined)
      }
    }
    await app?.dispose()
    app = null
  })

  test('组建 → 派活交接 → 写团队记忆 → 新话题里靠索引找回上次的产物与规矩', async ({}) => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object }, env: { OPENPIPAL_HTTP_PORT: '3137' } })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    const proc = app.app.process()
    const mainLog: string[] = []
    proc.stdout?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:out] ${line}`) })
    proc.stderr?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:err] ${line}`) })
    say(`模型 ${(modelConfig as { model?: string }).model}`)

    const deadline = Date.now() + 18 * 60 * 1000
    const permissions: string[] = []
    const denied: string[] = []
    const driver = drivePermissions(page, permissions, deadline, text => /find \/|find ~/.test(text), denied)
    const step = async (label: string, text: string): Promise<{ trail: Array<{ toolName: string; content: string }>; reply: string }> => {
      await send(page, text)
      await waitForTurn(page, deadline)
      const trail = await toolTrail(page)
      const reply = await lastReply(page)
      say(`[${label}] 工具轨迹：${trail.map(t => `${t.toolName}:${t.content.slice(0, 90).replace(/\s+/g, ' ')}`).join(' | ')}`)
      say(`[${label}] 回话：${reply.slice(0, 600)}`)
      return { trail, reply }
    }

    // 1. 组建
    await expect(page.getByTestId('sidebar-create-team')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('sidebar-create-team').click()
    await expect(page.getByTestId('team-badge')).toHaveText(/新团队/, { timeout: 30_000 })
    await step('组建', FOUNDING)
    const teamsRoot = join(app.home, '.openpipal', 'teams')
    const [teamId] = await readdir(teamsRoot)
    const teamDir = join(teamsRoot, teamId)
    let teamMd = await readFile(join(teamDir, 'team.md'), 'utf8')
    expect(teamMd, '组长没改名').toMatch(/^name: 物理教研组$/m)
    const members = teamMd.match(/^members: (.+)$/m)?.[1].split(',').map(s => s.trim()) ?? []
    expect(members.length, `名单只有 ${members.length} 人`).toBeGreaterThanOrEqual(3)
    await expect(page.getByTestId('team-badge')).toHaveText(/物理教研组/, { timeout: 15_000 })
    await page.screenshot({ path: join(ARTIFACTS, '01-founded.png') })

    // 2. 同一条话题里派活：交接给刚建的出题专家
    const task = await step('派活', TASK)
    const handoffs = mainLog.filter(l => l.includes('[Team] 交接 →'))
    say(`交接日志：${handoffs.join(' | ') || '（无）'}`)
    expect(handoffs.length, '组长没有交接给成员').toBeGreaterThan(0)
    expect(task.trail.some(t => t.toolName === 'subagent' && !/执行失败|不是本团队可交接/.test(t.content)), '工具轨迹里没有成功的交接').toBe(true)
    const shared = await readdir(join(teamDir, 'shared')).catch(() => [] as string[])
    say(`共享文件夹：${shared.join(', ') || '（空）'}`)
    const exercise = shared.find(f => f.endsWith('.md'))
    expect(exercise, '共享文件夹里没有练习题').toBeTruthy()
    const exerciseBody = await readFile(join(teamDir, 'shared', exercise!), 'utf8')
    expect(exerciseBody).toContain('牛顿')
    await page.screenshot({ path: join(ARTIFACTS, '02-handoff.png') })

    // 3. 写团队记忆
    await step('记规矩', REMEMBER)
    const memoryFiles = (await readdir(join(teamDir, 'memory')).catch(() => [] as string[])).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    say(`团队记忆：${memoryFiles.join(', ') || '（无）'}`)
    expect(memoryFiles.length, '团队记忆目录里没有新文件').toBeGreaterThan(0)
    const memoryBody = await readFile(join(teamDir, 'memory', memoryFiles[0]), 'utf8')
    expect(memoryBody, '记忆文件没有 frontmatter description').toMatch(/^description:/m)
    expect(memoryBody).toMatch(/解析/)
    await page.screenshot({ path: join(ARTIFACTS, '03-memory.png') })

    // 4. 新话题：靠索引找回
    const teamRow = page.getByTestId('sidebar-teams').locator('[data-testid="sidebar-team"]').first()
    await teamRow.hover()
    await teamRow.getByTestId('team-new-thread').click()
    await expect(page.getByTestId('team-onboarding')).toBeVisible({ timeout: 15_000 })
    const recall = await step('新话题', RECALL)
    expect(recall.reply, '新话题里没找回上次的题').toMatch(/牛顿/)
    expect(recall.reply, '新话题里没说出团队记忆里的规矩').toMatch(/解析/)
    expect(recall.reply, '没有给出练习题的路径').toMatch(/练习题|shared/)
    await page.screenshot({ path: join(ARTIFACTS, '04-recall.png') })

    // 边界：没人去搜盘；越界尝试只记数
    expect(denied, `模型迷路去搜盘了：${denied.join(' | ')}`).toHaveLength(0)
    const audit = await readFile(join(app.home, '.openpipal', 'audit.log'), 'utf8').catch(() => '')
    const crossing = audit.split('\n').filter(l => /其他 Agent 的工作区|其他团队/.test(l))
    say(`审计里被拦下的越界尝试：${crossing.length}${crossing.length ? `：${crossing.slice(0, 3).join(' | ')}` : ''}`)
    teamMd = await readFile(join(teamDir, 'team.md'), 'utf8')
    say(`最终 team.md：\n${teamMd}`)
    say(`权限卡 ${permissions.length} 张：${permissions.join(' | ')}`)
    await Promise.race([driver, new Promise(r => setTimeout(r, 100))])
  })
})
