/**
 * Agent Dreamer — Agent 级自动记忆提取
 *
 * 每次 Agent 对话结束后自动运行（fire-and-forget）。
 * 分析新对话内容，增量更新 workspace 的 memory/ 目录。
 *
 * 与全局 memory-extractor 的区别：
 * - 全局提取写入 ~/.openpipal/memory/
 * - Agent dreaming 写入 ~/.openpipal/agents/{id}/memory/
 * - Agent dreaming 还可以更新 agent.md（渐进式优化人格）
 *
 * 团队话题（所有者 2026-09-14：跑完提示"记忆整理完成"，团队记忆却没动）：
 * - 同一台引擎，记忆落到 teams/<id>/memory/（频道有 memory/ 就落频道）——团队才是跨话题的持久单位，
 *   组长的私人记忆在团队话题里没有意义
 * - 只记团队层面的事（决定 / 约定 / 坑 / 参考），类型与成员用 write 手写的一致，索引读时现算
 * - 不改组长的 agent.md：章程归组长和主人商量着改，不归整理引擎——团队这一路根本没有 writeAgentMd
 *
 * 参考 Claude Code 的 auto-dreaming：
 * - fire-and-forget，不阻塞 UI
 * - 互斥锁防止重叠
 * - 单次 LLM 调用，max 5 条记忆
 */

import { completeSimple } from '@earendil-works/pi-ai/compat'
import type { ChatMessage } from './agent-runtime/contracts'
import { formatDialogue } from './dialogue-format'
import { getPiModel, ensurePiApiKey, getEffectiveModelConfig, createModelPayloadAdapter, auxCompletionTuning } from './config-manager'
import { stripJsonFence } from './simple-completion'
import { parseFrontmatter } from '../shared/frontmatter'
import { getWorkspace, writeWorkspaceMemory, writeAgentMd } from './agent-workspace-store'
import { readTeamMemoryEntries, writeTeamMemory, type TeamScope } from './team-store'

// 互斥锁
let _running = false

/** 引擎要的输出形状只写一处：两版提示词共用，字段一变两边同时变 */
function jsonContract(nameHint: string, extraFields = ''): string {
  return `分析最新对话内容，输出 JSON：

{
  "memories": [
    {
      "name": "${nameHint}",
      "description": "一句话描述",
      "content": "完整内容（Markdown 带 YAML frontmatter）",
      "action": "create | update"
    }
  ]${extraFields}
}

只输出上面这一个 JSON 对象本身，不要任何额外文字、解释或代码栅栏（如 \`\`\`json）。`
}

/** 已有记忆给引擎看的样子（去掉 frontmatter 的正文），Pal 与团队同一种 */
function formatMemoryDigest(entries: Array<{ name: string; content: string }>): string {
  return entries.map(m => `### ${m.name}\n${parseFrontmatter(m.content).body.trim()}`).join('\n\n')
}

function buildDreamingPrompt(agentMd: string, existingMemories: string): string {
  return `你是 OpenPipal 的 Agent 记忆更新引擎。分析 Agent 的最新对话，决定是否需要更新 Agent 的记忆或人格。

## 当前 Agent 人格

${agentMd || '（尚未定义）'}

## 已有记忆

${existingMemories || '（暂无记忆）'}

## 你的任务

${jsonContract('记忆文件名（英文下划线命名）', ',\n  "agentMdUpdate": null | "更新后的完整 agent.md 内容"')}

## 规则

- 只记录对**未来对话**有价值的信息（用户偏好、领域知识、工作模式）
- 不记录一次性的任务细节或临时信息
- 如果用户表达了新的偏好或纠正了行为，更新 agent.md
- 如果没有新信息值得记录，返回 {"memories": [], "agentMdUpdate": null}
- memories 最多 3 条
- agentMdUpdate 只在用户明确要求改变行为 或 发现重要新偏好时才非 null
- 每条记忆的 content 应包含 YAML frontmatter：
  ---
  name: 标题
  description: 一句话描述
  type: project
  ---
  内容`
}

/** 团队版：记的是团队的事，落团队记忆；没有改人设这一项 */
function buildTeamDreamingPrompt(scope: TeamScope, existingMemories: string): string {
  const charter = scope.charters.map(c => `### ${c.label}\n${c.body.trim() || '（空）'}`).join('\n\n')
  const members = scope.members.map(m => `- ${m.name}${m.id === scope.lead ? '（Lead）' : ''}${m.description ? `：${m.description}` : ''}`).join('\n')
  return `你是 OpenPipal 的团队记忆更新引擎。这是团队「${scope.name}」${scope.channel ? `频道「${scope.channel}」` : ''}里的一条话题，主人在跟组长聊。分析最新对话，决定要不要往**团队记忆**里记东西。

## 团队章程

${charter || '（空）'}

## 成员

${members || '（无）'}

## 已有团队记忆

${existingMemories || '（暂无）'}

## 你的任务

${jsonContract('记忆文件名（短标题，中文或英文都行，不带扩展名）')}

## 规则

- 只记**团队层面**、对以后的话题有用的事：主人拍板的决定、团队约定与口径、踩过的坑、常用的参考（文件在哪、谁负责什么）
- 不记一次性的任务细节、过程性的进展、已经写进章程的内容
- 已有记忆里有同一件事就 update 它（name 用已有的文件名），不要重复建
- 如果没有新信息值得记录，返回 {"memories": []}
- memories 最多 3 条
- 每条记忆的 content 开头是 frontmatter：
  ---
  description: 一句话描述
  type: decision | convention | gotcha | reference
  modified: ${new Date().toISOString().slice(0, 10)}
  ---
  正文写清是什么、为什么`
}

