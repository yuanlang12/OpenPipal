import { expect, test } from '@playwright/test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn } from './live-helpers'

/**
 * 系统提示不被规则顶掉 —— 真模型验收。
 *
 * 2026-09-08~17 真机实撞：一条漏拼 event.systemPrompt 的 before_agent_start 规则让所有会话只剩它那一段，
 * 模型拿不到技能索引的 location，只好 ls 猜目录、find ~ 遍历主目录。这里把同样写坏的规则摆进隔离 home，
 * 验三件事：宿主记了「已按追加处理」、用量卡的 systemPrompt 分区不再是 0、模型说得出技能文件的真实路径。
 *
 * 真调模型 = 花钱，默认不跑：OPENPIPAL_HOOKS_LIVE=1 npx playwright test system-prompt-guard-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const ARTIFACTS = 'tests/artifacts/system-prompt-guard-live'

// 与肇事规则同形：只返回自己那段，没拼 event.systemPrompt
const BROKEN_RULE = `export const description = '没说要设计时，优先用 visual'
export default function (hook) {
  hook.on('before_agent_start', () => ({
    systemPrompt: '\\n## 设计行为默认偏好\\n除非用户明确说了要做设计类交付（含 3D 模型），否则优先用 create_visualizer 做轻量展示，不要主动读取 three-d-object 等设计相关技能。'
  }))
}
`

async function findSessionLogs(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await findSessionLogs(full))
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

test.describe('系统提示不被规则顶掉（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_HOOKS_LIVE=1 npx playwright test system-prompt-guard-live')
  test.setTimeout(6 * 60 * 1000)

  let app: IsolatedElectron | null = null
  test.afterEach(async () => { await app?.dispose(); app = null })

  test('写坏的规则在场：系统提示仍完整，模型说得出技能文件路径，不去翻主目录', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object } })
    const hooksDir = join(app.home, '.openpipal', 'plugins', 'local-rules', 'hooks')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(join(hooksDir, '..', 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'local-rules' }), 'utf8')
    await writeFile(join(hooksDir, 'visual-default-preference.ts'), BROKEN_RULE, 'utf8')

    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const logPath = join(ARTIFACTS, 'run.log')
    let mainLog = ''
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    const proc = app.app.process()
    proc.stdout?.on('data', d => { mainLog += String(d); say(`[main:out] ${String(d).trimEnd()}`) })
    proc.stderr?.on('data', d => { mainLog += String(d); say(`[main:err] ${String(d).trimEnd()}`) })
    say(`模型 ${(modelConfig as { model?: string }).model}`)

    const deadline = Date.now() + 5 * 60 * 1000
    const permissions: string[] = []
    const driver = drivePermissions(page, permissions, deadline)

    await send(page, '我想做个 3D 的故宫建筑群模型。先别动手、也别调任何工具，只回答一件事：按你的技能目录，你会先读哪个技能文件？把它的完整绝对路径原样写出来。')
    await waitForTurn(page, deadline)
    const reply = await lastReply(page)
    const trail = await toolTrail(page)
    say(`回话：${reply.slice(0, 600)}`)
    say(`工具轨迹：${JSON.stringify(trail.map(t => t.toolName))}`)
    await page.screenshot({ path: join(ARTIFACTS, '01-reply.png') })

    // 1. 宿主兜底真的触发了
    expect(mainLog, '主进程日志里没有「已按追加处理」——兜底没触发，或规则没加载').toContain('已按追加处理')

    // 2. 用量卡分区：systemPrompt 是「整份 - 技能段」，事故时整份只有 152、这一格被钳成 0；
    //    通用助手实测 1046（2026-09-17），门槛留一半余量
    let segments: { systemPrompt: number; skills: number } | undefined
    await expect.poll(async () => {
      for (const file of await findSessionLogs(join(app!.home, '.openpipal', 'sessions-v4', 'logs'))) {
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          if (!line.includes('lastContextUsage')) continue
          try { segments = JSON.parse(line).data?.config?.lastContextUsage?.segments ?? segments } catch { /* 半行 */ }
        }
      }
      return segments?.systemPrompt ?? 0
    }, { timeout: 30_000, message: '会话记录里的 systemPrompt 分区还是塌的' }).toBeGreaterThan(500)
    say(`分区：${JSON.stringify(segments)}`)

    // 3. 模型真的看到了技能索引的 location：说得出真实路径，没去翻目录
    expect(reply).toContain('three-d-object')
    expect(reply).toMatch(/resources[\\/]skills[\\/]three-d-object[\\/]SKILL\.md/)
    expect(trail.filter(t => t.toolName === 'bash')).toHaveLength(0)

    void driver
  })
})
