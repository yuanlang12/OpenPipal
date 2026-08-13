#!/usr/bin/env node
/**
 * 连续性矩阵驱动：同一条持久会话依次跑 legacy → pi-core → legacy。
 *
 * Runtime 选择是进程生命期固定的，所以三段必须各起一次 Electron，
 * 共用同一个隔离数据根，让会话真正跨进程续下去（而不是三条独立会话）。
 *
 * 用法：node scripts/qa/runtime-continuity.mjs --preset <presetId> --marker <MARKER>
 */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const args = { timeout: 180_000 }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--keep-home') { args.keepHome = true; continue }
  const v = argv[++i]
  if (a === '--preset') args.preset = v
  else if (a === '--marker') args.marker = v
  else if (a === '--timeout') args.timeout = Number(v)
  else throw new Error(`unknown argument: ${a}`)
}
if (!args.preset || !args.marker) throw new Error('--preset and --marker are required')

const real = JSON.parse(await readFile(join(homedir(), '.openpipal', 'config.json'), 'utf8'))
const preset = (real.modelPresets || []).find(p => p.id === args.preset)
if (!preset) throw new Error(`preset not found: ${args.preset}`)
const provider = (real.modelProviders || []).find(p => p.id === preset.providerId)
const resolved = { ...(provider ? { provider: provider.provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat } : {}), ...preset.config }

const home = await mkdtemp(join(tmpdir(), 'openpipal-continuity-'))
await mkdir(join(home, '.openpipal'), { recursive: true })
await writeFile(join(home, '.openpipal', 'config.json'), JSON.stringify({
  configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, autoMemoryEnabled: false,
  role: 'general', modelConfig: resolved,
  modelProviders: provider ? [{ ...provider }] : [], modelPresets: [{ ...preset }], activePresetId: preset.id
}, null, 2), 'utf8')

const electronBinary = join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
// 用目录而不是入口文件：Electron 的 app.getAppPath() 取入口所在目录，传
// out/main/index.js 会让它变成 <repo>/out/main，bundled resources/ 就找不到了。
const mainEntry = process.cwd()

/** 跑一段：runtime 固定、会话为 null 时新建、否则续上给定会话 */
async function runLeg(runtime, conversationId, legMarker) {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: { ...process.env, HOME: home, OPENPIPAL_ISOLATED_HOME: home, OPENPIPAL_DISABLE_APP_TRACKING: '1', OPENPIPAL_AGENT_RUNTIME: runtime }
  })
  const startedAt = Date.now()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__chatStore), null, { timeout: 30_000 })

    const cid = await page.evaluate(async ({ conversationId, legMarker }) => {
      const store = window.__chatStore
      if (conversationId) await store.getState().switchConversation(conversationId)
      else await store.getState().newConversation('general')
      const id = store.getState().activeConversationId
      void store.getState().sendMessage(`Reply with exactly this marker and nothing else: ${legMarker}`, 'general')
      return id
    }, { conversationId, legMarker })

    const outcome = await page.waitForFunction((marker) => {
      const state = window.__chatStore.getState()
      if (state.isStreaming) return null
      const hit = state.messages.some(m => m.role === 'assistant' && (m.content || '').includes(marker))
      if (!hit) return null
      return { assistants: state.messages.filter(m => m.role === 'assistant').length, total: state.messages.length }
    }, legMarker, { timeout: args.timeout, polling: 500 }).then(h => h.jsonValue()).catch(() => null)

    return { runtime, conversationId: cid, legMarker, elapsedMs: Date.now() - startedAt, outcome, ok: outcome !== null }
  } finally {
    await app.close().catch(() => {})
  }
}

const legs = []
let cid = null
for (const [index, runtime] of ['legacy', 'pi-core', 'legacy'].entries()) {
  const leg = await runLeg(runtime, cid, `${args.marker}_L${index + 1}`)
  cid = leg.conversationId
  legs.push(leg)
  if (!leg.ok) break
}

const phasesPath = join(home, '.openpipal', 'usage.jsonl')
const phases = existsSync(phasesPath)
  ? (await readFile(phasesPath, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(r => r && r.kind === 'runtime_turn')
      .map(p => ({ runtime: p.runtime, phase: p.phase, at: p.elapsedMs, outcome: p.outcome }))
  : []

const convDir = join(home, '.openpipal', 'conversations')
const files = existsSync(convDir) ? readdirSync(convDir).filter(f => f.endsWith('.json')) : []
let transcript = { fileCount: files.length }
if (files.length === 1) {
  const conv = JSON.parse(await readFile(join(convDir, files[0]), 'utf8'))
  transcript.messages = (conv.messages || []).map(m => ({ role: m.role, kind: m.messageKind, len: (m.content || '').length }))
}

console.log(JSON.stringify({
  marker: args.marker, preset: args.preset, model: resolved.model, home,
  legs, phases, transcript,
  verdict: legs.length === 3 && legs.every(l => l.ok) ? 'CONTINUITY_PASS' : 'CONTINUITY_FAIL'
}, null, 2))
if (!args.keepHome) await rm(home, { recursive: true, force: true })
process.exit(legs.length === 3 && legs.every(l => l.ok) ? 0 : 1)
