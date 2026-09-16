/**
 * 共享逻辑:从 agentId / workspaceId / conversationConfig 构造 AgentOverrides
 *
 * 之前这段逻辑只在 ipc-handlers.ts (chat:send) 里 inline,导致 HTTP /chat/stream
 * 走的路径拿不到 workspace 的 agent.md + memories,Agent 选择对 ACP 无效。
 *
 * Stage 8: 抽成共享函数,ipc-handlers 和 http-server 都用同一份,
 * 保证桌面端 IPC 和 openpipal-acp HTTP 链路行为一致。
 */

import type { AgentOverrides } from './agent-runtime/contracts'
import type { ConversationConfig } from './conversation-service'
import { listConversationsCached, peekConversation, updateConversationConfig } from './conversation-service'
import { outputsDirFor } from './data-root'
import { loadConfig } from './config-manager'
import { getWorkspace } from './agent-workspace-store'
import { palIdOf } from './pal-id'
import { getRoleConfig } from './role-manager'
import { getAgent, type AgentProfile } from './agent-registry'
import { parseFrontmatter } from '../shared/frontmatter'
import { DEFAULT_AGENT_ID, resolveAgentId } from '../shared/agent-identity'
import { capInsert } from './prompt-cache-fifo'
import { buildTeamPromptLayer, resolveTeamScope } from './team-store'

// ---- prompt 前缀缓存 P3：workspace basePrompt 会话快照 ----
// workspace.agentMd + memories 每轮现场拼装；evolver/agent-dreamer 会在会话中途异步改写
// memories 文件，basePrompt 是 system prompt 第 0 段，改一字就让全部前缀缓存作废。
// 会话中途新增的记忆来自本会话对话内容，模型已在原文里见过——快照到会话首轮对模型可用
// 信息几乎零损失。用户中途手改 agent.md 也要新开会话才生效，这是刻意取舍（与
// pi-agent-service.ts 的 memoryContextSnapshots 同一逻辑）。上限 30 会话，FIFO 淘汰最旧。
const BASE_PROMPT_SNAPSHOT_CAP = 30
const workspaceBasePromptSnapshots = new Map<string, string>()

export interface ResolveOverridesArgs {
  agentId?: string
  workspaceId?: string
  conversationConfig?: ConversationConfig
  conversationId?: string
  /** 团队话题（通常不用传：会话记录里带着，这里只给没落盘的入口用） */
  teamId?: string
  channel?: string
}

/**
 * Resolve an execution role without changing the process-global UI default.
 *
 * Runtime entry points created before AgentOverrides.roleName existed (notably
 * scheduled tasks) still carry conversationId. Reading that conversation here
 * gives both Runtime implementations the same safe compatibility path.
 */
/**
 * 本次执行属于哪个 Agent（统一身份）：overrides 里的 agentId > Pal（workspaceId）> 会话记录的 agent > 角色名；
 * 认不出的一律回落到通用助手的档案——档案永远存在，消费方不用再各自兜底。
 */
export function resolveExecutionAgent(
  context?: Pick<AgentOverrides, 'agentId' | 'roleName' | 'workspaceId' | 'conversationId'>
): AgentProfile {
  const candidates: Array<string | undefined> = [context?.agentId, context?.workspaceId]
  if (context?.conversationId) {
    try {
      const conv = peekConversation(context.conversationId)
      if (conv) candidates.push(resolveAgentId(conv))
    } catch { /* 新会话还没落盘 */ }
  }
  candidates.push(context?.roleName, DEFAULT_AGENT_ID)
  for (const id of candidates) {
    const profile = id ? getAgent(id) : undefined
    if (profile) return profile
  }
  throw new Error('agent registry has no general profile')
}

export function resolveExecutionRoleName(
  context?: Pick<AgentOverrides, 'roleName' | 'conversationId'>
): string {
  if (context?.roleName && getRoleConfig(context.roleName)) return context.roleName
  if (context?.conversationId) {
    try {
      const conversationRole = peekConversation(context.conversationId)?.role
      if (conversationRole && getRoleConfig(conversationRole)) return conversationRole
    } catch { /* 新会话还没落盘：回落默认角色 */ }
  }
  return DEFAULT_AGENT_ID
}

