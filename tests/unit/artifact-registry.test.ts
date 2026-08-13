/**
 * artifact-registry 回归锁（P1）：create 同步落盘关掉 id 竞态。
 * 旧 bug：create 拿到 id 却异步经渲染器往返才落盘，render/edit 立刻按 id 磁盘扫描 → "找不到 id" 重试循环。
 * 修复：upsert 同步落盘 + 记录；resolve 先查注册表、磁盘兜底 legacy。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// os.homedir() 优先读 HOME——必须在导入前劫持，让 ARTIFACTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-artifact-registry-'))
process.env.HOME = TMP

const { getArtifactStore } = await import('../../src/main/artifact-registry')

const CONV = 'conv-reg'

describe('artifact-registry: create 同步落盘关竞态', () => {
  it('upsert 后文件立即在盘 + resolve(id) 立即命中（无异步竞态）', () => {
    const store = getArtifactStore()
    const rec = store.upsert(CONV, { id: 'artifact-9990001', type: 'html', title: '落地页.dc.html', content: '<html>hi</html>' })
    // 竞态铁证：upsert 返回后文件已在磁盘（旧路径此刻文件还没写）
    expect(fs.existsSync(rec.path)).toBe(true)
    expect(fs.readFileSync(rec.path, 'utf8')).toContain('hi')
    // render/edit 的解析立即命中（旧竞态下这里报"找不到 id"）
    const r = store.resolve('artifact-9990001', CONV)
    expect('record' in r).toBe(true)
    if ('record' in r) {
      expect(r.record.id).toBe('artifact-9990001')
      expect(r.record.path).toBe(rec.path)
    }
  })

  it('jsx 场景 upsert 同步产出 .compiled.js sidecar（磁盘上）', () => {
    const store = getArtifactStore()
    const src = 'const { Stage } = window; function Scene(){ return null } Object.assign(window,{Scene})'
    const rec = store.upsert(CONV, { id: 'artifact-9990009', type: 'code', title: '场景', content: src, language: 'jsx' })
    // sidecar 由 saveArtifact 同步写到磁盘（render 隐藏窗口/导出依赖它），验磁盘存在即可
    const compiled = rec.path.replace(/\.jsx$/, '.compiled.js')
    expect(fs.existsSync(compiled)).toBe(true)
  })

  it('getRecord 返回 type/title（替代 artifactMetaCache）', () => {
    const store = getArtifactStore()
    store.upsert(CONV, { id: 'artifact-9990002', type: 'markdown', title: '文档', content: '# hi' })
    const g = store.getRecord('artifact-9990002')
    expect(g?.type).toBe('markdown')
    expect(g?.title).toBe('文档')
  })

  it('getRef 幂等回补：注册表拥有的 id 返回 ref、未知 id 返回 undefined', () => {
    const store = getArtifactStore()
    store.upsert(CONV, { id: 'artifact-9990003', type: 'html', title: 'x', content: '<html></html>' })
    const ref = store.getRef(CONV, 'artifact-9990003')
    expect(ref?.id).toBe('artifact-9990003')
    expect(ref?.path).toContain('artifact-9990003.html')
    expect(store.getRef(CONV, 'artifact-unknown')).toBeUndefined()
  })

  it('legacy 兜底：磁盘上存在但未入表的 artifact 仍能 resolve（重启场景）', () => {
    const legacyDir = path.join(TMP, '.openpipal', 'conversations', 'artifacts', 'conv-legacy')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'artifact-legacy001.html'), '<html>old</html>')
    const r = getArtifactStore().resolve('artifact-legacy001', 'conv-legacy')
    expect('record' in r).toBe(true)
    if ('record' in r) {
      expect(r.record.id).toBe('artifact-legacy001')
      expect(r.record.type).toBe('html')
    }
  })

  it('未知 id → 错误带真实 id 清单，绝不引导新建', () => {
    const r = getArtifactStore().resolve('artifact-nonexistent', CONV)
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toContain('找不到')
      expect(r.error).toContain('完整 id')
    }
  })

  it('会话隔离：resolve 只在本会话解析，不串味到别的会话', () => {
    const store = getArtifactStore()
    store.upsert('conv-x', { id: 'artifact-onlyx', type: 'html', title: 'x 专属', content: '<html></html>' })
    // 在 conv-reg 里解析 conv-x 的 id → 找不到（隔离）
    const r = store.resolve('artifact-onlyx', 'conv-reg')
    expect('error' in r).toBe(true)
  })
})

describe('artifact-registry: 按标题解析（P2 语义 handle）', () => {
  const C = 'conv-title'
  it('按完整标题解析到正确 record（模型不用猜 id）', () => {
    const store = getArtifactStore()
    const rec = store.upsert(C, { id: 'artifact-t0001', type: 'html', title: '学径产品宣传动画.dc.html', content: '<html></html>' })
    const r = store.resolve('学径产品宣传动画', C)
    expect('record' in r).toBe(true)
    if ('record' in r) {
      expect(r.record.id).toBe('artifact-t0001')
      expect(r.record.path).toBe(rec.path)
      expect(r.corrected).toBe(true)
    }
  })

  it('标题子串（≥6 归一后）也能对上（模型加了后缀）', () => {
    const store = getArtifactStore()
    store.upsert(C, { id: 'artifact-t0002', type: 'html', title: '教师讲义分册', content: '<html></html>' })
    const r = store.resolve('教师讲义分册 · 深色版', C)
    expect('record' in r).toBe(true)
    if ('record' in r) expect(r.record.id).toBe('artifact-t0002')
  })

  it('标题歧义（匹配多个）→ 报候选清单，绝不乱改', () => {
    const store = getArtifactStore()
    store.upsert(C, { id: 'artifact-t0003', type: 'html', title: '组件库总览页面A', content: '<html></html>' })
    store.upsert(C, { id: 'artifact-t0004', type: 'html', title: '组件库总览页面B', content: '<html></html>' })
    const r = store.resolve('组件库总览页面', C)
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toContain('多个')
      expect(r.error).toContain('artifact-t0003')
      expect(r.error).toContain('artifact-t0004')
    }
  })

  it('标题不跨会话串味', () => {
    const store = getArtifactStore()
    store.upsert('conv-title-x', { id: 'artifact-tx01', type: 'html', title: 'X会话独有标题', content: '<html></html>' })
    const r = store.resolve('X会话独有标题', C) // 在 C 里找 X 的标题 → 找不到
    expect('error' in r).toBe(true)
  })
})
