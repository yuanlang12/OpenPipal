#!/bin/bash
# 新语料绝对能力跑批：单臂 3 轮，问的是「这套东西能不能当日常主力」。
#
# ## 为什么不再跑 A/B
#
# 收工闸的 A/B 上一轮已经问完了，答案是**问不出来**：39 次有效样本里，闸门想防的那种
# 失败（模型宣布干完但工作区零改动）基础率只有 1/39 = 2.6%；配对 18 对格子里只有 3 对
# 不一致（开赢 2、关赢 1），p≈1.0。剔掉 4 道不可解的题重算之后更彻底——7 对配对格
# 开赢 1、关赢 1、打平 5。这个量级的样本回答不了那个问题，再跑一遍还是回答不了。
# 所以算力全部让给绝对能力。闸门代码和逃生舱口都留着，只是这次不当被测对象。
#
# ## 臂为什么设成关/关
#
# 和上一轮的 off 臂逐字可比（旧结果里核过 `goalOn=False`）。语料换了，臂再变的话
# 两个变量一起动，新旧数就对不上了。
#
# 2026-08-28 首跑之后：收工闸已按台账规则拆除，原来那行 `OPENPIPAL_COMPLETION_GATE=0`
# 随之删掉（没有代码再读它）。
#
# **首跑与今天不等价，别当成同一条臂的续跑。** 这里原先写着「首跑当时那行还在、值也是 0」，
# 是错的：翻首跑那 15 条记录，`gateOn` 全是 `true`——而闸门代码是 opt-out（`=== '0'` 才关），
# 所以首跑是**带着闸跑的**。今天闸已经不在代码里。
# 差多少不知道：首跑 15 条的 `gateLog` 全是空数组，闸到底响没响没有留下证据，
# 而机制已拆、补不回来了。A/B 那边量到闸对解决率没有可测影响，所以估计差别很小，
# 但那是估计，不是这批数据自己给的。跨这个日期比数时把这条摆出来。
#
# ## 读数时必须记住的两件事
#
# 1. **通过率会明显高于上一轮的 21%，但那不是模型变强**——上一轮 7 道里有 4 道判分绑死在
#    「猜中作者的命名 / 原样复述源码 / 撞中一个题面明说你自己拿捏的魔数」上，任何模型都做不出来
#    （判据见 `shadow_leakcheck.py` ③）。真正可比的是去污后的 50%~56%（n=16，独立题目只有 3 个）。
# 2. **`thinSuite=true` 的题，「不回归」这条判据形同虚设**——那些快照只有 70 条单测
#    （见 `shadow_prep.THIN_SUITE`）。别把「没测出回归」读成「没有回归」。
#
# ## 读数：没有配套报表，手工读
#
# `gate_report.js` 读的是 `gate-{off,on}-r*.jsonl`（配对两臂），和这里单臂的
# `cap-r*.jsonl` 不是一套，**不要指望它**。能力那几个数这么读：
#
#   cat $SHADOW_SCRATCH/cap-r*.jsonl | node -e 'let n=0,g=0,r=0;require("readline")
#     .createInterface({input:process.stdin}).on("line",l=>{const x=JSON.parse(l);
#     n++; if(x.gradable)g++; if(x.resolved)r++}).on("close",()=>
#     console.log(`共 ${n} 次，可判 ${g}，解决 ${r}`))'
#
# 首跑（2026-08-28，存档在 archive/cap-2026-08-28/）这么读出来是 **15 次、可判 15、解决 4**。
#
# **台账里那个 9/15 → 7/15 不在这几个字段里**，别拿上面这行去对。那是「模型有没有真做全集
# 回归对照」的行为计数，是逐条读 `reply` / `log_tail` 人工数出来的，没有对应的布尔字段。
# 想复核就得重读原文；想让它可复核，得先给这个行为定个可自动判的判据。
#
# 没做成报表是有意的：单臂绝对能力只有三四个数，做一个只跑一次的报表是过度建设。
# 真要看分项（thinSuite / 去污后），照上面那行加字段就行。
#
# 用法：tests/bench/cap_run.sh   （结果落在 $SHADOW_SCRATCH，默认 ~/openpipal-bench/shadow）
set -u
cd "$(dirname "$0")/../.." || exit 1

SCRATCH="${SHADOW_SCRATCH:-$HOME/openpipal-bench/shadow}"
LOG="$SCRATCH/cap-run.log"
# 墙钟 40 分钟，和 gate_ab.sh 同口径——理由见那个文件（卡着墙钟跑等于系统性截断主判据）
export SHADOW_TASK_MS="${SHADOW_TASK_MS:-2400000}"

# 上一批结果先挪走再跑。原来这里是 `rm -f`，那是**会把已发表的数据删掉**的写法：
# scratch 在 /tmp，看着像草稿目录，但台账和提示词注释都在引用这里跑出来的数字，
# 而这个脚本没有远端、没有备份，删了就真没了。挪走的代价是几百 KB。
ARCHIVE="$SCRATCH/archive/cap-$(date +%Y-%m-%d-%H%M%S)"
if ls "$SCRATCH"/cap-r*.jsonl >/dev/null 2>&1; then
  mkdir -p "$ARCHIVE"
  mv "$SCRATCH"/cap-r*.jsonl "$ARCHIVE"/
  [ -f "$LOG" ] && mv "$LOG" "$ARCHIVE"/
  echo "上一批结果已挪到 $ARCHIVE"
fi

: > "$LOG"

for r in 1 2 3; do
  out="$SCRATCH/cap-r$r.jsonl"
  echo "=== [$(date +%H:%M:%S)] 第 $r 轮开始 ===" | tee -a "$LOG"
  OPENPIPAL_CODING_LIVE=1 \
  SHADOW_RESULTS="$out" \
  SHADOW_ROUND="$r" \
    npx playwright test shadow-run --workers=3 --reporter=line >> "$LOG" 2>&1
  echo "--- [$(date +%H:%M:%S)] 第 $r 轮收工，落了 $(wc -l < "$out" 2>/dev/null || echo 0) 条" | tee -a "$LOG"
done

echo "=== [$(date +%H:%M:%S)] 全部跑完 ===" | tee -a "$LOG"
