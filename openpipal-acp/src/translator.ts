/**
 * 事件翻译器：把 OpenPipal SSE 事件翻译成 ACP session/update 通知
 *
 * Stage 4: text / thinking / tool_start/end / error
 * Stage 6: artifact / visualizer / questions_v2 / ask_user / mcp_app_inline / permission_request
 *
 * 设计原则：
 * - OpenPipal 特色（artifact/visualizer 等 ACP 没原生支持的）双轨发送：
 *   1. _meta.openpipal.io/<feature> 完整结构（懂的 client 可定制渲染）
 *   2. markdown 兜底文本（agent_message_chunk）确保普通 client 也能看到
 */

import { randomUUID } from 'node:crypto'

export type AcpProtocolVersion = 1 | 2
export type SessionUpdateEmitter = (update: Record<string, unknown>) => Promise<void>

export interface OpenPipalEvent {
  type: string
  content?: string
  name?: string
  // tool_end 字段
  screenshot?: string
  searchResults?: string
  mcpResult?: string
  mcpArgs?: string
  visualizer?: { id: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number }
  // artifact 事件
  artifact?: { id: string; type: string; title: string; content: string; language?: string }
  // artifact_delta / visualizer_delta
  id?: string
  title?: string
  artifactType?: string
  height?: number
  // mcp_app_inline
  messageId?: string
  payload?: any
  // ask_user
  question?: string
  options?: { label: string; value: string }[]
  fields?: any[]
  // questions_v2
  questions?: any[]
  // permission_request
  requestId?: string
  tool?: string
  args?: Record<string, any>
  risk?: string
  reason?: string

  conversationId?: string
}

export class EventTranslator {
  private currentToolCallId: string | null = null
  private readonly agentMessageId = `sw-message-${randomUUID()}`
  private readonly thoughtMessageId = `sw-thought-${randomUUID()}`
  private waitingForAction = false

  constructor(
    private emitUpdate: SessionUpdateEmitter,
    private protocolVersion: AcpProtocolVersion,
  ) {}

  async handle(evt: OpenPipalEvent): Promise<void> {
    if (this.protocolVersion === 2 && this.waitingForAction && evt.type !== 'permission_request') {
      await this.emit({ sessionUpdate: 'state_update', state: 'running' })
      this.waitingForAction = false
    }

    switch (evt.type) {
      // ============= Stage 4 已实现 =============
      case 'text':
        if (evt.content) await this.emitText(evt.content)
        break

      case 'thinking':
        if (evt.content) {
          await this.emitMessageChunk('agent_thought_chunk', this.thoughtMessageId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: evt.content },
          })
        }
        break

      case 'text_flush':
      case 'thinking_end':
      case 'done':
        break

      case 'tool_start':
        this.currentToolCallId = `sw-tool-${randomUUID()}`
        await this.emit({
          sessionUpdate: this.protocolVersion === 2 ? 'tool_call_update' : 'tool_call',
          toolCallId: this.currentToolCallId,
          title: evt.name || 'tool',
          kind: 'execute',
          status: 'in_progress',
        } as any)
        break

      case 'tool_progress':
        // OpenPipal 字符级进度,ACP 没原生支持,跳过
        break

