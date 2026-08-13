import { describe, expect, it, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => path.join(actual.tmpdir(), `openpipal-attachment-store-${process.pid}`)
  return { ...actual, default: { ...actual, homedir }, homedir }
})

import {
  isSafeConversationStorageId,
  saveConversationAttachment,
  loadConversationAttachment
} from '../../src/main/attachment-store'
import { getConversationMessages } from '../../src/main/conversation-store'

const CONV = 'test-attachment-conv'
const CONV_DIR = path.join(os.homedir(), '.openpipal', 'conversations')
const ATTACH_DIR = path.join(CONV_DIR, 'artifacts', CONV, 'attachments')
const CONV_FILE = path.join(CONV_DIR, `${CONV}.json`)

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true })
})

describe('消息附件卸载 sidecar', () => {
  it('截图 base64 落成二进制 png 并可按 ref 读回', () => {
    const base64 = Buffer.from('fake-png-bytes').toString('base64')
    const ref = saveConversationAttachment(CONV, 'msg-shot-1', 'screenshot', base64)
    expect(ref).toBe('msg-shot-1.png')
    // 磁盘上是解码后的二进制（省 4/3 base64 膨胀），读回时重编码
    expect(fs.readFileSync(path.join(ATTACH_DIR, ref!)).toString()).toBe('fake-png-bytes')
    expect(loadConversationAttachment(CONV, ref!)).toBe(base64)
  })

  it('mcpApp payload 以 JSON 原文往返', () => {
    const payload = JSON.stringify({ serverName: 's', html: '<div>app</div>'.repeat(100) })
    const ref = saveConversationAttachment(CONV, 'mcp-app-render-1', 'mcpapp', payload)
    expect(ref).toBe('mcp-app-render-1.mcpapp.json')
    expect(loadConversationAttachment(CONV, ref!)).toBe(payload)
  })

  it('ref 只接受纯文件名，目录穿越直接拒绝', () => {
    expect(loadConversationAttachment(CONV, '../other-conv/secret.png')).toBeNull()
    expect(loadConversationAttachment(CONV, 'a/b.png')).toBeNull()
    expect(loadConversationAttachment(CONV, 'missing.png')).toBeNull()
  })

  it('conversationId 只接受单个有界存储组件，读写都不能越出 artifacts 根目录', () => {
    expect(isSafeConversationStorageId(CONV)).toBe(true)
    expect(isSafeConversationStorageId('../../escape')).toBe(false)
    expect(isSafeConversationStorageId('encoded%2Fescape')).toBe(false)
    expect(isSafeConversationStorageId('a'.repeat(161))).toBe(false)

    const escapeDir = path.join(CONV_DIR, 'escape')
    expect(saveConversationAttachment('../../escape', 'msg', 'mcpapp', '{"secret":true}')).toBeNull()
    expect(loadConversationAttachment('../../escape', 'msg.mcpapp.json')).toBeNull()
    expect(fs.existsSync(escapeDir)).toBe(false)
  })

  it('拒绝会话目录或附件叶子符号链接', () => {
    const artifactsRoot = path.join(CONV_DIR, 'artifacts')
    const outsideDir = path.join(os.homedir(), 'outside-attachments')
    fs.mkdirSync(outsideDir, { recursive: true })

    const linkedConversation = 'linked-conversation'
    fs.symlinkSync(outsideDir, path.join(artifactsRoot, linkedConversation))
    expect(saveConversationAttachment(linkedConversation, 'msg', 'mcpapp', '{}')).toBeNull()
    expect(fs.readdirSync(outsideDir)).toEqual([])

    const leafConversation = 'linked-leaf-conversation'
    const leafDir = path.join(artifactsRoot, leafConversation, 'attachments')
    fs.mkdirSync(leafDir, { recursive: true })
    const outsideFile = path.join(outsideDir, 'outside.json')
    fs.writeFileSync(outsideFile, 'outside', 'utf8')
    fs.symlinkSync(outsideFile, path.join(leafDir, 'msg.mcpapp.json'))
    expect(loadConversationAttachment(leafConversation, 'msg.mcpapp.json')).toBeNull()
    expect(saveConversationAttachment(leafConversation, 'msg', 'mcpapp', 'overwrite')).toBeNull()
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside')
  })

  it('附件不带 artifact- 前缀且在子目录，不会混进 session-artifacts 清单', () => {
    const files = fs.readdirSync(path.join(CONV_DIR, 'artifacts', CONV))
    expect(files).toEqual(['attachments'])
  })

  it('getConversationMessages 只给最近几条消息重内联附件，更早的保持 ref', () => {
    const shotBase64 = Buffer.from('recent-shot').toString('base64')
    const oldRef = saveConversationAttachment(CONV, 'old-shot', 'screenshot', Buffer.from('old-shot').toString('base64'))
    const recentRef = saveConversationAttachment(CONV, 'recent-shot', 'screenshot', shotBase64)
    const mcpRef = saveConversationAttachment(CONV, 'recent-mcp', 'mcpapp', JSON.stringify({ html: '<x/>' }))

    const mkMsg = (id: string, extra: Record<string, unknown> = {}) => ({
      id, role: 'tool', content: 'ok', toolName: 'capture_screenshot', timestamp: 1, ...extra
    })
    const messages = [
      mkMsg('m0', { screenshotRef: oldRef }),          // index 0：远窗，不重内联
      ...Array.from({ length: 6 }, (_, i) => mkMsg(`filler-${i}`)),
      mkMsg('m7', { screenshotRef: recentRef }),        // 近窗：重内联
      mkMsg('m8', { toolName: 'mcp_app_render', mcpAppRef: mcpRef })
    ]
    fs.writeFileSync(CONV_FILE, JSON.stringify({
      id: CONV, title: 't', role: 'assistant', createdAt: 1, updatedAt: 1, messages
    }), 'utf8')

    const loaded = getConversationMessages(CONV) as any[]
    expect(loaded[0].screenshot).toBeUndefined()
    expect(loaded[0].screenshotRef).toBe(oldRef)
    expect(loaded[7].screenshot).toBe(shotBase64)
    expect(loaded[8].mcpAppPayload).toEqual({ html: '<x/>' })
  })
})
