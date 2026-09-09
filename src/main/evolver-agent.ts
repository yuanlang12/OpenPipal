/**
 * Evolver Agent — 统一的 Agent 自进化引擎
 *
 * 用一个 Pi Agent（带 Unix 工具）替代原来的单次 LLM 调用，
 * 直接 read/write/grep 文件完成 workspace 创建和进化。
 *
 * 四个能力（对应四个 skill）：
 *   save-agent:      从对话创建新 Agent（0→1）
 *   dream:           进化已有 Agent（1→N），夜间深度整理
 *   extract-memory:  每轮对话后的高频短增量记忆提取
 *   set-rule:        把前台递交的一条规则写成 hook 文件（hooks/rule-writer 排队调用）
 */

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'
import { app } from 'electron'
import { existsSync, readFileSync, cpSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { buildModelFromConfig, ensurePiApiKeyFor, isBuiltinModelCredential, resolveConversationModelConfig, withSessionStreamOptions, createModelPayloadAdapter, resolveAuxThinkingLevel } from './config-manager'
import { isolatedStreamSimple } from './isolated-stream-signal'
import { loadSkills, formatSkillsForPrompt } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js'
import type { ChatMessage } from './agent-runtime/contracts'
import { dataPath } from './data-root'
import { createHardBoundaryHook } from './pi-security'
import { getBuiltInSkillsDir } from './openpipal-skill-sources'
import { formatDialogue } from './dialogue-format'
import { getWorkspaceName } from './agent-workspace-store'
import { getConversationPinnedPreset } from './conversation-store'
import type { RuleWriterInput } from './hooks/rule-writer'
import type { EvolverTaskCandidate } from './evolver-task-migration'
import { buildEvolverTools } from './evolver-tools'

// ---- Paths ----

const EVOLVER_USER_DIR = dataPath('system-agents', 'evolver')

function getBundledEvolverDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'system-agents', 'evolver')
  }
  return join(app.getAppPath(), 'resources', 'system-agents', 'evolver')
}

// ---- Init ----

export function initEvolver(): void {
  const bundled = getBundledEvolverDir()
  if (!existsSync(bundled)) {
    console.warn('[Evolver] bundled evolver not found at', bundled)
    return
  }
  if (!existsSync(join(EVOLVER_USER_DIR, 'agent.md'))) {
    mkdirSync(EVOLVER_USER_DIR, { recursive: true })
    cpSync(bundled, EVOLVER_USER_DIR, { recursive: true })
    console.log('[Evolver] 初始化: bundled → user dir')
  }
  console.log('[Evolver] 已就绪')
}

// ---- System Prompt Builder ----

function buildEvolverPrompt(skillName: string): string {
  // Bundled policy is authoritative. Existing installations keep a copied
  // user file from first launch, so reading that copy first would preserve old
  // shell/cross-workspace instructions indefinitely after a security update.
  const bundledAgentMd = safeRead(join(getBundledEvolverDir(), 'agent.md'))
  const agentMd = bundledAgentMd || safeRead(join(EVOLVER_USER_DIR, 'agent.md'))
  // SKILL.md 是 OpenPipal 系统能力定义，bundled 是 source of truth；
  // 用户目录可能是首次安装时复制的旧版 → 优先读 bundled，fallback 到用户目录
  const bundledSkillMd = safeRead(join(getBundledEvolverDir(), 'skills', skillName, 'SKILL.md'))
  const skillMd = bundledSkillMd || safeRead(join(EVOLVER_USER_DIR, 'skills', skillName, 'SKILL.md'))

  // 加载 evolver 自身的 learnings
  const learnings = loadEvolverLearnings()

  let prompt = agentMd
  if (skillMd) prompt += `\n\n---\n\n# Active Skill: ${skillName}\n\n${skillMd}`
  if (learnings) prompt += `\n\n---\n\n# Your Past Learnings\n\n${learnings}`
  prompt += '\n\n---\n\n# Authoritative Runtime Boundary\n\nUse only the provided file tools. Access only the assigned workspace named in this run. Shell execution and access to any parent, sibling, or application credential path are unavailable.'

  return prompt
}

