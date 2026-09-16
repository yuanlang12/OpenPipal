/**
 * 模型产物按会话分目录（outputs/<conversationId>/，2026-09-12）：
 * 三个带会话 id 的写入点落到同一个目录，缩略图按会话找并回退老位置，提示词把目录当事实告诉模型。
 * 安全规则那半在 facts-before-blocks.test.ts。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-outputs-conv-'))
process.env.HOME = HOME
process.env.OPENPIPAL_ISOLATED_HOME = HOME

vi.mock('../../src/main/window-tracker', () => ({
  getCurrentConfig: () => ({ displayName: 'Finder', processName: 'Finder' }),
  isDockedToTargetApp: () => false,
  getEnvironmentSnapshot: () => ({ mode: 'undocked', foregroundApp: '', isFullscreen: false, connected: false })
}))
vi.mock('../../src/main/sandbox-manager', () => ({ isSandboxed: () => true }))

const { outputsDirFor, isConversationOutputsDirName } = await import('../../src/main/data-root')
const { saveOutput } = await import('../../src/main/memory-manager')
const { buildOpenPipalRuntimeContext } = await import('../../src/main/agent-runtime/openpipal-prompt-core')

const productToolsSrc = fs.readFileSync('src/main/openpipal-product-tools.ts', 'utf8')
const outputs = path.join(HOME, '.openpipal', 'outputs')

describe('outputsDirFor：会话 id 合法就分目录，否则退回共享根', () => {
  it('分目录与回退', () => {
    expect(outputsDirFor('0f9c1a2b-3d4e-4f60-8a7b-9c0d1e2f3a4b')).toBe(path.join(outputs, '0f9c1a2b-3d4e-4f60-8a7b-9c0d1e2f3a4b'))
    expect(outputsDirFor(undefined)).toBe(outputs)
    expect(outputsDirFor('')).toBe(outputs)
    for (const bad of ['..', '.', 'a/b', 'a\\b', 'x y']) expect(outputsDirFor(bad), bad).toBe(outputs)
  })

  it('只有 UUID 形状的子目录算会话目录（作品页只多进这一层）', () => {
    expect(isConversationOutputsDirName('0f9c1a2b-3d4e-4f60-8a7b-9c0d1e2f3a4b')).toBe(true)
    expect(isConversationOutputsDirName('.self-check')).toBe(false)
    expect(isConversationOutputsDirName('openpipal-xhs')).toBe(false)
  })
})

describe('三个写入点都落本会话目录', () => {
  it('generate_document → saveOutput 带会话 id 落 outputs/<id>/；独立 Pal 仍按 Pal 隔离', () => {
    const conv = '11111111-2222-4333-8444-555555555555'
    const p = saveOutput('周报', '# hi', undefined, conv)
    expect(path.dirname(p)).toBe(path.join(outputs, conv))
    expect(fs.readFileSync(p, 'utf8')).toBe('# hi')
    const legacy = saveOutput('周报', '# hi')
    expect(path.dirname(legacy)).toBe(outputs)
    const pal = saveOutput('周报', '# hi', 'pal-1', conv)
    expect(pal).toBe(path.join(HOME, '.openpipal', 'agents', 'pal-1', 'outputs', path.basename(pal)))
  })

  it('export_artifact 与 render_artifact 的截图目录都从 outputsDirFor(conversationId) 算', () => {
    expect(productToolsSrc).toContain('const outRoot = outputsDirFor(conversationId)')
    expect(productToolsSrc).toContain("const shotDir = path.join(outputsDirFor(conversationId), '.self-check')")
    expect(productToolsSrc).toContain('exportDcBundle(title, [{ title, content, artifactId }], outRoot)')
    expect(productToolsSrc).toContain('createGenerateDocumentTool(overrides?.workspaceId, overrides?.conversationId)')
    expect(productToolsSrc).not.toContain("const outRoot = dataPath('outputs')")
  })
})

describe('事实前移：运行时上下文告诉模型本会话产物目录', () => {
  it('有会话 id 就带一行目录；没有就不加', () => {
    const conv = '0f9c1a2b-3d4e-4f60-8a7b-9c0d1e2f3a4b'
    const ctx = buildOpenPipalRuntimeContext(conv)
    expect(ctx).toContain(`本会话产物目录:${path.join(outputs, conv)}`)
    expect(ctx).toContain('这个目录随便 ls')
    expect(buildOpenPipalRuntimeContext()).not.toContain('本会话产物目录')
  })
})
