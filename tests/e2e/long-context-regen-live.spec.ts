import { expect, test } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronExecutablePath } from './helpers'
import { lastReply, realModelConfig, toolTrail, waitForTurn, type StoreWindow } from './live-helpers'

/**
 * 长对话「工具调用之后必空完成」回归验收（真模型、真会话）。
 *
 * 2026-09-18 实案：deepseek-flash 预设填了 1M 窗口，createCustomCompatModel 漏传 contextWindow，
 * pi-ai 拿到 groq 模板的 131072；会话真实载荷过 12.7 万后，工具调用之后那次请求被 pi-ai 把
 * max_tokens 夹到 1，模型吐 1 个 token 就停，用户看到"模型连续两次结束，但都没有返回正文或工具调用"，
 * 重新生成永远复现。
 *
 * 验法：把用户真实的那条会话（session jsonl + 产物目录）种进隔离 HOME，用构建产物启动，
 * 在 store 上直接 regenerate，然后看磁盘事实：
 *   - usage.jsonl 里每次调用的 output 都 > 1（尤其是工具结果回来后的那次）
 *   - main.log 里没有 [Pi] 空完成 指纹
 *   - 最后一条 assistant 是正文，不是 [Error]
 *
 * 真调模型 = 花钱，默认不跑：
 *   OPENPIPAL_REGEN_LIVE=1 OPENPIPAL_LIVE_CONV=<会话 id> OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test long-context-regen-live
 * OPENPIPAL_LIVE_CONV 必填：本机 sessions-v4 里一条真实载荷已超过 131072、末尾停在那次空完成报错的会话。
 */

const CONV_ID = (process.env.OPENPIPAL_LIVE_CONV || '').trim()
const LIVE = !!process.env.OPENPIPAL_REGEN_LIVE && !!CONV_ID
const ARTIFACTS = 'tests/artifacts/long-context-regen-live'
const HTTP_PORT = '3135'

/** 与 @earendil-works/pi-agent-core jsonl repo 的 jsonlSessionDirectoryName 同一算法 */
function sessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

async function findSourceSession(root: string, convId: string): Promise<string | null> {
  const logs = join(root, 'sessions-v4', 'logs')
  if (!existsSync(logs)) return null
  for (const dir of await readdir(logs)) {
    const full = join(logs, dir)
    let files: string[] = []
    try { files = await readdir(full) } catch { continue }
    const hit = files.find(f => f.includes(convId) && f.endsWith('.jsonl'))
    if (hit) return join(full, hit)
  }
  return null
}

type UsageCall = { kind: string; conv: string; seq: number; prompt: number; output: number; model: string }

async function readUsageCalls(home: string, convShort: string): Promise<UsageCall[]> {
  const path = join(home, '.openpipal', 'usage.jsonl')
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter((r): r is UsageCall => !!r && r.kind === 'call' && r.conv === convShort)
}

