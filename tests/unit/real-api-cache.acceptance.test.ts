import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Agent } from '@earendil-works/pi-agent-core'
import { getModels, streamSimple } from '@earendil-works/pi-ai/compat'
import type { Model, Context, SimpleStreamOptions } from '@earendil-works/pi-ai/compat'
import { buildRuntimeContextMessage } from '../../src/main/agent-runtime/pi-message-conversion'

/**
 * 真实 API 缓存验收 —— 只有显式设置 OPENPIPAL_REAL_API=1 才跑（默认跳过，不烧钱）。
 *
 * 三方案对照，每方案两回合，度量第二回合的缓存命中：
 *   A glued            旧实现：runtime-context 拼进末条用户消息，且不落盘
 *   B separate         独立末尾消息，但不落盘（第一版"修正"）
 *   C separate+persist 独立消息且快照原样落盘回放（最终方案）
 *
 * 预期：A≈B < C。A/B 的第二回合在"上回合末条用户消息"处与缓存分歧，C 的分歧点
 * 推迟到最新一张快照——差值 ≈ 快照+上回合回复的 token 量。
 *
 * 成本纪律：挑配置里 flash/lite/turbo 级模型；u1 填充 ~4k token；三方案合计
 * prompt < 30k token、输出要求单字 ACK。按 flash 档价格计，单次全量验收 < ¥0.05。
 * 密钥从 ~/.openpipal/config.json 读取，绝不打印。
 */
const ENABLED = process.env.OPENPIPAL_REAL_API === '1'

interface ProviderPreset {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

function pickCheapPreset(): ProviderPreset | undefined {
  const configPath = join(process.env.OPENPIPAL_ISOLATED_HOME || homedir(), '.openpipal', 'config.json')
  let config: any
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return undefined
  }
  const candidates: ProviderPreset[] = [
    ...(config.modelPresets || []).map((p: any) => p.config),
    config.modelConfig
  ].filter(Boolean)
  return (
    candidates.find((c) => /flash|lite|turbo|mini/i.test(c.model || '')) ||
    candidates.find((c) => c.apiKey && c.baseUrl)
  )
}

/** 复刻 config-manager.createCustomCompatModel 的 custom 兜底：groq 模板 + 兼容位覆盖 */
function buildCompatModel(preset: ProviderPreset): Model<any> {
  const groqModels = getModels('groq' as any) as any[]
  const template = groqModels.find((m: any) => !m.reasoning) || groqModels[0]
  return {
    ...template,
    id: preset.model,
    baseUrl: preset.baseUrl,
    compat: {
      ...(template as any).compat,
      supportsStore: false,
      supportsStrictMode: false,
      supportsDeveloperRole: false
    }
  } as Model<any>
}

const SYSTEM = 'You are a terse test assistant. Follow output instructions exactly.'
const FILLER = ('The quick brown fox jumps over the lazy dog while the compiler emits a warning. ').repeat(300) // ~4k tokens
// 第一回合要求长回复（~1k+ token）：模拟真实 agentic 轮的工具流量量级——
// "落盘回放 vs 不落盘"的差值必须跨过网关的 128-token 缓存块粒度才可见
const U1_TEXT = `Context material for cache testing:\n${FILLER}\nEnd of material.\nSummarize the material above in 10 detailed bullet points (50+ words each), then end with the line DONE.`
const RC_TEXT = `\n\n<runtime-context>\n当前真实时间：2026年8月16日 15:04。测试快照。\n</runtime-context>`
const U1B_TEXT = 'Continue: reply with exactly: ACK2' // 模拟同轮第二个请求（工具循环里请求不断延长并整体入缓存）
const U2_TEXT = 'Now reply with exactly: ACK'

function userMessage(text: string): any {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
}

interface TurnResult {
  prompt: number
  cacheRead: number
  cacheWrite: number
  input: number
  hitPct: number
  error?: string
  /** 本回合最终 assistant 消息（真实对象，含 usage/api 等序列化必需元数据） */
  reply?: any
  /** 本回合 agent 的完整消息序列（模拟"落盘历史"——回放的真实来源） */
  transcript?: any[]
}

async function runTurn(
  model: Model<any>,
  apiKey: string,
  seedMessages: any[],
  promptMessages: any[],
  followUpMessages?: any[]
): Promise<TurnResult> {
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM, model, messages: [], tools: [] },
    streamFn: (m: Model<any>, context: Context, options?: SimpleStreamOptions) =>
      streamSimple(m, context, { ...options, apiKey })
  } as any)
  for (const msg of seedMessages) agent.state.messages.push(msg)
  await agent.prompt(promptMessages)
  if (followUpMessages) await agent.prompt(followUpMessages)
  const last = [...agent.state.messages].reverse().find((m: any) => m.role === 'assistant') as any
  if (!last) return { prompt: 0, cacheRead: 0, cacheWrite: 0, input: 0, hitPct: 0, error: 'no assistant reply' }
  if (last.stopReason === 'error') {
    return { prompt: 0, cacheRead: 0, cacheWrite: 0, input: 0, hitPct: 0, error: last.errorMessage || 'provider error' }
  }
  const input = last.usage?.input || 0
  const cacheRead = last.usage?.cacheRead || 0
  const cacheWrite = last.usage?.cacheWrite || 0
  const prompt = input + cacheRead + cacheWrite
  return {
    prompt, cacheRead, cacheWrite, input,
    hitPct: prompt > 0 ? Math.round((cacheRead / prompt) * 1000) / 10 : 0,
    reply: last,
    transcript: [...agent.state.messages]
  }
}

