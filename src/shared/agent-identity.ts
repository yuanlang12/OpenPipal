/**
 * 统一的 Agent 身份（设计稿 docs/claude/agent-identity-design.md，第 2 段）。
 *
 * 一条对话 / 一个任务只属于一个 Agent：内置的（general / design / coding …）或用户建的 Pal（uuid）。
 * 老记录背着三个字段——`role`（内置角色名）、`workspaceId`（Pal）、`agentId`（模板，历史含义）——
 * 这里统一派生成一个 `agent`。持久化时新旧字段并存一版（老版本照样能打开），读侧永远按这个顺序派生：
 * Pal 最具体 → 模板 → 角色名 → 通用助手。
 *
 * 字段名叫 `agent` 而不是 `agentId`：`agentId` 在对话 / 任务 / ACP 接口里早已是"模板 id"的意思，
 * 二十多处消费方按这个含义在读；换个名字让两种含义并存一版，等老字段下线再谈改名。
 */
export const DEFAULT_AGENT_ID = 'general'

export interface AgentIdentityRecord {
  agent?: string | null
  workspaceId?: string | null
  agentId?: string | null
  role?: string | null
}

export function resolveAgentId(record: AgentIdentityRecord): string {
  return record.agent || record.workspaceId || record.agentId || record.role || DEFAULT_AGENT_ID
}

export type AgentKind = 'builtin' | 'pal'

/** 捏头像的配饰组合（agents/<id>/mark.json 或 system-agents/<role>/mark.json） */
export interface AgentMark {
  accessory?: string
  /** 身体色 */
  hue?: string
  /** 配饰色；没写就按搭配表取身体色的搭子 */
  accent?: string
  shape?: string
}

/** 给渲染层 / HTTP 的一行摘要（主进程 listAgentSummaries 产出）：不带提示词与目录。内置 = kind === 'builtin' */
export interface AgentSummary {
  id: string
  kind: AgentKind
  name: string
  icon?: string
  description?: string
  category?: string
  mark?: AgentMark
  avatarDataUrl?: string
  workingDir?: string
  /** 档案声明里的权限档位（内置表或 agent.md frontmatter `permission-tier: allowed`）：界面据此决定给不给档位控件 */
  permissionTier?: 'allowed'
}
