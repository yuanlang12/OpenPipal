#!/usr/bin/env node
/**
 * 用量账本汇总 —— 读 ~/.openpipal/usage.jsonl，回答三个花钱的问题：
 *   ① 缓存到底命中多少（按模型分，不同网关差别极大）
 *   ② 工具轨迹在载荷里占多大比例（"8000 预算配得对不对"的实测依据）
 *   ③ 一轮对话平均要发几次、多少 token（N² 放大的真实倍数）
 *
 * 用法：node scripts/diagnostics/usage-report.mjs [--days 7]
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

const days = (() => {
  const i = process.argv.indexOf('--days')
  return i > 0 ? Number(process.argv[i + 1]) || 7 : 7
})()

const file = path.join(os.homedir(), '.openpipal', 'usage.jsonl')
if (!fs.existsSync(file)) {
  console.log('还没有用量记录。跑几轮对话后再来（记录由 pi-agent-service 的 Usage 观测落盘）。')
  process.exit(0)
}

const since = Date.now() - days * 86400_000
const calls = []
const turns = []
for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
  if (!line.trim()) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  if (new Date(r.ts).getTime() < since) continue
  ;(r.kind === 'turn' ? turns : calls).push(r)
}

if (calls.length === 0) {
  console.log(`最近 ${days} 天没有记录。`)
  process.exit(0)
}

const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0)
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0')
const k = n => (n / 1000).toFixed(1) + 'k'

const prompt = sum(calls, 'prompt')
const cacheRead = sum(calls, 'cacheRead')
const input = sum(calls, 'input')
const cacheWrite = sum(calls, 'cacheWrite')

console.log(`\n=== 最近 ${days} 天 · ${calls.length} 次调用 / ${turns.length} 轮 ===`)
console.log(`prompt 合计 ${k(prompt)}  (新增 input ${k(input)} / 缓存读 ${k(cacheRead)} / 缓存写 ${k(cacheWrite)})`)
console.log(`缓存命中率 ${pct(cacheRead, prompt)}%   ——每提高 10 个点，约省下 9% 的 prompt 成本`)
console.log(`输出合计 ${k(sum(calls, 'output'))}`)

// 按模型分组：不同网关的缓存行为差别极大，混在一起看没有意义
const byModel = new Map()
for (const c of calls) {
  const m = byModel.get(c.model) || { calls: 0, prompt: 0, cacheRead: 0, trailTok: 0 }
  m.calls++; m.prompt += c.prompt || 0; m.cacheRead += c.cacheRead || 0; m.trailTok += c.trailTok || 0
  byModel.set(c.model, m)
}
console.log('\n--- 按模型 ---')
for (const [model, m] of [...byModel].sort((a, b) => b[1].prompt - a[1].prompt)) {
  console.log(`${model.padEnd(24)} ${String(m.calls).padStart(5)} 次  prompt ${k(m.prompt).padStart(9)}  命中 ${pct(m.cacheRead, m.prompt).padStart(5)}%  轨迹占比 ${pct(m.trailTok, m.prompt).padStart(5)}%`)
}

// 工具轨迹：8000 是 **full 档**的预算，不是轨迹总量的上限。
// 超出预算的旧调用降级成回执档（最多 40 条 × 约 85 tok = 约 3.4k）仍留在载荷里，
// 所以"设计上限"≈ 8000 + 3.4k ≈ 11.4k。拿总量跟 8000 比会把满负荷误读成超支（2026-07-29 实案）。
const TRAIL_FULL_BUDGET = 8000
const TRAIL_RECEIPT_CEILING = 3400
const TRAIL_DESIGN_CEILING = TRAIL_FULL_BUDGET + TRAIL_RECEIPT_CEILING
const withTrail = calls.filter(c => c.trailMsgs > 0)
if (withTrail.length) {
  const trailTok = sum(withTrail, 'trailTok')
  const maxTrail = Math.max(...withTrail.map(c => c.trailTok))
  console.log('\n--- 工具轨迹 ---')
  console.log(`${withTrail.length}/${calls.length} 次调用带轨迹；合计 ${k(trailTok)} tok，占这些调用 prompt 的 ${pct(trailTok, sum(withTrail, 'prompt'))}%`)
  const near = maxTrail >= TRAIL_DESIGN_CEILING * 0.95 ? '（已满负荷：full 档吃满 + 回执档吃满）' : ''
  console.log(`单次最大 ${maxTrail} tok / 设计上限约 ${TRAIL_DESIGN_CEILING}（full ${TRAIL_FULL_BUDGET} + 回执约 ${TRAIL_RECEIPT_CEILING}）${near}`)
  console.log(`平均 ${Math.round(trailTok / withTrail.length)} tok / ${(sum(withTrail, 'trailMsgs') / withTrail.length).toFixed(1)} 条`)
}

// N² 放大：一轮几次调用、每次多大
if (turns.length) {
  const callsPerTurn = sum(turns, 'calls') / turns.length
  console.log('\n--- 每轮成本形状 ---')
  console.log(`平均每轮 ${callsPerTurn.toFixed(1)} 次模型调用；单次平均 prompt ${k(prompt / calls.length)}`)
  console.log(`压缩触发 ${calls.filter(c => c.compacted).length} 次 / ${calls.length}`)
}

// 命中率最差的调用：定位是哪些场景在烧钱
const worst = calls.filter(c => c.prompt > 8000 && c.seq > 1).sort((a, b) => a.hit - b.hit).slice(0, 5)
if (worst.length) {
  console.log('\n--- 热上下文里命中最差的 5 次（前缀疑似被改写） ---')
  for (const c of worst) {
    console.log(`${c.ts.slice(5, 16)} conv=${c.conv} call#${c.seq} hit=${c.hit}% prompt=${k(c.prompt)} 轨迹=${c.trailTok} 历史=${c.histMsgs}条`)
  }
}
console.log('')