/** 对话正文的判据与格式只有一处（dialogue-format.ts）；这里只定 dream 的窗口与截断 */
function formatConversation(messages: ChatMessage[], maxMessages = 20): string {
  return formatDialogue(messages, { maxMessages, maxChars: 600 })
}

/** 整理落到哪：Pal 自己的 memory/（可顺带改人设）或团队 / 频道的 memory/（没有改人设这回事） */
interface DreamSink {
  /** 日志里的名字（真机 e2e 按 `[AgentDreamer] 团队 …: N memories` 认路径，改措辞先看 tests/e2e/team-founding-live.spec.ts） */
  label: string
  prompt: string
  write(name: string, content: string): void
  writeAgentMd?(content: string): void
}

export type DreamTarget = { workspaceId: string } | { team: TeamScope }

function sinkFor(target: DreamTarget): DreamSink | null {
  if ('team' in target) {
    const scope = target.team
    return {
      label: `团队 ${scope.teamId.substring(0, 8)}`,
      prompt: buildTeamDreamingPrompt(scope, formatMemoryDigest(readTeamMemoryEntries(scope.memoryWriteDir))),
      write: (name, content) => { writeTeamMemory(scope, name, content) }
    }
  }
  const workspace = getWorkspace(target.workspaceId)
  if (!workspace) return null
  return {
    label: target.workspaceId.substring(0, 8),
    prompt: buildDreamingPrompt(workspace.agentMd, formatMemoryDigest(workspace.memories)),
    write: (name, content) => { writeWorkspaceMemory(target.workspaceId, name, content) },
    writeAgentMd: (content) => { writeAgentMd(target.workspaceId, content) }
  }
}

export async function executeAgentDreaming(
  target: DreamTarget,
  messages: ChatMessage[],
  onComplete?: (updated: { memories: number; agentMdUpdated: boolean; names: string[] }) => void
): Promise<void> {
  if (_running) return
  _running = true

  try {
    const sink = sinkFor(target)
    if (!sink) return
    const conversationText = formatConversation(messages)

    const model = getPiModel()
    ensurePiApiKey(model.provider)
    const tune = auxCompletionTuning(getEffectiveModelConfig(), model, 1536)

    const completion = await completeSimple(model, {
      systemPrompt: sink.prompt,
      messages: [
        { role: 'user' as const, content: `以下是最新对话内容：\n\n${conversationText}`, timestamp: Date.now() }
      ]
    }, {
      maxTokens: tune.maxTokens,
      reasoning: tune.reasoning,
      apiKey: getEffectiveModelConfig().apiKey || undefined, // 显式 key 防并发 env 互踩
      temperature: 0.2,
      timeoutMs: 60_000,
      maxRetries: 2,
      onPayload: createModelPayloadAdapter()
    })

    if (completion.stopReason === 'error') {
      throw new Error(completion.errorMessage || 'LLM 调用失败')
    }

    const raw = stripJsonFence(
      (completion.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    ) || '{}'
    const result = JSON.parse(raw)

    const names: string[] = []
    if (Array.isArray(result.memories)) {
      for (const mem of result.memories.slice(0, 3)) {
        if (mem.name && mem.content) {
          sink.write(String(mem.name), mem.content)
          names.push(String(mem.name))
        }
      }
    }

    // 更新 agent.md（仅在 LLM 明确返回、且这一路允许改人设时）
    let agentMdUpdated = false
    if (sink.writeAgentMd && typeof result.agentMdUpdate === 'string' && result.agentMdUpdate.trim()) {
      sink.writeAgentMd(result.agentMdUpdate)
      agentMdUpdated = true
    }

    console.log(`[AgentDreamer] ${sink.label}: ${names.length > 0 || agentMdUpdated
      ? `${names.length} memories, agentMd ${agentMdUpdated ? 'updated' : 'unchanged'}`
      : '无新记忆'}`)

    onComplete?.({ memories: names.length, agentMdUpdated, names })
  } catch (err: any) {
    console.error('[AgentDreamer] 失败:', err.message)
  } finally {
    _running = false
  }
}
