import { expect, test, _electron as electron } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { drivePermissions, lastReply, resolvePresetConfig, send, waitForTurn, type PresetLike, type ProviderLike, type StoreWindow } from './live-helpers'
import { electronExecutablePath } from './helpers'

/**
 * OpenCode 网关（Zen / Go）真机验收：装机版带着用户的真 key 发一轮对话，不再被 400 MissingSessionID 拒掉。
 * 2026-09-20 实撞：网关硬性要求 x-opencode-session，我们是裸 Agent + pi-ai，没人替我们补这个头。
 *
 * 先做对照：同一把 key、同一时刻、同一请求体，只差这一个头——不带应当 400 MissingSessionID，带了应当 200。
 * 再驱 App 真发一轮。key 只在本进程里用，不进日志、不进断言文案。
 *   OPENPIPAL_OPENCODE_LIVE=1 npx playwright test opencode-gateway-live
 *   OPENPIPAL_OPENCODE_LIVE_DEV=1 再加上面这行 → 改驱 out/ 的 dev 构建（先 electron-vite build）
 */
const LIVE = !!process.env.OPENPIPAL_OPENCODE_LIVE
const DEV = !!process.env.OPENPIPAL_OPENCODE_LIVE_DEV
const APP = DEV ? electronExecutablePath() : (process.env.OPENPIPAL_INSTALLED_APP || '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal')
const APP_ARGS = DEV ? [process.cwd()] : []
const ARTIFACTS = 'tests/artifacts/opencode-gateway-live'
const DATA_DIR = '.openpipal'

type Cfg = Record<string, unknown> & { provider?: string; model?: string; baseUrl?: string; apiKey?: string }

/** 没挂模型的端点、以及直连对照用的模型：Zen / Go 两份目录里都有、都走 chat/completions 的便宜款 */
const FALLBACK_MODEL = process.env.OPENPIPAL_OPENCODE_LIVE_MODEL || 'deepseek-v4-flash'

function isOpencode(cfg: Cfg): boolean {
  if (cfg.provider === 'opencode' || cfg.provider === 'opencode-go') return true
  try { return new URL(String(cfg.baseUrl || '')).hostname === 'opencode.ai' } catch { return false }
}

/** 用户配置里第一个走 OpenCode 网关的模型：默认配置 → 预设 → 只存了端点和 key、底下没挂模型的服务商（2026-09-21 所有者的配置就是这样）。 */
async function opencodeConfig(): Promise<Cfg | null> {
  let parsed: { modelConfig?: Cfg; modelPresets?: PresetLike[]; modelProviders?: ProviderLike[] }
  try { parsed = JSON.parse(await readFile(join(homedir(), DATA_DIR, 'config.json'), 'utf8')) } catch { return null }
  const providers = parsed.modelProviders || []
  const candidates: Cfg[] = [
    ...(parsed.modelConfig ? [parsed.modelConfig] : []),
    ...(parsed.modelPresets || []).map(preset => resolvePresetConfig(preset, providers) as Cfg),
    ...providers.map(({ id: _id, name: _name, ...endpoint }) => ({ ...endpoint, model: FALLBACK_MODEL }))
  ]
  return candidates.find(c => isOpencode(c) && typeof c.apiKey === 'string' && c.apiKey) || null
}

/**
 * 直连网关发一条最小请求；返回状态码和报错类型（不含 key）。
 * 对照验的是网关不是模型，所以不管 App 那一轮用哪个模型，这里固定走 chat/completions + FALLBACK_MODEL。
 */
async function directCall(cfg: Cfg, withSession: boolean): Promise<{ status: number; errorType: string }> {
  const root = String(cfg.baseUrl || (cfg.provider === 'opencode' ? 'https://opencode.ai/zen' : 'https://opencode.ai/zen/go'))
    .replace(/\/+$/, '').replace(/\/v1$/, '')
  const res = await fetch(`${root}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `pi (${process.platform}; ${process.arch})`,
      authorization: `Bearer ${cfg.apiKey}`,
      ...(withSession ? { 'x-opencode-session': `openpipal-live-${Date.now()}` } : {})
    },
    body: JSON.stringify({ model: FALLBACK_MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
  })
  let errorType = ''
  try { errorType = String(JSON.parse(await res.text())?.error?.type || '') } catch { /* 成功响应或非 JSON */ }
  return { status: res.status, errorType }
}

test.describe('OpenCode 网关：带 x-opencode-session 才放行（真 key）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_OPENCODE_LIVE=1 npx playwright test opencode-gateway-live')
  test.setTimeout(6 * 60 * 1000)

  test('对照：只差这一个头；App 真发一轮不再 MissingSessionID', async () => {
    const cfg = await opencodeConfig()
    expect(cfg, '用户配置里没有走 OpenCode 网关且带 key 的模型').not.toBeNull()
    mkdirSync(ARTIFACTS, { recursive: true })
    const logPath = join(ARTIFACTS, 'run.log')
    writeFileSync(logPath, '')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ } }
    say(`模型 provider=${cfg!.provider} model=${cfg!.model} baseUrl=${cfg!.baseUrl || '（走内置目录）'} 被测=${DEV ? 'out/ dev 构建' : APP}`)

    const without = await directCall(cfg!, false)
    const withHeader = await directCall(cfg!, true)
    say(`对照 不带头 → ${without.status} ${without.errorType}   带头 → ${withHeader.status} ${withHeader.errorType}`)
    expect(withHeader.status, `带头直连都不通（${withHeader.errorType}）——是 key / 配额 / 模型名的问题，和这个头无关`).toBe(200)
    expect(without.errorType, '不带头也放行了：网关不再强制这个头，这条用例的前提变了').toBe('MissingSessionID')

    const home = await mkdtemp(join(tmpdir(), 'openpipal-opencode-live-'))
    const data = join(home, DATA_DIR)
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'config.json'), JSON.stringify({
      configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, modelConfig: cfg
    }, null, 2), 'utf8')

    let mainLog = ''
    const app = await electron.launch({ executablePath: APP, args: APP_ARGS, env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_HTTP_PORT: '3139' } })
    const proc = app.process()
    proc.stdout?.on('data', d => { mainLog += String(d); say(`[main:out] ${String(d).trimEnd()}`) })
    proc.stderr?.on('data', d => { mainLog += String(d); say(`[main:err] ${String(d).trimEnd()}`) })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const deadline = Date.now() + 4 * 60 * 1000
      void drivePermissions(page, [], deadline).catch(() => undefined)

      await send(page, '不要调用任何工具，只回复两个字：收到')
      await waitForTurn(page, deadline)
      const reply = await lastReply(page)
      const all = await page.evaluate(() => ((window as StoreWindow).__chatStore?.getState().messages || [])
        .map(m => `${m.role}/${m.messageKind || ''}: ${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).slice(0, 200)}`))
      say(`回话：${reply.slice(0, 300)}`)
      say(`全部消息：${JSON.stringify(all)}`)
      await page.screenshot({ path: join(ARTIFACTS, '01-reply.png') })

      expect(`${mainLog}\n${all.join('\n')}`, '还是被网关按缺 session 头拒了').not.toContain('MissingSessionID')
      expect(reply.trim().length, '这一轮没有任何回话').toBeGreaterThan(0)
    } finally {
      await app.close().catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  })
})
