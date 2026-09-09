/**
 * 规则注册表：从启用的插件里找 hooks/ 文件，加载并缓存。
 *
 * - 文件式：文件在即生效，删掉即失效；单条开关是改名成 `<file>.off`（scanHooksDir 认这个后缀）；
 *   整包开关走插件页已有的 disabled 列表
 * - 每轮开始时重扫一次；按 mtime+size 缓存，没改过的文件不重编译——模型刚写完的文件下一轮就生效
 * - 工具刚写完规则文件时 probeHookFileWrite 当场加载：对话流的「已定下规则」提醒和回给模型的
 *   反馈都来自这次加载的事实，不来自模型的宣称
 * - 加载结果（成功/失败原因）留在这里，供插件页与对话流提醒读取
 * - 逃生舱口：OPENPIPAL_DISABLE_HOOKS=1 整层跳过（排查「是不是规则搞的」时用）
 */
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getOpenPipalHome } from '../data-root'
import {
  getDisabledPluginNames,
  getPluginsRootDir,
  HOOK_OFF_SUFFIX,
  listScannedPlugins,
  scanHooksDir,
  scanPluginDir,
  type ScannedPlugin
} from '../plugin-manager'
import { getWorkspaceDir, getWorkspaceName, getWorkspacesRootDir } from '../agent-workspace-store'
import { hookIdFor, loadHookFile, type LoadHookFileOptions } from './hook-loader'
import type { HookEntry, HookEventName, HookLoadFailure, HookLoadResult, HookNotice, LoadedHook } from './hook-types'
import type { HookSource, HookToggleResult } from '../../shared/hook-contract'

interface CacheEntry {
  mtimeMs: number
  size: number
  result: HookLoadResult
}

/** 一次加载的结论：清单条目里"在生效 / 没生效"的那两种（关掉的由 listHookEntries 另补） */
export type HookReportEntry = Omit<HookEntry, 'status' | 'offReason' | 'events'> & {
  status: 'ok' | 'error'
  events: HookEventName[]
}

export type { HookEntry }

export interface ActiveHooks {
  hooks: LoadedHook[]
  failures: HookLoadFailure[]
  /** 这次加载的清单：系统提示里的 <rules> 从这里来（是本会话装的那一份，不是进程级快照） */
  report: HookReportEntry[]
  /** 独立智能体的规则目录读不了（fail-open 只装了插件规则）：清单不全，提示里要说明 */
  agentScanError?: string
}

const HOOK_EXT_RE = /\.(ts|js|mjs|cjs)$/i

const cache = new Map<string, CacheEntry>()
let lastReport: HookReportEntry[] = []

export function hooksDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENPIPAL_DISABLE_HOOKS === '1'
}

// ---- 规则来自哪：插件 hooks/ 或独立智能体自己的 hooks/ ----

/** 独立智能体规则的 hookId 容器段前缀：`agent:<id>/<文件名>` */
export const AGENT_CONTAINER_PREFIX = 'agent:'

export interface HookScope {
  /** 只装这个独立智能体自己的规则（运行时：跑哪个 Agent 装哪个；全局助手与内置角色不传） */
  workspaceId?: string
  /** 把所有独立智能体的规则都算上（规则页清单） */
  allAgents?: boolean
}

interface HookFileRef {
  source: HookSource
  /** hookId 的容器段：插件名，或 `agent:<id>` */
  container: string
  file: string
}

export function pluginSource(pluginName: string): HookSource {
  return { kind: 'plugin', id: pluginName, name: pluginName }
}

export function agentSource(workspaceId: string, name?: string): HookSource {
  return { kind: 'agent', id: workspaceId, name: name || workspaceId }
}

/** hookId 的容器段：插件名，或 `agent:<id>`——来源结构是事实源，前缀只在这里拼一次 */
export function containerOf(source: HookSource): string {
  return source.kind === 'agent' ? AGENT_CONTAINER_PREFIX + source.id : source.id
}

interface AgentHookDir {
  source: HookSource
  active: string[]
  disabled: string[]
}