function loadEvolverLearnings(): string {
  const memDir = join(EVOLVER_USER_DIR, 'memory')
  if (!existsSync(memDir)) return ''
  try {
    const { readdirSync } = require('fs')
    const files = readdirSync(memDir).filter((f: string) => f.endsWith('.md') && f !== 'MEMORY.md')
    if (files.length === 0) return ''
    // 只加载最近 5 条 learnings 的摘要（渐进式披露）
    const recent = files.slice(-5)
    return recent.map((f: string) => {
      const content = safeRead(join(memDir, f))
      return content.length > 300 ? content.slice(0, 300) + '...' : content
    }).join('\n\n---\n\n')
  } catch { return '' }
}

function safeRead(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf-8') : '' } catch { return '' }
}

// ---- Conversation Formatter ----

/** 对话正文的判据与格式只有一处（dialogue-format.ts）；这里只定 Evolver 的窗口与截断 */
function formatConversation(messages: ChatMessage[], maxMessages = 40): string {
  return formatDialogue(messages, { maxMessages, maxChars: 1200 })
}

// ---- Core Runner ----

async function runEvolver(
  skillName: string,
  userMessage: string,
  cwd: string,
  taskCandidates: EvolverTaskCandidate[],
  scope: { assignedRoot: string; workspaceId?: string; conversationId?: string }
): Promise<{ success: boolean; error?: string }> {
  const systemPrompt = buildEvolverPrompt(skillName)
  if (!systemPrompt) {
    return { success: false, error: 'Evolver system prompt is empty' }
  }

  // 模型路由同子 Agent：来源会话钉住了预设就用它（刚在前台跑通的那个模型），没有才回全局默认。
  // 独立 Agent 的会话常固定在某个预设上，全局默认可能是另一家端点——那家一断，后台就"Connection error"
  // 而前台好好的（2026-09-08 实撞）。预设读会话文件（换模型时渲染层当场写盘），四种后台活同一条路。
  // 失败结论带上模型 id，用户一眼看出是哪家没连上。
  const pinnedPreset = scope.conversationId ? getConversationPinnedPreset(scope.conversationId) : undefined
  const route = resolveConversationModelConfig(pinnedPreset)
  if (route.danglingPresetId) console.warn(`[Evolver] 会话预设 ${route.danglingPresetId} 已不存在，回退全局默认`)
  const mc = route.config
  const model = buildModelFromConfig(mc)
  ensurePiApiKeyFor(model.provider, mc)
  // 结论会显示在对话胶囊里：内置凭证的模型名不出主进程（红线，与 getEffectiveModelConfigForDisplay 同口径）；
  // 预设被删了回退的那种要说明，不然用户看到的是回退后的名字、以为路由没变
  const modelLabel = (isBuiltinModelCredential(mc) ? '内置模型' : model.id) + (route.danglingPresetId ? '（会话预设已不存在，用的全局默认）' : '')
  const describeFailure = (error: string): { success: false; error: string } => ({ success: false, error: `${modelLabel}：${error}` })

  const tools = buildEvolverTools(cwd, taskCandidates)

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      thinkingLevel: resolveAuxThinkingLevel(mc, model),
      messages: [],
    },
    toolExecution: 'sequential',
    // key 注入防并发互踩：evolver 跑在后台，主会话切到不同 key 的预设时 env 会被覆盖
    streamFn: withSessionStreamOptions(isolatedStreamSimple, mc),
    // Evolver has no permission UI, but it is still a model-facing tool loop.
    // Keep workspace generation autonomous while enforcing every hard no-read,
    // system path, dangerous command, and tenant boundary.
    beforeToolCall: createHardBoundaryHook({
      workingDir: cwd,
      assignedRoot: scope.assignedRoot,
      workspaceId: scope.workspaceId,
    }),
    onPayload: createModelPayloadAdapter(),
  })

  console.log(`[Evolver] 启动 skill=${skillName}, cwd=${cwd}, model=${model.id}`)

  return new Promise((resolve) => {
    let resolved = false
    const finish = (result: { success: boolean; error?: string }) => {
      if (resolved) return
      resolved = true
      unsubscribe()
      clearTimeout(timer)
      resolve(result)
    }

    const unsubscribe = agent.subscribe((event: PiAgentEvent) => {
      if (event.type === 'message_end') {
        const msg = event.message as any
        if (msg?.stopReason === 'error') {
          finish(describeFailure(msg.errorMessage || 'Agent error'))
        }
      }
    })

    // 180s timeout
    const timer = setTimeout(() => {
      console.warn('[Evolver] 超时 (180s)')
      agent.abort()
      finish(describeFailure('Evolver timed out after 180s'))
    }, 180_000)

    agent.prompt({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
      timestamp: Date.now()
    }).then(() => {
      console.log(`[Evolver] 完成 skill=${skillName}`)
      finish({ success: true })
    }).catch((err: any) => {
      console.error(`[Evolver] 失败:`, err.message)
      finish(describeFailure(err.message))
    })
  })
}

