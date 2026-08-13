import {
  createModels,
  createProvider,
  type Api,
  type AuthCheck,
  type Model,
  type Models,
  type ProviderStreams
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy'
import { bedrockConverseStreamApi } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { googleVertexApi } from '@earendil-works/pi-ai/api/google-vertex.lazy'
import { lazyStream } from '@earendil-works/pi-ai/api/lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy'
import type { ModelConfig } from '../config-manager'
import {
  isolateAbortSignalForStream,
  type StreamBoundaryObserver
} from '../isolated-stream-signal'

const API_STREAM_FACTORIES: Readonly<Record<string, () => ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi,
  'azure-openai-responses': azureOpenAIResponsesApi,
  'bedrock-converse-stream': bedrockConverseStreamApi,
  'google-generative-ai': googleGenerativeAIApi,
  'google-vertex': googleVertexApi,
  'mistral-conversations': mistralConversationsApi,
  'openai-codex-responses': openAICodexResponsesApi,
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'pi-messages': piMessagesApi
}

const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  xai: ['XAI_API_KEY'],
  zai: ['ZAI_API_KEY']
}

function streamsFor(api: Api, onStreamBoundary?: StreamBoundaryObserver): ProviderStreams {
  const factory = API_STREAM_FACTORIES[api]
  if (!factory) {
    throw new Error(`[AgentRuntime] pi-core does not support model API "${api}" yet`)
  }
  const upstream = factory()
  const isolatedStreamSimple = isolateAbortSignalForStream(upstream.streamSimple, { onStreamBoundary })
  return {
    stream: upstream.stream,
    streamSimple(model, context, options) {
      return lazyStream(model, async () => isolatedStreamSimple(model, context, options))
    }
  }
}

async function ambientKey(
  provider: string,
  configuredKey: string | undefined,
  env: (name: string) => Promise<string | undefined>
): Promise<string | undefined> {
  if (configuredKey?.trim()) return configuredKey
  for (const name of PROVIDER_ENV_KEYS[provider] ?? []) {
    const value = await env(name)
    if (value?.trim()) return value
  }
  return undefined
}

/**
 * Build an isolated Models collection for one OpenPipal conversation.
 *
 * The API key lives in the provider resolver closure instead of process.env,
 * so two conversations using the same provider with different credentials
 * cannot overwrite one another. The model itself remains the exact projection
 * produced by OpenPipal's existing model configuration layer.
 */
export function createOpenPipalPiCoreModels(
  model: Model<Api>,
  config: ModelConfig,
  options: { onStreamBoundary?: StreamBoundaryObserver } = {}
): Models {
  const models = createModels()
  const resolveKey = (ctx: { env(name: string): Promise<string | undefined> }) =>
    ambientKey(model.provider, config.apiKey, (name) => ctx.env(name))

  models.setProvider(createProvider({
    id: model.provider,
    name: `OpenPipal ${model.provider}`,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: `${model.provider} API key`,
        async check({ ctx }): Promise<AuthCheck | undefined> {
          return (await resolveKey(ctx)) ? { type: 'api_key', source: 'OpenPipal conversation config' } : undefined
        },
        async resolve({ ctx, credential }) {
          const apiKey = credential?.key || await resolveKey(ctx)
          return apiKey
            ? { auth: { apiKey }, source: config.apiKey ? 'OpenPipal conversation config' : 'environment' }
            : undefined
        }
      }
    },
    models: [model],
    api: streamsFor(model.api, options.onStreamBoundary)
  }))

  return models
}
