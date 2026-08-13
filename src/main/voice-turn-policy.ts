/**
 * 语音回合策略 —— create_response=false 下,main 接管 response 创建的纯决策逻辑。
 *
 * 抽成纯函数是为了能 headless 演示"多工具链式 + 无撞车 + 无死寂"这条语音/文字对齐的核心机制:
 * 文字模式靠 Pi agent loop 自动多步;语音模式靠这套状态机在 WS 协议上手动续命。
 *
 * 不变量(对齐文字模式的能力):
 *  - 每个用户回合(committed)恰好建 1 个 response —— 不漏(否则死寂)、不重(否则 conversation_already_has_active_response)。
 *  - response 进行中(responseActive)时再来 committed → 不建新的(交给 interrupt_response 取消旧的),记为 collisionAvoided。
 *  - 一个用户回合内可连调多个工具(toolChainStep 累加,committed 时归零);工具回合的 response.create 由 handleVoiceFunctionCall 发,
 *    那时 responseActive 已是 false(function_call 那条 response 已 done),所以不撞车。
 */
export interface VoiceTurnState {
  responseActive: boolean
  toolChainStep: number
}

export interface VoiceTurnDecision {
  state: VoiceTurnState
  /** 是否应在此刻发送 response.create(用户回合结束、且当前无活跃 response) */
  createResponse: boolean
  /** committed 时已有活跃 response → 没建新的(正常 barge-in/竞态;长期出现=潜在死寂信号) */
  collisionAvoided: boolean
}

export const INITIAL_VOICE_TURN_STATE: VoiceTurnState = { responseActive: false, toolChainStep: 0 }

/** 工具执行的伪事件 —— handleVoiceFunctionCall 调用,累加本回合工具计数 */
export const TOOL_EXECUTED = '__voice_tool_executed__'

export function reduceVoiceTurn(state: VoiceTurnState, eventType: string): VoiceTurnDecision {
  let { responseActive, toolChainStep } = state
  let createResponse = false
  let collisionAvoided = false

  switch (eventType) {
    case 'response.created':
      responseActive = true
      break
    case 'response.done':
      responseActive = false
      break
    case 'input_audio_buffer.committed':
      toolChainStep = 0 // 新用户回合 → 工具链计数归零
      if (!responseActive) createResponse = true
      else collisionAvoided = true
      break
    case TOOL_EXECUTED:
      toolChainStep += 1
      break
    default:
      break
  }

  return { state: { responseActive, toolChainStep }, createResponse, collisionAvoided }
}
