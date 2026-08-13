/**
 * 对话标题生成器
 * 使用 AI 从对话首轮内容生成简洁标题，替代截断逻辑。
 * 异步执行，不阻塞消息保存。
 */

import { completeSimple } from '@earendil-works/pi-ai/compat'
import { getPiModel, ensurePiApiKey, createModelPayloadAdapter, getEffectiveModelConfig, auxCompletionTuning } from './config-manager'

/**
 * 从对话首轮内容生成标题（6-10 个中文字）
 * 失败时回退到截断逻辑
 */
export async function generateTitle(userMessage: string, assistantReply?: string): Promise<string> {
  const fallback = userMessage.substring(0, 30).replace(/\n/g, ' ') + (userMessage.length > 30 ? '...' : '')

  try {
    const model = getPiModel()
    ensurePiApiKey(model.provider)
    const mc = getEffectiveModelConfig()
    const tune = auxCompletionTuning(mc, model, 30)

    const conversation = assistantReply
      ? `用户: ${userMessage.substring(0, 200)}\n助手: ${assistantReply.substring(0, 200)}`
      : userMessage.substring(0, 300)

    const result = await completeSimple(model, {
      messages: [{
        role: 'user' as const,
        content: `用6-10个中文字概括以下对话的主题。只输出标题，不加标点、引号或解释。\n\n${conversation}`,
        timestamp: Date.now()
      }]
    }, {
      maxTokens: tune.maxTokens,
      reasoning: tune.reasoning,
      apiKey: mc.apiKey || undefined, // 显式 key 防并发 env 互踩（对齐其余辅助路径）
      temperature: 0.3,
      timeoutMs: 60_000,
      maxRetries: 2,
      onPayload: createModelPayloadAdapter()
    })

    if (result.stopReason === 'error') {
      throw new Error(result.errorMessage || 'LLM 调用失败')
    }

    const title = (result.content || [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
      .trim()

    if (title && title.length >= 2 && title.length <= 30) {
      return title.replace(/["""''。，！？、；：\n]/g, '')
    }
    return fallback
  } catch (err: any) {
    console.warn('[TitleGen] AI 标题生成失败，使用截断:', err.message)
    return fallback
  }
}
