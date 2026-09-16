/**
 * Team Store —— 团队 = 几个 Pal 围着一个真实项目干活的地方（设计稿 docs/claude/team-collaboration-design.md §2–§5）。
 *
 * 目录（文件式，有即开启；没有 teams/ 时所有团队代码路径都走不到）：
 *   ~/.openpipal/teams/<id>/
 *     team.md            frontmatter 声明：name / lead / members / tier / approvers / handoff-budget；正文 = 章程（人写）
 *     memory/            团队记忆：一事一文件 + MEMORY.md 索引（只把索引进提示词，正文按需 read）
 *     rules/             团队规则（hook 文件，第 3 段接入）
 *     tools/config.json  团队工具边界（与 Pal 同形 AgentToolsConfig：workingDir / mcpServers / disabledTools）
 *     shared/            共享文件夹；没配 workingDir 时就是默认工作目录
 *     mark.json          团队自己的 mark（agent-mark-store 的 'team' 作用域）
 *     channels/<name>/   可选。同一套布局的子集；缺哪个文件就继承团队的（§2.1：频道只收窄不放宽）
 *
 * 团队不是安全边界的替代：所有话题都跑在这台 Mac 上、用这台 Mac 的权限。边界是天花板（tier）+ 规则 + 审批，
 * 名单只决定"谁能被交接"。成员的人设与记忆仍是各自的私事（agents/<成员>/ 互相不可读，见 pi-security 租户规则）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import { randomUUID } from 'crypto'
import { dataPath } from './data-root'
import { parseFrontmatter } from '../shared/frontmatter'
import { isPalId } from './pal-id'
import { createWorkspace, readWorkspaceMeta, renameWorkspace, writeAgentMd, type AgentToolsConfig } from './agent-workspace-store'
import { writeMarkFile } from './agent-mark-file'
import { composeMark, type MarkConfig } from '../shared/agent-mark-catalog'

export type TeamTier = 'readonly' | 'auto' | 'full'
const TIER_ORDER: TeamTier[] = ['readonly', 'auto', 'full']
const DEFAULT_TIER: TeamTier = 'auto'
/** 一轮里 Lead 最多交接几次（§8 拐杖；team.md `handoff-budget: off` 关掉） */
export const DEFAULT_HANDOFF_BUDGET = 6
/**
 * 两份 MCP 白名单求交为空时的占位：空数组在 mcp-manager 里表示"全部允许"，
 * 交集为空必须表达成"一个都不许"，所以放一个任何服务器名都撞不上的名字。
 */
export const NO_MCP_SERVERS_SENTINEL = '__openpipal_no_mcp_server__'

export interface TeamMember {
  id: string
  name: string
  description?: string
}

// ---- 变更通知：团队目录一动（team.md / 记忆），订阅方（IPC → 左栏、团队面板）当场刷新，不用等话题跑完 ----

type TeamListener = (teamId: string) => void
const teamListeners = new Set<TeamListener>()

export function onTeamChanged(listener: TeamListener): () => void {
  teamListeners.add(listener)
  return () => { teamListeners.delete(listener) }
}

/** 同一个同步段里的多次写（整理引擎一次落三条记忆）合成一次通知：订阅方每次都是整份重拉 */
const pendingTeamChanges = new Set<string>()
function emitTeamChanged(teamId: string): void {
  if (pendingTeamChanges.size === 0) queueMicrotask(flushTeamChanges)
  pendingTeamChanges.add(teamId)
}
function flushTeamChanges(): void {
  const ids = Array.from(pendingTeamChanges)
  pendingTeamChanges.clear()
  for (const teamId of ids) {
    teamListeners.forEach((listener) => {
      try { listener(teamId) } catch (err) { console.warn('[Team] 变更通知失败:', (err as Error)?.message) }
    })
  }
}

export interface TeamSummary {
  id: string
  name: string
  lead: string
  members: string[]
  tier: TeamTier
  channels: string[]
  createdAt: number
  updatedAt: number
}

export interface Team extends TeamSummary {
  /** team.md 原文（frontmatter + 章程），给面板编辑用 */
  teamMd: string
  /** 章程正文（不含 frontmatter） */
  charter: string
  approvers: string[]
  handoffBudget: number | 'off'
  toolsConfig: AgentToolsConfig
  dir: string
  sharedDir: string
  memoryIndex: string
}

