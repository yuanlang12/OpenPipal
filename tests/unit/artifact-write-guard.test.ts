/**
 * artifact 写入对账门闩：create_artifact 同 id 全量重发从不读盘，用户经 UI 直改磁盘后会被静默覆盖。
 * 机制：注册表记录「Agent 最后一次读到/写出该文件时的磁盘 mtime」(lastKnownMtimeMs)；写入前对账
 * 磁盘当前 mtime，领先基线超过容差 → 判定"被外部修改过"，拒绝覆盖式重发，逼模型先 read_artifact。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// os.homedir() 优先读 HOME——必须在导入前劫持，让 ARTIFACTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-artifact-write-guard-'))
process.env.HOME = TMP

const { getArtifactStore, evaluateArtifactWriteGuard, WRITE_GUARD_TOLERANCE_MS } = await import(
  '../../src/main/artifact-registry'
)

const CONV = 'conv-write-guard'

describe('evaluateArtifactWriteGuard：纯判定', () => {
  it('无基线（从未读写过 / legacy 未入表）→ 放行，不设防', () => {
    const r = evaluateArtifactWriteGuard(Date.now(), undefined)
    expect(r.blocked).toBe(false)
    expect(r.message).toBeUndefined()
  })

  it('基线与磁盘一致（没人动过）→ 放行', () => {
    const t = 1_700_000_000_000
    const r = evaluateArtifactWriteGuard(t, t)
    expect(r.blocked).toBe(false)
  })

  it('磁盘 mtime 明显领先于基线（用户直改过）→ 拒绝，给证据式指路', () => {
    const base = 1_700_000_000_000
    const diskMtime = base + 5 * 60_000 // 5 分钟后
    const r = evaluateArtifactWriteGuard(diskMtime, base)
    expect(r.blocked).toBe(true)
    expect(r.message).toContain('用户直接修改')
    expect(r.message).toContain('read_artifact')
  })

  it('容差边界：领先量恰好等于容差 → 仍放行（不算外部修改）', () => {
    const base = 1_700_000_000_000
    const r = evaluateArtifactWriteGuard(base + WRITE_GUARD_TOLERANCE_MS, base)
    expect(r.blocked).toBe(false)
  })

  it('容差边界：领先量超出容差 1ms → 拒绝', () => {
    const base = 1_700_000_000_000
    const r = evaluateArtifactWriteGuard(base + WRITE_GUARD_TOLERANCE_MS + 1, base)
    expect(r.blocked).toBe(true)
  })

  it('磁盘 mtime 落后于基线（正常，自己刚写完）→ 放行', () => {
    const base = 1_700_000_000_000
    const r = evaluateArtifactWriteGuard(base - 1000, base)
    expect(r.blocked).toBe(false)
  })
})

describe('写入对账门闩：与真实 store 集成（mtime 流转）', () => {
  it('upsert 落盘后记录 lastKnownMtimeMs（对账基线来自 create_artifact 自己这次写入）', () => {
    const store = getArtifactStore()
    const rec = store.upsert(CONV, { id: 'artifact-wg-0001', type: 'html', title: '页面', content: '<html>v1</html>' })
    expect(rec.lastKnownMtimeMs).toBeDefined()
    const diskMtime = fs.statSync(rec.path).mtimeMs
    expect(rec.lastKnownMtimeMs).toBe(diskMtime)
    // 紧接着对账：磁盘就是刚写的这份，判定必须放行（否则每次 create 都会自锁）
    const guard = evaluateArtifactWriteGuard(diskMtime, store.getRecord('artifact-wg-0001')?.lastKnownMtimeMs)
    expect(guard.blocked).toBe(false)
  })

  it('用户经 UI 直改磁盘（不经 registry）后，基线落后于磁盘 → 对账判定拒绝', () => {
    const store = getArtifactStore()
    const rec = store.upsert(CONV, { id: 'artifact-wg-0002', type: 'html', title: '页面2', content: '<html>v1</html>' })
    // 模拟 ipc artifact:save 走 saveArtifactToDisk 直接写盘（不经 registry.upsert，不刷新 lastKnownMtimeMs）
    const future = new Date(Date.now() + 10 * 60_000)
    fs.writeFileSync(rec.path, '<html>用户直接改的内容</html>', 'utf8')
    fs.utimesSync(rec.path, future, future)
    const diskMtime = fs.statSync(rec.path).mtimeMs
    const guard = evaluateArtifactWriteGuard(diskMtime, store.getRecord('artifact-wg-0002')?.lastKnownMtimeMs)
    expect(guard.blocked).toBe(true)
  })

  it('read 后解锁：touch 刷新基线到当前磁盘 mtime，循环收敛为放行', () => {
    const store = getArtifactStore()
    const rec = store.upsert(CONV, { id: 'artifact-wg-0003', type: 'html', title: '页面3', content: '<html>v1</html>' })
    const future = new Date(Date.now() + 10 * 60_000)
    fs.writeFileSync(rec.path, '<html>用户直接改的内容</html>', 'utf8')
    fs.utimesSync(rec.path, future, future)
    const diskMtimeBefore = fs.statSync(rec.path).mtimeMs
    // 先确认此刻确实被拒（否则下面"解锁"验证没有意义）
    expect(evaluateArtifactWriteGuard(diskMtimeBefore, store.getRecord('artifact-wg-0003')?.lastKnownMtimeMs).blocked).toBe(true)
    // read_artifact 成功后的行为：touch 把基线刷新为当前磁盘 mtime
    store.touch(store.getRecord('artifact-wg-0003')!, diskMtimeBefore)
    const guard = evaluateArtifactWriteGuard(diskMtimeBefore, store.getRecord('artifact-wg-0003')?.lastKnownMtimeMs)
    expect(guard.blocked).toBe(false)
  })

  it('touch 合并字段而不整条覆盖：未传的既有字段（如 type）保留', () => {
    const store = getArtifactStore()
    store.upsert(CONV, { id: 'artifact-wg-0004', type: 'markdown', title: '文档', content: '# hi' })
    const before = store.getRecord('artifact-wg-0004')!
    store.touch({ id: 'artifact-wg-0004', type: before.type, title: before.title, path: before.path }, before.lastKnownMtimeMs! + 1)
    const after = store.getRecord('artifact-wg-0004')
    expect(after?.type).toBe('markdown')
    expect(after?.lastKnownMtimeMs).toBe(before.lastKnownMtimeMs! + 1)
  })
})