// ---- Public API ----

/**
 * 从对话创建新 Agent workspace（0→1）。
 * 调用方应先 createWorkspace() 建好目录，再调此函数填充内容。
 */
export async function evolverSaveAgent(
  workspaceDir: string,
  messages: ChatMessage[],
  roleName: string,
  conversationId?: string,
  candidateTasks?: EvolverTaskCandidate[]
): Promise<{ success: boolean; error?: string }> {
  const conversationText = formatConversation(messages)
  // 把 main 进程预筛的 task 候选清单格式化进 userMessage
  let candidateTasksSection = ''
  if (candidateTasks && candidateTasks.length > 0) {
    const lines = candidateTasks
      .map(t => `- ${t.id}  | name: ${t.name}  | created: ${new Date(t.createdAt).toISOString()}  | match: exact conversation binding`)
      .join('\n')
    candidateTasksSection = `\nCandidate tasks to migrate (pre-filtered by system — each task is exactly bound to this conversation):\n${lines}\n`
  } else {
    candidateTasksSection = `\nCandidate tasks to migrate: (none — system found no task files matching this conversation; skip the tasks/ section entirely)\n`
  }

  const userMessage = `Skill: save-agent
Workspace: ${workspaceDir}
${conversationId ? `Source conversation ID: ${conversationId}` : ''}
${candidateTasksSection}
Conversation (${messages.length} messages, role: ${roleName}):

${conversationText}`

  const workspaceId = basename(workspaceDir)
  return runEvolver('save-agent', userMessage, workspaceDir, candidateTasks || [], {
    assignedRoot: workspaceDir,
    workspaceId,
    conversationId,
  })
}

/**
 * 进化已有 Agent workspace（1→N）。
 * 分析最近对话，更新 agent.md / me.md / memory / skills。
 */
export async function evolverDream(
  workspaceDir: string,
  messages: ChatMessage[],
  conversationId?: string
): Promise<{ success: boolean; error?: string }> {
  const conversationText = formatConversation(messages)
  const userMessage = `Skill: dream
Target workspace: ${workspaceDir}
${conversationId ? `Source conversation ID: ${conversationId}` : ''}

Recent conversations (${messages.length} messages):

${conversationText}`

  const workspaceId = basename(workspaceDir)
  return runEvolver('dream', userMessage, workspaceDir, [], {
    assignedRoot: workspaceDir,
    workspaceId,
    conversationId,
  })
}