const SLEEP_BETWEEN_TURNS = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 回放轨迹 = turn1 落盘历史去掉最后的 prompt 消息组（u1b+rc2），保留 [u1,(rc),r1] */
function replayBase(t1: TurnResult, withRc: boolean): any[] {
  const msgs = t1.transcript || []
  // transcript: [u1, (rc), r1, u1b, (rc), r2] —— 回放历史只到 r1（u1b/r2 属于当轮内部脚手架不落盘的简化）
  const cut = msgs.length - 2
  const base = msgs.slice(0, cut)
  if (withRc) return base
  return base.filter((m: any) => !(m.role === 'user' && String(m.content?.[0]?.text || m.content || '').includes('<runtime-context>')))
}
function trailWithRc(t1: TurnResult): any[] { return replayBase(t1, true) }
function trailWithoutRc(t1: TurnResult): any[] { return replayBase(t1, false) }

describe.skipIf(!ENABLED)('真实 API 缓存验收（OPENPIPAL_REAL_API=1）', () => {
  const preset = pickCheapPreset()

  it('三方案第二回合命中率：separate+persist 应显著优于 glued / separate', { timeout: 180_000 }, async () => {
    expect(preset, '配置里没有可用的模型预设').toBeTruthy()
    const model = buildCompatModel(preset!)
    const apiKey = preset!.apiKey
    console.log(`[RealAPI] model=${preset!.model} baseUrl=${preset!.baseUrl!.replace(/\/\/[^/]+/, '//<host>')} （key 不打印）`)

    const results: Record<string, { turn1: TurnResult; turn2: TurnResult }> = {}

    // A glued：rc 拼进 u1（当轮），回放时 u1 无 rc
    {
      const t1 = await runTurn(model, apiKey, [], [userMessage(U1_TEXT + RC_TEXT)], [userMessage(U1B_TEXT + RC_TEXT)])
      await SLEEP_BETWEEN_TURNS(1500)
      // A 的回放：旧实现不落盘快照——u1 必须去掉拼进去的 rc 前缀再回放
      const gluedBase = replayBase(t1, true).map((m: any, i: number) =>
        i === 0 ? userMessage(U1_TEXT) : m
      )
      const t2 = await runTurn(model, apiKey, gluedBase, [userMessage(U2_TEXT + RC_TEXT)])
      results.A_glued = { turn1: t1, turn2: t2 }
    }

    // B separate 不落盘：当轮 [u1, rc]，回放不含 rc（第一版"修正"）
    {
      const t1 = await runTurn(model, apiKey, [], [userMessage(U1_TEXT), userMessage(RC_TEXT)], [userMessage(U1B_TEXT), userMessage(RC_TEXT)])
      await SLEEP_BETWEEN_TURNS(1500)
      const t2 = await runTurn(model, apiKey, trailWithoutRc(t1), [userMessage(U2_TEXT), userMessage(RC_TEXT)])
      results.B_separate = { turn1: t1, turn2: t2 }
    }

    // C separate+persist：当轮 [u1, rc] + 同轮第二请求，回放含落盘快照的完整轨迹
    {
      const rcLive = buildRuntimeContextMessage(RC_TEXT)
      const t1 = await runTurn(model, apiKey, [], [userMessage(U1_TEXT), rcLive], [userMessage(U1B_TEXT), buildRuntimeContextMessage(RC_TEXT)])
      await SLEEP_BETWEEN_TURNS(1500)
      // 回放快照用 buildRuntimeContextMessage 重建（时间戳必然不同）——顺带实证
      // 时间戳不进线上字节（命中不因此归零）
      const t2 = await runTurn(model, apiKey, trailWithRc(t1), [userMessage(U2_TEXT), buildRuntimeContextMessage(RC_TEXT)])
      results.C_persist = { turn1: t1, turn2: t2 }
    }

    const table = Object.entries(results).map(([k, v]) => {
      const noCacheReport = v.turn2.prompt > 0 && v.turn2.cacheRead === 0 && v.turn2.cacheWrite === 0
      return `${k}: turn1 prompt=${v.turn1.prompt} hit=${v.turn1.hitPct}% | turn2 prompt=${v.turn2.prompt} cacheRead=${v.turn2.cacheRead} hit=${v.turn2.hitPct}%${v.turn1.error ? ' ERR1=' + v.turn1.error : ''}${v.turn2.error ? ' ERR2=' + v.turn2.error : ''}${noCacheReport ? ' （该端点未上报缓存字段）' : ''}`
    })
    console.log('[RealAPI] 结果：\n  ' + table.join('\n  '))

    for (const [k, v] of Object.entries(results)) {
      expect(v.turn1.error, `${k} 第一回合失败`).toBeUndefined()
      expect(v.turn2.error, `${k} 第二回合失败（连续 user 消息被拒？）`).toBeUndefined()
      expect(v.turn1.prompt, `${k} 第一回合载荷异常`).toBeGreaterThan(1000)
    }

    const gatewayReportsCache =
      results.C_persist.turn2.cacheRead > 0 || results.C_persist.turn2.cacheWrite > 0
    if (!gatewayReportsCache) {
      console.log('[RealAPI] 端点不上报缓存字段——命中率断言跳过（请求形状与连通性已验证）')
      return
    }
    // 核心断言：落盘回放的命中率 ≥ 两个旧方案
    expect(results.C_persist.turn2.hitPct).toBeGreaterThanOrEqual(results.B_separate.turn2.hitPct)
    expect(results.C_persist.turn2.hitPct).toBeGreaterThanOrEqual(results.A_glued.turn2.hitPct)
    console.log(
      `[RealAPI] Δ(C-B)=${(results.C_persist.turn2.hitPct - results.B_separate.turn2.hitPct).toFixed(1)}pp ` +
      `Δ(C-A)=${(results.C_persist.turn2.hitPct - results.A_glued.turn2.hitPct).toFixed(1)}pp`
    )
  })
})
