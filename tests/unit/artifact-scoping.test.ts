/**
 * artifact 会话隔离回归锁（2026-07-03 实测 bug）：
 * 之前用进程级全局缓存充当"本会话清单"，把别的会话的 artifact 列进纠错提示，
 * 模型据此 render/edit 了别人的产物、并推倒重做出重复 artifact。
 * listConversationArtifacts 必须只回**本会话**的磁盘 sidecar 清单。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// os.homedir() 在 POSIX 优先读 HOME——必须在模块导入前劫持，让 ARTIFACTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-artifact-scope-'))
process.env.HOME = TMP

const { listConversationArtifacts, findSimilarArtifact } = await import('../../src/main/artifact-store')

function seedConversation(id: string, artifacts: { aid: string; title: string }[]): void {
  const convDir = path.join(TMP, '.openpipal', 'conversations')
  const artDir = path.join(convDir, 'artifacts', id)
  fs.mkdirSync(artDir, { recursive: true })
  const messages = artifacts.map((a, i) => ({
    id: `m${i}`,
    role: 'tool',
    content: `预览: ${a.title} (id: ${a.aid})`,
    artifactRef: { id: a.aid, type: 'html', title: a.title, path: path.join(artDir, `${a.aid}.html`) }
  }))
  fs.writeFileSync(
    path.join(convDir, `${id}.json`),
    JSON.stringify({ id, title: id, role: 'design', createdAt: 1, updatedAt: 2, messages })
  )
  for (const a of artifacts) fs.writeFileSync(path.join(artDir, `${a.aid}.html`), '<html></html>')
}

seedConversation('conv-a', [
  { aid: 'artifact-1111111111111', title: '学径 · 产品动画.dc.html' },
  { aid: 'artifact-2222222222222', title: '教师讲义.dc.html' }
])
seedConversation('conv-b', [{ aid: 'artifact-3333333333333', title: '别的会话的产物.dc.html' }])
// 会话目录里混入非 artifact 的 sidecar（questions_v2 落盘同一目录）
fs.writeFileSync(path.join(TMP, '.openpipal', 'conversations', 'artifacts', 'conv-a', 'questions-123.json'), '{}')

describe('listConversationArtifacts 会话隔离', () => {
  it('只列本会话磁盘清单，title 从会话 JSON 的 artifactRef 补齐', () => {
    const a = listConversationArtifacts('conv-a')
    expect(a.map((e) => e.id).sort()).toEqual(['artifact-1111111111111', 'artifact-2222222222222'])
    expect(a.find((e) => e.id === 'artifact-1111111111111')?.title).toBe('学径 · 产品动画.dc.html')
    expect(a.every((e) => e.file.includes(`${path.sep}conv-a${path.sep}`))).toBe(true)
  })

  it('绝不包含其他会话的 artifact（跨会话泄漏回归锁）', () => {
    expect(listConversationArtifacts('conv-a').some((e) => e.id === 'artifact-3333333333333')).toBe(false)
    expect(listConversationArtifacts('conv-b').map((e) => e.id)).toEqual(['artifact-3333333333333'])
  })

  it('忽略 questions-* 等非 artifact sidecar', () => {
    expect(listConversationArtifacts('conv-a').some((e) => e.id.startsWith('questions'))).toBe(false)
  })

  it('无目录 / 空 convId 返回空数组', () => {
    expect(listConversationArtifacts('no-such-conv')).toEqual([])
    expect(listConversationArtifacts('')).toEqual([])
  })
})

describe('findSimilarArtifact 门闩仅同 type 比较（W2：文件夹型动画产物）', () => {
  it('html 薄壳与同名 code 场景可共存（type 收窄，不拦）', () => {
    const entries = [{ id: 'scene', title: '咖啡店动画', type: 'code' }]
    expect(findSimilarArtifact('咖啡店动画', 'html', entries)).toBeNull()
  })

  it('同名 code 场景再建仍拦（同 type）', () => {
    const entries = [{ id: 'scene', title: '咖啡店动画', type: 'code' }]
    expect(findSimilarArtifact('咖啡店动画', 'code', entries)?.id).toBe('scene')
  })

  it('html+html 相近（后缀绕过）仍拦', () => {
    const entries = [{ id: 'shell', title: '咖啡店动画落地页', type: 'html' }]
    expect(findSimilarArtifact('咖啡店动画落地页 · 深色高级风', 'html', entries)?.id).toBe('shell')
  })

  it('标题不近 / 空标题不拦', () => {
    const entries = [{ id: 'x', title: '教师讲义', type: 'html' }]
    expect(findSimilarArtifact('完全不同的作品', 'html', entries)).toBeNull()
    expect(findSimilarArtifact('', 'html', entries)).toBeNull()
  })
})