/**
 * 构建 overrides:Workspace Agent > Agent 模板 > 对话级 config > 仅 conversationId
 *
 * 优先级:
 * - workspaceId → 自定义 Agent (用户保存的) 系统提示 = agent.md + memories
 * - agentId（老字段，曾指模板）→ 模板已并入 Pal，认得出是 Pal 就当 workspaceId
 * - conversationConfig → 仅运行参数 (workingDir/projectName/thinking 等)
 * - 都没有 → 仅 conversationId(回落到全局 role 的 systemPrompt)
 */
export function resolveAgentOverrides(args: ResolveOverridesArgs): AgentOverrides | undefined {
  const { agentId, conversationConfig, conversationId } = args
  let overrides: AgentOverrides | undefined
  let roleName: string = DEFAULT_AGENT_ID

  // 角色快照守卫：会话自带的 role 是本次执行的最终事实源。全局 currentRole
  // 可能被其他表面（UI / HTTP / 语音）切走，因此这里只捕获会话角色，
  // 不再 switchRole 或改写 UI 默认值。
  // 单次读盘复用（效率评审：此前角色对齐与磁盘钉住兜底各读一遍同一份会话文件——每消息热点）
  let diskConv: ReturnType<typeof peekConversation> | null = null
  if (conversationId) {
    try {
      diskConv = peekConversation(conversationId)
      const conv = diskConv
      if (conv?.role) {
        const conversationRole = getRoleConfig(conv.role)
        if (conversationRole) {
          if (conversationRole.name !== roleName) {
            console.log(`[Role] 会话执行角色快照: ${roleName} → ${conversationRole.name} (conv ${conversationId.slice(0, 8)})`)
          }
          roleName = conversationRole.name
        }
      }
    } catch { /* 会话不存在（新会话首发）→ 沿用全局角色 */ }
  }

  // 团队话题：会话记录里带着 teamId（建会话时定，之后不可改）。团队层叠在 Lead 自己的人设之上；
  // 团队不存在了（目录被删）就按普通 Pal 会话跑，并把这件事记进日志——不静默、也不整条拒绝
  const teamId = args.teamId ?? diskConv?.teamId
  const channel = args.channel ?? diskConv?.channel
  const teamScope = teamId ? resolveTeamScope(teamId, channel) : null
  if (teamId && !teamScope) {
    console.warn(`[Team] 会话 ${conversationId?.slice(0, 8) ?? '-'} 绑定的团队 ${teamId.slice(0, 8)}${channel ? ` › ${channel}` : ''} 不存在或没有成员，本轮按普通 Pal 会话跑`)
  }
  // 模板并入 Pal 后（第 5 段）：老的 agentId 就是 Pal id，读侧当 workspaceId。
  // 话题永远由 Lead 跑：会话记录里的 workspaceId 就是它；没落盘的入口补成频道的 Lead
  const workspaceId = palIdOf(args) || teamScope?.lead

  if (workspaceId) {
    const snapshotKey = conversationId ? `${workspaceId}:${conversationId}` : undefined
    const cached = snapshotKey ? workspaceBasePromptSnapshots.get(snapshotKey) : undefined
    if (cached !== undefined) {
      overrides = {
        systemPrompt: cached,
        conversationId,
        workspaceId,
      }
    } else {
      const workspace = getWorkspace(workspaceId)
      if (workspace) {
        // agent.md 的 frontmatter 是声明（artifacts / skills / memory…），不是人设，不进提示词
        let prompt = parseFrontmatter(workspace.agentMd || '').body
        // 团队层（章程 / 名单 / 记忆索引 / 交接规矩）排在人设之后、成员自己的记忆之前（设计稿 §6 的顺序）。
        // 频道最近话题的索引也在这里（只有标题与产物目录；快照进会话首轮，前缀稳定）
        if (teamScope) {
          const recentThreads = listConversationsCached()
            .filter(c => c.teamId === teamScope.teamId && (c.channel ?? undefined) === teamScope.channel && c.id !== conversationId)
            .slice(0, 8)
            .map(c => ({ title: c.title, updatedAt: c.updatedAt, outputsDir: outputsDirFor(c.id) }))
          prompt += `\n\n${buildTeamPromptLayer(teamScope, workspaceId, 'lead', { recentThreads })}`
        }
        if (workspace.memories.length > 0) {
          prompt += '\n\n## 你的记忆\n\n以下是你积累的领域知识和用户偏好，请在回答时参考：\n\n'
          for (const mem of workspace.memories) {
            const content = mem.content.replace(/^---[\s\S]*?---\n*/m, '').trim()
            if (content) prompt += `### ${mem.name}\n${content}\n\n`
          }
        }
        if (snapshotKey) capInsert(workspaceBasePromptSnapshots, snapshotKey, prompt, BASE_PROMPT_SNAPSHOT_CAP)
        overrides = {
          systemPrompt: prompt,
          conversationId,
          workspaceId, // 让 buildSystemPrompt 读取 Agent 专属 skills
        }
      }
    }
  } else if (
    conversationConfig?.workingDir ||
    conversationConfig?.roleBrief ||
    conversationConfig?.initialAssets?.length ||
    conversationConfig?.projectName ||
    conversationConfig?.thinkingEnabled !== undefined ||
    conversationConfig?.thinkingLevel !== undefined ||
    conversationConfig?.modelPresetId !== undefined ||
    conversationConfig?.goal !== undefined
  ) {
    overrides = {
      systemPrompt: '',
      workingDir: conversationConfig.workingDir,
      modelPresetId: conversationConfig.modelPresetId,
      roleBrief: conversationConfig.roleBrief,
      initialAssets: conversationConfig.initialAssets,
      projectName: conversationConfig.projectName,
      thinkingEnabled: conversationConfig.thinkingEnabled,
      thinkingLevel: conversationConfig.thinkingLevel,
      goal: conversationConfig.goal,
      conversationId,
    }
  }

  // 确保 conversationId 即使没有 overrides 也能传递
  if (!overrides && conversationId) {
    overrides = { systemPrompt: '', conversationId }
  } else if (overrides && conversationId && !overrides.conversationId) {
    overrides.conversationId = conversationId
  }

  // 权限档位只在编码助手的会话上生效。别的角色的会话即便 config 里带了这个字段也忽略——
  // UI 不给它们这个开关，而 ACP / HTTP 那条路上外部客户端能 PATCH 会话 config，
  // 不设这道门就等于留了一条"把任意会话提成完全允许"的路子（放宽必须有门，收紧不必）。
  // 统一身份：写进 overrides，后面的提示词 / 技能 / 工具 / 声明都从这个 Agent 的档案取
  const executionAgentId = resolveAgentId({ workspaceId, agentId, role: roleName })
  if (overrides) overrides.agentId = executionAgentId
  // 权限档位能放宽的只有档案里声明了 permission-tier: allowed 的 Agent（今天是编码助手），不再按角色名认
  if (overrides && conversationConfig?.permissionTier && getAgent(executionAgentId)?.policies.permissionTier === 'allowed') {
    overrides.permissionTier = conversationConfig.permissionTier
  }

  // thinkingEnabled / thinkingLevel 是 UI 级运行参数,与 agent/workspace 模板无关 —— 透传
  if (overrides && conversationConfig?.thinkingEnabled !== undefined && overrides.thinkingEnabled === undefined) {
    overrides.thinkingEnabled = conversationConfig.thinkingEnabled
  }
  if (overrides && conversationConfig?.thinkingLevel !== undefined && overrides.thinkingLevel === undefined) {
    overrides.thinkingLevel = conversationConfig.thinkingLevel
  }

  // 会话专属模型预设同样是会话级运行参数,与模板无关 —— 透传(pi-agent-service 解析,预设已删回退全局)
  if (overrides && conversationConfig?.modelPresetId && overrides.modelPresetId === undefined) {
    overrides.modelPresetId = conversationConfig.modelPresetId
  }
  // 磁盘钉住兜底（评审 M3）：渲染层载荷没带 modelPresetId 时（普通"+"新建的会话 conversationConfig
  // 常为 null），从落盘的会话 config 读已钉住的——否则桌面端裸会话仍会跟着全局切换被翻转，
  // 与 http-server（本就读磁盘 config）行为分裂。
  if (overrides && overrides.modelPresetId === undefined) {
    const pinned = diskConv?.config?.modelPresetId
    if (pinned) overrides.modelPresetId = pinned
  }
  // 第一次真跑才钉模型（所有者定的规则）：用户在会话里选过的优先；没选过就用此刻的全局默认，并从这一刻起钉住——
  // 之后全局再切不影响这条会话，除非用户在会话页手动换。空会话没跑过就不钉，所以它一直跟着全局走。
  // 桌面 / HTTP / ACP / 定时任务 / 语音都经过这里，一处钉。落盘是尽力而为（测试里这两个模块常被整体 mock）。
  if (overrides && overrides.modelPresetId === undefined && conversationId) {
    try {
      const activePresetId = loadConfig().activePresetId
      if (activePresetId) {
        overrides.modelPresetId = activePresetId
        // 落盘前再看一眼：这一小段时间里用户可能已在会话页选了模型，那就以他的为准，不用这次的全局默认盖掉
        void (async () => {
          const fresh = peekConversation(conversationId)?.config
          if (fresh?.modelPresetId) return
          await updateConversationConfig(conversationId, { ...(fresh ?? {}), modelPresetId: activePresetId })
        })().catch(() => undefined)
      }
    } catch { /* 拿不到全局配置或写不了：这一轮照常跑，下一轮再钉 */ }
  }

  // goal 同样是会话级状态,与 agent/workspace 模板无关 —— 透传
  // (workspace/agent 模板分支没显式带 goal,这里补上,让任何模板下 /goal 都生效)
  if (overrides && conversationConfig?.goal !== undefined && overrides.goal === undefined) {
    overrides.goal = conversationConfig.goal
  }

  // preflow 前置信息（roleBrief/initialAssets/projectName）同样是会话级状态,与模板无关 —— 透传
  // (workspace/agent 模板分支此前不带这三项,用户在前置页点选的模板/资产会被静默丢弃)
  if (overrides && conversationConfig) {
    if (conversationConfig.roleBrief && overrides.roleBrief === undefined) overrides.roleBrief = conversationConfig.roleBrief
    if (conversationConfig.initialAssets?.length && overrides.initialAssets === undefined) overrides.initialAssets = conversationConfig.initialAssets
    if (conversationConfig.projectName && overrides.projectName === undefined) overrides.projectName = conversationConfig.projectName
    // workingDir 与 goal/projectName 同一口径：**会话级选择优先于模板默认**。
    // 旧行为是 workspace/agent 分支把它留空、由 Runtime 回落到 Agent 自己的
    // ~/.openpipal/agents/<id>/workspace，症状是用户在目录条上看见仓库名、模型却在
    // 另一个目录里干活；Zed 经 ACP 打开的仓库同样读不到（编辑器的 cwd 就落在这条 config 上）。
    // 注意只在会话**显式选了**目录时才覆盖：没选就仍然走 Agent 自己的工作区，
    // 自定义 Agent「自带一块地」的语义不变。
    if (conversationConfig.workingDir && overrides.workingDir === undefined) {
      overrides.workingDir = conversationConfig.workingDir
    }
  }

  // 团队层的运行参数：工作目录 = 团队的（会话显式选了目录仍以会话为准，同上一段的口径）；
  // 权限档位 = 成员自己的 ∩ 团队天花板，只收窄不放宽（readonly 天花板对谁都生效，哪怕它本来没有档位开关）
  if (overrides && teamScope) {
    overrides.teamId = teamScope.teamId
    if (teamScope.channel) overrides.channel = teamScope.channel
    if (!conversationConfig?.workingDir) overrides.workingDir = teamScope.workingDir
    // 真值表只有两行会改：天花板 readonly 压给所有人；天花板 auto 只压掉 full。天花板 full 什么都不放宽
    if (teamScope.tier === 'readonly') overrides.permissionTier = 'readonly'
    else if (teamScope.tier === 'auto' && overrides.permissionTier === 'full') overrides.permissionTier = 'auto'
  }

  // 执行期角色必须是会话级快照。全局 role 仅保留用于 UI 默认值/历史兼容；
  // prompt、memory、skills 和工具在后续异步执行时不再把进程全局 currentRole 当事实源。
  if (overrides && overrides.roleName === undefined) overrides.roleName = roleName

  return overrides
}
