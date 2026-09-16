/**
 * 真模型验收共用的小工具：把用户本机配置里的模型抄进隔离 home（key 不进日志）、
 * 自动点权限卡、等一轮开始又结束、取最后一条回话、发消息。
 * hook-rule-live 与 pal-live 两条用例共用；判据尽量落磁盘和 DOM 属性，不靠回话措辞。
 */
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
export async function realModelConfig(): Promise<Record<string, unknown> | null> {
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

/**
 * 一直盯着聊天区，出现权限卡就点「允许」；`deny` 命中的卡点「拒绝」并记下来
 * （比如 `find /`——那是模型迷路的征兆，验收要抓的就是它，不能真让它搜全盘）。
 */
export async function drivePermissions(
  page: Page,
  log: string[],
  deadline: number,
  deny?: (cardText: string) => boolean,
  denied: string[] = []
): Promise<void> {
  while (Date.now() < deadline && !page.isClosed()) {
    try {
      const allow = page.getByRole('button', { name: '允许', exact: true }).first()
      if (await allow.count() > 0 && await allow.isVisible().catch(() => false)) {
        const card = allow.locator('xpath=ancestor::div[3]')
        const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
        if (deny?.(text)) {
          denied.push(text)
          await page.getByRole('button', { name: '拒绝', exact: true }).first().click()
        } else {
          log.push(text)
          await allow.click()
        }
        await page.waitForTimeout(400)
        continue
      }
      await page.waitForTimeout(700)
    } catch {
      return
    }
  }
}

export type StoreWindow = Window & {
  __chatStore?: {
    getState(): {
      isStreaming: boolean
      messages: Array<{ role: string; content: unknown; messageKind?: string; toolName?: string }>
      newConversationFromWorkspace(workspaceId: string, name: string): Promise<void>
    }
  }
  __appStore?: { getState(): { setActiveView(view: string): void; openToolsHub(tab: string): void } }
}

/** 等这一轮真正开始又真正结束（isStreaming 先变 true 再变 false）。 */
export async function waitForTurn(page: Page, deadline: number): Promise<void> {
  await page.waitForFunction(() => (window as StoreWindow).__chatStore?.getState().isStreaming === true, null, { timeout: 60_000 })
  await page.waitForFunction(() => (window as StoreWindow).__chatStore?.getState().isStreaming === false, null, { timeout: Math.max(1000, deadline - Date.now()) })
}

export async function lastReply(page: Page): Promise<string> {
  return page.evaluate(() => {
    const msgs = (window as StoreWindow).__chatStore?.getState().messages || []
    const last = [...msgs].reverse().find(m => m.role === 'assistant' && (!m.messageKind || m.messageKind === 'assistant'))
    return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  })
}

/** 这轮里所有工具结果（toolName + 内容开头），验"模型有没有迷路"用 */
export async function toolTrail(page: Page): Promise<Array<{ toolName: string; content: string }>> {
  return page.evaluate(() => {
    const msgs = (window as StoreWindow).__chatStore?.getState().messages || []
    return msgs
      .filter(m => m.role === 'tool')
      .map(m => ({ toolName: String(m.toolName || ''), content: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).slice(0, 400) }))
  })
}

export async function send(page: Page, text: string): Promise<void> {
  const input = page.locator('textarea').first()
  await input.waitFor({ state: 'visible', timeout: 60_000 })
  await input.fill(text)
  await page.locator('[data-testid="send-btn"]').first().click()
}
