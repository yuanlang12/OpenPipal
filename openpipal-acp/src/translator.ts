/**
 * 事件翻译器：把 OpenPipal SSE 事件翻译成 ACP session/update 通知
 *
 * Stage 4: text / thinking / tool_start/end / error
 * Stage 6: artifact / visualizer / questions_v2 / ask_user / mcp_app_inline
 * Stage 10: permission —— 反向调客户端 session/request_permission，编辑器里就地确认
 *
 * 设计原则：
 * - OpenPipal 特色（artifact/visualizer 等 ACP 没原生支持的）双轨发送：
 *   1. _meta.openpipal.io/<feature> 完整结构（懂的 client 可定制渲染）
 *   2. markdown 兜底文本（agent_message_chunk）确保普通 client 也能看到
 */

import { randomUUID } from 'node:crypto'

export type AcpProtocolVersion = 1 | 2
export type SessionUpdateEmitter = (update: Record<string, unknown>) => Promise<void>

/** 桌面端 permission 事件里的 request 体（原样透传，适配器不构造这些字段） */
export interface PermissionRequestPayload {
  requestId?: string
  tool?: string
  args?: Record<string, unknown>
  risk?: string
  reason?: string
  conversationId?: string
  executionId?: string
}

/**
 * 把一次授权走完：问客户端 → 把结果回传桌面端。实现方负责 fail closed
 * （客户端不答就回拒绝），所以这里 resolve 即代表桌面端已经收到裁决。
 */
export type PermissionBridge = (
  request: PermissionRequestPayload,
  toolCallId: string,
) => Promise<void>

export interface OpenPipalEvent {
  type: string
  content?: string
  name?: string
  /** tool_start / tool_end / tool_progress 带的桌面端调用 id（并行工具靠它区分） */
  toolCallId?: string
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
  /** 流式增量正文（create_artifact / create_visualizer 边写边发） */
  delta?: string
  offset?: number
  // mcp_app_inline
  messageId?: string
  payload?: any
  // ask_user
  question?: string
  options?: { label: string; value: string }[]
  fields?: any[]
  // questions_v2
  questions?: any[]
  // permission（桌面端把细节包在 request 里发出）
  request?: PermissionRequestPayload

  // goal_update（目标判定循环的进度）
  goal?: {
    text?: string
    maxTurns?: number
    turnsUsed?: number
    status?: string
    lastCheck?: { ok?: boolean; reason?: string }
  }

  conversationId?: string
}

interface TrackedToolCall {
  /** 发给客户端的 ACP toolCallId */
  acpId: string
  /** v2 下是否已经用 tool_call_content_chunk 流过正文（决定收尾能不能带 content） */
  streamed: boolean
}

export class EventTranslator {
  /**
   * 桌面端 toolCallId → 本次调用的状态。**不能只留一个槽**：模型一条回复里可以同时
   * 发多个 tool_use block，pi 会在任何一个执行前就把两条 tool_start 都推出来，
   * 单槽会让先开的那个永远停在 in_progress、后开的那个吃掉别人的结果。
   */
  private readonly toolCalls = new Map<string, TrackedToolCall>()
  /**
   * 最近开启且尚未收尾的那次调用。artifact_delta / visualizer_delta 不带 toolCallId
   * （桌面端的流式 JSON 提取器一次只跟一个工具），权限确认同理，都挂在它身上。
   */
  private currentToolKey: string | null = null
  private syntheticToolSeq = 0
  private readonly agentMessageId = `sw-message-${randomUUID()}`
  private readonly thoughtMessageId = `sw-thought-${randomUUID()}`

  constructor(
    private emitUpdate: SessionUpdateEmitter,
    private protocolVersion: AcpProtocolVersion,
    private permissionBridge?: PermissionBridge,
  ) {}

  async handle(evt: OpenPipalEvent): Promise<void> {
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

      // 服务端自用的过程事件，不是给客户端看的内容：
      // - runtime_context：前缀缓存快照，落盘用
      // - context_usage：token 用量遥测（v2 有 usage_update 可以承接，但 SDK 把它标成
      //   UNSTABLE，随时可能改，先不接）
      // - questions_v2_delta：问卷的流式中间态，最终 questions_v2 带完整载荷
      // 不显式列出来的话，每轮都会往 stderr 刷 "unhandled SSE event"，编辑器里看得见。
      case 'runtime_context':
      case 'context_usage':
      case 'questions_v2_delta':
        break

      case 'tool_start': {
        const key = evt.toolCallId || `sw-local-${++this.syntheticToolSeq}`
        const acpId = `sw-tool-${randomUUID()}`
        this.toolCalls.set(key, { acpId, streamed: false })
        this.currentToolKey = key
        await this.emit({
          sessionUpdate: this.protocolVersion === 2 ? 'tool_call_update' : 'tool_call',
          toolCallId: acpId,
          title: evt.name || 'tool',
          kind: 'execute',
          status: 'in_progress',
        } as any)
        break
      }

      case 'tool_progress':
        // OpenPipal 字符级进度,ACP 没原生支持,跳过
        break

      case 'tool_end': {
        const key = this.resolveToolKey(evt.toolCallId)
        const tracked = key === null ? undefined : this.toolCalls.get(key)
        if (!tracked || key === null) break

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

        // v2 的 tool_call_update.content 是**替换**语义：这次调用要是已经用 chunk
        // 流过正文，这里再带 content 就等于把用户刚看着写出来的产物整个抹掉。
        // 收尾摘要改成再追加一条 chunk，正文原样留着。
        const appendInsteadOfReplace = this.protocolVersion === 2 && tracked.streamed
        if (appendInsteadOfReplace) {
          for (const item of content) {
            await this.emit({
              sessionUpdate: 'tool_call_content_chunk',
              toolCallId: tracked.acpId,
              content: item,
            })
          }
        }
        await this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: tracked.acpId,
          status: 'completed',
          ...(!appendInsteadOfReplace && content.length > 0 ? { content } : {}),
          ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        } as any)

