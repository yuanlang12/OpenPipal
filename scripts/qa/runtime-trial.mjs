#!/usr/bin/env node
/**
 * 受控真实供应商试用驱动（可复现版）。
 *
 * 每次调用 = 一个样本：全新隔离数据根 + 全新会话 + 一轮真实模型请求。
 * 只做观测，不改仓库状态，也不碰用户正式数据根（~/.openpipal 只被只读地取用预设）。
 *
 * 之所以提交进仓库而不是用临时驱动：上一次无法归因的静默挂起，正是因为驱动跑完即失、
 * 无法按原样复跑。样本要能被第三方重放，证据才算数。
 *
 * 用法：
 *   node scripts/qa/runtime-trial.mjs --runtime pi-core --preset <presetId> --marker <MARKER>
 *   可选 --role <角色 id，默认 general> --prompt <文本> --timeout <毫秒，默认 180000>
 *        --save-as-agent（跑完再走一次"保存为 Agent"，验 workspace 真的建出来）
 *        --accept-any-completion（角色有强人设时不强求复述 marker，只要有终局回复即通过）
 *        --keep-home
 */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

function parseArgs(argv) {
  const out = { runtime: 'pi-core', role: 'general', timeout: 180_000, keepHome: false, saveAsAgent: false, acceptAnyCompletion: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep-home') { out.keepHome = true; continue }
    if (a === '--save-as-agent') { out.saveAsAgent = true; continue }
    if (a === '--accept-any-completion') { out.acceptAnyCompletion = true; continue }
    if (a === '--list-presets') { out.listPresets = true; continue }
    if (a === '--capture-artifacts') { out.captureArtifacts = true; continue }
    const v = argv[++i]
    if (a === '--role') out.role = v
    else if (a === '--runtime') out.runtime = v
    else if (a === '--preset') out.preset = v
    else if (a === '--marker') out.marker = v
    else if (a === '--prompt') out.prompt = v
    else if (a === '--timeout') out.timeout = Number(v)
    else throw new Error(`unknown argument: ${a}`)
  }
  if (out.listPresets) return out
  if (!out.preset) throw new Error('--preset is required')
  if (!out.marker) throw new Error('--marker is required')
  if (!['pi-core', 'legacy', 'default'].includes(out.runtime)) throw new Error('--runtime must be pi-core, legacy or default')
  return out
}

/** 从用户正式配置里只读地取一个预设，连同它的服务商实体，写进隔离数据根 */
async function buildIsolatedHome(presetId, roleName) {
  const real = JSON.parse(await readFile(join(homedir(), '.openpipal', 'config.json'), 'utf8'))
  const preset = (real.modelPresets || []).find(p => p.id === presetId)
  if (!preset) throw new Error(`preset not found in ~/.openpipal/config.json: ${presetId}`)
  const provider = (real.modelProviders || []).find(p => p.id === preset.providerId)
  const resolved = { ...(provider ? { provider: provider.provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat } : {}), ...preset.config }
  if (!resolved.apiKey) throw new Error(`preset ${presetId} has no resolvable apiKey`)

  const home = await mkdtemp(join(tmpdir(), 'openpipal-trial-'))
  await mkdir(join(home, '.openpipal'), { recursive: true })
  await writeFile(join(home, '.openpipal', 'config.json'), JSON.stringify({
    configVersion: 2,
    onboardingCompleted: true,
    appFollowingEnabled: false,
    autoMemoryEnabled: false,          // 样本之间不互相污染：不写记忆、不触发抽取子代理
    role: roleName,
    modelConfig: resolved,
    modelProviders: provider ? [{ ...provider }] : [],
    modelPresets: [{ ...preset }],
    activePresetId: preset.id
  }, null, 2), 'utf8')
  return { home, model: resolved.model }
}

/** 读隔离数据根里的运行时相位记录，用于归因（stream_fn_called / first_model_event / watchdog / settled） */
async function readRuntimePhases(home) {
  const path = join(home, '.openpipal', 'usage.jsonl')
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf8')
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(r => r && r.kind === 'runtime_turn')
}

async function readPersistedConversation(home) {
  const dir = join(home, '.openpipal', 'conversations')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  if (files.length !== 1) return { fileCount: files.length }
  const conv = JSON.parse(await readFile(join(dir, files[0]), 'utf8'))
  return { fileCount: 1, messages: (conv.messages || []).map(m => ({ role: m.role, kind: m.messageKind, len: (m.content || '').length })) }
}

/**
 * 列出可用预设的 id / 名字 / 模型——**只印这三样，绝不印 apiKey 或 baseUrl**。
 * 存在的理由：`~/.openpipal/config.json` 是凭据文件，跑样本的人（含 AI）不该、也不能直接读它，
 * 但选哪个预设是跑样本的前置条件。让脚本代读并只吐非敏感字段，是唯一不需要人肉转述的路。
 */
async function listPresets() {
  const real = JSON.parse(await readFile(join(homedir(), '.openpipal', 'config.json'), 'utf8'))
  const providers = new Map((real.modelProviders || []).map((p) => [p.id, p.provider]))
  return {
    activePresetId: real.activePresetId || null,
    presets: (real.modelPresets || []).map((p) => ({
      id: p.id,
      name: p.name || null,
      provider: providers.get(p.providerId) || null,
      model: (p.config && p.config.model) || null
    }))
  }
}

/**
 * 逐份列出这轮真的产出了什么：产物文件、自检截图、导出物。
 * 设计技能的验收判据是"新教的能力有没有被真的用上、观感成不成立"，两者都要落到**看得见的文件**上——
 * 只看助手最后那段话没有意义，模型说自己做完了和它真做出来了是两回事。
 */
