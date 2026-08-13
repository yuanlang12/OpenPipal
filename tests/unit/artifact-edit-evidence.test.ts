/**
 * 外部修改 diff 证据链：mtime 对账门闩只能告诉模型「被改过」，buildExternalEditEvidence 把
 * 「改了什么」算成 diff 附进 read_artifact 结果——模型上下文里未必有它自己上一版的原文，
 * 没有这份 diff 它无从识别哪些字是用户的修改（信息缺口，非能力问题）。
 * 快照基线语义：upsert（create 写出）与 touch 第三参（edit 写出）刷新；read（touch 不带参）不动。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// os.homedir() 优先读 HOME——必须在导入前劫持，让 ARTIFACTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-artifact-edit-evidence-'))
process.env.HOME = TMP

const { getArtifactStore, buildExternalEditEvidence } = await import('../../src/main/artifact-registry')

const CONV = 'conv-edit-evidence'

describe('buildExternalEditEvidence：纯 diff 证据', () => {
  it('内容相同 → null（无证据可附）', () => {
    expect(buildExternalEditEvidence('abc\ndef\n', 'abc\ndef\n')).toBeNull()
  })

  it('单行修改 → 同时给出旧行(-)与新行(+)', () => {
    const before = '<h1>上下文工程入门指南</h1>\n<p>正文</p>\n'
    const after = '<h1>上下文工程入门指南（用户改过的标题）</h1>\n<p>正文</p>\n'
    const ev = buildExternalEditEvidence(before, after)!
    expect(ev).toContain('-<h1>上下文工程入门指南</h1>')
    expect(ev).toContain('+<h1>上下文工程入门指南（用户改过的标题）</h1>')
    expect(ev).toContain('保留用户的这些修改')
  })

  it('多处修改 → 每处一个 hunk，行号定位到新版本', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`)
    const edited = [...lines]
    edited[4] = 'line-5-user-edited'
    edited[34] = 'line-35-user-edited'
    const ev = buildExternalEditEvidence(lines.join('\n'), edited.join('\n'))!
    expect(ev).toContain('@@ 第 3 行附近 @@') // context:2 → hunk 从改动行前 2 行起
    expect(ev).toContain('+line-5-user-edited')
    expect(ev).toContain('+line-35-user-edited')
    expect((ev.match(/@@ 第 \d+ 行附近 @@/g) || []).length).toBe(2)
  })

  it('超预算差异 → 截断并声明，不整段吞掉', () => {
    const before = Array.from({ length: 400 }, (_, i) => `row-${i}`).join('\n')
    const after = Array.from({ length: 400 }, (_, i) => `row-${i}-changed`).join('\n')
    const ev = buildExternalEditEvidence(before, after)!
    expect(ev).toContain('差异过长已截断')
    expect(ev.length).toBeLessThan(5000)
  })
})

describe('快照基线的生命周期（upsert 写出 / touch 写出 / read 不动）', () => {
  const store = getArtifactStore()

  it('upsert 后快照 = 磁盘落盘内容；用户直改磁盘后 read 场景可算出 diff', () => {
    const id = `artifact-ev-${Date.now()}`
    const rec = store.upsert(CONV, { id, type: 'html', title: '证据链测试', content: '<p>v1-agent</p>\n' })
    expect(store.getRecord(id)?.lastAgentContent).toBe('<p>v1-agent</p>\n')
    // 模拟用户经 UI 直改磁盘（artifact:save 路径不经注册表）
    fs.writeFileSync(rec.path, '<p>v1-user-edited</p>\n', 'utf8')
    const ev = buildExternalEditEvidence(store.getRecord(id)!.lastAgentContent!, fs.readFileSync(rec.path, 'utf8'))!
    expect(ev).toContain('-<p>v1-agent</p>')
    expect(ev).toContain('+<p>v1-user-edited</p>')
  })

  it('touch 带 writtenContent（edit 写出）→ 刷新快照；不带（read）→ 保留原快照', () => {
    const id = `artifact-ev2-${Date.now()}`
    const rec = store.upsert(CONV, { id, type: 'markdown', title: '快照刷新', content: 'v1\n' })
    store.touch(rec, Date.now(), 'v2-after-edit\n')
    expect(store.getRecord(id)?.lastAgentContent).toBe('v2-after-edit\n')
    store.touch(rec, Date.now()) // read 事件：只刷 mtime 基线
    expect(store.getRecord(id)?.lastAgentContent).toBe('v2-after-edit\n')
  })

  it('legacy/重启后无快照 → getRecord 无 lastAgentContent，证据链自然退化（不误报）', () => {
    expect(store.getRecord('artifact-never-written')?.lastAgentContent).toBeUndefined()
  })
})
