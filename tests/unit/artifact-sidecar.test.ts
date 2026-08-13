/**
 * 产物 sidecar（*.state.json）读写——image-slot 拖图持久化的宿主端契约:
 * 只放行 *.state.json 基名、JSON 校验、大小上限、路径注入防护、往返一致。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-sidecar-'))
process.env.HOME = TMP

const { writeArtifactSidecar, readArtifactSidecar } = await import('../../src/main/chat-uploads')

const CONV = 'conv-sidecar-test'
const NAME = '.image-slots.state.json'

describe('writeArtifactSidecar / readArtifactSidecar', () => {
  it('官方 STATE_FILE 名(带前导点)写入并读回一致,落在会话 artifacts 目录', () => {
    const payload = JSON.stringify({ hero: { u: 'data:image/webp;base64,AAAA', s: 1, x: 0, y: 0 } })
    expect(writeArtifactSidecar(CONV, NAME, payload)).toBe(true)
    expect(readArtifactSidecar(CONV, NAME)).toBe(payload)
    expect(fs.existsSync(path.join(TMP, '.openpipal', 'conversations', 'artifacts', CONV, NAME))).toBe(true)
  })

  it('整文件替换语义:后写覆盖前写', () => {
    writeArtifactSidecar(CONV, NAME, '{"a":1}')
    writeArtifactSidecar(CONV, NAME, '{"b":2}')
    expect(readArtifactSidecar(CONV, NAME)).toBe('{"b":2}')
  })

  it('非 *.state.json 基名 / 路径注入形状一律拒绝', () => {
    expect(writeArtifactSidecar(CONV, 'notes.json', '{}')).toBe(false)
    expect(writeArtifactSidecar(CONV, '../evil.state.json', '{}')).toBe(false)
    expect(writeArtifactSidecar(CONV, 'a/b.state.json', '{}')).toBe(false)
    expect(writeArtifactSidecar('../evil', NAME, '{}')).toBe(false)
    expect(readArtifactSidecar(CONV, '../..')).toBeNull()
    expect(readArtifactSidecar(CONV, 'artifact-1.html')).toBeNull()
  })

  it('非 JSON 内容拒绝(契约就是 JSON 状态文件)', () => {
    expect(writeArtifactSidecar(CONV, NAME, 'not json {')).toBe(false)
  })

  it('不存在的 sidecar 读回 null(空槽,非错误)', () => {
    expect(readArtifactSidecar(CONV, '.design-canvas.state.json')).toBeNull()
  })
})
