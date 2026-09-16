/**
 * Agent 注册表——统一身份的第 1 段（设计稿 docs/claude/agent-identity-design.md）。
 *
 * 一个 Agent = 一个目录。内置的出厂放在 resources/system-agents/<id>/（用户可改的副本在 ~/.openpipal/system-agents/<id>/），
 * 用户建的 Pal 在 ~/.openpipal/agents/<id>/。以前还有第三种"模板"（agent-templates/<id>.json）——第 5 段起启动时并入 Pal
 * （agent-template-manager.migrateTemplatesIntoPals），这里不再认它。
 *
 * 这一段只加不改：`getAgent(id)` / `listAgents()` 把三种来源解析成同一份 AgentProfile，现有消费方
 *（role-manager.getRoleConfig、agent-overrides 的 workspaceId / agentId 分支、product-tools 的角色分支）暂时不动，
 * 第 3 段起逐个改成读档案。角色专属行为先以"内置声明表"（BUILTIN_POLICIES）的形式集中到一处，
 * Pal 从 agent.md 的 frontmatter 声明；两者字段相同，代码只认声明、不认名字。
 *
 * id 规则：内置 id 是保留短名（general / design / coding …），Pal 是 uuid，磁盘上不加前缀；
 * 解析顺序 内置 → Pal → 模板，短名与 uuid 撞不上。
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { dataPath } from './data-root'
import { readMark } from './agent-mark-store'
import type { AgentKind, AgentSummary } from '../shared/agent-identity'
import { COMMON_TOOLS, getAllRoles, getRoleConfig, type LayoutManifest, type RoleConfig, PAL_OPT_IN_TOOLS } from './role-manager'
import { parseMemoryEnabled } from './role-loader'
import { parseFrontmatter } from '../shared/frontmatter'
import {
  createWorkspace,
  getWorkspaceDir,
  getWorkspacesRootDir,
  readToolsConfig,
  readWorkspaceMeta,
  writeAgentMd,
  type AgentToolsConfig,
  type WorkspaceMeta
} from './agent-workspace-store'
import { isPalId } from './pal-id'
import { getAgentSkillsDir, getBuiltInRoleSkillsDir } from './openpipal-skill-sources'

export type { AgentKind } from '../shared/agent-identity'

/**
 * 内置 Agent 的分类键（我的 Pal 页的分类标签 / 筛选片）。键是数据，显示文案在 i18n `agents.category.<键>`；
 * Pal 的分类写在 meta.json `category`——同一个键就并进同一组，用户自己的词就自成一组。
 */
export const BUILTIN_CATEGORY: Record<string, string> = {
  general: 'general',
  learner: 'education',
  teacher: 'education',
  office: 'office',
  interpreter: 'language',
  design: 'design',
  coding: 'coding'
}

/**
 * 角色专属行为的声明。今天这些还是 product-tools 等处按角色名写死的分支（见设计稿 §3 的对照表），
 * 这里先把"谁带什么"集中成数据；第 3 段消费方改读这里，分支随之删除。
 */
export interface AgentPolicies {
  /** 整页 HTML 交付物必须是 Design Component（.dc.html）；缺省 free */
  artifacts?: 'dc' | 'free'
  /** jsx 产物的体积 / 预编译闸门 */
  artifactJsxGuards?: boolean
  /** 权限档位：allowed = 不逐条确认（编码助手） */
  permissionTier?: 'allowed'
  /** 每轮注入 + 自动抽取记忆；design 关（agent.md frontmatter `memory: off`） */
  memory: boolean
  /** 素材库里按"系统文件夹"归档（teacher 的 风格.md 约定） */
  archives?: 'role-system'
  /** 点名引入的全局技能（Pal 在 frontmatter 里写 `skills: dc-authoring, deck-stage`） */
  skills: string[]
}

export interface AgentProfile {
  id: string
  kind: AgentKind
  name: string
  icon?: string
  description?: string
  /** 分类键或用户自己的词；没有 = 未分类 */
  category?: string
  /** 内置：~/.openpipal/system-agents/<id>（用户可改的副本）；Pal：~/.openpipal/agents/<id>；模板没有目录 */
  dir?: string
  /** 内置：resources/system-agents/<id>（出厂种子，只读） */
  seedDir?: string
  systemPrompt: string
  /** 工具白名单（内置角色早已是同一份 COMMON_TOOLS；模板可自带一份） */
  tools: string[]
  /** 技能目录，按优先级：自己的在前。全局技能与 agent-scope: all 的产品技能由技能加载器另算，不在这里 */
  skillDirs: string[]
  toolsConfig?: AgentToolsConfig
  workingDir?: string
  /** 自己的规则目录（Pal）；内置角色的规则只来自插件，没有自己的目录 */
  hooksDir?: string
  memoryDir?: string
  assetsDir: string
  mark?: RoleConfig['mark']
  avatarDataUrl?: string
  layoutManifest?: LayoutManifest
  policies: AgentPolicies
}

