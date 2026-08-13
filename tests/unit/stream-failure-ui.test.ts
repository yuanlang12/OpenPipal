import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolMessage, createUserMessage, failUnfinishedToolMessages, isRenderableToolMessage, shouldSendMessageToModel, stripOffloadedInline } from '../../src/renderer/src/chat/messages'

describe('模型流失败时收敛空工具卡', () => {
  it('只标记当前用户回合里尚未收到结果的工具调用', () => {
    const oldTool = createToolMessage({ id: 'old', toolName: 'read', content: '旧结果', timestamp: 1 })
    const user = createUserMessage({ id: 'user', content: '继续', timestamp: 2 })
    const pending = createToolMessage({ id: 'pending', toolName: 'bash', toolCallId: 'call-1', timestamp: 3 })

    const next = failUnfinishedToolMessages([oldTool, user, pending], '工具调用流提前结束')

    expect(next[0].content).toBe('旧结果')
    expect(next[2].content).toBe('失败：工具调用流提前结束')
    expect(next[2].toolCallId).toBe('call-1')
  })

  it('已有 artifact 引用的工具卡不会被误判为失败', () => {
    const tool = createToolMessage({
      id: 'artifact-tool',
      toolName: 'create_artifact',
      artifactRef: { id: 'artifact-1', type: 'code', title: 'scene.jsx', path: '/tmp/scene.jsx' },
      timestamp: 1
    })

    expect(failUnfinishedToolMessages([tool], '断流')).toBeInstanceOf(Array)
    expect(failUnfinishedToolMessages([tool], '断流')[0].content).toBe('')
  })
})

describe('附件卸载的落盘投影', () => {
  it('有 ref 的消息剥离内联大字段，无 ref 的原样保留（引用不变）', () => {
    const offloaded: any = {
      id: 'm1', role: 'tool', toolName: 'capture_screenshot', content: '', timestamp: 1,
      screenshot: 'A'.repeat(100_000), screenshotRef: 'm1.png'
    }
    const mcpApp: any = {
      id: 'm2', role: 'tool', toolName: 'mcp_app_render', content: '', timestamp: 2,
      mcpAppPayload: { html: '<x/>' }, mcpAppRef: 'm2.mcpapp.json'
    }
    const untouched: any = {
      id: 'm3', role: 'tool', toolName: 'capture_screenshot', content: '', timestamp: 3,
      screenshot: 'B'.repeat(1000) // 无 ref(卸载失败/插件端)——保持内联，行为不降级
    }

    const result = stripOffloadedInline([offloaded, mcpApp, untouched])
    expect(result[0].screenshot).toBeUndefined()
    expect(result[0].screenshotRef).toBe('m1.png')
    expect(result[1].mcpAppPayload).toBeUndefined()
    expect(result[1].mcpAppRef).toBe('m2.mcpapp.json')
    expect(result[2]).toBe(untouched)
    // 原对象不被就地修改——内存态/模型载荷继续看到内联内容
    expect(offloaded.screenshot?.length).toBe(100_000)
  })

  it('只剩 ref 的消息仍视为可渲染（不会被断流收敛误标失败）', () => {
    const refOnly = createToolMessage({ id: 'r1', toolName: 'capture_screenshot', timestamp: 1 })
    const withRef = { ...refOnly, screenshotRef: 'r1.png' }
    expect(isRenderableToolMessage(withRef)).toBe(true)
    expect(failUnfinishedToolMessages([withRef], '断流')[0].content).toBe('')
  })
})

describe('合成错误气泡不进模型历史', () => {
  it('只过滤带稳定元数据的合成错误，正常模型 [Error] 正文仍保留', () => {
    const errorBubble = createAssistantMessage({
      id: 'e1',
      content: '[Error] 模型工具调用流提前结束，请重试本轮。',
      messageKind: 'incomplete',
      messageSubtype: 'stream-error',
      syntheticErrorOffset: 0,
      timestamp: 1
    })
    const modelStartsWithError = createAssistantMessage({
      id: 'a0', content: '[Error] is the exact token emitted by this provider.', timestamp: 2
    })
    const normal = createAssistantMessage({ id: 'a1', content: '这是正常回复', timestamp: 2 })
    const mentionsError = createAssistantMessage({
      id: 'a2', content: '关于 [Error] 前缀的说明：它出现在……', timestamp: 3
    })

    expect(shouldSendMessageToModel(errorBubble)).toBe(false)
    expect(shouldSendMessageToModel(modelStartsWithError)).toBe(true)
    expect(shouldSendMessageToModel(normal)).toBe(true)
    // 模型正文里提到或写出 sentinel 不等于 OpenPipal 合成错误。
    expect(shouldSendMessageToModel(mentionsError)).toBe(true)
  })

  it('用户 Stop 后的可见部分回复标为 incomplete，不回放给模型', () => {
    const incomplete = createAssistantMessage({
      id: 'partial', content: '尚未生成完的部分回复', messageKind: 'incomplete', timestamp: 3
    })
    expect(incomplete.content).toBe('尚未生成完的部分回复')
    expect(incomplete.messageKind).toBe('incomplete')
    expect(shouldSendMessageToModel(incomplete)).toBe(false)
  })
})
