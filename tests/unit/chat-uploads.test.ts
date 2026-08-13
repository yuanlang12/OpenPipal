/**
 * 随消息图片落盘（官方 uploads/ 形状）：pasted-<ts>-<i>.png 命名、相对路径返回、
 * 读取侧 basename 级路径守卫。价值链：模型拿到确定路径 → 不再全盘找图（TCC 实案）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-chat-uploads-'))
process.env.HOME = TMP

const {
  persistChatImages,
  readUploadAsset,
  writeArtifactSidecar,
  readArtifactSidecar,
} = await import('../../src/main/chat-uploads')

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const CONV = 'conv-uploads-test'

describe('persistChatImages', () => {
  it('落盘为 uploads/pasted-<ts>-<i>.png（官方命名），返回相对路径', () => {
    const rels = persistChatImages(CONV, [PNG_1PX, PNG_1PX], 1784600000000)
    expect(rels).toEqual(['uploads/pasted-1784600000000-0.png', 'uploads/pasted-1784600000000-1.png'])
    const abs = path.join(TMP, '.openpipal', 'conversations', 'artifacts', CONV, 'uploads', 'pasted-1784600000000-0.png')
    expect(fs.existsSync(abs)).toBe(true)
    expect(fs.readFileSync(abs).length).toBeGreaterThan(30) // 真实解码的 PNG 字节，不是 base64 文本
  })

  it('非法会话 id（路径注入形状）→ 空数组不落盘', () => {
    expect(persistChatImages('../evil', [PNG_1PX])).toEqual([])
    expect(persistChatImages('', [PNG_1PX])).toEqual([])
  })

  it('空图片列表 → 空数组', () => {
    expect(persistChatImages(CONV, [])).toEqual([])
  })
})

describe('readUploadAsset', () => {
  it('落盘后可读回：base64 一致 + mime 按扩展名', () => {
    persistChatImages(CONV, [PNG_1PX], 1784600001000)
    const asset = readUploadAsset(CONV, 'pasted-1784600001000-0.png')
    expect(asset?.mime).toBe('image/png')
    expect(asset?.base64).toBe(PNG_1PX)
  })

  it('路径穿越/隐藏文件/未知扩展 → null', () => {
    expect(readUploadAsset(CONV, '../../../etc/passwd')).toBeNull()
    expect(readUploadAsset(CONV, '.DS_Store')).toBeNull()
    expect(readUploadAsset(CONV, 'evil.sh')).toBeNull()
    expect(readUploadAsset('../evil', 'a.png')).toBeNull()
  })

  it('不存在的文件 → null', () => {
    expect(readUploadAsset(CONV, 'pasted-9999-0.png')).toBeNull()
  })

  it('拒绝会话目录、uploads 目录和叶子文件的软链接，且不会写穿', () => {
    const root = path.join(TMP, '.openpipal', 'conversations', 'artifacts')
    const outside = path.join(TMP, 'outside')
    fs.mkdirSync(path.join(outside, 'uploads'), { recursive: true })
    const secret = path.join(outside, 'secret.png')
    fs.writeFileSync(secret, 'do not expose')

    // A safe-looking conversation id must still not be allowed to resolve via
    // a symlinked conversation directory.
    fs.mkdirSync(root, { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'conv-linked'))
    expect(persistChatImages('conv-linked', [PNG_1PX], 1784600002000)).toEqual([])
    expect(readUploadAsset('conv-linked', 'secret.png')).toBeNull()
    expect(writeArtifactSidecar('conv-linked', '.state.state.json', '{}')).toBe(false)

    // The child uploads directory has the same boundary, not just the parent.
    const uploadLinked = path.join(root, 'conv-upload-linked')
    fs.mkdirSync(uploadLinked)
    fs.symlinkSync(path.join(outside, 'uploads'), path.join(uploadLinked, 'uploads'))
    expect(persistChatImages('conv-upload-linked', [PNG_1PX], 1784600002001)).toEqual([])
    expect(readUploadAsset('conv-upload-linked', 'secret.png')).toBeNull()

    // Existing leaf links must not be read or atomically replaced by a write.
    const leafConv = 'conv-leaf-linked'
    const leafDir = path.join(root, leafConv, 'uploads')
    fs.mkdirSync(leafDir, { recursive: true })
    const leafName = 'pasted-1784600002002-0.png'
    fs.symlinkSync(secret, path.join(leafDir, leafName))
    expect(readUploadAsset(leafConv, leafName)).toBeNull()
    expect(persistChatImages(leafConv, [PNG_1PX], 1784600002002)).toEqual([])
    expect(fs.readFileSync(secret, 'utf8')).toBe('do not expose')

    const sidecarName = '.image.state.json'
    fs.symlinkSync(secret, path.join(root, leafConv, sidecarName))
    expect(readArtifactSidecar(leafConv, sidecarName)).toBeNull()
    expect(writeArtifactSidecar(leafConv, sidecarName, '{"safe":true}')).toBe(false)
    expect(fs.readFileSync(secret, 'utf8')).toBe('do not expose')
  })

  it('不会把相邻前缀目录当作会话目录', () => {
    const root = path.join(TMP, '.openpipal', 'conversations', 'artifacts')
    const sibling = path.join(root, `${CONV}-evil`, 'uploads')
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'pasted-1784600003000-0.png'), 'sibling secret')

    expect(readUploadAsset(CONV, 'pasted-1784600003000-0.png')).toBeNull()
  })

  it('拒绝被替换成软链接的 artifacts 根目录', () => {
    const originalHome = process.env.HOME
    const alternateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-chat-root-link-'))
    const outside = path.join(TMP, 'root-link-outside')
    const linkedRoot = path.join(alternateHome, '.openpipal', 'conversations', 'artifacts')
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, linkedRoot)
    try {
      process.env.HOME = alternateHome
      expect(persistChatImages('conv-root-linked', [PNG_1PX], 1784600004000)).toEqual([])
      expect(writeArtifactSidecar('conv-root-linked', '.state.state.json', '{}')).toBe(false)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      process.env.HOME = originalHome
      fs.rmSync(alternateHome, { recursive: true, force: true })
    }
  })
})
