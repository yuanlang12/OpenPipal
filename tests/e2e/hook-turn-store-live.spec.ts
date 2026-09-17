import { expect, test } from '@playwright/test'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { drivePermissions, lastReply, realModelConfig, send, waitForTurn } from './live-helpers'

/**
 * 收工事件（agent_end）+ 规则仓库（ctx.store）真机验收。
 *
 * 单测验的是链和仓库各自的语义；「真 App 里一轮说完 → 规则在收工事件里记账 → 文件真的落在
 * plugin-data 下 → 下一轮开工规则读得到上一轮记的」这条只有真运行时才验得到。判据全落磁盘：
 * 仓库文件的内容（轮数、outcome、这轮说的话），不靠模型措辞——回话只记日志。
 *
 * 真调模型 = 花钱，默认不跑：OPENPIPAL_HOOKS_LIVE=1 npx playwright test hook-turn-store-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const ARTIFACTS = 'tests/artifacts/hook-turn-store-live'

const RULE = `export const description = '数一数聊了几轮'

export default function (hook) {
  hook.on('agent_end', async (event, ctx) => {
    const rounds = ((await ctx.store.get('rounds')) ?? 0) + 1
    await ctx.store.set('rounds', rounds)
    await ctx.store.set('last', {
      outcome: event.outcome,
      prompt: event.prompt,
      tools: event.toolCalls.map((call) => call.toolName),
      replyLength: event.reply.length
    })
  })
  hook.on('before_agent_start', async (event, ctx) => {
    const rounds = (await ctx.store.get('rounds')) ?? 0
    await ctx.store.set('seenAtStart', rounds)
    return { systemPrompt: event.systemPrompt + '\\n\\n<user-rule>这是本会话的第 ' + (rounds + 1) + ' 轮。用户问"这是第几轮"时只答这个数字。</user-rule>' }
  })
}
`

interface StoreShape {
  rounds?: number
  seenAtStart?: number
  last?: { outcome: string; prompt: string; tools: string[]; replyLength: number }
}

async function readStore(file: string): Promise<StoreShape | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StoreShape
  } catch {
    return null
  }
}

/** 收工事件在回话渲染完之后才跑：等仓库文件出现指定轮数 */
async function waitForRounds(file: string, rounds: number, timeoutMs: number): Promise<StoreShape> {
  const deadline = Date.now() + timeoutMs
  let seen: StoreShape | null = null
  while (Date.now() < deadline) {
    seen = await readStore(file)
    if (seen?.rounds === rounds) return seen
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`仓库文件 ${file} 在 ${timeoutMs}ms 内没有变成第 ${rounds} 轮：${JSON.stringify(seen)}`)
}

async function preserveEvidence(home: string): Promise<void> {
  for (const rel of ['conversations', 'plugins', 'plugin-data']) {
    await cp(join(home, '.openpipal', rel), join(ARTIFACTS, rel), { recursive: true }).catch(() => undefined)
  }
}

test.describe('收工事件 + 规则仓库（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_HOOKS_LIVE=1 npx playwright test hook-turn-store-live')
  test.setTimeout(8 * 60 * 1000)

  let app: IsolatedElectron | null = null

  test.afterEach(async () => {
    if (app) await preserveEvidence(app.home)
    await app?.dispose()
    app = null
  })

  test('一轮说完规则记账落盘 → 下一轮开工读得到 → 第二轮累计', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object }, env: { OPENPIPAL_HTTP_PORT: '3135' } })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // 规则直接放进 local-rules（写规则那条链 hook-rule-live 已验）；仓库应落在 plugin-data 下，不在插件目录里
    const pluginDir = join(app.home, '.openpipal', 'plugins', 'local-rules')
    await mkdir(join(pluginDir, 'hooks'), { recursive: true })
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'local-rules' }), 'utf8')
    await writeFile(join(pluginDir, 'hooks', 'count-rounds.ts'), RULE, 'utf8')
    const storeFile = join(app.home, '.openpipal', 'plugin-data', 'local-rules', 'hooks', 'count-rounds.json')

    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    const proc = app.app.process()
    const mainLog: string[] = []
    proc.stdout?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:out] ${line}`) })
    proc.stderr?.on('data', d => { const line = String(d).trimEnd(); mainLog.push(line); say(`[main:err] ${line}`) })
    page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
    say(`模型 ${(modelConfig as { model?: string }).model}`)

    const deadline = Date.now() + 6 * 60 * 1000
    const permissions: string[] = []
    const driver = drivePermissions(page, permissions, deadline)

    // ---- 第一轮 ----
    const first = '你好，简单回一句就行，不用调工具。'
    await send(page, first)
    await waitForTurn(page, deadline)
    say(`第一轮回话：${(await lastReply(page)).slice(0, 200)}`)
    const afterFirst = await waitForRounds(storeFile, 1, 30_000)
    say(`第一轮仓库：${JSON.stringify(afterFirst)}`)
    expect(afterFirst.seenAtStart, '开工事件读到的应是 0（还没收过工）').toBe(0)
    expect(afterFirst.last?.outcome).toBe('completed')
    expect(afterFirst.last?.prompt).toBe(first)
    expect(afterFirst.last?.replyLength ?? 0).toBeGreaterThan(0)
    await page.screenshot({ path: join(ARTIFACTS, '01-round-1.png') })

    // ---- 第二轮：开工时应读到上一轮记的 1 ----
    const second = '这是第几轮？只回一个数字。'
    await send(page, second)
    await waitForTurn(page, deadline)
    const reply = await lastReply(page)
    say(`第二轮回话：${reply.slice(0, 200)}（提示词型，模型答不答"2"只记录不判）`)
    const afterSecond = await waitForRounds(storeFile, 2, 30_000)
    say(`第二轮仓库：${JSON.stringify(afterSecond)}`)
    expect(afterSecond.seenAtStart, '第二轮开工时规则应读到上一轮记的 1').toBe(1)
    expect(afterSecond.last?.outcome).toBe('completed')
    expect(afterSecond.last?.prompt).toBe(second)
    await page.screenshot({ path: join(ARTIFACTS, '02-round-2.png') })

    // 仓库只落 plugin-data，插件目录里不该多出状态文件；也不该留临时文件
    const hooksDir = await readdir(join(pluginDir, 'hooks'))
    expect(hooksDir, '插件目录里不该多出仓库文件').toEqual(['count-rounds.ts'])
    const dataDir = await readdir(join(app.home, '.openpipal', 'plugin-data', 'local-rules', 'hooks'))
    expect(dataDir, '不该留下临时文件').toEqual(['count-rounds.json'])

    const armed = mainLog.filter(l => l.includes('[Hooks] conv=') && l.includes('local-rules/count-rounds'))
    expect(armed, '这条规则没有装进对话（主进程没有「生效 … local-rules/count-rounds」日志）').not.toHaveLength(0)
    const failed = mainLog.filter(l => l.includes('agent_end 处理失败'))
    expect(failed, `收工事件处理失败：${failed.join(' | ')}`).toHaveLength(0)

    say(`权限卡 ${permissions.length} 张：${permissions.join(' | ')}`)
    await Promise.race([driver, new Promise(r => setTimeout(r, 100))])
  })
})
