import { describe, expect, it } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { createOpenPipalPiCoreModels } from '../../src/main/agent-runtime/pi-core-models'

const model: Model<'openai-completions'> = {
  id: 'same-model',
  name: 'Same model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192
}

function config(apiKey: string) {
  return {
    provider: 'openai',
    baseUrl: model.baseUrl,
    apiKey,
    model: model.id
  }
}

describe('pi-core conversation Models', () => {
  it('isolates credentials for concurrent conversations using the same provider', async () => {
    const first = createOpenPipalPiCoreModels(model, config('key-a'))
    const second = createOpenPipalPiCoreModels(model, config('key-b'))

    const [firstAuth, secondAuth] = await Promise.all([
      first.getAuth(model),
      second.getAuth(model)
    ])

    expect(firstAuth?.auth.apiKey).toBe('key-a')
    expect(secondAuth?.auth.apiKey).toBe('key-b')
    expect(first.getProvider('openai')).not.toBe(second.getProvider('openai'))
  })

  it('fails explicitly for an API without a public adapter', () => {
    expect(() => createOpenPipalPiCoreModels(
      { ...model, api: 'private-api' },
      config('key')
    )).toThrow('does not support model API')
  })
})
