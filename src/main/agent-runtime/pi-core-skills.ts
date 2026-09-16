import {
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
  type SkillDiagnostic
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { dirname } from 'node:path'
import { SKILL_USAGE_NUDGE } from '../skill-prompt-policy'
import {
  getAgentSkillsDir,
  getBuiltInRoleSkillsDir,
  isAgentWideSkillFile,
  listGlobalSkillDirs,
  readDisabledSkillNames
} from '../openpipal-skill-sources'
import { getAgent } from '../agent-registry'

export interface PiCoreSkillCatalog {
  skills: Skill[]
  promptSection: string
  diagnostics: SkillDiagnostic[]
}

async function canonicalSkillPath(env: NodeExecutionEnv, filePath: string): Promise<string> {
  const canonical = await env.canonicalPath(filePath)
  return canonical.ok ? canonical.value : filePath
}

async function mergeFirstWins(
  env: NodeExecutionEnv,
  dirs: string[],
  diagnostics: SkillDiagnostic[]
): Promise<Skill[]> {
  const byName = new Map<string, Skill>()
  const realPaths = new Set<string>()
  for (const dir of dirs) {
    const loaded = await loadSkills(env, dir)
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills) {
      const canonical = await canonicalSkillPath(env, skill.filePath)
      if (realPaths.has(canonical)) continue
      const winner = byName.get(skill.name)
      if (winner) {
        diagnostics.push({
          type: 'warning',
          code: 'invalid_metadata',
          path: skill.filePath,
          message: `name "${skill.name}" collision; keeping ${winner.filePath}`
        })
        continue
      }
      byName.set(skill.name, skill)
      realPaths.add(canonical)
    }
  }
  return Array.from(byName.values())
}

function formatCatalogPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''
  // Keep legacy prompt bytes stable while delegating XML escaping and listing
  // to pi-core's public formatter. The only upstream wording difference is the
  // instruction line below.
  const official = formatSkillsForSystemPrompt(skills).replace(
    'Read the full skill file when the task matches its description.',
    "Use the read tool to load a skill's file when the task matches its description."
  )
  return `\n\n${official}${SKILL_USAGE_NUDGE}`
}

/** Load one immutable skill snapshot for a pi-core agentChat lifecycle. */
export async function loadPiCoreSkillCatalog(options: {
  workspaceId?: string
  roleName?: string
  /** 统一身份；给了就按它的档案算作用域（Pal / 模板：自己的 + 自荐或被点名的全局技能） */
  agentId?: string
}): Promise<PiCoreSkillCatalog> {
  const env = new NodeExecutionEnv({ cwd: process.cwd() })
  const diagnostics: SkillDiagnostic[] = []
  try {
    let skills: Skill[]
    const profile = getAgent(options.agentId ?? options.workspaceId)
    // 独立智能体：自己的目录 + 全局里自荐（agent-scope: all）或被这个 Agent 点名（frontmatter skills:）的技能
    //（同名自己的优先；全局禁用照样禁）。档案解析不到的 workspaceId（目录坏了）退回只装它自己的目录，点名为空。
    // 与 skill-manager.resolveSkillScope 同一条规则——菜单里列的和模型看到的必须是同一份
    const palDirs = profile?.kind === 'pal' ? profile.skillDirs : (options.workspaceId ? [getAgentSkillsDir(options.workspaceId)] : null)
    if (palDirs) {
      const own = await mergeFirstWins(env, palDirs, diagnostics)
      const global = await mergeFirstWins(env, listGlobalSkillDirs(), diagnostics)
      const disabled = new Set(readDisabledSkillNames())
      const ownNames = new Set(own.map((skill) => skill.name))
      const named = new Set(profile?.kind === 'pal' ? profile.policies.skills : [])
      skills = [
        ...own,
        ...global.filter((skill) => !ownNames.has(skill.name) && !disabled.has(skill.name) && (named.has(skill.name) || isAgentWideSkillFile(skill.filePath)))
      ]
    } else {
      const global = await mergeFirstWins(env, listGlobalSkillDirs(), diagnostics)
      const disabled = new Set(readDisabledSkillNames())
      const enabledGlobal = global.filter((skill) => !disabled.has(skill.name))
      const roleDir = options.roleName ? getBuiltInRoleSkillsDir(options.roleName) : null
      const role = roleDir ? await mergeFirstWins(env, [roleDir], diagnostics) : []
      const roleNames = new Set(role.map((skill) => skill.name))
      skills = [...role, ...enabledGlobal.filter((skill) => !roleNames.has(skill.name))]
    }

    for (const diagnostic of diagnostics) {
      console.log(`[Skills ${diagnostic.code}] ${diagnostic.message} — ${diagnostic.path}`)
    }
    return { skills, promptSection: formatCatalogPrompt(skills), diagnostics }
  } finally {
    await env.cleanup()
  }
}

/** Product projection used by UI/tests that still need a skill directory. */
export function piCoreSkillBaseDir(skill: Skill): string {
  return dirname(skill.filePath)
}