/**
 * 内置角色的专属行为，从 product-tools / agent-overrides 里按角色名写死的分支抄过来集中一处
 * （product-tools.ts:1050 dc 闸门、:1117 jsx 闸门、agent-overrides.ts:162 权限档位、role-manager.ts:312 归档约定）。
 * 第 3 段这些分支改读档案后，这张表就是它们唯一的事实源；再往后搬进各自目录的 agent.md frontmatter。
 */
const BUILTIN_POLICIES: Record<string, Partial<AgentPolicies>> = {
  design: { artifacts: 'dc', artifactJsxGuards: true },
  teacher: { artifacts: 'dc', archives: 'role-system' },
  coding: { permissionTier: 'allowed' }
}

const ARTIFACT_VALUES = new Set(['dc', 'free'])

/** frontmatter → 声明；认不出的值一律当没写（与 role-loader 的 tools / memory 同一态度） */
export function policiesFromFrontmatter(frontmatter: Record<string, string>, base: Partial<AgentPolicies> = {}): AgentPolicies {
  const artifacts = frontmatter.artifacts?.trim().toLowerCase()
  const tier = frontmatter['permission-tier']?.trim().toLowerCase()
  const skills = (frontmatter.skills || '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    ...base,
    memory: frontmatter.memory !== undefined ? parseMemoryEnabled(frontmatter.memory) : (base.memory ?? true),
    ...(artifacts && ARTIFACT_VALUES.has(artifacts) ? { artifacts: artifacts as 'dc' | 'free' } : {}),
    ...(frontmatter['artifact-jsx-guards']?.trim().toLowerCase() === 'true' ? { artifactJsxGuards: true } : {}),
    ...(tier === 'allowed' ? { permissionTier: 'allowed' as const } : {}),
    skills: Array.from(new Set([...(base.skills ?? []), ...skills]))
  }
}

function builtinProfile(role: RoleConfig): AgentProfile {
  const id = role.name
  const roleSkillsDir = getBuiltInRoleSkillsDir(id)
  return {
    id,
    kind: 'builtin',
    name: role.displayName,
    icon: role.icon,
    ...(BUILTIN_CATEGORY[id] ? { category: BUILTIN_CATEGORY[id] } : {}),
    dir: dataPath('system-agents', id),
    seedDir: roleSkillsDir ? dirname(roleSkillsDir) : undefined,
    systemPrompt: role.systemPrompt,
    tools: role.tools.slice(),
    skillDirs: roleSkillsDir ? [roleSkillsDir] : [],
    memoryDir: dataPath('memory', id),
    assetsDir: join(dataPath('workspace'), 'assets', id),
    mark: role.mark,
    avatarDataUrl: role.avatarDataUrl,
    layoutManifest: role.layoutManifest,
    // 内置的声明也从它自己的 agent.md（用户副本）读，TS 表只是缺省——Pal 那条路（frontmatter 声明）对内置同样成立。
    // memory 一项角色表已经从同一个文件解析过（role-loader），这里沿用它，不再读一遍
    policies: policiesFromFrontmatter(withoutMemory(readAgentMd(dataPath('system-agents', id)).frontmatter), { ...BUILTIN_POLICIES[id], memory: role.memoryEnabled !== false })
  }
}

const withoutMemory = ({ memory: _memory, ...rest }: Record<string, string>): Record<string, string> => rest

function readAgentMd(dir: string): { frontmatter: Record<string, string>; body: string } {
  try {
    const raw = readFileSync(join(dir, 'agent.md'), 'utf-8')
    return parseFrontmatter(raw)
  } catch {
    return { frontmatter: {}, body: '' }
  }
}

function palProfile(meta: WorkspaceMeta): AgentProfile {
  const dir = getWorkspaceDir(meta.id)
  const { frontmatter, body } = readAgentMd(dir)
  const toolsConfig = readToolsConfig(meta.id)
  return {
    id: meta.id,
    kind: 'pal',
    name: meta.name,
    icon: meta.icon,
    description: meta.description,
    ...(typeof meta.category === 'string' && meta.category.trim() ? { category: meta.category.trim() } : {}),
    dir,
    systemPrompt: body,
    // 独立 Pal = 整张公共表，减去要点名才有的那几个（tools/config.json 的 enabledTools 点了就有）
    tools: COMMON_TOOLS.filter(t => !PAL_OPT_IN_TOOLS.includes(t) || !!toolsConfig.enabledTools?.includes(t)),
    skillDirs: [getAgentSkillsDir(meta.id)],
    toolsConfig,
    workingDir: toolsConfig.workingDir,
    hooksDir: join(dir, 'hooks'),
    memoryDir: join(dir, 'memory'),
    assetsDir: join(dir, 'assets'),
    mark: readMark('agent', meta.id) ?? undefined,
    policies: policiesFromFrontmatter(frontmatter)
  }
}

/** 按 id 解析档案：内置 → Pal；认不出返回 undefined（调用方自己决定回落到哪个默认） */
export function getAgent(id: string | undefined | null): AgentProfile | undefined {
  if (!id) return undefined
  const role = getRoleConfig(id)
  if (role) return builtinProfile(role)
  if (isPalId(id)) {
    const meta = readWorkspaceMeta(id)
    if (meta) return palProfile(meta)
  }
  return undefined
}

