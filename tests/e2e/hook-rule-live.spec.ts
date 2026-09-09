import { expect, test, type Page } from '@playwright/test'
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'

/**
 * 规则（hook）整体验收 —— 用户一句话定规则，真 App 里从头到尾走一遍。
 *
 * 五段各有单测，但「模型照着 hook-creator 写出能加载的文件 → 加载器当场给结论 →
 * 对话流出现那行提醒 → 下一轮规则真的拦住/改掉了工具结果 → 插件页能看能关」
 * 这条链只有真模型 + 真 UI 才验得到。判据尽量落磁盘和 DOM 属性，不靠回话措辞。
 *
 * 真调模型 = 花钱，默认不跑：OPENPIPAL_HOOKS_LIVE=1 npx playwright test hook-rule-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const ARTIFACTS = 'tests/artifacts/hook-rule-live'
const NAMES = ['张三', '李四', '王五']

const RULE_REQUEST = '以后读成绩表之前，先把学生的名字遮掉再给你看。这条规则以后一直生效，不只是这一次。'

interface PresetLike {
  name?: string
  providerId?: string
  config?: Record<string, unknown> & { model?: string; thinkingFormat?: string }
}
interface ProviderLike {
  id: string
  name?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  apiFormat?: string
  thinkingFormat?: string
  thinkingBudgets?: unknown
}

/**
 * 把用户真实配置里的模型抄进隔离 home。只在测试进程里抄，key 不经过任何日志或断言。
 *   OPENPIPAL_LIVE_PRESET=<子串>  从已保存的预设里按名字/模型名挑一个（默认端点配额用完时换别家）；
 *                                多个命中时优先不在 opencode 上的那个
 *   OPENPIPAL_LIVE_MODEL=<模型名>  只换模型名，端点与 key 照抄默认配置
 * 找不到预设时把可选的名字列出来（不含 key），省得去翻凭据文件。
 */
async function realModelConfig(): Promise<Record<string, unknown> | null> {
  let parsed: { modelConfig?: Record<string, unknown>; modelPresets?: PresetLike[]; modelProviders?: ProviderLike[] }
  try {
    parsed = JSON.parse(await readFile(join(homedir(), '.openpipal', 'config.json'), 'utf8'))
  } catch {
    return null
  }
  const presetQuery = process.env.OPENPIPAL_LIVE_PRESET?.trim().toLowerCase()
  if (presetQuery) {
    const providers = parsed.modelProviders || []
    const resolve = (preset: PresetLike): Record<string, unknown> => {
      const provider = preset.providerId ? providers.find(p => p.id === preset.providerId) : undefined
      const cfg = preset.config || {}
      if (!provider) return cfg
      const modelFormat = cfg.thinkingFormat
      return {
        ...cfg,
        provider: provider.provider,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.apiFormat ? { apiFormat: provider.apiFormat } : {}),
        thinkingFormat: modelFormat && modelFormat !== 'auto' ? modelFormat : (provider.thinkingFormat || modelFormat),
        ...(Object.prototype.hasOwnProperty.call(cfg, 'thinkingBudgets') ? {} : { thinkingBudgets: provider.thinkingBudgets })
      }
    }
    const label = (p: PresetLike): string => `${p.name || '?'} / ${p.config?.model || '?'}`
    const matches = (parsed.modelPresets || [])
      .filter(p => `${p.name || ''} ${p.config?.model || ''}`.toLowerCase().includes(presetQuery))
      .map(p => ({ preset: p, config: resolve(p) }))
      .filter(m => typeof m.config.apiKey === 'string' && m.config.apiKey)
      .sort((a, b) => Number(String(a.config.baseUrl || '').includes('opencode')) - Number(String(b.config.baseUrl || '').includes('opencode')))
    if (matches.length === 0) {
      const available = (parsed.modelPresets || []).map(label).join('\n  ')
      throw new Error(`没有名字或模型含「${presetQuery}」的预设。可选：\n  ${available || '（一个都没有）'}`)
    }
    console.log(`[验收] 预设 ${label(matches[0].preset)}（端点 ${new URL(String(matches[0].config.baseUrl || 'http://?')).host}）`)
    return matches[0].config
  }
  if (!parsed?.modelConfig?.apiKey) return null
  const override = process.env.OPENPIPAL_LIVE_MODEL
  if (!override) return parsed.modelConfig
  const { supportsThinking: _thinking, ...rest } = parsed.modelConfig
  return { ...rest, model: override }
}

/** 一直盯着聊天区，出现权限卡就点「允许」。 */
async function drivePermissions(page: Page, log: string[], deadline: number): Promise<void> {
  while (Date.now() < deadline && !page.isClosed()) {
    try {
      const allow = page.getByRole('button', { name: '允许', exact: true }).first()
      if (await allow.count() > 0 && await allow.isVisible().catch(() => false)) {
        const card = allow.locator('xpath=ancestor::div[3]')
        log.push((await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200))
        await allow.click()
        await page.waitForTimeout(400)
        continue
      }
      await page.waitForTimeout(700)
    } catch {
      return
    }
  }
}

type StoreWindow = Window & {
  __chatStore?: { getState(): { isStreaming: boolean; messages: Array<{ role: string; content: unknown; messageKind?: string }> } }
  __appStore?: { getState(): { setActiveView(view: string): void } }
}

