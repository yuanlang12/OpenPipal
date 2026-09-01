#!/bin/bash
# ⚠️ 被测机制已于 2026-08-28 拆除，这个脚本**现在跑不出任何东西**：
#    `OPENPIPAL_COMPLETION_GATE` 这个环境变量已经没有代码读它，两条臂完全相同。
#    留着是当**配对 A/B 的模板**——下一个要证伪的机制照抄这套编排（交错跑、每格独立 jsonl、
#    随时可停且配平）。拆除的数据与理由见 docs/claude/mechanism-registry.md「已拆除」一节。
#
# 收工闸配对对照：同一批影子题，闸门开/关各跑 3 遍。
#
# 为什么要跑 3 遍：上一轮 goal 对照已经证明**单跑不可信**——同一条臂两次跑出 2/7 和 0/7。
# n=7 的单次结果基本就是噪声，看不出机制有没有用。
#
# 为什么按轮次交错（off-r1 → on-r1 → off-r2 → …）而不是跑完一条臂再跑另一条：
# 全程好几个小时，模型服务端的排队/降级会漂。整段跑完一条臂，漂移就整段落在那条臂上，
# 变成假信号。交错让两条臂共享同一段时间窗。
#
# 两条臂唯一的差别是 OPENPIPAL_COMPLETION_GATE。提示词那两句（通用解 / 不许改已有测试期望）
# **两条臂都有**——它们是新基线的一部分，本次实验分不出它们的贡献，别把结论安到它们头上。
#
# 用法：tests/bench/gate_ab.sh   （结果落在 $SHADOW_SCRATCH，默认 ~/openpipal-bench/shadow）
set -u
cd "$(dirname "$0")/../.." || exit 1

# 光在文件头写"这个跑不出东西"不够——真跑起来是 6 条臂 × 约 2.2 小时 ≈ 13 小时，
# 烧出两条一模一样的数据。所以直接拦住，想当模板就读源码。
if [ "${GATE_AB_I_KNOW_IT_IS_DEAD:-}" != "1" ]; then
  echo "被测机制（收工闸）已于 2026-08-28 拆除，OPENPIPAL_COMPLETION_GATE 没有代码再读它。" >&2
  echo "照跑只会得到两条完全相同的臂，白烧约 13 小时。" >&2
  echo "拆除的数据与理由：docs/claude/mechanism-registry.md「已拆除」一节。" >&2
  echo "确实要拿它当下一个机制的编排模板：改掉 run_one 里的分流变量，或设 GATE_AB_I_KNOW_IT_IS_DEAD=1。" >&2
  exit 1
fi

SCRATCH="${SHADOW_SCRATCH:-$HOME/openpipal-bench/shadow}"
LOG="$SCRATCH/gate-ab.log"
# 墙钟给 40 分钟，不是影子运行默认的 20。
#
# 为什么一路往上加：收工闸**只在模型自己停手时才响**，被墙钟砍断的那次闸门根本没执行到
# （`pi-core-runtime.ts` 里 `stopReason==='error'`/断流的早退走在闸门块前面）。
# 卡着墙钟跑，等于把主判据系统性截断，实验白做——报告 ② 段那个「没执行到」的计数就是量这个的。
#
# 20 → 30：冒烟跑实测同一道题上一轮 3.3 分钟收工，那一轮做到 20 分整被砍断，它还在补单测。
# 30 → 40：2026-08-27 换模型之后重测，`8b85caba9` 干满 15 分钟墙钟还在跑（53 次工具调用、
#          写了 62 行、正在跑全量单测对基线）。上一个模型这道题 2~3.5 分钟就停手。
#          新模型更能干活，30 分钟大概率还是不够。
#
# 代价是整轮变长：7 道题 / 3 worker = 3 波，最坏一条臂 ~2.2 小时，6 条臂 ~13 小时。
# 两条臂是交错跑的（off-r1 → on-r1 → off-r2 …），所以**中途任何时候停都是配平的**，
# 报告直接读现有 jsonl 出结果，不用等全跑完。
export SHADOW_TASK_MS="${SHADOW_TASK_MS:-2400000}"

: > "$LOG"

run_one() {
  local arm="$1" round="$2" gate="$3"
  local out="$SCRATCH/gate-$arm-r$round.jsonl"
  rm -f "$out"
  echo "=== [$(date +%H:%M:%S)] 第 $round 轮 · 闸门$arm ===" | tee -a "$LOG"
  OPENPIPAL_CODING_LIVE=1 \
  OPENPIPAL_COMPLETION_GATE="$gate" \
  SHADOW_RESULTS="$out" \
  SHADOW_ROUND="$round" \
    npx playwright test shadow-run --workers=3 --reporter=line >> "$LOG" 2>&1
  echo "--- [$(date +%H:%M:%S)] 第 $round 轮 · 闸门$arm 收工，落了 $(wc -l < "$out" 2>/dev/null || echo 0) 条" | tee -a "$LOG"
}

for r in 1 2 3; do
  run_one off "$r" 0
  run_one on  "$r" 1
done

echo "=== [$(date +%H:%M:%S)] 全部跑完 ===" | tee -a "$LOG"
echo "报告：node tests/bench/gate_report.js"
