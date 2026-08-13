/**
 * Agent Extractor — 从对话内容中提取 Agent 配置
 *
 * 分析对话历史，生成：
 *   - 名称、图标、描述
 *   - agent.md（人格 + system prompt）
 *   - 记忆条目（领域知识）
 *
 * 复用 memory-extractor.ts 的 LLM 调用模式。
 */

import { completeSimple } from '@earendil-works/pi-ai/compat'
import type { ChatMessage } from './agent-runtime/contracts'
import { getPiModel, ensurePiApiKey, getEffectiveModelConfig, createModelPayloadAdapter, auxCompletionTuning } from './config-manager'
import { stripJsonFence } from './simple-completion'

// ---- Types ----

export interface ExtractedSkillFile {
  path: string    // 如 "scripts/render.py", "references/api.md"
  content: string
}

export interface ExtractedSkill {
  name: string       // skill 目录名（英文短横线命名）
  skillMd: string    // SKILL.md 完整内容（含 YAML frontmatter）
  files?: ExtractedSkillFile[]  // 附加文件（scripts/, references/）
}

export interface ExtractedAgent {
  name: string
  icon: string
  description: string
  agentMd: string
  meMd: string
  memories: {
    name: string
    description: string
    content: string
  }[]
  skills: ExtractedSkill[]
}

// ---- Prompt ----

function buildExtractionPrompt(): string {
  return `你是 OpenPipal 的 Agent 提取引擎。分析用户与 AI 的对话内容，提取出一个完整的 Agent 工作空间配置。

## 你的任务

从对话中理解 5 个维度：
1. **AI 角色**：这个 AI 在扮演什么角色？有什么专长？
2. **协作模式**：用户和 AI 之间形成了什么样的工作方式？
3. **领域知识**：有哪些值得长期保留的领域知识？
4. **用户画像**：这个用户是什么样的人？知识水平、偏好、习惯？
5. **可复用技能**：对话中有没有可以沉淀为标准流程的操作模式？

## 输出 JSON 格式

{
  "name": "Agent 名称（2-6个字）",
  "icon": "一个合适的 emoji",
  "description": "一句话描述（15字以内）",
  "agentMd": "agent.md 内容",
  "meMd": "me.md 内容（用户画像）",
  "memories": [
    {
      "name": "文件名（英文下划线命名）",
      "description": "一句话描述",
      "content": "Markdown 内容（带 YAML frontmatter）"
    }
  ],
  "skills": [
    {
      "name": "skill-name（英文短横线命名）",
      "skillMd": "SKILL.md 完整内容（必须含 YAML frontmatter）",
      "files": [
        { "path": "scripts/xxx.py", "content": "脚本内容" },
        { "path": "references/xxx.md", "content": "参考文档" }
      ]
    }
  ]
}

只输出上面这一个 JSON 对象本身，不要任何额外文字、解释或代码栅栏（如 \`\`\`json）。

## agent.md 格式

\`\`\`markdown
# {Agent 名称}

{自然语言描述：这个 Agent 是谁，擅长什么}

## 专长领域
- ...

## 行为偏好
- {从对话中观察到的风格偏好}

## 工作方式
- {协作模式}
\`\`\`

## me.md 格式（用户画像）

\`\`\`markdown
# 关于用户

## 角色
{用户的职业/身份，如"小学数学老师"、"计算机系研究生"}

## 知识水平
{用户在相关领域的水平，如"精通 Python 但不熟悉前端"}

## 偏好
- {沟通偏好，如"喜欢简洁回答"、"需要中文"}
- {内容偏好，如"偏好实际例子"、"不喜欢长篇大论"}

## 习惯
- {工作习惯，如"习惯先看大纲再细化"、"经常修改需求"}
\`\`\`

如果对话太短无法判断用户画像，meMd 返回空字符串。

## SKILL.md 格式（可复用技能）

\`\`\`markdown
---
name: skill-name
description: 什么时候该用这个技能（触发条件描述）
---

# 技能名称

## 流程
1. 步骤一
2. 步骤二
...
\`\`\`

### 什么样的对话模式值得沉淀为 skill？

- AI 反复执行相同的多步骤流程（如"批改作业的标准流程"）
- 用户明确要求"以后都这样做"的操作规范
- 涉及特定工具调用链的工作流（如"先截图→分析→生成报告"）

### 复杂度判断

- **简单**（只需 SKILL.md）：纯文字流程描述
- **中等**（SKILL.md + references/）：流程 + 参考文档/模板
- **复杂**（SKILL.md + scripts/ + references/）：流程 + 可执行脚本

如果对话中没有可复用的模式，skills 返回空数组。
大多数对话不需要提取 skill — 只在确实有反复出现的结构化流程时才提取。

## 注意事项

- agent.md / me.md / memories / skills 都从对话推断，不是复制对话内容
- 名称应体现功能特点，不要用"AI助手"这种泛称
- 宁缺勿滥：没有明确信号就返回空数组/空字符串`
}