/** 一条话题实际生效的团队层：团队 ∩ 频道（频道只收窄） */
export interface TeamScope {
  teamId: string
  channel?: string
  name: string
  lead: string
  members: TeamMember[]
  tier: TeamTier
  approvers: string[]
  handoffBudget: number | 'off'
  workingDir: string
  sharedDir: string
  charters: Array<{ label: string; body: string }>
  memoryIndexes: Array<{ label: string; dir: string; index: string }>
  /** Pal 写团队记忆落这里：有频道写频道的，没有写团队的（§6） */
  memoryWriteDir: string
  toolsConfig: AgentToolsConfig
  rulesDirs: string[]
}

const TEAMS_DIR = dataPath('teams')
const ID_RE = /^[\w-]+$/

export function getTeamsRootDir(): string {
  return TEAMS_DIR
}

export function getTeamDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid team id: ${id}`)
  return join(TEAMS_DIR, id)
}

/** 这个 id 是不是一个团队——只看 teams/<id>/team.md 在不在 */
export function isTeamId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id) && existsSync(join(TEAMS_DIR, id, 'team.md'))
}

function isChannelName(name: unknown): name is string {
  return typeof name === 'string' && /^[^/\\.\s][^/\\]{0,63}$/.test(name)
}

export function getChannelDir(teamId: string, channel: string): string {
  if (!isChannelName(channel)) throw new Error(`Invalid channel name: ${channel}`)
  return join(getTeamDir(teamId), 'channels', channel)
}

// ---- 声明解析 ----

interface Declarations {
  name?: string
  lead?: string
  members?: string[]
  tier?: TeamTier
  approvers?: string[]
  handoffBudget?: number | 'off'
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

/** frontmatter → 声明；认不出的值一律当没写（与 agent-registry 的 policiesFromFrontmatter 同一态度） */
export function declarationsFromFrontmatter(frontmatter: Record<string, string>): Declarations {
  const tierRaw = frontmatter.tier?.trim().toLowerCase()
  const budgetRaw = frontmatter['handoff-budget']?.trim().toLowerCase()
  let handoffBudget: number | 'off' | undefined
  if (budgetRaw === 'off') handoffBudget = 'off'
  else if (budgetRaw) {
    const n = parseInt(budgetRaw, 10)
    if (Number.isFinite(n) && n > 0) handoffBudget = n
  }
  return {
    ...(frontmatter.name?.trim() ? { name: frontmatter.name.trim() } : {}),
    ...(frontmatter.lead?.trim() ? { lead: frontmatter.lead.trim() } : {}),
    ...(frontmatter.members !== undefined ? { members: splitList(frontmatter.members) } : {}),
    ...(tierRaw && (TIER_ORDER as string[]).includes(tierRaw) ? { tier: tierRaw as TeamTier } : {}),
    ...(frontmatter.approvers !== undefined ? { approvers: splitList(frontmatter.approvers) } : {}),
    ...(handoffBudget !== undefined ? { handoffBudget } : {})
  }
}

function readMd(file: string): { frontmatter: Record<string, string>; body: string; raw: string } | null {
  try {
    const raw = readFileSync(file, 'utf-8')
    return { ...parseFrontmatter(raw), raw }
  } catch {
    return null
  }
}

function readToolsConfigAt(dir: string): AgentToolsConfig | undefined {
  const file = join(dir, 'tools', 'config.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as AgentToolsConfig : undefined
  } catch (err: any) {
    console.warn(`[Team] tools/config.json 解析失败 (${dir}): ${err.message}`)
    return undefined
  }
}

/**
 * 记忆索引在读的时候从文件现算（一事一文件的 frontmatter：description / type），不依赖 MEMORY.md——
 * Pal 用 write 工具直接往 memory/ 里放文件，没有任何一处会替它更新 MEMORY.md；现算永远是真的。
 * MEMORY.md 仍由 rebuildTeamMemoryIndex 写一份给人看（Finder 里翻）。
 */
function memoryIndexLines(memoryDir: string): string[] {
  const lines: string[] = []
  for (const f of listFilesAt(memoryDir, n => n.endsWith('.md') && n !== 'MEMORY.md')) {
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(join(memoryDir, f), 'utf-8'))
      const name = f.replace(/\.md$/, '')
      const desc = frontmatter.description?.trim() || name
      const type = frontmatter.type?.trim()
      lines.push(`- [${name}](${f})${type ? ` (${type})` : ''} -- ${desc}`)
    } catch { /* 读不了的文件不进索引 */ }
  }
  return lines
}

function readMemoryIndexAt(dir: string): string {
  return memoryIndexLines(join(dir, 'memory')).join('\n')
}

function statTimes(dir: string): { createdAt: number; updatedAt: number } {
  try {
    const teamMd = statSync(join(dir, 'team.md'))
    const root = statSync(dir)
    return { createdAt: Math.round(root.birthtimeMs || root.ctimeMs), updatedAt: Math.round(teamMd.mtimeMs) }
  } catch {
    const now = Date.now()
    return { createdAt: now, updatedAt: now }
  }
}

// ---- 求交（只收窄不放宽） ----

export function intersectTier(a: TeamTier | undefined, b: TeamTier | undefined): TeamTier {
  const ia = TIER_ORDER.indexOf(a ?? DEFAULT_TIER)
  const ib = TIER_ORDER.indexOf(b ?? DEFAULT_TIER)
  return TIER_ORDER[Math.min(ia < 0 ? 1 : ia, ib < 0 ? 1 : ib)]
}

/**
 * 成员配置 ∩ 边界：禁用工具取并集；MCP 白名单两边都写了取交集（交集为空 = 一个都不许），
 * 只有一边写了就用那一边；工作目录一律用边界的（团队的），边界没写才用成员自己的。
 */
export function intersectToolsConfig(
  narrow: AgentToolsConfig | undefined,
  boundary: AgentToolsConfig | undefined
): AgentToolsConfig {
  const disabled = Array.from(new Set([...(narrow?.disabledTools ?? []), ...(boundary?.disabledTools ?? [])]))
  const a = narrow?.mcpServers ?? []
  const b = boundary?.mcpServers ?? []
  let mcpServers: string[] | undefined
  if (a.length && b.length) {
    const inter = a.filter(s => b.includes(s))
    mcpServers = inter.length ? inter : [NO_MCP_SERVERS_SENTINEL]
  } else if (a.length || b.length) {
    mcpServers = a.length ? a.slice() : b.slice()
  }
  const workingDir = boundary?.workingDir || narrow?.workingDir
  return {
    ...(workingDir ? { workingDir } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(disabled.length ? { disabledTools: disabled } : {})
  }
}

// ---- 读 ----

function resolveMembers(ids: string[] | undefined, allowed?: string[]): string[] {
  const out: string[] = []
  for (const id of ids ?? []) {
    if (allowed ? !allowed.includes(id) : !isPalId(id)) {
      console.warn(`[Team] 名单里的 ${id.slice(0, 8)} ${allowed ? '不在团队名单里' : '不是一个 Pal'}，已忽略`)
      continue
    }
    if (!out.includes(id)) out.push(id)
  }
  return out
}

export function listChannels(teamId: string): string[] {
  const dir = join(getTeamDir(teamId), 'channels')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && isChannelName(e.name))
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

export function readTeam(id: string): Team | null {
  if (!ID_RE.test(id)) return null
  const dir = join(TEAMS_DIR, id)
  const md = readMd(join(dir, 'team.md'))
  if (!md) return null
  const decl = declarationsFromFrontmatter(md.frontmatter)
  const members = resolveMembers(decl.members)
  const lead = decl.lead && members.includes(decl.lead) ? decl.lead : members[0]
  if (decl.lead && lead !== decl.lead) console.warn(`[Team] ${id.slice(0, 8)} 的 lead 不在名单里，改用名单第一个`)
  const times = statTimes(dir)
  const sharedDir = join(dir, 'shared')
  return {
    id,
    name: decl.name || id.slice(0, 8),
    lead: lead || '',
    members,
    tier: decl.tier ?? DEFAULT_TIER,
    channels: listChannels(id),
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
    teamMd: md.raw,
    charter: md.body.trim(),
    approvers: decl.approvers ?? [],
    handoffBudget: decl.handoffBudget ?? DEFAULT_HANDOFF_BUDGET,
    toolsConfig: readToolsConfigAt(dir) ?? {},
    dir,
    sharedDir,
    memoryIndex: readMemoryIndexAt(dir)
  }
}

export function listTeams(): TeamSummary[] {
  if (!existsSync(TEAMS_DIR)) return []
  const out: TeamSummary[] = []
  for (const entry of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue
    const team = readTeam(entry.name)
    if (!team) continue
    out.push({
      id: team.id, name: team.name, lead: team.lead, members: team.members, tier: team.tier,
      channels: team.channels, createdAt: team.createdAt, updatedAt: team.updatedAt
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function memberOf(id: string): TeamMember {
  const meta = readWorkspaceMeta(id)
  return {
    id,
    name: meta?.name || id.slice(0, 8),
    ...(meta?.description ? { description: meta.description } : {})
  }
}

/**
 * 一条话题实际生效的团队层。频道存在就叠上去：名单 / lead / tier / approvers / 工具边界只收窄，
 * 章程与记忆索引按"团队 → 频道"顺序拼接（Claude Tag 的 scope 链：窄的补充宽的，不替换）。
 * 团队或频道不存在返回 null（调用方决定报错还是回落）。
 */
export function resolveTeamScope(teamId: string, channel?: string): TeamScope | null {
  const team = readTeam(teamId)
  if (!team || team.members.length === 0) return null
  let members = team.members
  let lead = team.lead
  let tier = team.tier
  let approvers = team.approvers
  let toolsConfig = team.toolsConfig
  let workingDir = team.toolsConfig.workingDir || team.sharedDir
  let sharedDir = team.sharedDir
  let memoryWriteDir = join(team.dir, 'memory')
  const charters = team.charter ? [{ label: team.name, body: team.charter }] : []
  const memoryIndexes = team.memoryIndex ? [{ label: team.name, dir: join(team.dir, 'memory'), index: team.memoryIndex }] : []
  const rulesDirs = [join(team.dir, 'rules')]

  if (channel !== undefined) {
    if (!isChannelName(channel)) return null
    const cdir = join(team.dir, 'channels', channel)
    if (!existsSync(cdir)) return null
    const md = readMd(join(cdir, 'team.md'))
    const decl = md ? declarationsFromFrontmatter(md.frontmatter) : {}
    if (decl.members?.length) {
      const narrowed = resolveMembers(decl.members, team.members)
      if (narrowed.length) members = narrowed
    }
    lead = decl.lead && members.includes(decl.lead) ? decl.lead : (members.includes(lead) ? lead : members[0])
    tier = intersectTier(team.tier, decl.tier)
    if (decl.approvers?.length) approvers = decl.approvers
    const channelTools = readToolsConfigAt(cdir)
    if (channelTools) toolsConfig = intersectToolsConfig(channelTools, team.toolsConfig)
    const channelShared = join(cdir, 'shared')
    if (existsSync(channelShared)) sharedDir = channelShared
    workingDir = channelTools?.workingDir || (existsSync(channelShared) ? channelShared : workingDir)
    memoryWriteDir = join(cdir, 'memory')
    const channelLabel = `${team.name} › ${decl.name || channel}`
    if (md?.body.trim()) charters.push({ label: channelLabel, body: md.body.trim() })
    const idx = readMemoryIndexAt(cdir)
    if (idx) memoryIndexes.push({ label: channelLabel, dir: join(cdir, 'memory'), index: idx })
    rulesDirs.push(join(cdir, 'rules'))
  }

  return {
    teamId,
    ...(channel !== undefined ? { channel } : {}),
    name: team.name,
    lead,
    members: members.map(memberOf),
    tier,
    approvers,
    handoffBudget: team.handoffBudget,
    workingDir,
    sharedDir,
    charters,
    memoryIndexes,
    memoryWriteDir,
    toolsConfig,
    rulesDirs
  }
}

/** 给检视面板看的全貌：成员带名字、记忆正文、规则 / 共享文件名。所见即磁盘（团队级自动化由 IPC 层从 task-store 拼上） */
export interface TeamDetail extends Team {
  memberProfiles: TeamMember[]
  memories: Array<{ name: string; content: string }>
  rules: string[]
  sharedFiles: string[]
}

function listFilesAt(dir: string, filter: (name: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.') && filter(e.name))
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 一个 memory/ 目录里的条目（不含 MEMORY.md 索引）：面板展示与整理引擎判断 update / create 都读这份 */
export function readTeamMemoryEntries(memoryDir: string): Array<{ name: string; content: string }> {
  return listFilesAt(memoryDir, n => n.endsWith('.md') && n !== 'MEMORY.md').map(name => {
    try { return { name: name.replace(/\.md$/, ''), content: readFileSync(join(memoryDir, name), 'utf-8') } } catch { return { name, content: '' } }
  })
}

export function getTeamDetail(id: string): TeamDetail | null {
  const team = readTeam(id)
  if (!team) return null
  return {
    ...team,
    memberProfiles: team.members.map(memberOf),
    memories: readTeamMemoryEntries(join(team.dir, 'memory')),
    rules: listFilesAt(join(team.dir, 'rules'), n => /\.(ts|js|mjs|cjs)(\.off)?$/.test(n)),
    sharedFiles: listFilesAt(team.sharedDir)
  }
}

const TEAM_FILE_PREVIEW_MAX = 200 * 1024

/** 面板预览团队目录里的一个文件：只认团队目录内的普通文件，超 200KB 截断（不给渲染层任意路径读的口子） */
export function readTeamFile(id: string, relPath: string): string | null {
  const dir = getTeamDir(id)
  if (!existsSync(join(dir, 'team.md'))) return null
  const target = join(dir, relPath)
  const rel = relative(dir, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  try {
    const info = statSync(target)
    if (!info.isFile()) return null
    const content = readFileSync(target, 'utf-8')
    return content.length > TEAM_FILE_PREVIEW_MAX ? content.slice(0, TEAM_FILE_PREVIEW_MAX) + '\n…（已截断）' : content
  } catch {
    return null
  }
}

// ---- 写 ----

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function renderTeamMd(decl: { name: string; lead: string; members: string[]; tier?: TeamTier; approvers?: string[] }, charter = ''): string {
  const lines = [
    '---',
    `name: ${decl.name}`,
    `lead: ${decl.lead}`,
    `members: ${decl.members.join(', ')}`,
    `tier: ${decl.tier ?? DEFAULT_TIER}`,
    ...(decl.approvers?.length ? [`approvers: ${decl.approvers.join(', ')}`] : []),
    '---',
    ''
  ]
  return lines.join('\n') + (charter ? charter.trim() + '\n' : '')
}

export function createTeam(data: { name: string; members: string[]; lead?: string; tier?: TeamTier; charter?: string }): Team {
  const name = data.name?.trim()
  if (!name) throw new Error('团队要有名字')
  const members = Array.from(new Set((data.members ?? []).map(s => s.trim()).filter(Boolean)))
  if (members.length === 0) throw new Error('团队至少要有一个成员')
  const notPal = members.find(id => !isPalId(id))
  if (notPal) throw new Error(`成员 ${notPal} 不是一个 Pal`)
  const lead = data.lead?.trim() || members[0]
  if (!members.includes(lead)) throw new Error('Lead 必须在成员名单里')
  const id = randomUUID()
  const dir = getTeamDir(id)
  ensureDir(join(dir, 'memory'))
  ensureDir(join(dir, 'shared'))
  ensureDir(join(dir, 'rules'))
  writeFileSync(join(dir, 'team.md'), renderTeamMd({ name, lead, members, tier: data.tier }, data.charter), 'utf-8')
  console.log(`[Team] 创建: ${name} (${id.slice(0, 8)}，${members.length} 个成员)`)
  const team = readTeam(id)
  if (!team) throw new Error('团队写入后读不回来')
  emitTeamChanged(id)
  return team
}

export function writeTeamMd(id: string, content: string): void {
  const dir = getTeamDir(id)
  if (!existsSync(join(dir, 'team.md'))) throw new Error(`团队不存在: ${id}`)
  writeFileSync(join(dir, 'team.md'), content, 'utf-8')
  emitTeamChanged(id)
}

// ---- 组建：建团队 = 跟组长聊（所有者 2026-09-14 定的：不要弹窗和确认）----

const FOUNDING_TEAM_NAME = '新团队'
const founderName = (teamName: string): string => `${teamName}组长`

/** 默认组长的人设：团队刚成立时它唯一的活是把团队聊出来；成员到位后就是普通的 Lead */
function founderAgentMd(teamName: string): string {
  return [
    `# ${founderName(teamName)}`,
    '',
    `你是团队「${teamName}」的组长。团队刚成立，名单里只有你。`,
    '先跟主人聊清楚：这个团队做什么、要哪些角色、东西放哪、有什么规矩。聊清楚一段就落一段——用 manage_team 起名字、写章程、建成员，不用等最后一起写。',
    '建成员时把它的人设写具体（它做什么、怎么做、不做什么），主人已有合适的 Pal 就直接加进来，别重复建。',
    '成员到位后，每条话题先到你这里：能自己做的就做，该分派的用 subagent 交给成员。回答简洁。',
    ''
  ].join('\n')
}