/**
 * 每轮对话后的高频短增量记忆提取。
 *
 * 与 dream 的区别：
 * - dream = 24h + ≥5 次对话才触发，扫所有记忆做合并整理
 * - extract = 每轮对话后触发，只看最近 N 条消息，但必须 read 已有同主题文件再决定 create/update
 *
 * cwd 设为 ~/.openpipal/memory/ → agent 在这个 sandbox 内能访问 global/ 和 conversations/{id}/
 * 两个子目录。memoryDir 参数主要用于派生 cwd 的父目录。
 */
export async function evolverExtract(
  memoryDir: string,
  conversationMemoryDir: string | null,
  messages: ChatMessage[],
  roleName: string,
  conversationId?: string
): Promise<{ success: boolean; error?: string }> {
  // 短增量：只看最近 20 条对话正文（滤掉非正文再切，见 dialogue-format.ts），避免重复处理已 extract 过的部分
  const RECENT = 20
  const conversationText = formatConversation(messages, RECENT)

  const convMemSection = conversationMemoryDir
    ? `Conversation memory directory: ${conversationMemoryDir}`
    : 'Conversation memory directory: (none — no conversation ID, skip conversation-scoped memory)'

  const userMessage = `Skill: extract-memory
Memory directory: ${memoryDir}
${convMemSection}
Role: ${roleName}
${conversationId ? `Source conversation ID: ${conversationId}` : ''}

Recent conversation (last ${RECENT} messages):

${conversationText}`

  // cwd = ~/.openpipal/memory/（memoryDir 的父目录）
  // 这样 agent 同时能读写 global/ 和 conversations/{id}/
  const sandboxRoot = join(memoryDir, '..')
  return runEvolver('extract-memory', userMessage, sandboxRoot, [], {
    assignedRoot: sandboxRoot,
    conversationId,
  })
}

/**
 * 把一条规则写成 hook 文件（前台 set_rule 工具递交，hooks/rule-writer 排队调用；入参形状就是它的 RuleWriterInput）。
 *
 * cwd / assignedRoot 都是 local-rules 插件根：Evolver 只能在这个目录里读写。
 * 类型声明随消息附上——边界之外的文件它读不到，不能让它去翻 hook-creator 的 references。
 */
export async function evolverSetRule(input: RuleWriterInput): Promise<{ success: boolean; error?: string }> {
  const previous = input.previousError
    ? `\nPrevious error (the file you wrote last time failed to load — fix exactly this):\n${input.previousError}\n`
    : ''
  // 独立智能体里提的规则写进它自己的目录：位置即范围，只在跑它时装，文件里不用再判 workspaceId
  const agentName = input.workspaceId ? (getWorkspaceName(input.workspaceId) || input.workspaceId) : undefined
  const scope = input.workspaceId
    ? `\nRequested inside standalone Agent "${agentName}". The rules directory is this Agent's own hooks/ folder:
rules written there apply only to this Agent. Do not add workspaceId guards and do not append the Agent's name to the description.\n`
    : ''
  const userMessage = `Skill: set-rule
Rules directory (the hooks/ folder itself; write one <name>.ts per rule directly in it): ${input.rulesDir}
Description: ${input.description}
Details: ${input.details}
Role: ${input.roleName || 'general'}
${scope}${previous}
Type declarations for 'openpipal/hooks' (authoritative; nothing else may be imported):

\`\`\`ts
${readHookAuthorTypes()}
\`\`\``
  // workspaceId 必须给：租户边界把 agents/ 下的一切都当别人的，没有它写手在独立智能体目录里一个文件也写不出来
  return runEvolver('set-rule', userMessage, input.rulesDir, [], { assignedRoot: input.rulesDir, workspaceId: input.workspaceId, conversationId: input.conversationId })
}

function readHookAuthorTypes(): string {
  return safeRead(join(getBuiltInSkillsDir(), 'hook-creator', 'references', 'hook-types.d.ts'))
    || '(type declarations unavailable — follow the template in the skill exactly)'
}