function captureArtifacts(home) {
  const root = join(home, '.openpipal')
  const out = { artifacts: [], selfCheckShots: [], outputs: [] }
  const artRoot = join(root, 'conversations', 'artifacts')
  if (existsSync(artRoot)) {
    for (const conv of readdirSync(artRoot)) {
      const dir = join(artRoot, conv)
      if (!statSync(dir).isDirectory()) continue
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isFile()) out.artifacts.push({ path: p, bytes: statSync(p).size })
      }
    }
  }
  const shotDir = join(root, 'outputs', '.self-check')
  if (existsSync(shotDir)) {
    for (const f of readdirSync(shotDir)) {
      const p = join(shotDir, f)
      if (statSync(p).isFile()) out.selfCheckShots.push({ path: p, bytes: statSync(p).size })
    }
  }
  const outDir = join(root, 'outputs')
  if (existsSync(outDir)) {
    for (const f of readdirSync(outDir)) {
      const p = join(outDir, f)
      if (statSync(p).isFile()) out.outputs.push({ path: p, bytes: statSync(p).size })
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.listPresets) {
  console.log(JSON.stringify(await listPresets(), null, 2))
  process.exit(0)
}

const prompt = args.prompt || `Reply with exactly this marker and nothing else: ${args.marker}`
const { home, model } = await buildIsolatedHome(args.preset, args.role)
const startedAt = Date.now()

const app = await electron.launch({
  executablePath: join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  // 用目录而不是入口文件启动：Electron 的 app.getAppPath() 取入口所在目录，
  // 传 out/main/index.js 会让它变成 <repo>/out/main，resources/ 就找不到了
  // （evolver seed、bundled skills 全靠它）——等价于 `npx electron .`。
  args: [process.cwd()],
  env: {
    ...process.env,
    HOME: home,
    OPENPIPAL_ISOLATED_HOME: home,
    OPENPIPAL_DISABLE_APP_TRACKING: '1',
    // --runtime default 完全不设该变量，用来验证产品默认值本身而不是显式选择
    ...(args.runtime === 'default' ? {} : { OPENPIPAL_AGENT_RUNTIME: args.runtime })
  }
})

let result = { marker: args.marker, runtime: args.runtime, role: args.role, preset: args.preset, model, home }
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__chatStore), null, { timeout: 30_000 })

  await page.evaluate(async ({ prompt, role }) => {
    const store = window.__chatStore
    await store.getState().newConversation(role)
    void store.getState().sendMessage(prompt, role)
  }, { prompt, role: args.role })

  // 等终局：流结束且出现 assistant 消息。超时上限必须大于看门狗阈值，
  // 否则看门狗尚未开口就被驱动杀掉，挂起就永远归因不了。
  const outcome = await page.waitForFunction(() => {
    const state = window.__chatStore.getState()
    if (state.isStreaming) return null
    const assistant = state.messages.filter(m => m.role === 'assistant')
    if (assistant.length === 0) return null
    const last = assistant[assistant.length - 1]
    return { content: last.content || '', kind: last.messageKind || 'assistant', count: assistant.length }
  }, null, { timeout: args.timeout, polling: 500 }).then(h => h.jsonValue()).catch(() => null)

  result.elapsedMs = Date.now() - startedAt
  result.assistant = outcome
  result.matchedMarker = Boolean(outcome && outcome.content.includes(args.marker))
  result.timedOut = outcome === null

  // "保存为 Agent"：同一条真实对话 → workspace。走的是 renderer 真实调用路径，
  // 不是直接敲 IPC——要连 agentStore 的刷新一起验，才算这个功能真的通。
  if (args.saveAsAgent && !result.timedOut) {
    result.saveAsAgent = await page.evaluate(async () => {
      const conversationId = window.__chatStore.getState().activeConversationId
      if (!conversationId) return { ok: false, reason: 'no active conversation' }
      try {
        const workspace = await window.api.createAgentFromConversation(conversationId)
        const list = await window.api.listAgentWorkspaces()
        return {
          ok: true,
          conversationId,
          workspaceId: workspace?.meta?.id,
          name: workspace?.meta?.name,
          agentMdLength: (workspace?.agentMd || '').length,
          listedCount: (list || []).length,
          listedNames: (list || []).map(w => w.name)
        }
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err) }
      }
    }).catch(err => ({ ok: false, reason: `evaluate failed: ${String(err)}` }))
  }
} finally {
  await app.close().catch(() => {})
}

result.phases = (await readRuntimePhases(home)).map(p => ({ runtime: p.runtime, phase: p.phase, at: p.elapsedMs, firstModelEvent: p.firstModelEvent, outcome: p.outcome, attempt: p.attempt }))
result.conversation = await readPersistedConversation(home)
// 产物清单要在删 home 之前取；带 --capture-artifacts 时通常同时带 --keep-home，否则拿到路径也读不到文件
if (args.captureArtifacts) result.produced = captureArtifacts(home)
result.verdict = result.timedOut ? 'NO_TERMINAL_RESULT'
  : result.matchedMarker ? 'COMPLETED_WITH_MARKER'
  : 'COMPLETED_WITHOUT_MARKER'

const turnPassed = args.acceptAnyCompletion
  ? result.verdict !== 'NO_TERMINAL_RESULT'
  : result.verdict === 'COMPLETED_WITH_MARKER'
const agentPassed = !args.saveAsAgent || Boolean(result.saveAsAgent && result.saveAsAgent.ok)
result.passed = turnPassed && agentPassed

console.log(JSON.stringify(result, null, 2))
if (!args.keepHome) await rm(home, { recursive: true, force: true })
process.exit(result.passed ? 0 : 1)