/** 等这一轮真正开始又真正结束（isStreaming 先变 true 再变 false）。 */
async function waitForTurn(page: Page, deadline: number): Promise<void> {
  await page.waitForFunction(() => (window as StoreWindow).__chatStore?.getState().isStreaming === true, null, { timeout: 60_000 })
  await page.waitForFunction(() => (window as StoreWindow).__chatStore?.getState().isStreaming === false, null, { timeout: Math.max(1000, deadline - Date.now()) })
}

async function lastReply(page: Page): Promise<string> {
  return page.evaluate(() => {
    const msgs = (window as StoreWindow).__chatStore?.getState().messages || []
    const last = [...msgs].reverse().find(m => m.role === 'assistant' && (!m.messageKind || m.messageKind === 'assistant'))
    return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  })
}

/** 隔离 home 跑完就删；把会话记录与规则文件先抄到产物目录，失败了才有得看（不抄 config.json，那里有 key） */
async function preserveEvidence(home: string): Promise<void> {
  for (const rel of ['conversations', 'plugins']) {
    const from = join(home, '.openpipal', rel)
    await cp(from, join(ARTIFACTS, rel), { recursive: true }).catch(() => undefined)
  }
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator('textarea').first()
  await input.waitFor({ state: 'visible', timeout: 60_000 })
  await input.fill(text)
  await page.locator('[data-testid="send-btn"]').first().click()
}

test.describe('规则整体验收（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_HOOKS_LIVE=1 npx playwright test hook-rule-live')
  test.setTimeout(12 * 60 * 1000)

  let app: IsolatedElectron | null = null
  let fixture = ''

  test.afterEach(async () => {
    if (app) await preserveEvidence(app.home)
    await app?.dispose()
    app = null
    if (fixture) await rm(fixture, { recursive: true, force: true })
  })

  test('一句话定规则 → 对话流提醒 → 下一轮真的遮了名字 → 插件页能关', async () => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()

    fixture = await mkdtemp(join(tmpdir(), 'openpipal-hook-live-'))
    const csv = join(fixture, '期中成绩.csv')
    await writeFile(csv, `姓名,分数\n${NAMES.map((n, i) => `${n},${92 - i * 7}`).join('\n')}\n`, 'utf8')
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({ config: { modelConfig: modelConfig as object } })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ } }
    const proc = app.app.process()
    proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
    proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
    page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
    say(`模型 ${(modelConfig as { model?: string }).model}`)

    const deadline = Date.now() + 10 * 60 * 1000
    const permissions: string[] = []
    const driver = drivePermissions(page, permissions, deadline)

    // ---- 第一轮：定规则 ----
    // 前台只递交（set_rule），文件由后台 Evolver 写，回话结束时文件多半还没落地：
    // 先等胶囊（后台写完才发），再看目录
    await send(page, RULE_REQUEST)
    await waitForTurn(page, deadline)
    say(`第一轮回话：${(await lastReply(page)).slice(0, 300)}`)

    const notice = page.locator('[data-testid="inject-notice"][data-subtype="hook"]').first()
    await expect(notice, '对话流里没有出现「已定下规则」胶囊（后台没写、或写完没送到渲染层）').toBeVisible({ timeout: 4 * 60_000 })
    await expect(notice).toHaveAttribute('data-hook-state', 'ok', { timeout: 15_000 })

    const hooksDir = join(app.home, '.openpipal', 'plugins', 'local-rules', 'hooks')
    const hookFiles = await readdir(hooksDir).catch(() => [] as string[])
    say(`规则文件：${hookFiles.join(', ') || '（无）'}`)
    expect(hookFiles.filter(f => /\.(ts|js|mjs|cjs)$/.test(f)), '后台没有把规则写到约定目录').not.toHaveLength(0)
    await expect(notice).toContainText('已定下规则')
    await page.screenshot({ path: join(ARTIFACTS, '01-rule-set.png') })

    // ---- 第二轮：读成绩表，规则必须先遮名字 ----
    await send(page, `读一下 ${csv} 这个文件，把里面每一行原样列给我。`)
    await waitForTurn(page, deadline)
    const reply = await lastReply(page)
    say(`第二轮回话：${reply.slice(0, 500)}`)
    await page.screenshot({ path: join(ARTIFACTS, '02-masked-read.png') })
    for (const name of NAMES) {
      expect(reply, `规则没拦住：模型看到了真名 ${name}`).not.toContain(name)
    }

    // ---- 规则页：能看、能关；对话流那枚胶囊随之变「已撤销」 ----
    await page.evaluate(() => (window as StoreWindow).__appStore?.getState().openToolsHub('rules'))
    const rules = page.locator('[data-testid="plugin-rules"]').first()
    await expect(rules, '规则页没有列出规则').toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: join(ARTIFACTS, '03-plugins-rules.png') })
    await rules.getByRole('switch').first().click()
    await expect(rules.getByRole('switch').first()).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 })
    await page.screenshot({ path: join(ARTIFACTS, '04-rule-off.png') })
    const offFiles = await readdir(hooksDir)
    expect(offFiles.some(f => f.endsWith('.off')), '关掉规则应当是把文件改名成 .off').toBe(true)

    await page.evaluate(() => (window as StoreWindow).__appStore?.getState().setActiveView('chat'))
    await expect(notice).toHaveAttribute('data-hook-state', 'off', { timeout: 15_000 })
    await expect(notice).toContainText('已撤销')
    await page.screenshot({ path: join(ARTIFACTS, '05-notice-revoked.png') })

    say(`权限卡 ${permissions.length} 张：${permissions.join(' | ')}`)
    await Promise.race([driver, new Promise(r => setTimeout(r, 100))])
  })
})
