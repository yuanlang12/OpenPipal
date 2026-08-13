/**
 * Simple Completion — Artifact 内部调用 LLM 的轻量通道
 *
 * 供 window.openpipal.complete() 使用：单次补全，无工具、无流式事件、无多轮对话历史。
 * 走 pi-ai 的 completeSimple() —— 复用现有模型配置和 API Key。
 *
 * 设计约束（不是全量 agentChat，保持轻）：
 * - 单轮：只接 prompt + 可选 systemPrompt，不维护 history
 * - 无工具：Artifact 里的 AI 能力是"补内容"，不是"再开 Agent"
 * - 硬上限：输出 ≤ 2048 token，防 HTML 里死循环 drain API 额度
 * - 简易节流：每个进程 60s 内最多 30 次
 */

import { completeSimple } from '@earendil-works/pi-ai/compat'
import {
  getPiModel,
  ensurePiApiKey,
  ensurePiApiKeyFor,
  buildModelFromConfig,
  createModelPayloadAdapter,
  getEffectiveModelConfig,
  auxCompletionTuning,
  type ModelConfig
} from './config-manager'

// ---- 节流（进程级，简单够用） ----
const callLog: number[] = []
const WINDOW_MS = 60_000
const MAX_CALLS_PER_WINDOW = 30
export const ARTIFACT_COMPLETION_PROMPT_MAX_BYTES = 32 * 1024
export const ARTIFACT_COMPLETION_SYSTEM_PROMPT_MAX_BYTES = 8 * 1024
export const ARTIFACT_COMPLETION_TIMEOUT_MS = 60_000
export const ARTIFACT_COMPLETION_MAX_CONCURRENT = 2
let activeArtifactCompletions = 0

function checkRateLimit(): void {
  const now = Date.now()
  while (callLog.length > 0 && now - callLog[0] > WINDOW_MS) callLog.shift()
  if (callLog.length >= MAX_CALLS_PER_WINDOW) {
    throw new Error(`Artifact 调用 AI 过于频繁（${WINDOW_MS / 1000}s 内超过 ${MAX_CALLS_PER_WINDOW} 次），已暂停`)
  }
  callLog.push(now)
}

export interface SimpleCompleteOptions {
  prompt: string
  systemPrompt?: string
  maxTokens?: number
  /** Optional caller-owned cancellation for bounded background work. */
  signal?: AbortSignal
  /**
   * 可选的调用级模型配置。会话内的辅助调用（例如历史摘要）必须传入它，
   * 不能悄悄回退到全局默认模型，否则会话钉住的服务商、模型和密钥会被换掉。
   */
  modelConfig?: ModelConfig
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function artifactInput(prompt: unknown, systemPrompt: unknown): { prompt: string; systemPrompt?: string } {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt 为空或格式无效')
  if (utf8Bytes(prompt) > ARTIFACT_COMPLETION_PROMPT_MAX_BYTES) {
    throw new Error(`Artifact prompt 超过 ${ARTIFACT_COMPLETION_PROMPT_MAX_BYTES} bytes 上限`)
  }
  if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
    throw new Error('systemPrompt 格式无效')
  }
  if (typeof systemPrompt === 'string' && utf8Bytes(systemPrompt) > ARTIFACT_COMPLETION_SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(`Artifact systemPrompt 超过 ${ARTIFACT_COMPLETION_SYSTEM_PROMPT_MAX_BYTES} bytes 上限`)
  }
  return { prompt, systemPrompt: systemPrompt || undefined }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Artifact completion aborted')
  error.name = 'AbortError'
  return error
}

/** Canonical, bounded sink for untrusted HTML artifact completion requests. */
export async function completeInArtifact(
  prompt: unknown,
  systemPrompt?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const input = artifactInput(prompt, systemPrompt)
  if (activeArtifactCompletions >= ARTIFACT_COMPLETION_MAX_CONCURRENT) {
    throw new Error('Artifact AI 正在处理其他请求，请稍后再试')
  }
  activeArtifactCompletions += 1
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(() => {
    const error = new Error(`Artifact completion 超过 ${ARTIFACT_COMPLETION_TIMEOUT_MS / 1000}s 上限`)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, ARTIFACT_COMPLETION_TIMEOUT_MS)
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(abortReason(controller.signal))
    else controller.signal.addEventListener('abort', () => reject(abortReason(controller.signal)), { once: true })
  })
  try {
    return await Promise.race([
      simpleComplete({
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        maxTokens: 1024,
        signal: controller.signal,
      }),
      abortPromise,
    ])
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', forwardAbort)
    activeArtifactCompletions -= 1
  }
}

/**
 * 剥离 LLM 回复外层的 ```json ... ``` / ``` ... ``` 代码栅栏。
 * pi-ai 无 OpenAI 的 response_format:'json_object' 严格模式等价物，只能靠 prompt
 * 约束模型"只输出 JSON"；部分模型仍会习惯性包一层代码栅栏，解析前先剥掉。
 * 纯字符串处理，不做 JSON.parse——调用方自行 try/catch 解析剥栅栏后的文本。
 */
export function stripJsonFence(text: string): string {
  // 允许 ``` 与语言标注之间有空白(``` json);语言标注只吃同行的 json 字面量,不误伤正文
  return text.trim().replace(/^```[ \t]*(?:json)?[ \t]*\r?\n?/i, '').replace(/\n?[ \t]*```[ \t]*$/, '').trim()
}

export async function simpleComplete(opts: SimpleCompleteOptions): Promise<string> {
  checkRateLimit()

  const prompt = (opts.prompt || '').trim()
  if (!prompt) throw new Error('prompt 为空')

  const mc = opts.modelConfig ?? getEffectiveModelConfig()
  const model = opts.modelConfig ? buildModelFromConfig(mc) : getPiModel()
  if (opts.modelConfig) ensurePiApiKeyFor(model.provider, mc)
  else ensurePiApiKey(model.provider)

  const systemPrompt = opts.systemPrompt
    || '你是嵌入在 HTML 作品中的 AI 助手。输出简洁、直接、可直接使用的内容，不要解释过程。'

  const tune = auxCompletionTuning(mc, model, Math.min(opts.maxTokens ?? 1024, 2048))

  const context = {
    systemPrompt,
    messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }]
  }

  console.log(`[SimpleComplete] prompt(${prompt.length} chars) → ${model.provider}/${model.id}`)
  const result = await completeSimple(model, context, {
    maxTokens: tune.maxTokens,
    reasoning: tune.reasoning,
    apiKey: mc.apiKey || undefined, // 显式 key 防并发 env 互踩（对齐其余辅助路径）
    onPayload: createModelPayloadAdapter(mc),
    signal: opts.signal
  })

  const textParts = (result.content || [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
  return textParts.join('').trim()
}
