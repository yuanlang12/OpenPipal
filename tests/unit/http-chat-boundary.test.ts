import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isDurableHttpTurn,
  normalizeHttpConversationId,
  validateHttpChatBodySource,
} from '../../src/main/http-chat-boundary'

describe('HTTP chat source and persistence boundary', () => {
  it('uses body.source only as an assertion and rejects desktop or spoofed ACP', () => {
    expect(validateHttpChatBodySource(undefined, 'extension')).toBeNull()
    expect(validateHttpChatBodySource('extension', 'extension')).toBeNull()
    expect(validateHttpChatBodySource('acp', 'acp')).toBeNull()

    expect(validateHttpChatBodySource('acp', 'extension')).toMatchObject({ status: 403 })
    expect(validateHttpChatBodySource('extension', 'acp')).toMatchObject({ status: 400 })
    expect(validateHttpChatBodySource('desktop', 'extension')).toMatchObject({ status: 400 })
    expect(validateHttpChatBodySource('other', 'extension')).toMatchObject({ status: 400 })
  })

  it('classifies missing, empty, and non-string ids as stateless', () => {
    expect(normalizeHttpConversationId(undefined)).toBeUndefined()
    expect(normalizeHttpConversationId('')).toBeUndefined()
    expect(normalizeHttpConversationId('   ')).toBeUndefined()
    expect(normalizeHttpConversationId(42)).toBeUndefined()
    expect(isDurableHttpTurn(normalizeHttpConversationId(undefined))).toBe(false)
    expect(isDurableHttpTurn(normalizeHttpConversationId('conv-1'))).toBe(true)
  })

  it('keeps authentication before body reads and durable effects behind a conversation gate', () => {
    const source = readFileSync(resolve('src/main/http-server.ts'), 'utf8')
    const authenticationIndex = source.indexOf('const authentication = auth.authenticate(req.headers)')
    const streamRoute = source.slice(
      source.indexOf("if (url === '/chat/stream'"),
      source.indexOf('// ---- 聊天 非流式')
    )
    const nonStreamRoute = source.slice(source.indexOf("if (url === '/chat'"))

    expect(authenticationIndex).toBeGreaterThan(-1)
    expect(authenticationIndex).toBeLessThan(source.indexOf("if (url === '/chat/stream'"))
    expect(authenticationIndex).toBeLessThan(source.indexOf("if (url === '/chat'"))
    expect(streamRoute).toContain("principal === 'browser' ? 'extension' : 'acp'")
    expect(nonStreamRoute).toContain("principal === 'browser' ? 'extension' : 'acp'")
    expect(source).not.toMatch(/const source:\s*ChatSource\s*=\s*body\.source/)
    expect(streamRoute).toContain(
      'isDurableHttpTurn(conversationId) && isAutoMemoryEnabled()'
    )
    expect(streamRoute).toContain(
      'executeExtraction(messages, conversationId, turnRoleName)'
    )
  })
})
