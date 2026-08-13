import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: any[]) => any

interface WriteRecord {
  kind: 'append' | 'replace'
  cid: string
  messages: any[]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createRendererHarness(options: {
  conversations?: any[]
  messages?: Record<string, any[]>
  saveArtifact?: (cid: string, artifact: any) => Promise<any>
  apiOverrides?: Record<string, any>
  onAppend?: (cid: string, batch: any[]) => void
} = {}) {
  const listeners: Record<string, Listener> = {}
  const writes: WriteRecord[] = []
  const conversations = options.conversations || []
  const messages = options.messages || {}
  let nextConversation = 0

  const base: Record<string, any> = {
    appendMessages: async (cid: string, batch: any[]) => {
      writes.push({ kind: 'append', cid, messages: batch })
      messages[cid] = [...(messages[cid] || []), ...batch]
      options.onAppend?.(cid, batch)
      return { ok: true }
    },
    replaceMessages: async (cid: string, batch: any[]) => {
      writes.push({ kind: 'replace', cid, messages: batch })
      messages[cid] = [...batch]
      return { ok: true }
    },
    listConversations: async () => conversations,
    getConversationMessages: async (cid: string) => messages[cid] || [],
    createConversation: async (role: string) => ({
      id: `created-${++nextConversation}`,
      role,
      config: null
    }),
    updateConversationConfig: async () => ({ ok: true }),
    updateConversationRole: async () => true,
    clearSessionApprovals: () => {},
    saveArtifact: options.saveArtifact || (async (_cid: string, artifact: any) => ({
      ok: true,
      ref: { id: artifact.id, type: artifact.type, title: artifact.title, path: `${artifact.id}.json` }
    }))
  }
  Object.assign(base, options.apiOverrides || {})

  const api = new Proxy(base, {
    get(target, property: string | symbol) {
      if (property in target) return target[property as string]
      const name = String(property)
      if (name.startsWith('on')) {
        return (callback: Listener) => {
          listeners[name] = callback
          return () => { if (listeners[name] === callback) delete listeners[name] }
        }
      }
      if (name === 'sendChat' || name === 'abortChat') return () => {}
      return undefined
    }
  })

  ;(globalThis as any).window = { api }
  return { listeners, writes, conversations, messages }
}

describe('renderer transcript integrity barrier', () => {
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.restoreAllMocks()
  })