/**
 * 组建一个团队：先造一个默认组长（一个普通的 Pal，人设是"把团队聊出来"），团队名单只有它。
 * 名字先叫「新团队」，主人跟组长聊的过程中由组长用 manage_team 改名、写章程、建成员。
 */
export function foundTeam(): Team {
  const lead = createWorkspace({ name: founderName(FOUNDING_TEAM_NAME), icon: '🧭', description: '组建团队、分派话题' })
  writeAgentMd(lead.id, founderAgentMd(FOUNDING_TEAM_NAME))
  writeMarkFile('agent', lead.id, composeMark(lead.id, 'briefcase'))
  return createTeam({ name: FOUNDING_TEAM_NAME, members: [lead.id], lead: lead.id })
}

/** 团队还没成形：名单里只有组长、章程还是空的（提示词与空状态据此换话） */
export function isTeamForming(scope: Pick<TeamScope, 'members' | 'charters'>): boolean {
  return scope.members.length <= 1 && scope.charters.every(c => !c.body.trim())
}

export interface TeamMdPatch {
  name?: string
  lead?: string
  members?: string[]
  tier?: TeamTier
  approvers?: string[]
  charter?: string
}

/** 改 team.md：只动给了的字段，其余 frontmatter（handoff-budget 之类）原样保留 */
export function updateTeamMd(id: string, patch: TeamMdPatch): Team {
  const team = readTeam(id)
  if (!team) throw new Error(`团队不存在: ${id}`)
  const { frontmatter, body } = parseFrontmatter(team.teamMd)
  const next: Record<string, string> = { ...frontmatter }
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('团队名字不能为空')
    next.name = name
  }
  if (patch.members !== undefined) {
    const members = Array.from(new Set(patch.members.map(s => s.trim()).filter(Boolean)))
    if (members.length === 0) throw new Error('团队至少要有一个成员')
    const notPal = members.find(m => !isPalId(m))
    if (notPal) throw new Error(`成员 ${notPal} 不是一个 Pal`)
    next.members = members.join(', ')
  }
  const members = splitList(next.members) ?? []
  if (patch.lead !== undefined) {
    if (!members.includes(patch.lead)) throw new Error('Lead 必须在成员名单里')
    next.lead = patch.lead
  } else if (next.lead && !members.includes(next.lead)) {
    next.lead = members[0]
  }
  if (patch.tier !== undefined) next.tier = patch.tier
  if (patch.approvers !== undefined) next.approvers = patch.approvers.join(', ')
  const charter = (patch.charter !== undefined ? patch.charter : body).trim()
  const fm = Object.entries(next).map(([k, v]) => `${k}: ${v}`).join('\n')
  writeTeamMd(id, `---\n${fm}\n---\n\n${charter}${charter ? '\n' : ''}`)
  return readTeam(id)!
}

