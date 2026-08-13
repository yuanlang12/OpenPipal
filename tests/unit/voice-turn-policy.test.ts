import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  reduceVoiceTurn,
  INITIAL_VOICE_TURN_STATE,
  TOOL_EXECUTED,
  VoiceTurnState
} from '../../src/main/voice-turn-policy.ts'

// 把一串服务端事件喂给状态机,收集"建了几次 response.create / 避免了几次撞车 / 最终工具链步数"。
// 这就是 headless 演示"语音多工具链式 + 无撞车 + 无死寂"这条文字↔语音对齐核心机制。
function run(events: string[]): { creates: number; collisions: number; final: VoiceTurnState } {
  let state = { ...INITIAL_VOICE_TURN_STATE }
  let creates = 0
  let collisions = 0
  for (const e of events) {
    const d = reduceVoiceTurn(state, e)
    state = d.state
    if (d.createResponse) creates++
    if (d.collisionAvoided) collisions++
  }
  return { creates, collisions, final: state }
}

// 服务端在收到 client 的 response.create 后会回 response.created;这里模拟"我们建了就紧跟一个 created"
function createdAfter(events: string[]): string[] {
  const out: string[] = []
  let active = false
  for (const e of events) {
    out.push(e)
    if (e === 'response.created') active = true
    if (e === 'response.done') active = false
    // committed 且当前无活跃 → 我们会发 create → 服务端回 created
    if (e === 'input_audio_buffer.committed' && !active) {
      out.push('response.created')
      active = true
    }
  }
  return out
}

test('单个用户回合恰好建 1 个 response(不漏=无死寂)', () => {
  const r = run(createdAfter(['session.updated', 'input_audio_buffer.committed']))
  assert.equal(r.creates, 1)
  assert.equal(r.collisions, 0)
})

test('一问一答多轮:每个用户回合各建 1 个,不重不漏', () => {
  // 回合1: committed→create→created→...→done; 回合2: committed→create→created→done
  const seq = createdAfter([
    'input_audio_buffer.committed', 'response.done',
    'input_audio_buffer.committed', 'response.done',
    'input_audio_buffer.committed', 'response.done'
  ])
  const r = run(seq)
  assert.equal(r.creates, 3)       // 3 个用户回合 = 3 次 create
  assert.equal(r.collisions, 0)    // 无撞车
})

test('response 进行中又来 committed(barge-in/竞态)→ 不重复建(避免 conversation_already_has_active_response)', () => {
  // committed→create→created(进行中) ... 还没 done 又来一个 committed → 应避免撞车,不建第二个
  const r = run([
    'input_audio_buffer.committed',  // → create #1
    'response.created',              // 进行中
    'input_audio_buffer.committed'   // 进行中又 committed → collisionAvoided,不 create
  ])
  assert.equal(r.creates, 1)
  assert.equal(r.collisions, 1)
})

test('多工具链式:一个用户回合内连调 3 个工具,toolChainStep 累加到 3', () => {
  // committed(归零) → 工具1 → 工具2 → 工具3,中间没有新的 committed
  const r = run([
    'input_audio_buffer.committed',
    'response.created', TOOL_EXECUTED, 'response.done',  // 工具1 那条 response
    'response.created', TOOL_EXECUTED, 'response.done',  // 工具2
    'response.created', TOOL_EXECUTED, 'response.done'   // 工具3
  ])
  assert.equal(r.final.toolChainStep, 3)  // N>1 = 多工具链式生效
})

test('新用户回合 committed → 工具链计数归零', () => {
  const r = run([
    'input_audio_buffer.committed', TOOL_EXECUTED, TOOL_EXECUTED, // 回合1:2 个工具
    'response.done',
    'input_audio_buffer.committed'  // 回合2 开始 → 归零
  ])
  assert.equal(r.final.toolChainStep, 0)
})

test('工具回合的 create 不撞车:function_call 那条 response done 后 responseActive=false', () => {
  // 模拟:committed→create→created(含function_call)→done(responseActive 回 false)
  // 此时 handleVoiceFunctionCall 发 create(工具结果回填后)→ 不撞车
  let state = { ...INITIAL_VOICE_TURN_STATE }
  for (const e of ['input_audio_buffer.committed', 'response.created', 'response.done']) {
    state = reduceVoiceTurn(state, e).state
  }
  assert.equal(state.responseActive, false)  // 工具执行时无活跃 response → main 可安全 create 总结回复
})