/** 只格式化对话正文：非 user 一律标"[助手]"，工具轨迹混进来就成了助手的伪证词。
 *  滤在切片之前——切完再滤，窗口已经被工具消息吃掉了（口径同 evolver-agent） */
function formatConversation(messages: ChatMessage[], maxMessages = 30): string {
  const recent = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-maxMessages)
  return recent
    .map(m => {
      const role = m.role === 'user' ? '用户' : '助手'
      const content = m.content.slice(0, 800)
      return `[${role}] ${content}`
    })
    .join('\n\n')
}

// ---- Extraction ----

export async function extractAgentFromConversation(
  messages: ChatMessage[],
  _roleName: string
): Promise<ExtractedAgent> {
  const model = getPiModel()
  ensurePiApiKey(model.provider)
  const prompt = buildExtractionPrompt()
  const conversationText = formatConversation(messages)

  console.log(`[AgentExtractor] 开始提取，${messages.length} 条消息`)

  const tune = auxCompletionTuning(getEffectiveModelConfig(), model, 4096)
  const completion = await completeSimple(model, {
    systemPrompt: prompt,
    messages: [
      { role: 'user' as const, content: `以下是对话内容，请分析并提取 Agent 配置：\n\n${conversationText}`, timestamp: Date.now() }
    ]
  }, {
    maxTokens: tune.maxTokens,
    reasoning: tune.reasoning,
    apiKey: getEffectiveModelConfig().apiKey || undefined, // 显式 key 防并发 env 互踩
    temperature: 0.3,
    timeoutMs: 120_000, // 2 分钟超时（Qwen API 较慢）
    maxRetries: 2,
    onPayload: createModelPayloadAdapter()
  })

  if (completion.stopReason === 'error') {
    throw new Error(completion.errorMessage || 'LLM 调用失败')
  }

  const raw = stripJsonFence(
    (completion.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
  ) || '{}'

  try {
    const result = JSON.parse(raw)

    const extracted: ExtractedAgent = {
      name: result.name || '未命名 Agent',
      icon: result.icon || '🤖',
      description: result.description || '',
      agentMd: result.agentMd || `# ${result.name || 'Agent'}\n\n从对话中生成的 Agent。`,
      meMd: result.meMd || '',
      memories: Array.isArray(result.memories) ? result.memories.map((m: any) => ({
        name: String(m.name || 'memory'),
        description: String(m.description || ''),
        content: String(m.content || '')
      })) : [],
      skills: Array.isArray(result.skills) ? result.skills.map((s: any) => ({
        name: String(s.name || 'skill'),
        skillMd: String(s.skillMd || ''),
        files: Array.isArray(s.files) ? s.files.map((f: any) => ({
          path: String(f.path || ''),
          content: String(f.content || '')
        })).filter((f: ExtractedSkillFile) => f.path && f.content) : []
      })).filter((s: ExtractedSkill) => s.skillMd) : []
    }

    console.log(`[AgentExtractor] 提取完成: ${extracted.name} (${extracted.memories.length} 条记忆, ${extracted.skills.length} 个技能, me.md ${extracted.meMd ? '✓' : '—'})`)
    return extracted
  } catch (err) {
    console.error('[AgentExtractor] JSON 解析失败:', err)
    // 回退：返回最小 Agent
    return {
      name: '未命名 Agent',
      icon: '🤖',
      description: '从对话中创建',
      agentMd: '# Agent\n\n从对话中生成的 Agent。',
      meMd: '',
      memories: [],
      skills: []
    }
  }
}
