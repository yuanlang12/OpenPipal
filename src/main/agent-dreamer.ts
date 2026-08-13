/**
 * Agent Dreamer — Agent 级自动记忆提取
 *
 * 每次 Agent 对话结束后自动运行（fire-and-forget）。
 * 分析新对话内容，增量更新 workspace 的 memory/ 目录。
 *
 * 与全局 memory-extractor 的区别：
 * - 全局提取写入 ~/.openpipal/memory/
 * - Agent dreaming 写入 ~/.openpipal/workspaces/{id}/memory/
 * - Agent dreaming 还可以更新 agent.md（渐进式优化人格）
 *
 * 参考 Claude Code 的 auto-dreaming：
 * - fire-and-forget，不阻塞 UI
 * - 互斥锁防止重叠
 * - 单次 LLM 调用，max 5 条记忆
 */

import { completeSimple } from '@earendil-works/pi-ai/compat'
import type { ChatMessage } from './agent-runtime/contracts'
import { getPiModel, ensurePiApiKey, getEffectiveModelConfig, createModelPayloadAdapter, auxCompletionTuning } from './config-manager'
import { stripJsonFence } from './simple-completion'
import { getWorkspace, writeWorkspaceMemory, writeAgentMd } from './agent-workspace-store'

// 互斥锁
let _running = false

function buildDreamingPrompt(agentMd: string, existingMemories: string): string {
  return `你是 OpenPipal 的 Agent 记忆更新引擎。分析 Agent 的最新对话，决定是否需要更新 Agent 的记忆或人格。

## 当前 Agent 人格

${agentMd || '（尚未定义）'}

## 已有记忆

${existingMemories || '（暂无记忆）'}

## 你的任务

分析最新对话内容，输出 JSON：

{
  "memories": [
    {
      "name": "记忆文件名（英文下划线命名）",
      "description": "一句话描述",
      "content": "完整内容（Markdown 带 YAML frontmatter）",
      "action": "create | update"
    }
  ],
  "agentMdUpdate": null | "更新后的完整 agent.md 内容"
}

只输出上面这一个 JSON 对象本身，不要任何额外文字、解释或代码栅栏（如 \`\`\`json）。

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

/** 只格式化对话正文：非 user 一律标"[助手]"，工具轨迹混进来就成了助手的伪证词。
 *  滤在切片之前——切完再滤，窗口已经被工具消息吃掉了（口径同 evolver-agent） */
function formatConversation(messages: ChatMessage[], maxMessages = 20): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-maxMessages)
    .map(m => {
      const role = m.role === 'user' ? '用户' : '助手'
      return `[${role}] ${m.content.slice(0, 600)}`
    })
    .join('\n\n')
}

export async function executeAgentDreaming(
  workspaceId: string,
  messages: ChatMessage[],
  onComplete?: (updated: { memories: number; agentMdUpdated: boolean }) => void
): Promise<void> {
  if (_running) return
  _running = true

  try {
    const workspace = getWorkspace(workspaceId)
    if (!workspace) return

    const existingMemories = workspace.memories
      .map(m => `### ${m.name}\n${m.content.replace(/^---[\s\S]*?---\n*/m, '').trim()}`)
      .join('\n\n')

    const prompt = buildDreamingPrompt(workspace.agentMd, existingMemories)
    const conversationText = formatConversation(messages)

    const model = getPiModel()
    ensurePiApiKey(model.provider)
    const tune = auxCompletionTuning(getEffectiveModelConfig(), model, 1536)

    const completion = await completeSimple(model, {
      systemPrompt: prompt,
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

    let memoriesWritten = 0
    let agentMdUpdated = false

    // 写入新记忆
    if (Array.isArray(result.memories)) {
      for (const mem of result.memories.slice(0, 3)) {
        if (mem.name && mem.content) {
          writeWorkspaceMemory(workspaceId, mem.name, mem.content)
          memoriesWritten++
        }
      }
    }

    // 更新 agent.md（仅在 LLM 明确返回时）
    if (typeof result.agentMdUpdate === 'string' && result.agentMdUpdate.trim()) {
      writeAgentMd(workspaceId, result.agentMdUpdate)
      agentMdUpdated = true
    }

    if (memoriesWritten > 0 || agentMdUpdated) {
      console.log(`[AgentDreamer] ${workspaceId.substring(0, 8)}: ${memoriesWritten} memories, agentMd ${agentMdUpdated ? 'updated' : 'unchanged'}`)
    }

    onComplete?.({ memories: memoriesWritten, agentMdUpdated })
  } catch (err: any) {
    console.error('[AgentDreamer] 失败:', err.message)
  } finally {
    _running = false
  }
}
