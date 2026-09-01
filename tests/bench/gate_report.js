// ⚠️ 被测机制（收工闸）已于 2026-08-28 按台账预先登记的规则拆除。这份报表读的是当时留下的
//    `gate-{off,on}-r{1,2,3}.jsonl`，**只能用来复核那次的结论**，别拿它跑新数据。
//    留着是当模板：三态分解、配对符号检验、逐轮拆开看漂移，这三件下一个 A/B 还要用。
//    结论与数据见 docs/claude/mechanism-registry.md「已拆除」一节。
// 收工闸对照报告：7 道题 × 2 条臂 × 3 遍。
//
// 主判据不是「过了几道」。n=7 跑三遍，完成率的分辨率大概是 1/21≈5%，而闸门要解决的问题
// （宣布干完但一个字节没改）在上一轮里只占 1/7——完成率根本量不动它。
// 所以**主判据是「零改动交付」的次数**，那正是台账里给这道闸登记的日落条件。
//
// 2026-08-27 起这个判据的口径变了：评测会在「第一轮零改动」时补一句自动确认再跑一轮
// （见 `tests/e2e/shadow-run.spec.ts` 文件头）。所以现在数的是**两轮之后仍然零改动**——
// 上一版把「按规矩停下来问确认」和「真的放弃了」算成了同一件事，那是测量假象。
// 完成率、回归、改测试当次要判据看，主要是防副作用：闸门不能为了让它接着干而把别的搞坏。
const fs = require('fs')
const ROOT = process.env.SHADOW_SCRATCH || require('os').homedir() + '/openpipal-bench/shadow'
const ROUNDS = [1, 2, 3]