/** 全部 Agent：内置在前（角色表顺序），然后 Pal；同 id 以先到的为准 */
export function listAgents(): AgentProfile[] {
  const seen = new Set<string>()
  const out: AgentProfile[] = []
  const push = (profile: AgentProfile | undefined): void => {
    if (!profile || seen.has(profile.id)) return
    seen.add(profile.id)
    out.push(profile)
  }
  for (const role of getAllRoles()) push(builtinProfile(role))
  for (const meta of listPalMetas()) push(palProfile(meta))
  return out
}

export { resolveAgentId } from '../shared/agent-identity'

export type { AgentSummary }

/** 只读 meta.json 的 Pal 列表（不算记忆 / 技能 / 任务的计数——那是 listWorkspaces 的活，注册表不要它） */
function listPalMetas(): WorkspaceMeta[] {
  const root = getWorkspacesRootDir()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readWorkspaceMeta(e.name))
    .filter((meta): meta is WorkspaceMeta => !!meta)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Pal 的摘要：meta + mark + 工作目录 + agent.md 头部的声明（正文不要，界面用不上） */
function palSummary(meta: WorkspaceMeta): AgentSummary {
  const dir = getWorkspaceDir(meta.id)
  const category = typeof meta.category === 'string' && meta.category.trim() ? meta.category.trim() : undefined
  const mark = readMark('agent', meta.id)
  const workingDir = readToolsConfig(meta.id).workingDir
  const permissionTier = policiesFromFrontmatter(readAgentMd(dir).frontmatter).permissionTier
  return {
    id: meta.id,
    kind: 'pal',
    name: meta.name,
    ...(meta.icon ? { icon: meta.icon } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(category ? { category } : {}),
    ...(mark ? { mark } : {}),
    ...(workingDir ? { workingDir } : {}),
    ...(permissionTier ? { permissionTier } : {})
  }
}

export function toAgentSummary(profile: AgentProfile): AgentSummary {
  return {
    id: profile.id,
    kind: profile.kind,
    name: profile.name,
    ...(profile.icon ? { icon: profile.icon } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.category ? { category: profile.category } : {}),
    ...(profile.mark ? { mark: profile.mark } : {}),
    ...(profile.avatarDataUrl ? { avatarDataUrl: profile.avatarDataUrl } : {}),
    ...(profile.workingDir ? { workingDir: profile.workingDir } : {}),
    ...(profile.policies.permissionTier ? { permissionTier: profile.policies.permissionTier } : {})
  }
}

/** 选择器 / 我的 Pal 页用的一份列表：内置在前，然后 Pal（Pal 走轻量摘要，不读 agent.md） */
export function listAgentSummaries(): AgentSummary[] {
  const seen = new Set<string>()
  const out: AgentSummary[] = []
  for (const role of getAllRoles()) { seen.add(role.name); out.push(toAgentSummary(builtinProfile(role))) }
  for (const meta of listPalMetas()) { if (!seen.has(meta.id)) { seen.add(meta.id); out.push(palSummary(meta)) } }
  return out
}

/** 档案声明 → agent.md 的 frontmatter 行（复制内置 Agent 成 Pal 时把它带的行为一起带走） */
export function policiesToFrontmatter(policies: AgentPolicies): string[] {
  const lines: string[] = []
  if (policies.artifacts) lines.push(`artifacts: ${policies.artifacts}`)
  if (policies.artifactJsxGuards) lines.push('artifact-jsx-guards: true')
  if (policies.permissionTier) lines.push(`permission-tier: ${policies.permissionTier}`)
  if (!policies.memory) lines.push('memory: off')
  if (policies.skills.length) lines.push(`skills: ${policies.skills.join(', ')}`)
  return lines
}

/**
 * 把一个内置 Agent 复制成用户自己的 Pal：人设正文 + 它声明的行为（frontmatter）+ 它的专属技能名（点名引入，不复制文件）。
 * 内置的不能改、不能删；想在它基础上改，就复制一份。
 */
export function copyBuiltinAsPal(id: string): WorkspaceMeta | undefined {
  const profile = getAgent(id)
  if (profile?.kind !== 'builtin') return undefined
  const ownSkills = profile.skillDirs.flatMap((dir) => {
    try {
      return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
    } catch {
      return []
    }
  })
  const policies: AgentPolicies = { ...profile.policies, skills: Array.from(new Set([...profile.policies.skills, ...ownSkills])) }
  const meta = createWorkspace({ name: `${profile.name} 副本`, icon: profile.icon || '🤖', description: '', category: profile.category })
  const frontmatter = policiesToFrontmatter(policies)
  writeAgentMd(meta.id, (frontmatter.length ? ['---', ...frontmatter, '---', ''].join('\n') + '\n' : '') + profile.systemPrompt.trimEnd() + '\n')
  return meta
}
