import { describe, expect, it } from 'vitest'
import { shouldOfferAiDecision } from '../../src/renderer/src/chat/questionChoices'

describe('questions_v2 的 AI 代选边界', () => {
  it('普通偏好问题仍可交给 AI 判断', () => {
    expect(shouldOfferAiDecision({ options: ['简洁', '详细'] })).toBe(true)
  })

  it('Agent 可显式关闭 AI 代选', () => {
    expect(shouldOfferAiDecision({ allowAiDecision: false, options: ['是', '否'] })).toBe(false)
  })

  it('个人风格写入类旧问卷即使没有新字段也必须由老师本人决定', () => {
    expect(shouldOfferAiDecision({
      options: ['准确，记下来', '大体对，需要修改', '不代表我，不记录']
    })).toBe(false)
  })
})
