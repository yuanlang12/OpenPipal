/**
 * jsx 场景预编译钩子（W2：文件夹型动画产物）：
 * type=code&language=jsx 的产物存盘时用 esbuild 同步产出 <id>.compiled.js（React 就绪门闩 wrapper），
 * 依赖 animations 链的场景追加 window.Stage 门闩；编译失败不阻塞保存、回传 error 供模型自修。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// os.homedir() 在 POSIX 优先读 HOME——模块导入前劫持，让 ARTIFACTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-artifact-compile-'))
process.env.HOME = TMP

const {
  saveArtifact, updateArtifact, compileJsxArtifact, loadCompiledArtifact,
  listConversationArtifacts, findArtifactFileById
} = await import('../../src/main/artifact-store')

const CONV = 'conv-compile'
const ARTDIR = path.join(TMP, '.openpipal', 'conversations', 'artifacts', CONV)

describe('jsx 场景预编译钩子', () => {
  it('type=code&lang=jsx 存盘产出 <id>.compiled.js（含 React 就绪门闩 + JSX 降级）', () => {
    const ref = saveArtifact(CONV, {
      id: 'artifact-scene1', type: 'code', title: '场景1',
      content: 'function Scene(){return <div>hi</div>}\nObject.assign(window,{Scene})', language: 'jsx'
    })
    expect(fs.existsSync(ref.path)).toBe(true)
    expect(ref.path).toMatch(/artifact-scene1\.jsx$/)
    const compiled = path.join(ARTDIR, 'artifact-scene1.compiled.js')
    expect(fs.existsSync(compiled)).toBe(true)
    const js = fs.readFileSync(compiled, 'utf8')
    expect(js).toContain('var __run=function()')
    expect(js).toContain('openpipal-jsx-compiled:v2')
    expect(js).toContain('window.React&&window.ReactDOM')
    expect(js).toContain('React.createElement') // jsx 已降级
  })

  it('标题是 .jsx 且漏填 language 时自动归一，不再错误保存为 .txt', () => {
    const ref = saveArtifact(CONV, {
      id: 'artifact-title-jsx', type: 'code', title: '场景-title.jsx',
      content: 'function Scene(){return <div>title</div>}\nObject.assign(window,{Scene})'
    })
    expect(ref.language).toBe('jsx')
    expect(ref.path).toMatch(/artifact-title-jsx\.jsx$/)
    expect(fs.existsSync(path.join(ARTDIR, 'artifact-title-jsx.compiled.js'))).toBe(true)
  })

  it('引用 Stage 的场景 poll 门闩追加 window.Stage（链序：Stage 必须先在场）', () => {
    const r = compileJsxArtifact('function Scene(){const {Stage}=window;return <Stage><div/></Stage>}\nObject.assign(window,{Scene})')
    expect(r.error).toBeUndefined()
    expect(r.js).toContain('window.React&&window.ReactDOM&&window.Stage')
  })

  it('不依赖 animations 的场景门闩只有 React（无 Stage，避免死等）', () => {
    const r = compileJsxArtifact('function A(){return <div/>}\nObject.assign(window,{A})')
    expect(r.js).toContain('window.React&&window.ReactDOM')
    expect(r.js).not.toContain('window.Stage')
  })

  it('多个自注册场景拼在同一 JSX 时按 Object.assign 边界分段编译', () => {
    const source = [
      'const {Stage}=window; const T={name:"a"}; function A(){return <Stage><div>{T.name}</div></Stage>} Object.assign(window,{A});',
      'const {Stage}=window; const T={name:"b"}; function B(){return <Stage><div>{T.name}</div></Stage>} Object.assign(window,{B});'
    ].join('\n')
    const r = compileJsxArtifact(source)
    expect(r.error).toBeUndefined()
    expect(r.js).toContain('openpipal-jsx-compiled:v2')
    expect(r.js).toContain('Object.assign(window, { A })')
    expect(r.js).toContain('Object.assign(window, { B })')
    expect(r.js).toContain('window.React&&window.ReactDOM&&window.Stage')
  })

  it('语法错误回传 error、不写 sidecar，但主文件仍保存', () => {
    const r = compileJsxArtifact('function X(){ return <div>')
    expect(r.error).toBeTruthy()
    expect(r.js).toBeUndefined()
    const ref = saveArtifact(CONV, { id: 'artifact-bad', type: 'code', title: '坏', content: 'function X(){ return <div>', language: 'jsx' })
    expect(fs.existsSync(ref.path)).toBe(true)
    expect(fs.existsSync(path.join(ARTDIR, 'artifact-bad.compiled.js'))).toBe(false)
  })

  it('edit 后 updateArtifact 重编译 compiled.js（不留陈旧内容）', () => {
    const ref = saveArtifact(CONV, { id: 'artifact-scene2', type: 'code', title: '场景2', content: 'function S(){return <div>v1</div>}\nObject.assign(window,{S})', language: 'jsx' })
    updateArtifact(ref, 'function S(){return <div>v2</div>}\nObject.assign(window,{S})')
    const js = fs.readFileSync(path.join(ARTDIR, 'artifact-scene2.compiled.js'), 'utf8')
    expect(js).toContain('v2')
    expect(js).not.toContain('v1')
  })

  it('loadCompiledArtifact 返回 compiled 文本；路径穿越 / 缺失返回 null', () => {
    expect(loadCompiledArtifact(CONV, 'artifact-scene1')).toContain('__run')
    expect(loadCompiledArtifact(CONV, '../evil')).toBeNull()
    expect(loadCompiledArtifact(CONV, 'artifact-missing')).toBeNull()
  })

  it('普通 js 产物无 compiled.js，loadCompiledArtifact 回退到 <id>.js 原文', () => {
    saveArtifact(CONV, { id: 'artifact-plainjs', type: 'code', title: 'plain', content: 'window.Foo = 1', language: 'javascript' })
    expect(fs.existsSync(path.join(ARTDIR, 'artifact-plainjs.compiled.js'))).toBe(false)
    expect(loadCompiledArtifact(CONV, 'artifact-plainjs')).toContain('window.Foo')
  })

  it('.compiled.js 不污染 listConversationArtifacts / findArtifactFileById', () => {
    const ids = listConversationArtifacts(CONV).map((e) => e.id)
    expect(ids).toContain('artifact-scene1')
    expect(ids.some((id) => id.endsWith('.compiled'))).toBe(false)
    expect(findArtifactFileById('artifact-scene1')).toMatch(/artifact-scene1\.jsx$/)
  })

  // Workstream B2：compiled sidecar 自愈——"谁写了源文件"不再决定预览新旧
  it('自愈①compiled 缺失（write 直写源文件绕过 saveArtifact 不重编译 / 模型手删逼重编译）→ 当场重编译回写', () => {
    saveArtifact(CONV, { id: 'artifact-heal1', type: 'code', title: '自愈1', content: 'function H(){return <div>v1</div>}\nObject.assign(window,{H})', language: 'jsx' })
    const compiled = path.join(ARTDIR, 'artifact-heal1.compiled.js')
    expect(fs.existsSync(compiled)).toBe(true)
    fs.rmSync(compiled) // 模拟 compiled 缺失
    const js = loadCompiledArtifact(CONV, 'artifact-heal1')
    expect(js).toContain('v1')
    expect(fs.existsSync(compiled)).toBe(true) // 回写
  })

  it('自愈②源文件 mtime 比 compiled 新（write 直写 .jsx 但没重编译）→ 重编译反映最新源内容', () => {
    saveArtifact(CONV, { id: 'artifact-heal2', type: 'code', title: '自愈2', content: 'function H(){return <div>v1</div>}\nObject.assign(window,{H})', language: 'jsx' })
    const jsxPath = path.join(ARTDIR, 'artifact-heal2.jsx')
    const compiledPath = path.join(ARTDIR, 'artifact-heal2.compiled.js')
    // 模拟"通用 write 工具绕过 saveArtifact 直写源文件"：只改 .jsx，不碰 compiled，且让 mtime 更新
    fs.writeFileSync(jsxPath, 'function H(){return <div>v2</div>}\nObject.assign(window,{H})', 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(jsxPath, future, future)
    const js = loadCompiledArtifact(CONV, 'artifact-heal2')
    expect(js).toContain('v2')
    expect(js).not.toContain('v1')
    expect(fs.readFileSync(compiledPath, 'utf8')).toContain('v2') // 回写覆盖旧 compiled
  })

  it('自愈③旧 recipe 的 compiled 即使比源文件新，也会重编译为 Stage 就绪门闩', () => {
    saveArtifact(CONV, { id: 'artifact-heal-recipe', type: 'code', title: '旧配方', content: 'function H(){const {Stage}=window;return <Stage><div>fresh</div></Stage>}\nObject.assign(window,{H})', language: 'jsx' })
    const jsxPath = path.join(ARTDIR, 'artifact-heal-recipe.jsx')
    const compiledPath = path.join(ARTDIR, 'artifact-heal-recipe.compiled.js')
    fs.writeFileSync(compiledPath, '(function(){if(document.readyState===\'loading\')document.addEventListener(\'DOMContentLoaded\',function(){})})();', 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(compiledPath, future, future)
    expect(fs.statSync(compiledPath).mtimeMs).toBeGreaterThan(fs.statSync(jsxPath).mtimeMs)

    const js = loadCompiledArtifact(CONV, 'artifact-heal-recipe')
    expect(js).toContain('openpipal-jsx-compiled:v2')
    expect(js).toContain('window.React&&window.ReactDOM&&window.Stage')
    expect(js).toContain('fresh')
    expect(fs.readFileSync(compiledPath, 'utf8')).toBe(js)
  })

  it('自愈④合法的历史多场景 compiled 只升级 boot，不因重复源码声明而回退', () => {
    const source = [
      'const {Stage}=window; const T={name:"a"}; function A(){return <Stage><div>{T.name}</div></Stage>} Object.assign(window,{A});',
      'const {Stage}=window; const T={name:"b"}; function B(){return <Stage><div>{T.name}</div></Stage>} Object.assign(window,{B});'
    ].join('\n')
    saveArtifact(CONV, { id: 'artifact-heal-legacy-multi', type: 'code', title: '历史多场景', content: source, language: 'jsx' })
    const jsxPath = path.join(ARTDIR, 'artifact-heal-legacy-multi.jsx')
    const compiledPath = path.join(ARTDIR, 'artifact-heal-legacy-multi.compiled.js')
    const legacy = '(function(){var __run=function(){window.A=function A(){};window.B=function B(){}}; if(document.readyState===\'loading\')document.addEventListener(\'DOMContentLoaded\',__run); else __run();})();'
    fs.writeFileSync(compiledPath, legacy, 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(compiledPath, future, future)
    expect(fs.statSync(compiledPath).mtimeMs).toBeGreaterThan(fs.statSync(jsxPath).mtimeMs)

    const js = loadCompiledArtifact(CONV, 'artifact-heal-legacy-multi')
    expect(js).toContain('openpipal-jsx-compiled:v2')
    expect(js).toContain('window.A=function A(){};window.B=function B(){}')
    expect(js).toContain('window.React&&window.ReactDOM&&window.Stage')
    expect(js).not.toContain('document.readyState')
  })

  it('自愈⑤历史 JSX 场景误存为 .txt → 识别强场景形状并补写 .jsx + compiled', () => {
    fs.mkdirSync(ARTDIR, { recursive: true })
    const source = 'function Legacy(){return <Stage><div>legacy</div></Stage>}\nObject.assign(window,{Legacy})'
    fs.writeFileSync(path.join(ARTDIR, 'artifact-legacy-txt.txt'), source, 'utf8')
    const js = loadCompiledArtifact(CONV, 'artifact-legacy-txt')
    expect(js).toContain('legacy')
    expect(fs.existsSync(path.join(ARTDIR, 'artifact-legacy-txt.jsx'))).toBe(true)
    expect(fs.existsSync(path.join(ARTDIR, 'artifact-legacy-txt.compiled.js'))).toBe(true)
  })

  it('普通 .txt 不会被 legacy JSX 自愈误编译', () => {
    fs.mkdirSync(ARTDIR, { recursive: true })
    fs.writeFileSync(path.join(ARTDIR, 'artifact-plain-txt.txt'), '普通说明文字 <div>not code</div>', 'utf8')
    expect(loadCompiledArtifact(CONV, 'artifact-plain-txt')).toBeNull()
    expect(fs.existsSync(path.join(ARTDIR, 'artifact-plain-txt.compiled.js'))).toBe(false)
  })
})
