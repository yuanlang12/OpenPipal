#!/usr/bin/env node
/**
 * 把 dc-runtime 里的 JSX 预制件编译成宿主实际内联的 .compiled.js。
 *
 * 为什么要这一步：产物跑在离线的 srcdoc 沙箱与 headless 导出里，拉 Babel 不现实，
 * 所以机器吃预编译版；JSX 源码留给人读和改。两份必须由脚本产生而不是手工同步——
 * 手工同步迟早会漂，而"编译产物可复现"本身是开源发行的一条证据（任何人都能重跑比对）。
 *
 * 用法：
 *   node scripts/build-dc-runtime-compiled.mjs            # 编译全部
 *   node scripts/build-dc-runtime-compiled.mjs ios-frame  # 只编译一件
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join(ROOT, 'resources/dc-runtime')

/** 需要预编译的 JSX 预制件。新增 JSX 型预制件时在这里加一行。 */
const TARGETS = ['ios-frame', 'android-frame']

/**
 * 就绪门闩：本件被注入到 head 顶部，早于宿主注入 React。自己等齐再跑。
 * 与 animations.compiled.js 尾部同一套写法，保持运行时件的启动语义一致。
 */
function wrap(name, body) {
  return `/**
 * ${name} —— esbuild 预编译版，由 scripts/build-dc-runtime-compiled.mjs 从 ${name}.jsx 生成。
 *
 * 不要手改本文件：改 ${name}.jsx 后重跑 \`node scripts/build-dc-runtime-compiled.mjs\`。
 */
;(function () {
  function boot() {
${body.trimEnd()}
  }

  function reactReady() {
    return !!(window.React && window.ReactDOM)
  }

  if (reactReady()) {
    boot()
  } else {
    var tries = 0
    var timer = setInterval(function () {
      if (reactReady()) {
        clearInterval(timer)
        boot()
        return
      }
      if (++tries > 500) { // 约 15s
        clearInterval(timer)
        console.error('[OpenPipal] ${name} 预制件等不到 React/ReactDOM，设备外框未挂载。')
      }
    }, 30)
  }
})()
`
}

const picked = process.argv.slice(2)
const targets = picked.length ? picked : TARGETS
for (const name of targets) {
  if (!TARGETS.includes(name)) {
    console.error(`未知目标 ${name}；可选：${TARGETS.join(' / ')}`)
    process.exitCode = 1
    continue
  }
  const src = join(RUNTIME_DIR, `${name}.jsx`)
  const out = join(RUNTIME_DIR, `${name}.compiled.js`)
  // esm：拿到的就是裸语句体，外层 IIFE 由 wrap 提供。源码按 C1 不含 import/export，
  // 所以这一档不会产生任何模块语法——真出现了就是源码违约，下面直接拦。
  const { code } = transformSync(readFileSync(src, 'utf8'), {
    loader: 'jsx',
    format: 'esm',
    target: 'es2018'
  })
  if (/^\s*(?:import|export)\s/m.test(code)) {
    console.error(`${name}.jsx 含 import/export，违反 dc-runtime 的零模块契约（C1），未生成。`)
    process.exitCode = 1
    continue
  }
  const body = code.split('\n').map((l) => (l ? '    ' + l : l)).join('\n')
  const text = wrap(name, body)
  writeFileSync(out, text, 'utf8')
  console.log(`${name}.jsx → ${name}.compiled.js (${text.length} bytes)`)
}