      case 'tool_end':
        if (this.currentToolCallId) {
          const content: any[] = []
          if (evt.searchResults) {
            content.push({ type: 'content', content: { type: 'text', text: evt.searchResults } })
          }
          if (evt.mcpResult) {
            content.push({ type: 'content', content: { type: 'text', text: evt.mcpResult } })
          }
          // tool_end 里如果带了 visualizer (OpenPipal 内联场景),也走 _meta
          const meta: any = {}
          if (evt.visualizer) {
            meta['openpipal.io/visualizer'] = evt.visualizer
          }
          if (evt.screenshot) {
            // 截图作为 image content block 给 ACP
            content.push({
              type: 'content',
              content: { type: 'image', mimeType: 'image/png', data: evt.screenshot },
            })
          }
          await this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: this.currentToolCallId,
            status: 'completed',
            ...(content.length > 0 ? { content } : {}),
            ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
          } as any)
          this.currentToolCallId = null
        }
        break

      case 'error':
        if (evt.content) {
          await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `[Error] ${evt.content}` },
          })
        }
        break

      // ============= Stage 6: OpenPipal 特色双轨 fallback =============
      case 'artifact':
        if (evt.artifact) {
          // _meta 透传完整结构
          await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
            sessionUpdate: 'agent_message_chunk',
            _meta: { 'openpipal.io/artifact': evt.artifact },
            content: {
              type: 'text',
              text: `\n\n📎 **Artifact: ${evt.artifact.title}** (${evt.artifact.type}, id: \`${evt.artifact.id}\`)\n\n*OpenPipal 桌面端侧栏可查看完整预览。*\n\n`,
            },
          })
        }
        break

      case 'visualizer':
        if (evt.visualizer) {
          await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
            sessionUpdate: 'agent_message_chunk',
            _meta: { 'openpipal.io/visualizer': evt.visualizer },
            content: {
              type: 'text',
              text: `\n\n📊 **Visualizer: ${evt.visualizer.title}** (${evt.visualizer.type})\n\n*OpenPipal 桌面端侧栏可查看完整可视化。*\n\n`,
            },
          })
        }
        break

      case 'artifact_delta':
      case 'visualizer_delta':
        // 流式中间态——ACP 没原生支持,_meta 透传给懂的 client
        // markdown 不发避免 spam
        await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
          sessionUpdate: 'agent_message_chunk',
          _meta: { [`openpipal.io/${evt.type}`]: evt },
          content: { type: 'text', text: '' },
        } as any)
        break

      case 'mcp_app_inline':
        if (evt.payload) {
          await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
            sessionUpdate: 'agent_message_chunk',
            _meta: { 'openpipal.io/mcp_app_inline': evt.payload },
            content: {
              type: 'text',
              text: `\n\n🧩 **MCP App: ${evt.payload.toolName}** (${evt.payload.serverName})\n\n*MCP 应用 UI 仅在 OpenPipal 桌面端渲染。*\n\n`,
            },
          })
        }
        break

      case 'ask_user':
        // 单选/表单收集——通过 _meta 给 client（理想情况能渲染表单）
        // 同时给 markdown fallback 把 question 输出，让 user 看到能在桌面端回答
        const optsMd = evt.options?.length
          ? '\n选项：\n' + evt.options.map((o) => `- ${o.label} (\`${o.value}\`)`).join('\n')
          : ''
        const fieldsMd = evt.fields?.length
          ? '\n需要填写：\n' + evt.fields.map((f: any) => `- **${f.label}**${f.required ? ' *' : ''}`).join('\n')
          : ''
        await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
          sessionUpdate: 'agent_message_chunk',
          _meta: {
            'openpipal.io/ask_user': {
              question: evt.question,
              options: evt.options,
              fields: evt.fields,
            },
          },
          content: {
            type: 'text',
            text: `\n\n❓ **${evt.question || 'OpenPipal 在等你的回答'}**${optsMd}${fieldsMd}\n\n*请到 OpenPipal 桌面端回答此问题。*\n\n`,
          },
        })
        break

      case 'questions_v2':
        // 整页问卷——同上
        const qCount = evt.questions?.length || 0
        await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
          sessionUpdate: 'agent_message_chunk',
          _meta: {
            'openpipal.io/questions_v2': {
              title: evt.title,
              questions: evt.questions,
            },
          },
          content: {
            type: 'text',
            text: `\n\n📋 **${evt.title || '问卷'}** (${qCount} 项)\n\n*请到 OpenPipal 桌面端填写。*\n\n`,
          },
        })
        break

      case 'permission_request':
        // 权限确认——通过 _meta 透传，markdown 提示用户去桌面端确认
        // 注：理想做法是用 ACP session/request_permission 反向调 client，但桌面端 Pi Agent
        // 已经在等用户确认（IPC 弹窗），不能 block ACP server。先简单透传 + markdown
        if (this.protocolVersion === 2) {
          await this.emit({ sessionUpdate: 'state_update', state: 'requires_action' })
          this.waitingForAction = true
        }
        await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
          sessionUpdate: 'agent_message_chunk',
          _meta: {
            'openpipal.io/permission_request': {
              requestId: evt.requestId,
              tool: evt.tool,
              args: evt.args,
              risk: evt.risk,
              reason: evt.reason,
            },
          },
          content: {
            type: 'text',
            text: `\n\n🔐 **需要权限确认**：${evt.tool} (风险: ${evt.risk})\n${evt.reason || ''}\n\n*请到 OpenPipal 桌面端确认。*\n\n`,
          },
        })
        break

      default:
        // 未识别事件不发,只记 stderr 防 stdout 污染
        console.error(`[openpipal-acp] unhandled SSE event: ${evt.type}`)
        break
    }
  }

  private async emitText(text: string): Promise<void> {
    await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    })
  }

  private async emitMessageChunk(
    _kind: 'agent_message_chunk' | 'agent_thought_chunk',
    messageId: string,
    update: Record<string, unknown>,
  ): Promise<void> {
    await this.emit(this.protocolVersion === 2 ? { ...update, messageId } : update)
  }

  private async emit(update: Record<string, unknown>): Promise<void> {
    await this.emitUpdate(update)
  }
}
