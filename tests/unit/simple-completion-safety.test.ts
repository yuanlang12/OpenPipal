import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => ({ complete: vi.fn() }))

vi.mock('@earendil-works/pi-ai/compat', () => ({ completeSimple: provider.complete }))
vi.mock('../../src/main/config-manager', () => ({
  getPiModel: () => ({ provider: 'faux', id: 'artifact-test' }),
  ensurePiApiKey: () => undefined,
  ensurePiApiKeyFor: () => undefined,
  buildModelFromConfig: () => ({ provider: 'faux', id: 'artifact-test' }),
  createModelPayloadAdapter: () => undefined,
  getEffectiveModelConfig: () => ({ provider: 'faux', baseUrl: '', apiKey: '', model: 'artifact-test' }),
  auxCompletionTuning: (_mc: unknown, _model: unknown, maxTokens: number) => ({ maxTokens, reasoning: undefined }),
}))

import {
  ARTIFACT_COMPLETION_MAX_CONCURRENT,
  ARTIFACT_COMPLETION_PROMPT_MAX_BYTES,
  ARTIFACT_COMPLETION_SYSTEM_PROMPT_MAX_BYTES,
  completeInArtifact,
} from '../../src/main/simple-completion'

describe('artifact completion safety boundary', () => {
  beforeEach(() => {
    provider.complete.mockReset()
    provider.complete.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('rejects oversized prompt and system input before reaching the provider', async () => {
    await expect(completeInArtifact('x'.repeat(ARTIFACT_COMPLETION_PROMPT_MAX_BYTES + 1)))
      .rejects.toThrow(/prompt 超过/)
    await expect(completeInArtifact('ok', 'x'.repeat(ARTIFACT_COMPLETION_SYSTEM_PROMPT_MAX_BYTES + 1)))
      .rejects.toThrow(/systemPrompt 超过/)
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('allows only a small fixed number of concurrent artifact requests', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    provider.complete.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
    const active = Array.from({ length: ARTIFACT_COMPLETION_MAX_CONCURRENT }, () => completeInArtifact('bounded'))
    await vi.waitFor(() => expect(provider.complete).toHaveBeenCalledTimes(ARTIFACT_COMPLETION_MAX_CONCURRENT))
    await expect(completeInArtifact('one too many')).rejects.toThrow(/正在处理其他请求/)
    for (const resolve of resolvers) resolve({ content: [{ type: 'text', text: 'done' }] })
    await expect(Promise.all(active)).resolves.toEqual(Array(ARTIFACT_COMPLETION_MAX_CONCURRENT).fill('done'))
  })

  it('forwards caller cancellation and releases its concurrency slot', async () => {
    provider.complete.mockImplementation((_model, _context, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const controller = new AbortController()
    const pending = completeInArtifact('cancel me', undefined, controller.signal)
    controller.abort(new Error('user stopped'))
    await expect(pending).rejects.toThrow('user stopped')

    provider.complete.mockResolvedValue({ content: [{ type: 'text', text: 'after' }] })
    await expect(completeInArtifact('after cancel')).resolves.toBe('after')
  })
})