        this.toolCalls.delete(key)
        if (this.currentToolKey === key) {
          // 还开着的调用里取最后一个当"当前"，没有就置空
          const open = Array.from(this.toolCalls.keys())
          this.currentToolKey = open.length > 0 ? open[open.length - 1] : null
        }
        break
      }

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
      case 'visualizer_delta': {
        // v2 有正经的流式工具内容通道：把增量正文追加到当前这次工具调用上，
        // 编辑器里就能看着 artifact/visualizer 一个字一个字被写出来。
        // v1 没有这个通道，只能沿用 _meta 透传（正文不发，避免刷屏）。
        const meta = { [`openpipal.io/${evt.type}`]: evt }
        const tracked = this.currentToolKey ? this.toolCalls.get(this.currentToolKey) : undefined
        if (this.protocolVersion === 2 && tracked) {
          // 首条 delta 是"开面板"的空信号：v2 下直接丢掉。之前它会掉进下面的
          // 兜底分支，往会话里插一条空的助手消息（正文没了，噪音留下了）。
          if (evt.delta) {
            tracked.streamed = true
            await this.emit({
              sessionUpdate: 'tool_call_content_chunk',
              toolCallId: tracked.acpId,
              content: { type: 'content', content: { type: 'text', text: evt.delta } },
              _meta: meta,
            })
          }
          break
        }
        // v1 没有 chunk 通道；v2 万一没有在跑的工具调用也落到这里，_meta 至少不丢
        await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
          sessionUpdate: 'agent_message_chunk',
          _meta: meta,
          content: { type: 'text', text: '' },
        } as any)
        break
      }

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

      case 'goal_update': {
        // 目标判定循环的进度。每轮都播报会刷屏，所以只在**终态**说人话——
        // 用户在编辑器里设了目标，至少要知道它是达成了还是撞了上限。
        const goal = evt.goal
        if (!goal) break
        const meta = { 'openpipal.io/goal': goal }
        const summary = goal.status === 'done'
          ? `\n\n🎯 **目标已达成**：${goal.text || ''}${goal.lastCheck?.reason ? `\n${goal.lastCheck.reason}` : ''}\n\n`
          : goal.status === 'exceeded'
            ? `\n\n🎯 **目标未达成，已停止续跑**（用了 ${goal.turnsUsed ?? '?'}/${goal.maxTurns ?? '?'} 轮）：${goal.text || ''}\n\n`
            : ''
        await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
          sessionUpdate: 'agent_message_chunk',
          _meta: meta,
          content: { type: 'text', text: summary },
        })
        break
      }

      case 'permission': {
        // 权限确认走 ACP 标准反向请求：编辑器弹自己的授权框，选完由 bridge 回传桌面端。
        // 桌面端此刻正 block 在等这个裁决，所以 bridge 必须 fail closed——它不返回，
        // 这一轮就永远停在 requires_action。
        const request = evt.request
        if (!request?.requestId) break
        const tracked = this.currentToolKey ? this.toolCalls.get(this.currentToolKey) : undefined
        const toolCallId = tracked?.acpId || `sw-permission-${request.requestId}`
        if (this.protocolVersion === 2) {
          await this.emit({ sessionUpdate: 'state_update', state: 'requires_action' })
        }
        try {
          if (!this.permissionBridge) throw new Error('permission bridge unavailable')
          await this.permissionBridge(request, toolCallId)
        } catch (error) {
          // 两种失败要分开说：bridge 把"拒绝"送到了（桌面端已解锁），还是连裁决都没送出去
          // （桌面端还在等它自己的长超时）。后者说成"已自动拒绝"就是骗用户。
          const message = (error as Error).message
          const undelivered = message.includes('裁决未能送达')
          await this.emitMessageChunk('agent_message_chunk', this.agentMessageId, {
            sessionUpdate: 'agent_message_chunk',
            _meta: { 'openpipal.io/permission_request': request },
            content: {
              type: 'text',
              text: undelivered
                ? `\n\n🔐 **授权没能送回 OpenPipal**：${request.tool || '工具'} —— ${message}\n\n`
                : `\n\n🔐 **已自动拒绝** ${request.tool || '工具'} 的授权请求：${message}\n\n`,
            },
          })
        }
        if (this.protocolVersion === 2) {
          await this.emit({ sessionUpdate: 'state_update', state: 'running' })
        }
        break
      }

      default:
        // 未识别事件不发,只记 stderr 防 stdout 污染
        console.error(`[openpipal-acp] unhandled SSE event: ${evt.type}`)
        break
    }
  }

  /** tool_end 带 toolCallId 就按它找；老路径不带，退回"当前那次" */
  private resolveToolKey(toolCallId: string | undefined): string | null {
    if (toolCallId && this.toolCalls.has(toolCallId)) return toolCallId
    return this.currentToolKey
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
