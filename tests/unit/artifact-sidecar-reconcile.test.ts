/**
 * 产物库直写对账（2026-09-12）：bash/write 直写本会话的 artifact sidecar 不再硬拒，
 * 改由工具跑完后按 mtime 对账——面板同步、jsx 重编译、注册表基线刷新。
 * 以前的硬拒（artifact-sidecar-bash-guard）守的是"单一写入方"，现在这条不变量由对账保证。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-sidecar-reconcile-'))
process.env.HOME = HOME
process.env.OPENPIPAL_ISOLATED_HOME = HOME

vi.mock('../../src/main/sandbox-manager', () => ({ isSandboxed: () => true }))

const { classifyToolRisk } = await import('../../src/main/pi-security')
const { saveArtifact } = await import('../../src/main/artifact-store')
const { getArtifactStore } = await import('../../src/main/artifact-registry')
const { reconcileArtifactSidecarWrites, formatReconciledForModel, SIDECAR_WRITE_CHANNELS } = await import('../../src/main/artifact-reconcile')

const CONV = 'conv-reconcile'
const sidecar = path.join(HOME, '.openpipal', 'conversations', 'artifacts', CONV)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('直写本会话 sidecar 不再拦（租户边界另在 assessToolScope）', () => {
  it.each([
    `cp /tmp/homework.png "${sidecar}/homework.png"`,
    `cat /tmp/draft.txt > "${sidecar}/artifact-a.html"`,
    `sed -i '' 's/old/new/' "${sidecar}/artifact-a.html"`,
    `cp "${sidecar}/uploads/homework.png" /tmp/homework.png`
  ])('bash：%s', (command) => {
    const r = classifyToolRisk('bash', { command })
    expect(r.level).not.toBe('risky')
    expect(r.reason).not.toContain('artifact 内容必须走')
  })

  it('write 直写 sidecar → 沙箱下 safe', () => {
    const r = classifyToolRisk('write', { path: path.join(sidecar, 'artifact-a.html'), content: '<html></html>' })
    expect(r.level).toBe('safe')
  })

  it('对账只挂在可能直写的通道上，artifact 三工具自己走产物库', () => {
    for (const t of ['write', 'edit', 'bash', 'powershell', 'execute_code']) expect(SIDECAR_WRITE_CHANNELS.has(t), t).toBe(true)
    for (const t of ['create_artifact', 'edit_artifact', 'read', 'render_artifact']) expect(SIDECAR_WRITE_CHANNELS.has(t), t).toBe(false)
  })
})

describe('reconcileArtifactSidecarWrites', () => {
  it('只挑这条调用期间改过、且内容异于快照的产物：同步内容、jsx 重编译、基线刷新', async () => {
    const store = getArtifactStore()
    const page = { id: 'artifact-page', type: 'html', title: '旧页', content: '<html>old</html>' }
    const scene = { id: 'artifact-scene', type: 'code', title: '场景', content: 'const A = () => <div/>', language: 'jsx' }
    saveArtifact(CONV, page)
    store.upsert(CONV, page)
    saveArtifact(CONV, scene)
    store.upsert(CONV, scene)
    await sleep(20)
    const since = Date.now()
    await sleep(20)
    // 模拟 bash 直写：只改 jsx 源；html 的 mtime 落在 1 秒余量里但内容没变，不该被报
    const next = 'const A = () => <span>v2</span>'
    fs.writeFileSync(path.join(sidecar, 'artifact-scene.jsx'), next)

    const changed = reconcileArtifactSidecarWrites(CONV, since)
    expect(changed.map(c => c.artifact.id)).toEqual(['artifact-scene'])
    expect(changed[0].artifact).toMatchObject({ type: 'code', language: 'jsx', title: '场景', content: next })
    expect(changed[0].recompiled).toBe(true)
    expect(fs.readFileSync(path.join(sidecar, 'artifact-scene.compiled.js'), 'utf8')).toContain('v2')
    expect(store.getRecord('artifact-scene')?.lastAgentContent).toBe(next)
    const note = formatReconciledForModel(changed)
    expect(note).toContain('artifact-scene（场景）已按磁盘内容同步到产物面板')
    expect(note).toContain('jsx 已重编译')

    // 幂等：基线已刷新，再对一次账什么都不报（渲染端回写同内容也落在这条路上）
    expect(reconcileArtifactSidecarWrites(CONV, since)).toEqual([])
  })

  it('没有注册表记录的老产物：按文件名推类型，jsx 照样重编译', async () => {
    await sleep(20)
    const since = Date.now()
    await sleep(20)
    fs.writeFileSync(path.join(sidecar, 'artifact-legacy.jsx'), 'const B = () => <b>legacy</b>')
    const changed = reconcileArtifactSidecarWrites(CONV, since).filter(c => c.artifact.id === 'artifact-legacy')
    expect(changed).toHaveLength(1)
    expect(changed[0].artifact.language).toBe('jsx')
    expect(changed[0].recompiled).toBe(true)
    expect(fs.existsSync(path.join(sidecar, 'artifact-legacy.compiled.js'))).toBe(true)
  })

  it('没有会话 id 什么都不做', () => {
    expect(reconcileArtifactSidecarWrites(undefined, 0)).toEqual([])
  })
})
