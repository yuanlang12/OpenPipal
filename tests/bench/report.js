// 数据住 scratch（默认 ~/openpipal-bench/swebench），脚本住仓库。
// 别把默认改回 /tmp：那里开机会被 macOS 清空，2026-08-30 因此丢过三批结果和 A/B 原始记录。
const ROOT = process.env.BENCH_SCRATCH || require('os').homedir() + '/openpipal-bench/swebench'
/** 配对结果汇总。配对实验看的是**不一致的那些对**，不是两个总分。 */
const fs = require('fs')
const rows = fs.readFileSync(ROOT + '/ab-results.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
// 同一道题跑过多次时取最后一次
const last = new Map(); for (const r of rows) last.set(r.iid, r)
const all = [...last.values()]
const A = all.filter(r => r.a.resolved).length
const B = all.filter(r => r.b.resolved).length
const bothPass = all.filter(r => r.a.resolved && r.b.resolved).length
const bothFail = all.filter(r => !r.a.resolved && !r.b.resolved).length
const onlyA = all.filter(r => r.a.resolved && !r.b.resolved)
const onlyB = all.filter(r => !r.a.resolved && r.b.resolved)
const pct = n => (100 * n / all.length).toFixed(1) + '%'
console.log(`题数 ${all.length}（去重后）`)
console.log(`  A 臂 裸 pi CLI      解决 ${A}  ${pct(A)}`)
console.log(`  B 臂 走我们这层壳   解决 ${B}  ${pct(B)}`)
console.log(`\n配对表：都过 ${bothPass} | 都没过 ${bothFail} | 只有 A 过 ${onlyA.length} | 只有 B 过 ${onlyB.length}`)
const disc = onlyA.length + onlyB.length
console.log(`不一致对 ${disc} —— 这才是能读出差值的样本量`)
if (disc === 0) console.log('  （零不一致：这批题上两条臂表现完全一样，差值 = 0，但样本不足以说"没有差别"）')
if (onlyA.length) console.log('  只有 A 过:', onlyA.map(r => r.iid).join(' '))
if (onlyB.length) console.log('  只有 B 过:', onlyB.map(r => r.iid).join(' '))
const med = xs => { const s = [...xs].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)] / 1000) }
console.log(`\n耗时中位数  A ${med(all.map(r => r.a.ms))}s   B ${med(all.map(r => r.b.ms))}s`)
const stopA = {}, stopB = {}
for (const r of all) { stopA[r.a.stop] = (stopA[r.a.stop] || 0) + 1; stopB[r.b.stop] = (stopB[r.b.stop] || 0) + 1 }
console.log('收敛方式  A', JSON.stringify(stopA), ' B', JSON.stringify(stopB))
console.log(`B 臂弹出的权限卡总数: ${all.reduce((s, r) => s + (r.b.permissions || 0), 0)}`)
console.log('\n逐题:')
for (const r of all) console.log(`  ${r.a.resolved ? '✅' : '❌'}A ${r.b.resolved ? '✅' : '❌'}B  ${r.iid.padEnd(28)} ${r.difficulty}`)
