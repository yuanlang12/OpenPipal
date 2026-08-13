/**
 * Evolver Agent — 统一的 Agent 自进化引擎
 *
 * 用一个 Pi Agent（带 Unix 工具）替代原来的单次 LLM 调用，
 * 直接 read/write/grep 文件完成 workspace 创建和进化。
 *
 * 三个能力（对应三个 skill）：
 *   save-agent:      从对话创建新 Agent（0→1）
 *   dream:           进化已有 Agent（1→N），夜间深度整理
 *   extract-memory:  每轮对话后的高频短增量记忆提取
 */

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'
import { app } from 'electron'
import { existsSync, readFileSync, cpSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { getPiModel, ensurePiApiKey, getEffectiveModelConfig, withSessionStreamOptions, createModelPayloadAdapter, resolveAuxThinkingLevel } from './config-manager'
import { isolatedStreamSimple } from './isolated-stream-signal'
import { loadSkills, formatSkillsForPrompt } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js'
import type { ChatMessage } from './agent-runtime/contracts'
import { dataPath } from './data-root'
import { createHardBoundaryHook } from './pi-security'
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

/**
 * 只格式化对话正文。工具轨迹（role:'tool'）自"跨轮回放"起就活在 messages 里，而下面
 * 一律把非 user 标成"[助手]"——不先滤掉的话，工具回执会被当成助手说过的话写进长期
 * 记忆/agent.md，且一轮 agentic 的工具消息足以把真正说了偏好的那句挤出窗口。
 * 滤在切片**之前**：切完再滤等于窗口已经被工具消息吃掉了。
 */
function formatConversation(messages: ChatMessage[], maxMessages = 40): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-maxMessages)
    .map(m => {
      const role = m.role === 'user' ? '用户' : '助手'
      const content = m.content.slice(0, 1200)
      return `[${role}] ${content}`
    })
    .join('\n\n')
}

// ---- Core Runner ----

async function runEvolver(
  skillName: string,
  userMessage: string,
  cwd: string,
  taskCandidates: EvolverTaskCandidate[],
  scope: { assignedRoot: string; workspaceId?: string }
): Promise<{ success: boolean; error?: string }> {
  const systemPrompt = buildEvolverPrompt(skillName)
  if (!systemPrompt) {
    return { success: false, error: 'Evolver system prompt is empty' }
  }

  const model = getPiModel()
  ensurePiApiKey(model.provider)
  const mc = getEffectiveModelConfig()

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
          finish({ success: false, error: msg.errorMessage || 'Agent error' })
        }
      }
    })

    // 180s timeout
    const timer = setTimeout(() => {
      console.warn('[Evolver] 超时 (180s)')
      agent.abort()
      finish({ success: false, error: 'Evolver timed out after 180s' })
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
      finish({ success: false, error: err.message })
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
  // 只喂对话正文。工具轨迹（role:'tool'）自"跨轮回放"起就活在模型载荷里，而 formatConversation
  // 把所有非 user 一律标成"[助手]"——工具回执会被当成助手说过的话写进长期记忆，
  // 且一轮 agentic 的工具消息能把真正说了偏好的那句挤出 20 条窗口（说了记不住的成因）。
  const dialogue = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  // 短增量：只看最近 20 条消息，避免重复处理已 extract 过的部分
  const recentMessages = dialogue.slice(-20)
  const conversationText = formatConversation(recentMessages, 20)

  const convMemSection = conversationMemoryDir
    ? `Conversation memory directory: ${conversationMemoryDir}`
    : 'Conversation memory directory: (none — no conversation ID, skip conversation-scoped memory)'

  const userMessage = `Skill: extract-memory
Memory directory: ${memoryDir}
${convMemSection}
Role: ${roleName}
${conversationId ? `Source conversation ID: ${conversationId}` : ''}

Recent conversation (last ${recentMessages.length} messages):

${conversationText}`

  // cwd = ~/.openpipal/memory/（memoryDir 的父目录）
  // 这样 agent 同时能读写 global/ 和 conversations/{id}/
  const sandboxRoot = join(memoryDir, '..')
  return runEvolver('extract-memory', userMessage, sandboxRoot, [], {
    assignedRoot: sandboxRoot,
  })
}
