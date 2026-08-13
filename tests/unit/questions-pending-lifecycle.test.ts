import { describe, expect, it } from 'vitest'
import {
  hasAnsweredQuestion,
  isLegacyQuestionWithoutPayload,
  QUESTIONS_V2_PERSISTENCE_VERSION,
  recoverPendingQuestionFromHistory,
  restorePendingQuestion,
  toPersistedPendingQuestion
} from '../../src/renderer/src/chat/questionsPending'

const artifact = {
  id: 'questions-1',
  type: 'questions',
  title: '关于页面目标的问题',
  content: JSON.stringify({
    title: '关于页面目标的问题',
    questions: [{ id: 'goal', kind: 'text-options', title: '主要目标？', options: ['转化'] }]
  })
}

const anchor = {
  id: 'tool-questions-1',
  role: 'tool',
  content: artifact.title,
  artifactRef: { id: artifact.id }
}

describe('questions_v2 待答状态', () => {
  it('将待答问卷最小状态持久化，并可按会话恢复', () => {
    const persisted = toPersistedPendingQuestion({
      artifactId: artifact.id,
      title: artifact.title,
      questions: [{ id: 'goal' }],
      conversationId: 'conv-1'
    })

    expect(persisted).not.toHaveProperty('conversationId')
    expect(restorePendingQuestion(persisted, 'conv-restored')).toMatchObject({
      artifactId: artifact.id,
      conversationId: 'conv-restored'
    })
  })

  it('兼容旧会话：有问卷锚点且没有后续答案时恢复待答状态', () => {
    const recovered = recoverPendingQuestionFromHistory([
      { role: 'user', content: '帮我做一个首页' },
      anchor
    ], [artifact], 'conv-legacy')

    expect(recovered).toMatchObject({
      artifactId: artifact.id,
      conversationId: 'conv-legacy',
      title: artifact.title
    })
  })

  it('旧会话已有对应答案时不重新打开问卷', () => {
    const recovered = recoverPendingQuestionFromHistory([
      anchor,
      { role: 'user', content: '[Questions answered] 问题卡「关于页面目标的问题」\n主要目标？: 转化' }
    ], [artifact], 'conv-answered')

    expect(recovered).toBeNull()
  })

  it('旧版只留下标题、没有题目正文时不伪造恢复，并标记为不可恢复', () => {
    const legacyAnchor = {
      id: 'tool-questions-lost',
      role: 'tool',
      toolName: 'questions_v2',
      content: '关于页面目标的问题',
      artifactRef: { id: 'questions-lost', type: 'questions', title: '关于页面目标的问题', path: '' }
    }

    expect(recoverPendingQuestionFromHistory([legacyAnchor], [], 'conv-lost')).toBeNull()
    expect(isLegacyQuestionWithoutPayload(legacyAnchor)).toBe(true)
    expect(isLegacyQuestionWithoutPayload({
      ...legacyAnchor,
      artifactRef: { ...legacyAnchor.artifactRef, path: '/tmp/questions-lost.json' }
    })).toBe(false)
  })

  it('新版 ephemeral 问卷不会因 path 为空被误标为旧版丢失', () => {
    const currentAnchor = {
      id: 'tool-questions-current',
      role: 'tool',
      toolName: 'questions_v2',
      questionsV2Version: QUESTIONS_V2_PERSISTENCE_VERSION,
      content: '当前问卷',
      artifactRef: { id: 'questions-current', type: 'questions', title: '当前问卷', path: '' }
    }

    expect(isLegacyQuestionWithoutPayload(currentAnchor)).toBe(false)
  })

  it('部署过渡期的问卷只要仍 pending 或已有答案，也不会显示旧版不可恢复提示', () => {
    const transitionAnchor = {
      id: 'tool-questions-transition',
      role: 'tool',
      toolName: 'questions_v2',
      content: '过渡问卷',
      artifactRef: { id: 'questions-transition', type: 'questions', title: '过渡问卷', path: '' }
    }
    const answer = {
      id: 'answer-transition',
      role: 'user',
      content: '[Questions answered] 问题卡「过渡问卷」\n目标？: 完成'
    }

    expect(isLegacyQuestionWithoutPayload(transitionAnchor, {
      pendingArtifactId: 'questions-transition'
    })).toBe(false)
    expect(isLegacyQuestionWithoutPayload(transitionAnchor, {
      messages: [transitionAnchor, answer]
    })).toBe(false)
    expect(hasAnsweredQuestion([answer], '过渡问卷')).toBe(true)
  })

  it('待答问卷不会被更早同标题问卷的答案误关', () => {
    const firstAnchor = {
      id: 'tool-questions-first',
      role: 'tool',
      toolName: 'questions_v2',
      artifactRef: { id: 'questions-first', type: 'questions', title: '几个问题', path: '' }
    }
    const oldAnswer = {
      id: 'answer-first',
      role: 'user',
      content: '[Questions answered] 问题卡「几个问题」\n目标？: 完成'
    }
    const currentAnchor = {
      id: 'tool-questions-current',
      role: 'tool',
      toolName: 'questions_v2',
      artifactRef: { id: 'questions-current', type: 'questions', title: '几个问题', path: '' }
    }
    const messages = [firstAnchor, oldAnswer, currentAnchor]

    expect(hasAnsweredQuestion(messages, '几个问题', 'questions-first')).toBe(true)
    expect(hasAnsweredQuestion(messages, '几个问题', 'questions-current')).toBe(false)
  })
})
