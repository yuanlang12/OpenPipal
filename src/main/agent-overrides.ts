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
import { peekConversation } from './conversation-service'
import { getWorkspace } from './agent-workspace-store'
import { getAgentTemplate } from './agent-template-manager'
import { getCurrentRole, getRoleConfig } from './role-manager'
import { capInsert } from './prompt-cache-fifo'

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
}

/**
 * Resolve an execution role without changing the process-global UI default.
 *
 * Runtime entry points created before AgentOverrides.roleName existed (notably
 * scheduled tasks) still carry conversationId. Reading that conversation here
 * gives both Runtime implementations the same safe compatibility path.
 */
export function resolveExecutionRoleName(
  context?: Pick<AgentOverrides, 'roleName' | 'conversationId'>
): string {
  if (context?.roleName && getRoleConfig(context.roleName)) return context.roleName
  if (context?.conversationId) {
    try {
      const conversationRole = peekConversation(context.conversationId)?.role
      if (conversationRole && getRoleConfig(conversationRole)) return conversationRole
    } catch { /* missing/new conversation: capture the UI default below */ }
  }
  return getCurrentRole().name
}

/**
 * 构建 overrides:Workspace Agent > Agent 模板 > 对话级 config > 仅 conversationId
 *
 * 优先级:
 * - workspaceId → 自定义 Agent (用户保存的) 系统提示 = agent.md + memories
 * - agentId → 内置 Agent 模板的 systemPrompt + tools + skills + workingDir
 * - conversationConfig → 仅运行参数 (workingDir/projectName/thinking 等)
 * - 都没有 → 仅 conversationId(回落到全局 role 的 systemPrompt)
 */
export function resolveAgentOverrides(args: ResolveOverridesArgs): AgentOverrides | undefined {
  const { agentId, workspaceId, conversationConfig, conversationId } = args
  let overrides: AgentOverrides | undefined
  let roleName = getCurrentRole().name

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
        let prompt = workspace.agentMd || ''
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
  } else if (agentId) {
    const template = getAgentTemplate(agentId)
    if (template) {
      overrides = {
        systemPrompt: template.systemPrompt,
        tools: template.tools,
        workingDir: template.workingDir,
        conversationId,
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
  if (overrides && conversationConfig?.permissionTier && roleName === 'coding') {
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
  // 常为 null），从落盘的会话 config 读出生钉住——否则桌面端裸会话仍会跟着全局切换被翻转，
  // 与 http-server（本就读磁盘 config）行为分裂。
  if (overrides && overrides.modelPresetId === undefined) {
    const pinned = diskConv?.config?.modelPresetId
    if (pinned) overrides.modelPresetId = pinned
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

  // 执行期角色必须是会话级快照。全局 role 仅保留用于 UI 默认值/历史兼容；
  // prompt、memory、skills 和工具在后续异步执行时不再把进程全局 currentRole 当事实源。
  if (overrides && overrides.roleName === undefined) overrides.roleName = roleName

  return overrides
}