  it.each(['active', 'background'] as const)(
    'rejects the desktop barrier when %s durable artifact sidecar reports failure',
    async (route) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const harness = createRendererHarness({
        saveArtifact: async () => ({ ok: false, error: 'disk full' })
      })
      const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
      useChatStore.setState({
        activeConversationId: route === 'active' ? 'artifact-cid' : 'current',
        conversations: [{ id: 'artifact-cid', role: 'learner' }, { id: 'current', role: 'learner' }] as any,
        messages: [] as any,
        streamingConvIds: { 'artifact-cid': true }
      } as any)
      cleanup = useChatStore.getState().setupListeners()

      harness.listeners.onArtifact('artifact-cid', {
        id: 'bad-artifact', type: 'html', title: 'bad.html', content: '<main />'
      }, 'call-bad')

      await expect(
        harness.listeners.onTranscriptPersistenceRequest('artifact-cid', 'exec-bad')
      ).rejects.toThrow(/artifact sidecar|durability|unsuccessful/i)
    }
  )

  it('does not let a failed navigation drain consume the later false desktop ACK', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = createRendererHarness({
      conversations: [{ id: 'current', role: 'learner' }, { id: 'artifact-cid', role: 'learner' }],
      saveArtifact: async () => ({ ok: false })
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'current',
      conversations: harness.conversations as any,
      messages: [] as any,
      streamingConvIds: { 'artifact-cid': true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onArtifact('artifact-cid', {
      id: 'bad-artifact', type: 'html', title: 'bad.html', content: '<main />'
    }, 'call-bad-nav')

    await expect(useChatStore.getState().switchConversation('artifact-cid')).rejects.toThrow()
    await expect(
      harness.listeners.onTranscriptPersistenceRequest('artifact-cid', 'exec-after-nav')
    ).rejects.toThrow(/artifact sidecar|durability|unsuccessful/i)
  })

  it.each(['active', 'background'] as const)(
    'rejects the desktop barrier when %s questions pending config is not durable',
    async (route) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const harness = createRendererHarness({
        apiOverrides: { updateConversationConfig: async () => ({ ok: false }) }
      })
      const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
      useChatStore.setState({
        activeConversationId: route === 'active' ? 'questions-cid' : 'current',
        conversations: [{ id: 'questions-cid', role: 'learner' }, { id: 'current', role: 'learner' }] as any,
        messages: [] as any,
        streamingConvIds: { 'questions-cid': true }
      } as any)
      cleanup = useChatStore.getState().setupListeners()

      harness.listeners.onQuestionsV2('questions-cid', 'Need input', [{ id: 'q1', title: 'Choose' }])

      await expect(
        harness.listeners.onTranscriptPersistenceRequest('questions-cid', 'exec-questions')
      ).rejects.toThrow(/questions pending config|unsuccessful/i)
    }
  )

  it.each(['active', 'background'] as const)(
    'rejects the desktop barrier when an %s questions anchor append fails',
    async (route) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const harness = createRendererHarness({
        apiOverrides: { appendMessages: async () => ({ ok: false }) }
      })
      const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
      useChatStore.setState({
        activeConversationId: route === 'active' ? 'questions-cid' : 'current',
        conversations: [{ id: 'questions-cid', role: 'learner' }, { id: 'current', role: 'learner' }] as any,
        messages: [] as any,
        streamingConvIds: { 'questions-cid': true }
      } as any)
      cleanup = useChatStore.getState().setupListeners()

      harness.listeners.onQuestionsV2('questions-cid', 'Need input', [{ id: 'q1', title: 'Choose' }])

      await expect(
        harness.listeners.onTranscriptPersistenceRequest('questions-cid', 'exec-anchor')
      ).rejects.toThrow(/artifact anchor|active conversation messages|unsuccessful/i)
    }
  )

  it('waits for an already-dispatched deferred artifact sidecar before acknowledging persistence', async () => {
    const sidecar = deferred<any>()
    const harness = createRendererHarness({ saveArtifact: () => sidecar.promise })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'conv-a',
      conversations: [{ id: 'conv-a', role: 'learner' }] as any,
      messages: [{ id: 'user-1', role: 'user', content: 'build it', timestamp: 1 }] as any,
      isStreaming: true,
      streamingConvIds: { 'conv-a': true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onToolStart('conv-a', 'create_artifact', 'call-artifact')
    harness.listeners.onArtifact('conv-a', {
      id: 'artifact-1', type: 'html', title: 'result.html', content: '<main />'
    }, 'call-artifact')

    let acknowledged = false
    const barrier = Promise.resolve(
      harness.listeners.onTranscriptPersistenceRequest('conv-a', 'exec-1')
    ).then(() => { acknowledged = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(acknowledged).toBe(false)

    sidecar.resolve({
      ok: true,
      ref: { id: 'artifact-1', type: 'html', title: 'result.html', path: 'artifact-1.json' }
    })
    await barrier

    const persisted = harness.writes.flatMap(write => write.messages)
    const anchors = persisted.filter(message => message.toolCallId === 'call-artifact')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].artifactRef?.path).toBe('artifact-1.json')
  })

  it('hands a visible partial to the old conversation before switching without persisting it as completed', async () => {
    const oldUser = { id: 'old-user', role: 'user', content: 'continue', timestamp: 1 }
    const harness = createRendererHarness({
      conversations: [
        { id: 'old', role: 'learner' },
        { id: 'next', role: 'learner' }
      ],
      messages: { old: [oldUser], next: [] }
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'old',
      conversations: harness.conversations as any,
      messages: [oldUser] as any,
      isStreaming: true,
      streamingConvIds: { old: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onStreamChunk('old', 'visible partial')
    await useChatStore.getState().switchConversation('next')

    const beforeEnd = harness.writes
      .filter(write => write.cid === 'old')
      .flatMap(write => write.messages)
    expect(beforeEnd.some(message => message.content === 'visible partial')).toBe(false)

    harness.listeners.onStreamChunk('old', ' plus tail')
    harness.listeners.onStreamEnd('old')
    await harness.listeners.onTranscriptPersistenceRequest('old', 'exec-old')

    const finalMessages = harness.writes
      .filter(write => write.cid === 'old')
      .flatMap(write => write.messages)
    const finalReply = finalMessages.find(message => message.content === 'visible partial plus tail')
    expect(finalReply).toBeTruthy()
    // It becomes a normal assistant message only after the real stream_end.
    expect(finalReply.messageKind).toBe('assistant')
  })

  it('persists background text, tool, then text in event order', async () => {
    const harness = createRendererHarness({
      conversations: [{ id: 'current', role: 'learner' }, { id: 'background', role: 'learner' }]
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'current',
      conversations: harness.conversations as any,
      messages: [] as any,
      streamingConvIds: { background: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onStreamChunk('background', 'before tool')
    harness.listeners.onTextFlush('background')
    harness.listeners.onToolEnd(
      'background', 'read', undefined, undefined, 'tool result', undefined, undefined, 'call-read'
    )
    harness.listeners.onStreamChunk('background', 'after tool')
    harness.listeners.onTextFlush('background')
    harness.listeners.onStreamEnd('background')
    await harness.listeners.onTranscriptPersistenceRequest('background', 'exec-bg')

    const ordered = harness.writes
      .filter(write => write.cid === 'background' && write.kind === 'append')
      .flatMap(write => write.messages)
      .map(message => ({ role: message.role, content: message.content }))
    expect(ordered).toEqual([
      { role: 'assistant', content: 'before tool' },
      { role: 'tool', content: 'tool result' },
      { role: 'assistant', content: 'after tool' }
    ])
  })

  it('deduplicates tool_end-before-artifact by toolCallId and keeps the artifact ref on that anchor', async () => {
    const harness = createRendererHarness({
      conversations: [{ id: 'current', role: 'learner' }, { id: 'background', role: 'learner' }]
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'current',
      conversations: harness.conversations as any,
      messages: [] as any,
      streamingConvIds: { background: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onToolEnd(
      'background', 'create_artifact', undefined, undefined, 'created artifact', undefined, undefined, 'call-1'
    )
    harness.listeners.onArtifact('background', {
      id: 'artifact-1', type: 'html', title: 'artifact.html', content: '<article />'
    }, 'call-1')
    await harness.listeners.onTranscriptPersistenceRequest('background', 'exec-artifact')

    const anchors = harness.writes
      .filter(write => write.cid === 'background')
      .flatMap(write => write.messages)
      .filter(message => message.toolCallId === 'call-1')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].content).toBe('created artifact')
    expect(anchors[0].artifactRef?.path).toBe('artifact-1.json')
  })

  it('keeps one ordered artifact anchor when navigation splits artifact and tool_end across lanes', async () => {
    const sidecar = deferred<any>()
    const user = { id: 'user-old', role: 'user', content: 'make it', timestamp: 1 }
    const harness = createRendererHarness({
      conversations: [{ id: 'old', role: 'learner' }, { id: 'next', role: 'learner' }],
      // The store snapshot is intentionally unsaved (module watermark starts
      // at zero); the exit snapshot must write it before background events.
      messages: { old: [], next: [] },
      saveArtifact: () => sidecar.promise
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'old',
      conversations: harness.conversations as any,
      messages: [user] as any,
      isStreaming: true,
      streamingConvIds: { old: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onToolStart('old', 'create_artifact', 'call-split')
    harness.listeners.onArtifact('old', {
      id: 'artifact-split', type: 'html', title: 'split.html', content: '<section />'
    }, 'call-split')
    const switching = useChatStore.getState().switchConversation('next')

    harness.listeners.onToolEnd(
      'old', 'create_artifact', undefined, undefined, 'created during switch', undefined, undefined, 'call-split'
    )
    harness.listeners.onStreamChunk('old', 'after artifact')
    harness.listeners.onTextFlush('old')
    sidecar.resolve({
      ok: true,
      ref: { id: 'artifact-split', type: 'html', title: 'split.html', path: 'artifact-split.json' }
    })
    await switching
    harness.listeners.onStreamEnd('old')
    await harness.listeners.onTranscriptPersistenceRequest('old', 'exec-split')

    const durable = harness.messages.old
    const callAnchors = durable.filter(message => message.toolCallId === 'call-split')
    expect(callAnchors).toHaveLength(1)
    expect(callAnchors[0].content).toBe('created during switch')
    expect(callAnchors[0].artifactRef?.path).toBe('artifact-split.json')
    expect(durable.map(message => message.content)).toEqual([
      'make it',
      'created during switch',
      'after artifact'
    ])
  })

  it('serializes concurrent switch/new navigation without overwriting the old conversation gate', async () => {
    const nextMessages = deferred<any[]>()
    const callOrder: string[] = []
    const user = { id: 'old-user', role: 'user', content: 'old prompt', timestamp: 1 }
    const harness = createRendererHarness({
      conversations: [{ id: 'old', role: 'learner' }, { id: 'next', role: 'learner' }],
      messages: { old: [], next: [] },
      apiOverrides: {
        getConversationMessages: async (cid: string) => {
          callOrder.push(`get:${cid}`)
          return cid === 'next' ? nextMessages.promise : []
        },
        createConversation: async (role: string) => {
          callOrder.push('create')
          return { id: 'created-after-switch', role, config: null }
        }
      }
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'old',
      conversations: harness.conversations as any,
      messages: [user] as any,
      isStreaming: true,
      streamingConvIds: { old: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()
    harness.listeners.onStreamChunk('old', 'old partial')

    const switching = useChatStore.getState().switchConversation('next')
    for (let i = 0; i < 10 && !callOrder.includes('get:next'); i++) await Promise.resolve()
    expect(callOrder).toContain('get:next')

    const creating = useChatStore.getState().newConversation('learner')
    harness.listeners.onTextFlush('old')
    await Promise.resolve()
    expect(callOrder).not.toContain('create')

    nextMessages.resolve([])
    await switching
    await creating
    harness.listeners.onStreamEnd('old')
    await harness.listeners.onTranscriptPersistenceRequest('old', 'exec-old-nav')

    expect(callOrder.indexOf('create')).toBeGreaterThan(callOrder.indexOf('get:next'))
    expect(useChatStore.getState().activeConversationId).toBe('created-after-switch')
    expect(harness.messages.old.map(message => message.content)).toEqual(['old prompt', 'old partial'])
  })

  it('keeps a switched-away abort incomplete and does not poison the next conversation end', async () => {
    const harness = createRendererHarness({
      conversations: [{ id: 'old', role: 'learner' }, { id: 'next', role: 'learner' }],
      messages: { old: [], next: [] }
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'old',
      conversations: harness.conversations as any,
      messages: [] as any,
      isStreaming: true,
      streamingConvIds: { old: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onStreamChunk('old', 'aborted partial')
    useChatStore.getState().abortChat()
    await useChatStore.getState().switchConversation('next')
    // A late phase flush after navigation must retain the old cid's abort
    // state instead of persisting this partial as a normal assistant replay.
    harness.listeners.onTextFlush('old')
    harness.listeners.onStreamEnd('old')
    await harness.listeners.onTranscriptPersistenceRequest('old', 'exec-abort')

    const oldPartial = harness.messages.old.find(message => message.content === 'aborted partial')
    expect(oldPartial?.messageKind).toBe('incomplete')

    useChatStore.setState({ isStreaming: true, streamingConvIds: { next: true } } as any)
    harness.listeners.onStreamChunk('next', 'normal next reply')
    harness.listeners.onStreamEnd('next')
    await harness.listeners.onTranscriptPersistenceRequest('next', 'exec-next')
    const nextReply = harness.messages.next.find(message => message.content === 'normal next reply')
    expect(nextReply?.messageKind).toBe('assistant')
  })

  it('marks a switched-away Runtime error partial incomplete', async () => {
    const harness = createRendererHarness({
      conversations: [{ id: 'old', role: 'learner' }, { id: 'next', role: 'learner' }],
      messages: { old: [], next: [] }
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'old',
      conversations: harness.conversations as any,
      messages: [] as any,
      isStreaming: true,
      streamingConvIds: { old: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onStreamChunk('old', 'runtime partial')
    await useChatStore.getState().switchConversation('next')
    harness.listeners.onStreamEnd('old', 'provider disconnected')
    await harness.listeners.onTranscriptPersistenceRequest('old', 'exec-error')

    const failed = harness.messages.old.find(message => message.content.includes('runtime partial'))
    expect(failed?.messageKind).toBe('incomplete')
    expect(failed?.content).toContain('[Error] provider disconnected')
  })

  it('merges an artifact-first late tool_end result and args into one durable anchor', async () => {
    const anchorAppended = deferred<void>()
    const harness = createRendererHarness({
      conversations: [{ id: 'current', role: 'learner' }, { id: 'background', role: 'learner' }],
      messages: { background: [] },
      onAppend: (cid, batch) => {
        if (cid === 'background' && batch.some(message => message.toolCallId === 'call-late')) {
          anchorAppended.resolve()
        }
      }
    })
    const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
    useChatStore.setState({
      activeConversationId: 'current',
      conversations: harness.conversations as any,
      messages: [] as any,
      streamingConvIds: { background: true }
    } as any)
    cleanup = useChatStore.getState().setupListeners()

    harness.listeners.onArtifact('background', {
      id: 'artifact-late', type: 'html', title: 'late.html', content: '<aside />'
    }, 'call-late')
    await anchorAppended.promise
    harness.listeners.onToolEnd(
      'background', 'create_artifact', undefined, undefined,
      'late result', '{"requested":"late"}', undefined, 'call-late', '{"model":"args"}'
    )
    harness.listeners.onStreamEnd('background')
    await harness.listeners.onTranscriptPersistenceRequest('background', 'exec-late')

    const anchors = harness.messages.background.filter(message => message.toolCallId === 'call-late')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].content).toBe('late result')
    expect(anchors[0].toolArgs).toBe('{"requested":"late"}')
    expect(anchors[0].modelToolArgs).toBe('{"model":"args"}')
    expect(anchors[0].artifactRef?.path).toBe('artifact-late.json')
  })
})