test.describe('长对话工具调用之后不再空完成（真模型、真会话）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑：OPENPIPAL_REGEN_LIVE=1 OPENPIPAL_LIVE_CONV=<会话 id> OPENPIPAL_LIVE_PRESET=deepseek-flash npx playwright test long-context-regen-live')
  test.setTimeout(12 * 60 * 1000)

  let home = ''
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null

  test.afterEach(async () => {
    if (home) {
      await mkdir(ARTIFACTS, { recursive: true })
      for (const rel of ['logs/main.log', 'usage.jsonl']) {
        await cp(join(home, '.openpipal', rel), join(ARTIFACTS, rel.replace('/', '_')), { force: true }).catch(() => undefined)
      }
      await cp(join(home, '.openpipal', 'sessions-v4'), join(ARTIFACTS, 'sessions-v4'), { recursive: true }).catch(() => undefined)
    }
    await app?.close().catch(() => undefined)
    app = null
    if (home) await rm(home, { recursive: true, force: true })
    home = ''
  })

  test('重新生成：写幻灯片的工具调用之后，模型继续给出正文，而不是 1 个 token 就停', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '没有模型配置（OPENPIPAL_LIVE_PRESET 指向的预设要有 key）').not.toBeNull()
    expect((modelConfig as { contextWindow?: number }).contextWindow, '这条回归只对填了 contextWindow 的预设有意义').toBeGreaterThan(131072)

    const realRoot = join(homedir(), '.openpipal')
    const sourceSession = await findSourceSession(realRoot, CONV_ID)
    expect(sourceSession, `本机 sessions-v4 里找不到会话 ${CONV_ID}`).not.toBeNull()

    // 隔离 HOME：配置 + 那条会话 + 它的产物目录。先种再启动，避免列表缓存看不到。
    home = await mkdtemp(join(tmpdir(), 'openpipal-regen-live-'))
    const isolatedRoot = join(home, '.openpipal')
    await mkdir(isolatedRoot, { recursive: true })
    await writeFile(
      join(isolatedRoot, 'config.json'),
      JSON.stringify({ configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, modelConfig }, null, 2),
      'utf8'
    )
    const destDir = join(isolatedRoot, 'sessions-v4', 'logs', sessionDirName(join(isolatedRoot, 'sessions-v4', 'openpipal')))
    await mkdir(destDir, { recursive: true })
    await cp(sourceSession!, join(destDir, sourceSession!.split('/').pop()!))
    await cp(join(realRoot, 'conversations', 'artifacts', CONV_ID), join(isolatedRoot, 'conversations', 'artifacts', CONV_ID), { recursive: true }).catch(() => undefined)
    await cp(join(realRoot, 'conversations', `${CONV_ID}.json`), join(isolatedRoot, 'conversations', `${CONV_ID}.json`)).catch(() => undefined)

    await mkdir(ARTIFACTS, { recursive: true })
    const logPath = join(ARTIFACTS, 'run.log')
    await writeFile(logPath, '', 'utf8')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    say(`隔离 HOME=${home} 会话=${CONV_ID} 模型=${(modelConfig as { model?: string }).model} contextWindow=${(modelConfig as { contextWindow?: number }).contextWindow}`)

    app = await electron.launch({
      executablePath: electronExecutablePath(),
      args: [process.cwd()],
      env: {
        ...process.env,
        HOME: home,
        OPENPIPAL_ISOLATED_HOME: home,
        OPENPIPAL_DISABLE_APP_TRACKING: '1',
        OPENPIPAL_HTTP_PORT: HTTP_PORT
      }
    })
    const proc = app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    const page = await app.firstWindow()
    page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as StoreWindow).__chatStore, null, { timeout: 60_000 })

    // 打开那条会话：末尾应当就是那次失败（[Error] 连续两次空完成），证明种进来的是同一份历史
    const before = await page.evaluate(async (id) => {
      const store = (window as StoreWindow).__chatStore!
      await store.getState().switchConversation(id)
      const msgs = store.getState().messages
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      const last = msgs[msgs.length - 1]
      return {
        count: msgs.length,
        lastUser: typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 120) : '',
        lastContent: typeof last?.content === 'string' ? last.content.slice(0, 120) : JSON.stringify(last?.content ?? '').slice(0, 120)
      }
    }, CONV_ID)
    say(`打开会话：${before.count} 条，末条=${before.lastContent}`)
    expect(before.count, '会话没有装进来').toBeGreaterThan(10)
    expect(before.lastContent, '种进来的历史末尾应当就是那次空完成报错').toContain('连续两次结束')

    const deadline = Date.now() + 8 * 60 * 1000
    await page.evaluate(() => (window as StoreWindow).__chatStore!.getState().regenerate())
    await waitForTurn(page, deadline)

    const reply = await lastReply(page)
    const trail = await toolTrail(page)
    const errors = await page.evaluate(() => {
      const msgs = (window as StoreWindow).__chatStore?.getState().messages || []
      let lastUser = -1
      msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i })
      return msgs.slice(lastUser + 1).filter(m => typeof m.content === 'string' && m.content.startsWith('[Error]')).map(m => String(m.content).slice(0, 160))
    })
    const convShort = CONV_ID.slice(0, 8)
    const calls = await readUsageCalls(home, convShort)
    const mainLog = await readFile(join(isolatedRoot, 'logs', 'main.log'), 'utf8').catch(() => '')
    const emptyFingerprints = mainLog.split('\n').filter(l => l.includes('空完成 conv='))

    say(`回复=${reply.slice(0, 200)}`)
    say(`工具轨迹=${JSON.stringify(trail.map(t => t.toolName))}`)
    say(`调用=${JSON.stringify(calls.map(c => ({ seq: c.seq, prompt: c.prompt, output: c.output })))}`)
    say(`空完成指纹=${JSON.stringify(emptyFingerprints)}`)
    console.log(`[验收] 本轮 ${calls.length} 次调用：` + calls.map(c => `#${c.seq} prompt=${c.prompt} output=${c.output}`).join('；'))
    console.log(`[验收] 末条回复：${reply.slice(0, 200)}`)

    expect(errors, '这轮不该再出现 [Error]').toEqual([])
    expect(emptyFingerprints, 'main.log 里不该再有空完成指纹').toEqual([])
    expect(calls.length, '至少要有"写幻灯片 + 工具结果之后"两次调用').toBeGreaterThanOrEqual(2)
    for (const call of calls) expect(call.output, `第 ${call.seq} 次调用输出被夹到贴地（max_tokens 夹到 1 的指纹）`).toBeGreaterThan(1)
    expect(reply.trim().length, '末条 assistant 应当有正文').toBeGreaterThan(0)
  })
})