const load = (arm, r) => {
  const p = `${ROOT}/gate-${arm}-r${r}.jsonl`
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** 补丁里动了几个**已有**测试文件、改了几行断言。新写的测试文件不算——那是好事。 */
function testTouch(patch) {
  const files = new Set()
  let assertions = 0
  for (const b of (patch || '').split(/^diff --git /m).slice(1)) {
    const m = b.match(/^a\/(\S+) b\/(\S+)/)
    if (!m) continue
    const f = m[2]
    if (!/(^|\/)tests?\//.test(f) && !/\.(test|spec)\.[jt]sx?$/.test(f)) continue
    if (/^new file mode/m.test(b)) continue
    files.add(f)
    for (const line of b.split('\n')) {
      if (!/^[+-]/.test(line) || /^[+-]{3}/.test(line)) continue
      // 只数**删掉**的断言：新增断言是补用例，删旧断言才是「改绿」
      if (line.startsWith('-') && /expect\(|assert|toBe|toEqual|toThrow|toContain/.test(line)) assertions++
    }
  }
  return { files: [...files], assertions }
}

const addedLines = (p) => (p || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length

/**
 * 这一次运行**作废**吗（被基础设施打死，不是模型没做到）。
 *
 * 实案：2026-08-26 21:50 上游 503「Endpoint is unavailable」抖了三分钟，
 * 正好打死当时在飞的 3 个任务——运行时重连打满 5 次后 external_abort。
 * 特征非常干净：SSE 收到过 error 事件、助手一个字都没输出、补丁是空的。
 * 判据用 **`done` 事件**，不用「回复是不是空的」。`done` 只在流正常收尾时才发
 * （`http-server.ts` 里跟在 `res.end()` 前面），所以「有 error 且没有 done」就是
 * 整条流以错误告终 —— 干净、和模型干了多少活无关。
 *
 * 上一版拿「回复为空 + 补丁为空」当判据，**漏掉了跑到一半被打断的那种**：
 * `gate-on-r1` 的 `92506183f` 已经写了 26 行、还新建了 `prompt-privacy.ts`，
 * `6b34c7ddd` 写了 46 行，`03472f433` 新建了探针文件——三条都是 `error=1 done=0` 被打断，
 * 却因为「有回复、有补丁」被当成有效样本，混进了「闸门开臂 0 次触发」那个数里。
 * 它们**根本没执行到闸门**（`pi-core-runtime.ts` 的 `stopReason==='error'` 早退在前面），
 * 拿它们证明机制无效，等于用没吃过药的人证明药没用。
 *
 * **判据不看 `errors` 正文**：中间抖一下又自己重连接着干完的运行照样带着 503 字样，那种是有效数据。
 */
function invalid(r) {
  const t = r.types || {}
  if ((t.error || 0) === 0) return false
  // 整条流以错误收尾（一个 done 都没有）
  if ((t.done || 0) === 0) return true
  // 两轮的情况：`types` 是两轮合并的，第一轮的 done 会把第二轮的死盖住。
  // `reply` 又恒为第一轮原话（shadow-run.spec.ts 里写死的口径），光看它也发现不了。
  // 不补这一条，第二轮被打死会被记成「补过确认之后它仍然一个字节没改」——方向正好反了。
  if (r.turns >= 2 && (r.reply2 || '').length === 0) return true
  return false
}

/**
 * 收工闸这一轮的**三态**，别压成一个布尔。
 *
 * 上一版只有 `gateLog.length > 0`，于是「没执行到」和「执行了但按设计闭嘴」都算 0。
 * 实案：`gate-on-r1` 的 `92506183f` 补丁 26 行、新建了文件，闸门只要执行到就必然打日志，
 * 可 gateLog 是空的——因为流被上游打断，`pi-core-runtime.ts` 的 `stopReason === 'error'`
 * 早退走在闸门块前面。这种样本**没接受过治疗**，不能拿它去证明「机制无效」。
 */
function gateState(r) {
  const log = (r.gateLog || []).join('\n')
  if (log.includes('[收工闸] 触发')) return 'fired'
  if (log.includes('[收工闸] 沉默')) return 'silent'
  if (log.includes('[收工闸] 未执行')) return 'skipped'
  // 关闸臂正常跑完时**一条日志都没有**（逃生舱口那条分支不打日志，
  // 否则关闸臂会被数成「闸门执行了并闭嘴」）。这不是「分不出」，是本来就关着。
  if (r.gateOn === false) return 'off'
  return 'unknown'      // 2026-08-27 之前的数据只打「触发」，其余两态都落这里
}

/**
 * 作废是**因为什么**。只用来在报告里分类，不参与判定。
 * 2026-08-27 起 harness 会把 SSE error 事件正文记进 `errors`——在那之前的数据没有这个字段，
 * 只能显示「不明」，当初为了查 13 次作废的原因翻了半天临时目录的 main.log。
 */
function deadWhy(r) {
  const e = (r.errors || []).join(' ')
  if (!e) return '不明（老数据没记 errors）'
  if (/not supported|does not exist|无此模型/i.test(e)) return '模型名上游不认（配置过期）'
  if (/\b401\b|\b403\b|unauthor|invalid.*key/i.test(e)) return '鉴权失败'
  if (/\b429\b|rate.?limit/i.test(e)) return '限流'
  if (/unavailable|\b50\d\b|Upstream request failed/i.test(e)) return '上游断流/不可用'
  return e.slice(0, 60)
}

function stat(r) {
  const t = testTouch(r.patch)
  const dead = invalid(r)
  const lines = addedLines(r.patch)
  // untracked 是**数组**（shadow_judge.py 直接给的），当字符串用会 TypeError 当场炸
  const untracked = Array.isArray(r.untracked) ? r.untracked.length : 0
  // 只删不加也是动过磁盘（删死代码、删文件）。只数加号行的话，
  // 一次「删了 30 行、一行没加」会被记成"零改动交付"，而决定补不补确认的 `git status`
  // 明明看得见那次改动——同一次运行，两个判据给出相反答案。
  const delLines = (r.patch || '').split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
  return {
    dead,
    ok: !!r.resolved,
    // 「零改动交付」：补丁空（加、删都空）、也没新建文件，却正常收工了。这是主判据。
    empty: lines === 0 && delLines === 0 && untracked === 0,
    lines, untracked,
    reg: r.regress_n || 0,
    touched: t.files.length, assertions: t.assertions,
    gate: gateState(r),
    gateLog: (r.gateLog || []).find((l) => l.includes('触发')) || '',
    // **别把 undefined 折成 1**。老数据（2026-08-27 之前）压根没有这个字段，
    // 那批运行从来没被补过确认；新数据的 1 是「跑了但判据不触发」。两者混在一起，
    // ① 那个「补过确认之后仍零改动」的标题就是假的。
    legacy: r.turns === undefined,
    turns: r.turns,
    // askedFirst 也是新字段，但它算得出来——老数据的 reply 还在，现算即可，
    // 这样老数据上也能看见「它其实在问确认」，不至于只有这一个观测点被写死成 0
    asked: r.askedFirst !== undefined ? !!r.askedFirst : /[？?]\s*$/.test((r.reply || '').trim()),
    min: r.ms / 60000,
    stop: r.stop,
    stop2: r.stop2 || null      // 补确认那一轮怎么停的。不读它，⑤ 就漏掉全部第二轮撞钟
  }
}

const arms = { off: {}, on: {} }
const dead = []
const ids = new Set()
for (const arm of ['off', 'on']) {
  for (const r of ROUNDS) {
    for (const row of load(arm, r)) {
      ids.add(row.commit)
      const st = stat(row)
      if (st.dead) { dead.push({ arm, round: r, commit: row.commit, why: deadWhy(row) }); continue }
      ;(arms[arm][row.commit] ||= [])[r - 1] = st
    }
  }
}
const ID = [...ids].sort()
const runsOf = (arm) => Object.values(arms[arm]).flat().filter(Boolean)

const nOff = runsOf('off').length, nOn = runsOf('on').length
console.log(`样本：闸门关 ${nOff} 次运行 / 闸门开 ${nOn} 次运行（${ID.length} 道题 × 最多 ${ROUNDS.length} 遍）`)
if (dead.length) {
  const byArm = { off: 0, on: 0 }
  for (const d of dead) byArm[d.arm]++
  console.log(`作废 ${dead.length} 次（上游断流打死，未计入）：闸门关 ${byArm.off} / 闸门开 ${byArm.on}`)
  console.log(`  ${dead.map((d) => `${d.commit.slice(0, 9)}@${d.arm}r${d.round}`).join('  ')}`)
  const why = {}
  for (const d of dead) (why[d.why] ||= []).push(`${d.commit.slice(0, 9)}@${d.arm}r${d.round}`)
  for (const [k, v] of Object.entries(why)) console.log(`  · ${k}：${v.length} 次`)
  // 比的是**存活数之差**，不是作废数之差。两者不等价：作废 6 vs 7（差 1，看着还行）
  // 对应的存活可能是 7 vs 4（差 3）——而 ① 和 ③ 正是在存活数这对分母上并排打的。
  if (Math.abs(nOff - nOn) >= 2 || nOff === 0 || nOn === 0) {
    console.log(`  ⚠️ 两条臂**存活**样本不对等（${nOff} vs ${nOn}）——补跑之前，下面 ① 和 ③ 的横向比较不成立`)
  }
  // 补跑就是把那一格重跑一遍：SHADOW_ONLY 点名那几道，结果落回同一个 jsonl（追加即可，
  // 装载时按 commit 去重靠的是「后写的覆盖前写的」——同一 commit 同一轮只会留最后一条）
  console.log(`  补跑那一格：OPENPIPAL_CODING_LIVE=1 OPENPIPAL_COMPLETION_GATE=<0|1> \\`)
  console.log(`    SHADOW_RESULTS=${ROOT}/gate-<arm>-r<n>.jsonl SHADOW_ROUND=<n> \\`)
  console.log(`    SHADOW_ONLY=${dead.map((x) => x.commit).filter((v, i, a) => a.indexOf(v) === i).join(',')} \\`)
  console.log(`    npx playwright test shadow-run --workers=3`)
}
console.log('')

console.log('题号           闸门关(3遍)          闸门开(3遍)        说明')
console.log('               过 空交付 回归 分钟   过 空交付 回归 分钟 闸响')
const cell = (rows) => {
  const v = rows.filter(Boolean)
  return {
    ok: v.filter((x) => x.ok).length, empty: v.filter((x) => x.empty).length,
    reg: v.reduce((a, x) => a + x.reg, 0), min: v.reduce((a, x) => a + x.min, 0) / Math.max(1, v.length),
    fired: v.filter((x) => x.gate === 'fired').length,
    silent: v.filter((x) => x.gate === 'silent').length,
    skipped: v.filter((x) => x.gate === 'skipped').length,
    off: v.filter((x) => x.gate === 'off').length,
    unknownGate: v.filter((x) => x.gate === 'unknown').length,
    legacy: v.filter((x) => x.legacy).length,
    n: v.length,
    touched: v.filter((x) => x.touched > 0).length, assertions: v.reduce((a, x) => a + x.assertions, 0),
    lines: v.reduce((a, x) => a + x.lines, 0) / Math.max(1, v.length),
    // 补过自动确认的次数 / 其中补完真的交出东西的次数
    two: v.filter((x) => x.turns >= 2).length,
    twoSaved: v.filter((x) => x.turns >= 2 && !x.empty).length,
    twoOk: v.filter((x) => x.turns >= 2 && x.ok).length,
    // 分母只算「跑过自动确认那版 harness」的运行，老数据不进这个比
    freshN: v.filter((x) => !x.legacy).length,
    asked: v.filter((x) => x.asked).length
  }
}
const T = { off: cell(runsOf('off')), on: cell(runsOf('on')) }
for (const id of ID) {
  const a = cell(arms.off[id] || []), b = cell(arms.on[id] || [])
  console.log(
    id.slice(0, 9).padEnd(14)
    + `${a.ok}/${a.n}${String(a.empty).padStart(5)}${String(a.reg).padStart(6)}${a.min.toFixed(0).padStart(6)}   `
    + `${b.ok}/${b.n}${String(b.empty).padStart(5)}${String(b.reg).padStart(6)}${b.min.toFixed(0).padStart(6)}${String(b.fired).padStart(5)}`
  )
}

const nLegacy = T.off.legacy + T.on.legacy
if (nLegacy) {
  console.log(`\n⚠️ ${nLegacy}/${nOff + nOn} 次运行是「自动确认」上线之前跑的（没有 turns 字段）。`)
  console.log(`   这批运行**从来没被补过确认**，下面 ① 的口径对它们不成立——`)
  console.log(`   混着读会把「按规矩停下来问确认」当成「零改动交付」，那正是这次改动要消灭的假象。`)
  console.log(`   重跑一整轮 A/B 之后这行会自己消失（gate_ab.sh 每格开跑前会清掉旧文件）。`)
}

console.log(`\n=== ① 主判据：零改动交付${nLegacy ? '（口径混杂，见上面的告警）' : '（补过一次自动确认之后，磁盘仍一个字节没变）'} ===`)
console.log(`  闸门关 ${T.off.empty}/${nOff} 次    闸门开 ${T.on.empty}/${nOn} 次`)
console.log(`  这是台账给这道闸登记的日落条件；两臂量不出差别就当场拆`)

console.log(`\n=== ①b 那一轮自动确认救回来多少 ===`)
console.log(`  （分母只算跑过新 harness 的：闸门关 ${T.off.freshN} 次 / 闸门开 ${T.on.freshN} 次）`)
console.log(`  第一轮就零改动、补了确认的：闸门关 ${T.off.two}/${T.off.freshN}      闸门开 ${T.on.two}/${T.on.freshN}`)
console.log(`   └ 补完真的动手了：        闸门关 ${T.off.twoSaved}/${T.off.two}        闸门开 ${T.on.twoSaved}/${T.on.two}`)
console.log(`   └ 补完还判过了：          闸门关 ${T.off.twoOk}/${T.off.two}        闸门开 ${T.on.twoOk}/${T.on.two}`)
console.log(`  第一轮结尾在问问题（现算，只观测不判定）：闸门关 ${T.off.asked}/${nOff}      闸门开 ${T.on.asked}/${nOn}`)
console.log(`  注：闸门开臂的「补确认次数」本该更少——闸门在第一轮里就该把它推回去干活了。`)
console.log(`      两臂这个数一样多，等于闸门没起作用（它在「没调写类工具」时按设计沉默）。`)

console.log(`\n=== ② 闸门到底响没响（三态，别只看「触发」那个数） ===`)
const gs = (c, n) => `响 ${c.fired} / 按设计闭嘴 ${c.silent} / 没执行到 ${c.skipped}`
  + (c.off ? ` / 关着 ${c.off}` : '') + (c.unknownGate ? ` / 分不出 ${c.unknownGate}` : '')
  + `  （共 ${n} 次）`
console.log(`  闸门开臂：${gs(T.on, nOn)}`)
console.log(`  闸门关臂：${gs(T.off, nOff)}   ← 「响」必须是 0，不为 0 说明开关没生效，整个对照作废`)
console.log(`  · 响       = 真把净改动摆到它面前了`)
console.log(`  · 闭嘴     = 闸门执行了，但本轮工作区没变、也没调写类工具，按设计不打扰`)
console.log(`  · 没执行到 = 流被上游打断（stopReason=error/aborted）或看门狗掐了，`)
console.log(`               早退走在闸门块前面。**这种样本没接受过治疗，不能拿来证明机制无效**`)
if (T.on.unknownGate) {
  console.log(`  ⚠️ 「分不出」= 2026-08-27 之前的数据，那时只打「触发」一种日志。别拿它下拆除结论。`)
}
if (T.on.fired === 0 && T.on.silent + T.on.skipped > 0) {
  console.log(`  ⚠️ 开臂一次都没响：先看是不是「没执行到」占多数——那是上游打断，不是机制无效。`)
}
for (const id of ID) {
  const logs = (arms.on[id] || []).filter(Boolean).map((x) => x.gateLog).filter(Boolean)
  if (logs.length) console.log(`    ${id.slice(0, 9)}  ${logs.join(' | ')}`)
}

console.log(`\n=== ③ 完成率（次要判据，n 太小别当结论） ===`)
console.log(`  闸门关 ${T.off.ok}/${nOff}    闸门开 ${T.on.ok}/${nOn}`)
// 按题配对的符号检验：每道题比「三遍里过了几次」，只有胜负不同的题带信息
let win = 0, lose = 0
for (const id of ID) {
  const a = cell(arms.off[id] || []).ok, b = cell(arms.on[id] || []).ok
  if (b > a) win++; else if (a > b) lose++
}
const d = win + lose
if (d) {
  const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r }
  let p = 0; for (let i = 0; i <= Math.min(win, lose); i++) p += C(d, i)
  console.log(`  按题配对：开闸更好 ${win} 道 / 关闸更好 ${lose} 道 / 打平 ${ID.length - d} 道 → 符号检验双尾 p = ${Math.min(1, 2 * p / 2 ** d).toFixed(3)}`)
} else {
  console.log(`  按题配对：没有一道题分出胜负`)
}

console.log(`\n=== ④ 副作用：闸门有没有把别的搞坏 ===`)
console.log(`  回归（打坏原本绿的）：      闸门关 ${T.off.reg} 条      闸门开 ${T.on.reg} 条`)
console.log(`  动过已有测试的运行次数：    闸门关 ${T.off.touched}/${nOff}      闸门开 ${T.on.touched}/${nOn}`)
console.log(`  删掉的断言行数：            闸门关 ${T.off.assertions}          闸门开 ${T.on.assertions}`)
if (T.on.assertions > T.off.assertions || T.on.touched > T.off.touched) {
  console.log('  ⚠️ 开闸把「改测试」推上去了——正是 Claude 3.7 系统卡警告的形态，别默认开')
}

console.log(`\n=== ⑤ 成本 ===`)
console.log(`  平均耗时（含补确认那一轮）：闸门关 ${T.off.min.toFixed(1)} 分钟      闸门开 ${T.on.min.toFixed(1)} 分钟  (${(T.on.min / Math.max(0.1, T.off.min)).toFixed(2)}x)`)
console.log(`  单次平均补丁行数：闸门关 ${T.off.lines.toFixed(0)}        闸门开 ${T.on.lines.toFixed(0)}`)
// 两轮都要数。只数第一轮的话，补确认那轮撞钟的全漏掉——而那一轮恰恰是按臂不对称触发的
const dl = (arm) => runsOf(arm).filter((x) => x.stop === 'hard_deadline').length
const dl2 = (arm) => runsOf(arm).filter((x) => x.stop2 === 'hard_deadline').length
console.log(`  撞墙钟被砍断：  闸门关 ${dl('off')}+${dl2('off')} 次      闸门开 ${dl('on')}+${dl2('on')} 次   (第一轮+补确认轮；两轮合计封顶 SHADOW_TASK_MS，gate_ab.sh 设 30 分钟)`)