/**
 * 有 hooks/ 目录的独立智能体 id：只 readdir 一层加两个 existsSync，不读 meta / 记忆 / 任务——每次 shell 命令之后都要跑。
 * 要有 meta.json 才算智能体（与 listWorkspaces 同判据）：agents/ 下的野目录不该被当成规则来源编译执行。
 */
function agentIdsWithHooks(): string[] {
  const root = getWorkspacesRootDir()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'meta.json')) && existsSync(join(root, entry.name, 'hooks')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * 独立智能体自己的 `agents/<id>/hooks/`：和它的 memory / skills 并排，文件在即生效，规则跟着 Agent 走。
 * 位置即范围——放在这里的规则只在跑这个 Agent 时装，文件里不用再判 ctx.workspaceId。
 */
function agentHookDirs(scope: HookScope): { dirs: AgentHookDir[]; error?: string } {
  if (!scope.allAgents && !scope.workspaceId) return { dirs: [] }
  try {
    const ids = scope.allAgents ? agentIdsWithHooks() : [scope.workspaceId!]
    const dirs: AgentHookDir[] = []
    for (const id of ids) {
      const root = getWorkspaceDir(id)
      const hooksDir = join(root, 'hooks')
      if (!existsSync(hooksDir)) continue
      const scanned = scanHooksDir(hooksDir, root, [])
      dirs.push({ source: agentSource(id, getWorkspaceName(id)), active: scanned.active, disabled: scanned.disabled })
    }
    return { dirs }
  } catch (error) {
    // 独立智能体目录读不了（权限、目录被删到一半）不能连累插件规则：fail-open 只装插件规则，
    // 但清单不全这件事要带到 <rules> 里说明，不能让模型拿着半份清单答"这是全部"
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[Hooks] 独立智能体的规则目录扫描失败，本次只装插件规则：${message}`)
    return { dirs: [], error: message }
  }
}

interface HookInputs {
  plugins: ScannedPlugin[]
  agents: AgentHookDir[]
  agentScanError?: string
}

/** 扫一次盘：所有插件 + 按 scope 选中的独立智能体。调用方拿着这一份派生清单，不重复扫 */
function scanHookInputs(scope: HookScope): HookInputs {
  const agents = agentHookDirs(scope)
  return { plugins: listScannedPlugins(), agents: agents.dirs, agentScanError: agents.error }
}

/** 这次要装 / 要看的所有规则文件：启用插件的全部 + 选中的独立智能体的。顺序稳定（清单进系统提示，顺序变了前缀缓存就翻） */
function collectHookRefs({ plugins, agents }: HookInputs): HookFileRef[] {
  const refs: HookFileRef[] = []
  for (const plugin of plugins) {
    if (plugin.info.invalid || !plugin.info.enabled) continue
    const source = pluginSource(plugin.info.name)
    for (const file of plugin.hookFiles) refs.push({ source, container: source.id, file })
  }
  refs.sort((a, b) => a.container.localeCompare(b.container) || a.file.localeCompare(b.file))
  for (const dir of agents) {
    const container = containerOf(dir.source)
    for (const file of dir.active) refs.push({ source: dir.source, container, file })
  }
  return refs
}

function toReport(source: HookSource, result: HookLoadResult): HookReportEntry {
  if (result.ok) {
    const { hook } = result
    return {
      id: hook.id,
      source,
      file: hook.file,
      description: hook.description,
      status: 'ok',
      events: (Object.keys(hook.handlers) as HookEventName[]).filter((name) => hook.handlers[name].length > 0)
    }
  }
  const { failure } = result
  return { id: failure.id, source, file: failure.file, status: 'error', error: failure.error, events: [] }
}

function rememberResult(file: string, result: HookLoadResult): void {
  try {
    const stat = statSync(file)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  } catch {
    cache.delete(file)
  }
}

function emptyLoad(): ActiveHooks {
  lastReport = []
  return { hooks: [], failures: [], report: [] }
}

/**
 * 加载这些文件：坏文件进 failures，好文件照常生效，永不抛出。
 * gcCache 只在看全量时给 true：按单个 Agent 装的那一轮看不见别的 Agent 的文件，不能据此判它们没了。
 */
async function loadHookRefs(inputs: HookInputs, options: LoadHookFileOptions | undefined, gcCache: boolean): Promise<ActiveHooks> {
  const refs = collectHookRefs(inputs)
  const seen = new Set<string>()
  const results: Array<{ source: HookSource; result: HookLoadResult }> = []
  for (const { source, container, file } of refs) {
    seen.add(file)
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(file)
    } catch (error) {
      results.push({ source, result: { ok: false, failure: { id: hookIdFor(container, file), pluginName: container, file, error: `读取失败：${error instanceof Error ? error.message : String(error)}` } } })
      continue
    }
    const cached = cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      results.push({ source, result: cached.result })
      continue
    }
    const result = await loadHookFile(file, container, options)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result })
    results.push({ source, result })
  }
  if (gcCache) {
    for (const key of Array.from(cache.keys())) {
      if (!seen.has(key)) cache.delete(key)
    }
  }
  const report = results.map(({ source, result }) => toReport(source, result))
  lastReport = report
  return {
    hooks: results.flatMap(({ result }) => (result.ok ? [result.hook] : [])),
    failures: results.flatMap(({ result }) => (result.ok ? [] : [result.failure])),
    report,
    ...(inputs.agentScanError ? { agentScanError: inputs.agentScanError } : {})
  }
}

/** 扫描 + 加载规则：启用插件的全部，加上 scope 选中的独立智能体自己的 */
export async function loadActiveHooks(options?: LoadHookFileOptions, scope: HookScope = {}): Promise<ActiveHooks> {
  if (hooksDisabledByEnv()) return emptyLoad()
  return loadHookRefs(scanHookInputs(scope), options, Boolean(scope.allAgents))
}

/** 上一次加载的结果快照（测试与排查用；会话自己的清单走 loadActiveHooks 的返回值） */
export function getHookReport(): HookReportEntry[] {
  return lastReport
}

/** 测试与热重载用：清掉编译缓存 */
export function resetHookCache(): void {
  cache.clear()
  lastReport = []
}

// ---- 写入探针：工具刚写完的文件是不是规则 ----

/** 工具参数里的路径 → 绝对路径：`~` 展开 + 相对路径按会话工作目录解析（与 pi 写工具同口径） */
function expandToolPath(raw: string, workingDir?: string): string {
  let candidate = raw.trim()
  if (candidate === '~' || candidate.startsWith('~/')) candidate = join(getOpenPipalHome(), candidate.slice(1))
  if (!isAbsolute(candidate)) candidate = resolve(workingDir || process.cwd(), candidate)
  return resolve(candidate)
}

/** 真实路径（跟符号链接、按磁盘上的大小写）；还不存在的那几段保留原样，只把存在的前缀换成真实的 */
function realish(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    const parent = dirname(p)
    return parent === p ? p : join(realish(parent), basename(p))
  }
}

interface Located {
  /** 第一段：插件名 / 智能体 id */
  name: string
  /** `<base>/<name>`，按调用方给的 base 形式拼（不换成 /private/var 那种真实前缀，和扫描结果同形） */
  root: string
  /** 命中的文件按同一形式拼出来的路径：大小写按磁盘上的，之后比对、记指纹都用它 */
  file: string
}

/**
 * 绝对路径落在 base 之下、且相对路径各段通过 accept 才算命中。
 * 逃出 base 的（`..`、绝对路径、指到外面的符号链接）一律不认——这是规则文件位置的唯一判据，插件根与智能体根共用。
 * 包含关系按真实路径判：macOS 不区分大小写，`~/.OpenPipal/...` 写得进去，字节比较会认不出来（workspace-root-gate 同一课）。
 */
function locateUnder(base: string, absPath: string, accept: (parts: string[]) => boolean): Located | undefined {
  const root = resolve(base)
  const rel = relative(realish(root), realish(absPath))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const parts = rel.split(sep)
  if (!accept(parts)) return undefined
  return { name: parts[0], root: join(root, parts[0]), file: join(root, ...parts) }
}

/** `<name>/hooks/<file>` 这一层的文件；文件名判据由调用方给（源码文件 / 含 .off 版） */
const hookFileAt = (isName: (file: string) => boolean) => (parts: string[]): boolean =>
  parts.length === 3 && parts[1] === 'hooks' && isName(parts[2])
const manifestAt = (parts: string[]): boolean => parts.length === 2 && parts[1] === 'plugin.json'
const isHookSource = (file: string): boolean => HOOK_EXT_RE.test(file)

type PluginLocation =
  | { pluginName: string; pluginDir: string; kind: 'hook'; file: string }
  | { pluginName: string; pluginDir: string; kind: 'manifest' }

/** 绝对路径落在 plugins/<name>/hooks/<file> 或 plugins/<name>/plugin.json 才算命中 */
function locateInPlugins(absPath: string): PluginLocation | undefined {
  const hook = locateUnder(getPluginsRootDir(), absPath, hookFileAt(isHookSource))
  if (hook) return { pluginName: hook.name, pluginDir: hook.root, kind: 'hook', file: hook.file }
  const manifest = locateUnder(getPluginsRootDir(), absPath, manifestAt)
  return manifest ? { pluginName: manifest.name, pluginDir: manifest.root, kind: 'manifest' } : undefined
}

interface AgentLocation {
  workspaceId: string
  root: string
  file: string
}

/** 绝对路径落在 agents/<id>/hooks/<file> 才算命中 */
function locateInAgents(absPath: string): AgentLocation | undefined {
  const hit = locateUnder(getWorkspacesRootDir(), absPath, hookFileAt(isHookSource))
  return hit ? { workspaceId: hit.name, root: hit.root, file: hit.file } : undefined
}

function stemOf(file: string): string {
  return basename(file).replace(HOOK_EXT_RE, '')
}

/** 写进了某个独立智能体 hooks/ 的文件：当场加载给结论（没有 plugin.json、没有整包开关这两道） */
async function probeAgentHookFile(
  agent: AgentLocation,
  options?: LoadHookFileOptions,
  baseline?: HookSignatures
): Promise<HookNotice> {
  const { file } = agent
  const source = agentSource(agent.workspaceId, getWorkspaceName(agent.workspaceId))
  const container = containerOf(source)
  const base = { hookId: hookIdFor(container, file), source, file, description: stemOf(file) }
  const scanned = scanHooksDir(join(agent.root, 'hooks'), agent.root, [])
  if (!scanned.active.some((candidate) => resolve(candidate) === file)) {
    return { ...base, status: 'error', error: '文件不在这个 Agent 的 hooks/ 目录里，或解析后逃出了它的目录' }
  }
  const result = await loadHookFile(file, container, options)
  rememberResult(file, result)
  const signature = signatureOf(file)
  if (baseline && signature) baseline.set(file, signature)
  return result.ok
    ? { ...base, status: 'ok', description: result.hook.description }
    : { ...base, status: 'error', error: result.failure.error }
}

/**
 * 工具刚写完一个文件：如果它是规则文件（或规则所在插件的 plugin.json），当场加载并给出结论。
 * 不是规则相关的路径返回空数组。永不抛出。
 */
export async function probeHookFileWrite(
  rawPath: string,
  workingDir?: string,
  options?: LoadHookFileOptions,
  /** 本轮基线：写完顺手记上指纹，之后 bash 探针不会把同一个文件再报一遍 */
  baseline?: HookSignatures,
  /** 与本会话装规则的范围一致：写进别的 Agent 目录的文件对本会话不生效，不给"从下一轮开始执行"的结论（与 shell 探针同口径） */
  scope: HookScope = ALL
): Promise<HookNotice[]> {
  if (hooksDisabledByEnv() || typeof rawPath !== 'string' || !rawPath.trim()) return []
  let abs: string
  try {
    abs = expandToolPath(rawPath, workingDir)
  } catch {
    return []
  }
  const agent = locateInAgents(abs)
  if (agent) {
    const inScope = scope.allAgents || scope.workspaceId === agent.workspaceId
    return inScope ? [await probeAgentHookFile(agent, options, baseline)] : []
  }
  const located = locateInPlugins(abs)
  if (!located) return []
  const scanned = scanPluginDir(located.pluginDir, located.pluginName, getDisabledPluginNames())
  const known = new Set(scanned.hookFiles.map((file) => resolve(file)))
  const targets = located.kind === 'hook' ? [located.file] : scanned.hookFiles.map((file) => resolve(file))
  const notices: HookNotice[] = []
  for (const file of targets) {
    const pluginName = scanned.info.invalid ? located.pluginName : scanned.info.name
    const base = { hookId: hookIdFor(pluginName, file), source: pluginSource(pluginName), file, description: stemOf(file) }
    if (scanned.info.invalid) {
      notices.push({ ...base, status: 'error', error: `插件 ${located.pluginName} 无效：${scanned.info.invalid}` })
      continue
    }
    if (!scanned.info.enabled) {
      notices.push({ ...base, status: 'error', error: `插件 ${pluginName} 已停用，规则不会生效` })
      continue
    }
    if (!known.has(file)) {
      notices.push({ ...base, status: 'error', error: '文件不在插件的 hooks/ 目录里，或解析后逃出了插件根' })
      continue
    }
    const result = await loadHookFile(file, pluginName, options)
    rememberResult(file, result)
    const signature = signatureOf(file)
    if (baseline && signature) baseline.set(file, signature)
    notices.push(result.ok
      ? { ...base, status: 'ok', description: result.hook.description }
      : { ...base, status: 'error', error: result.failure.error })
  }
  return notices
}

/** 规则文件的"指纹"表：file → mtime:size。每个会话轮次自己持一份基线，探针只对基线报变化 */
export type HookSignatures = Map<string, string>

function signatureOf(file: string): string | undefined {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

/** 探针的范围与这个会话装规则时一致：别的 Agent 目录里的改动对它没影响，规则页照样列 */
const ALL: HookScope = { allAgents: true }

/** scope 里所有规则文件的指纹，作为本轮的基线 */
export function snapshotHookSignatures(scope: HookScope = ALL): HookSignatures {
  const signatures: HookSignatures = new Map()
  refreshHookSignatures(signatures, scope)
  return signatures
}

/**
 * 把基线刷成"此刻"的样子（原地改，调用方持有的就是同一个 Map）。
 * 在 bash/powershell 真要开跑之前刷一次，之后的探针只会看到**这条命令跑的期间**出现的变化——
 * 别的会话、插件页、用户在编辑器里的改动，只要发生在命令开跑之前，就不会被算到这条会话头上。
 * 命令执行那几秒里别人恰好也在写，仍会被一起报出来；那是并发写同一目录的固有代价，只是窗口极窄。
 */
export function refreshHookSignatures(baseline: HookSignatures, scope: HookScope = ALL): void {
  baseline.clear()
  if (hooksDisabledByEnv()) return
  for (const { file } of collectHookRefs(scanHookInputs(scope))) {
    const signature = signatureOf(file)
    if (signature) baseline.set(file, signature)
  }
}

/**
 * 兜底探针：不知道哪个文件被改了（多半是模型用 bash 建的文件）时，把 scope 里
 * 所有规则文件和**本轮基线**比一遍——新出现的、内容变了的当场加载并给结论，然后更新基线。
 *
 * 基线按会话轮次持有，不用进程级编译缓存来判"新不新"：缓存会被插件页开关、别的会话、
 * 缓存清理动到，拿它比对会把别人改的规则当成"这轮刚定的"报进本会话（既多一行提醒，
 * 又给模型塞一句它没做过的事）。只看 mtime+size，每次 bash 之后跑得起。
 */
export async function probeHookChanges(baseline: HookSignatures, options?: LoadHookFileOptions, scope: HookScope = ALL): Promise<HookNotice[]> {
  if (hooksDisabledByEnv()) return []
  const notices: HookNotice[] = []
  const seen = new Set<string>()
  for (const { source, container, file } of collectHookRefs(scanHookInputs(scope))) {
    seen.add(file)
    const signature = signatureOf(file)
    if (!signature) continue
    if (baseline.get(file) === signature) continue
    baseline.set(file, signature)
    const result = await loadHookFile(file, container, options)
    rememberResult(file, result)   // 文件可能在编译那几十毫秒里被删/改名——rememberResult 自己兜住，永不抛出
    const base = { hookId: hookIdFor(container, file), source, file, description: stemOf(file) }
    notices.push(result.ok
      ? { ...base, status: 'ok', description: result.hook.description }
      : { ...base, status: 'error', error: result.failure.error })
  }
  for (const key of Array.from(baseline.keys())) {
    if (!seen.has(key)) baseline.delete(key)
  }
  return notices
}

/** 回给模型的一句话：让它知道规则到底生效了没有，不用它自己猜 */
export function formatHookNoticeForModel(notice: HookNotice): string {
  return notice.status === 'ok'
    ? `【规则已生效】${notice.description}（${notice.file}）。从下一轮开始执行。告诉用户一句即可，不要贴代码。`
    : `【规则没生效】${notice.file}：${notice.error || '未知原因'}。请修正文件后再写一次。`
}

/**
 * 每轮塞进系统提示的规则清单：模型看不到规则的执行过程，也看不到胶囊，问它"定没定"它只能猜——
 * 真机实撞：第一次后台没写成，用户再提一遍，模型答"已经完成了"。给它事实：生效的、没生效的、
 * 后台正在写的，并说明清单就是全部。怎么答由模型判断（hook-creator 技能里有该怎么说）。
 * 没有规则就返回空串（零注入）；内容只随规则变化，前缀缓存不被翻。
 */
export function formatHookStatusForPrompt(report: HookReportEntry[], pending: string[] = [], agentScanError?: string): string {
  const ok = report.filter((entry) => entry.status === 'ok')
  const failed = report.filter((entry) => entry.status === 'error')
  if (ok.length === 0 && failed.length === 0 && pending.length === 0 && !agentScanError) return ''
  const lines = ['<rules>', agentScanError
    ? `用户定下、由代码强制执行的规则清单。这个 Pal 自己的规则目录本轮读不了（${agentScanError}），下面只有插件里的规则，清单不全；你看不到规则的执行过程。`
    : '用户定下、由代码强制执行的规则清单。这是全部：不在清单里的规则不存在；你看不到规则的执行过程。']
  if (ok.length) {
    lines.push('生效中：', ...ok.map((entry) => `- ${entry.description || entry.id}`))
  }
  if (failed.length) {
    lines.push('没生效（加载失败，用户问起就照实说原因）：', ...failed.map((entry) => `- ${entry.description || entry.id}：${entry.error || '未知原因'}`))
  }
  if (pending.length) {
    lines.push('后台正在写（写好前不算定下）：', ...pending.map((description) => `- ${description}`))
  }
  lines.push('</rules>')
  return lines.join('\n')
}

// ---- 文件式开关与清单 ----

function isHookFileName(name: string): boolean {
  const logical = name.endsWith(HOOK_OFF_SUFFIX) ? name.slice(0, -HOOK_OFF_SUFFIX.length) : name
  return HOOK_EXT_RE.test(logical) && !logical.endsWith('.d.ts')
}

/**
 * 改名 `<file>` ↔ `<file>.off`。只认 plugins/<name>/hooks/ 或 agents/<id>/hooks/ 的直接子文件，别的一律拒。
 * 关：生效中的那份是事实源，同名的旧 `.off`（撤销过又让助手重写了一份的情形）直接丢掉再改名；
 * 开：若同名生效版已存在，拒绝——两份同 id 的规则只能留一份，留的是正在生效的。
 */
export function setHookFileEnabled(file: string, enabled: boolean): HookToggleResult {
  if (typeof file !== 'string' || !file.trim()) return { ok: false, error: '缺少文件路径' }
  const toggleable = hookFileAt(isHookFileName)
  const located = locateUnder(getPluginsRootDir(), resolve(file), toggleable) ?? locateUnder(getWorkspacesRootDir(), resolve(file), toggleable)
  if (!located) return { ok: false, error: '不是插件或 Agent 的 hooks/ 里的规则文件' }
  const abs = located.file
  const isOff = abs.endsWith(HOOK_OFF_SUFFIX)
  const target = enabled
    ? (isOff ? abs.slice(0, -HOOK_OFF_SUFFIX.length) : abs)
    : (isOff ? abs : abs + HOOK_OFF_SUFFIX)
  if (target === abs) return { ok: true, file: abs }
  if (!existsSync(abs)) return { ok: false, error: '文件不存在' }
  if (existsSync(target)) {
    if (enabled) return { ok: false, error: `已有一份生效中的同名规则（${basename(target)}），先关掉或删掉它` }
    try {
      rmSync(target)
    } catch (error) {
      return { ok: false, error: `清理旧的 ${basename(target)} 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  try {
    renameSync(abs, target)
  } catch (error) {
    return { ok: false, error: `改名失败：${error instanceof Error ? error.message : String(error)}` }
  }
  cache.delete(abs)
  cache.delete(target)
  return { ok: true, file: target }
}

/** 不执行代码地读 `export const description = '…'`——关掉的规则不该为了列个名字就被跑一遍 */
function peekDescription(file: string): string | undefined {
  try {
    const source = readFileSync(file, 'utf-8')
    const match = source.match(/export\s+const\s+description\s*=\s*(['"`])([\s\S]*?)\1/)
    const text = match?.[2]?.trim()
    return text ? text.slice(0, 120) : undefined
  } catch {
    return undefined
  }
}

/** 关掉的规则（文件 .off / 整包停用）在清单里的样子 */
function offEntry(source: HookSource, file: string, logical: string, offReason: 'file' | 'plugin'): HookEntry {
  return {
    id: hookIdFor(containerOf(source), logical),
    source,
    file,
    description: peekDescription(file) || stemOf(logical),
    status: 'off',
    offReason,
    events: []
  }
}

/** 所有插件与所有独立智能体里的规则：生效的 / 加载失败的 / 关掉的，供规则页与对话流提醒判断"现在还开着没有" */
export async function listHookEntries(options?: LoadHookFileOptions): Promise<HookEntry[]> {
  const inputs = scanHookInputs(ALL)
  const { report } = hooksDisabledByEnv() ? emptyLoad() : await loadHookRefs(inputs, options, true)
  const entries: HookEntry[] = report.map((entry) => ({ ...entry }))
  const containers = [
    ...inputs.plugins.filter((plugin) => !plugin.info.invalid).map((plugin) => ({
      source: pluginSource(plugin.info.name), active: plugin.hookFiles, disabled: plugin.disabledHookFiles, enabled: plugin.info.enabled
    })),
    ...inputs.agents.map((dir) => ({ ...dir, enabled: true }))
  ]
  for (const { source, active, disabled, enabled } of containers) {
    const liveFiles = new Set(active.map((file) => resolve(file)))
    for (const file of disabled) {
      const logical = file.slice(0, -HOOK_OFF_SUFFIX.length)
      // 同名的生效版已经在清单里：这份 .off 是撤销过又被重写后的残留，不列第二条同 id 的
      if (liveFiles.has(resolve(logical))) continue
      entries.push(offEntry(source, file, logical, 'file'))
    }
    if (!enabled) {
      for (const file of active) entries.push(offEntry(source, file, file, 'plugin'))
    }
  }
  return entries.sort((a, b) =>
    a.source.kind.localeCompare(b.source.kind) || a.source.name.localeCompare(b.source.name) || a.id.localeCompare(b.id)
  )
}