/** 改名；组长还叫默认名（「<旧名>组长」）就一起改 */
export function renameTeam(id: string, name: string): Team {
  const before = readTeam(id)
  if (!before) throw new Error(`团队不存在: ${id}`)
  const team = updateTeamMd(id, { name })
  const leadMeta = readWorkspaceMeta(team.lead)
  if (leadMeta && leadMeta.name === founderName(before.name)) renameWorkspace(team.lead, founderName(team.name))
  return team
}

export function addTeamMember(id: string, palId: string): Team {
  const team = readTeam(id)
  if (!team) throw new Error(`团队不存在: ${id}`)
  if (team.members.includes(palId)) return team
  return updateTeamMd(id, { members: [...team.members, palId] })
}

/**
 * 组长给团队造一个新成员：一个普通的 Pal（人设由组长写），再加进名单。
 * 头像直接捏好（所有者 2026-09-14：不要 emoji）：配饰按角色挑（组长给 look），颜色与轮廓由 id 散列，
 * 落 agents/<id>/mark.json——与手捏的同一个文件、同一个写入口（agent-mark-file），在即生效。
 */
export function createTeamMember(id: string, data: { name: string; description?: string; persona: string; look?: string }): { memberId: string; mark: MarkConfig } {
  const team = readTeam(id)
  if (!team) throw new Error(`团队不存在: ${id}`)
  const name = data.name.trim()
  if (!name) throw new Error('成员要有名字')
  if (!data.persona?.trim()) throw new Error('成员要有人设（它做什么、怎么做）')
  const meta = createWorkspace({ name, icon: '🤖', description: (data.description || '').trim() })
  writeAgentMd(meta.id, data.persona.trim().startsWith('#') ? `${data.persona.trim()}\n` : `# ${name}\n\n${data.persona.trim()}\n`)
  const mark = composeMark(meta.id, data.look?.trim())
  writeMarkFile('agent', meta.id, mark)
  updateTeamMd(id, { members: [...team.members, meta.id] })
  return { memberId: meta.id, mark }
}

