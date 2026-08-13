import {
  Agent,
  AgentHarness,
  InMemorySessionRepo
} from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider
} from '@earendil-works/pi-ai'
import process from 'node:process'
import { setImmediate } from 'node:timers'

const faux = fauxProvider({
  provider: 'openpipal-contract',
  models: [{
    id: 'electron-contract',
    name: 'Electron contract model',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 32_000,
    maxTokens: 2_000
  }]
})
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage('ok')])

const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  initialState: {
    model: faux.getModel(),
    systemPrompt: 'Reply with the configured faux response.',
    tools: []
  },
  toolExecution: 'sequential'
})

const events = []
let markAgentEnd
const agentEndStarted = new Promise((resolve) => { markAgentEnd = resolve })
let releaseAgentEnd
const agentEndRelease = new Promise((resolve) => { releaseAgentEnd = resolve })
const unsubscribe = agent.subscribe(async (event) => {
  events.push(event.type)
  if (event.type === 'agent_end') {
    markAgentEnd()
    await agentEndRelease
  }
})

try {
  let promptSettled = false
  const prompt = agent.prompt('contract probe').then(() => { promptSettled = true })
  await agentEndStarted
  let idleSettled = false
  const idle = agent.waitForIdle().then(() => { idleSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  const listenerSettlement = {
    isStreamingDuringAgentEnd: agent.state.isStreaming,
    promptPendingDuringAgentEnd: !promptSettled,
    waitForIdlePendingDuringAgentEnd: !idleSettled
  }
  releaseAgentEnd()
  await Promise.all([prompt, idle])
  const response = agent.state.messages.at(-1)
  if (!response || response.role !== 'assistant') {
    throw new Error('Agent did not append a final assistant message')
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

  const harness = new AgentHarness({
    session: await new InMemorySessionRepo().create({ id: 'openpipal-electron-harness-guard' }),
    model: faux.getModel(),
    tools: []
  })
  let harnessPromptError
  try {
    await harness.prompt('must fail closed')
  } catch (error) {
    harnessPromptError = {
      name: error?.name,
      operation: error?.operation,
      message: error?.message
    }
  }

  process.stdout.write(JSON.stringify({
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    modulesVersion: process.versions.modules,
    text,
    messageCount: agent.state.messages.length,
    events,
    listenerSettlement,
    harnessPromptError
  }))
} finally {
  unsubscribe()
}
