/**
 * 是否允许在当前问题上出现“交给 AI 判断”。
 *
 * `allowAiDecision: false` 是 Agent 的显式声明；同时对旧会话做语义兜底：只要选项同时
 * 包含“写入/保存”和“不记录/不写入”，就视为用户本人必须裁决的持久化决定。
 */
export function shouldOfferAiDecision(question: any): boolean {
  if (question?.allowAiDecision === false) return false
  const options: string[] = Array.isArray(question?.options)
    ? (question.options as unknown[]).filter(
        (value: unknown): value is string => typeof value === 'string'
      )
    : []
  const hasPersistChoice = options.some(option => /(记下来|写入|保存|纳入|沉淀)/.test(option))
  const hasRejectChoice = options.some(option => /(不记录|不要记录|不写入|不保存|不纳入|不沉淀)/.test(option))
  return !(hasPersistChoice && hasRejectChoice)
}