export function removeTeamMember(id: string, palId: string): Team {
  const team = readTeam(id)
  if (!team) throw new Error(`团队不存在: ${id}`)
  if (palId === team.lead) throw new Error('Lead 不能移出名单；先换 Lead')
  return updateTeamMd(id, { members: team.members.filter(m => m !== palId) })
}

export function setTeamLead(id: string, palId: string): Team {
  return updateTeamMd(id, { lead: palId })
}

export function deleteTeam(id: string): boolean {
  const dir = getTeamDir(id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  console.log(`[Team] 删除: ${id.slice(0, 8)}`)
  emitTeamChanged(id)
  return true
}

/** 成员写团队记忆：一事一文件，落频道 / 团队的 memory/，并重建 MEMORY.md 索引（与 Pal 记忆同一种格式） */
export function writeTeamMemory(scope: Pick<TeamScope, 'memoryWriteDir' | 'teamId'>, fileName: string, content: string): string {
  const dir = scope.memoryWriteDir
  ensureDir(dir)
  const safe = fileName.replace(/[^\w一-鿿.-]+/g, '-').replace(/^-+|-+$/g, '') || 'note'
  const file = join(dir, safe.endsWith('.md') ? safe : `${safe}.md`)
  writeFileSync(file, content, 'utf-8')
  rebuildTeamMemoryIndex(dir)
  emitTeamChanged(scope.teamId)
  return file
}

export function rebuildTeamMemoryIndex(dir: string): void {
  if (!existsSync(dir)) return
  writeFileSync(join(dir, 'MEMORY.md'), memoryIndexLines(dir).join('\n') + '\n', 'utf-8')
}

// ---- 提示词：团队层 ----

/**
 * 团队层提示词（§6 顺序：成员人设 → 团队章程 → 频道章程 → 团队记忆索引 → 频道记忆索引 → 成员记忆）。
 * Lead 版多一段"怎么交接"；成员版多一段"做完怎么回报、不能再交接"。
 * 只放每次都需要的：名单一句话、章程全文、记忆索引；正文靠 read 按需取。
 */
/** 频道最近话题的一行（Tier-1 索引：只有标题、时间、产物目录；别的话题的对话记录读不到） */
export interface RecentThread {
  title: string
  updatedAt: number
  outputsDir: string
}

export function buildTeamPromptLayer(
  scope: TeamScope,
  selfId: string,
  role: 'lead' | 'member',
  extras: { recentThreads?: RecentThread[] } = {}
): string {
  const isLead = role === 'lead'
  const title = scope.channel ? `${scope.name} › ${scope.channel}` : scope.name
  const lines: string[] = [`## 你所在的团队：${title}`]
  if (isLead) {
    if (isTeamForming(scope)) {
      lines.push(
        '你是这个团队的 Lead（组长）。团队刚成立：名单里只有你，章程还是空的。',
        '先跟主人聊清楚这个团队做什么、要哪些角色、东西放哪、有什么规矩；聊清楚一段就落一段——',
        '用 `manage_team` 起名字（rename）、写章程（set_charter）、建新成员（create_member，把它的人设写具体）或把主人已有的 Pal 加进来（add_member），不用等最后一起写。',
        '成员到位后，每条话题先到你这里：能自己做的就做，该分派的用 `subagent` 工具、把 `pal` 填成成员的 id 交给它。'
      )
    } else {
      lines.push(
        '你是这个团队的 Lead（前台）。发到团队的每条话题先到你这里：自己几句话或几个工具能做完的就自己做；',
        '该由某个成员做的，用 `subagent` 工具、把 `pal` 填成成员的 id 交给它，它做完把结果带回来，再由你决定下一步或回复。',
        '成员看不到这条话题，`task` 里要写全交接条五项：任务 / 依据（文件路径与事实）/ 输出放哪 / 没解决的 / 下一步谁。',
        '做不下去就立刻回报卡在哪，别换法子反复重试。每轮交接次数有预算，工具结果里会告诉你还剩几次。',
        '主人在 App 里跟你聊的时候，团队自己的事（改名、改章程、加减成员、换 Lead）用 `manage_team`；定时跑的话题里没有这个工具。'
      )
    }
  } else {
    lines.push(
      '你是这个团队的成员，本次由 Lead 交接给你。只做交接条里的任务；做完把产物放到交接条要求的位置，',
      '最后一条回复按五项回报：做了什么 / 产物路径 / 依据 / 没解决的 / 建议下一步谁。你不能再交接给别人，也不能直接问用户。'
    )
  }
  lines.push('', '### 成员')
  for (const m of scope.members) {
    const leadHere = isLead ? m.id === selfId : m.id === scope.lead
    const tag = leadHere ? '（Lead' + (m.id === selfId ? '，就是你）' : '）') : (m.id === selfId ? '（就是你）' : '')
    lines.push(`- ${m.name}${tag} id: ${m.id}${m.description ? ` — ${m.description}` : ''}`)
  }
  lines.push('', '### 工作目录', `团队共用 ${scope.workingDir}；共享文件夹 ${scope.sharedDir}。团队的章程、规则、工具边界只有人在 App 里能改；你只能写团队的 memory/ 与 shared/。`)
  for (const c of scope.charters) lines.push('', `### 章程：${c.label}`, c.body)
  for (const m of scope.memoryIndexes) {
    lines.push('', `### 团队记忆索引：${m.label}`, `需要细节时 read ${m.dir}/ 下对应文件：`, m.index)
  }
  // 团队记忆怎么写（§6 的卫生规则）：用现成的 write 工具落一事一文件，索引读的时候现算，不用它维护 MEMORY.md
  lines.push(
    '',
    '### 团队记忆怎么写',
    `值得全团队记住的事（决定 / 约定 / 踩过的坑 / 外部资料）用 write 写成 ${scope.memoryWriteDir}/<一事一名>.md：`,
    '开头 frontmatter 三行 description（一句话）/ type（decision | convention | gotcha | reference）/ modified（今天日期），正文写清是什么、为什么。',
    '先看上面的索引：已有条目就改它，不另开；被纠正过的事把纠正本身记下；代码、git、本话题里已经记着的过程不记；这里对全团队可见，关于某个人的私事不进。'
  )
  if (isLead && extras.recentThreads?.length) {
    lines.push('', '### 频道最近话题', '只列标题与产物目录；别的话题的对话记录读不到，产物目录可以 read / ls：')
    for (const th of extras.recentThreads) {
      lines.push(`- ${th.title}（${new Date(th.updatedAt).toISOString().slice(0, 10)}）产物：${th.outputsDir}/`)
    }
  }
  return lines.join('\n')
}
