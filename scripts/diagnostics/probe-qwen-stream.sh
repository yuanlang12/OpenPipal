#!/bin/bash
# Probe qwen3.7-max SSE chunk timing.
# 从 ~/.openpipal/config.json 读取 baseUrl / apiKey / model,记录每个 chunk 的到达时间和大小,
# 用来判断"流式不丝滑"是上游 chunk 粒度问题还是下游问题。
#
# 用法:
#   bash scripts/diagnostics/probe-qwen-stream.sh
#   bash scripts/diagnostics/probe-qwen-stream.sh "自定义 prompt"
#   PRESET_NAME="qwen3.6-plus" bash scripts/diagnostics/probe-qwen-stream.sh  # 对照其他模型

set -euo pipefail

CONFIG="${HOME}/.openpipal/config.json"
PROMPT="${1:-请用 300 字介绍一下杭州西湖,包括历史、景点和文化意义。要详细一些。}"

# 默认用 activePreset,或用环境变量指定 preset 名字做对照实验
read BASE_URL API_KEY MODEL <<EOF
$(PRESET_NAME="${PRESET_NAME:-}" python3 - <<'PY'
import json, os
cfg = json.load(open(os.path.expanduser('~/.openpipal/config.json')))
name = os.environ.get('PRESET_NAME', '')
active = cfg.get('activePresetId')
preset = None
if name:
    for p in cfg.get('modelPresets', []):
        if p.get('name') == name:
            preset = p; break
    if not preset:
        raise SystemExit(f'preset not found: {name}')
elif active:
    for p in cfg.get('modelPresets', []):
        if p.get('id') == active:
            preset = p; break
if not preset:
    raise SystemExit('no active preset')
c = preset['config']
print(c['baseUrl'], c['apiKey'], c['model'])
PY
)
EOF

THINKING_FLAG=$(PRESET_NAME="${PRESET_NAME:-}" python3 - <<'PY'
import json, os
cfg = json.load(open(os.path.expanduser('~/.openpipal/config.json')))
name = os.environ.get('PRESET_NAME', '')
active = cfg.get('activePresetId')
preset = None
if name:
    for p in cfg.get('modelPresets', []):
        if p.get('name') == name: preset = p; break
elif active:
    for p in cfg.get('modelPresets', []):
        if p.get('id') == active: preset = p; break
print('true' if preset['config'].get('supportsThinking') else 'false')
PY
)

echo "=== Probing $MODEL @ $BASE_URL  (thinking=$THINKING_FLAG) ==="
echo "Prompt: $PROMPT"
echo

# 关掉 thinking,只测 content 流式粒度(thinking 数据量大会干扰判断)
PAYLOAD=$(python3 -c "
import json,sys
p = json.dumps({
    'model': '$MODEL',
    'stream': True,
    'enable_thinking': False,
    'messages': [{'role':'user','content':'''$PROMPT'''}]
}, ensure_ascii=False)
print(p)
")

curl -sN -X POST "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" 2>&1 | python3 -c "
import sys, time, json

start = time.time()
last_t = start
idx = 0
total = ''
gaps = []
sizes = []
first_byte_ms = None

for line in sys.stdin:
    line = line.rstrip('\n')
    if not line.startswith('data: '): continue
    body = line[6:]
    if body.strip() == '[DONE]': break
    try:
        d = json.loads(body)
        delta = d.get('choices', [{}])[0].get('delta', {})
        chunk = delta.get('content') or delta.get('reasoning_content') or ''
        if not chunk: continue
    except Exception: continue

    now = time.time()
    if first_byte_ms is None: first_byte_ms = (now - start) * 1000
    t_ms = (now - start) * 1000
    gap_ms = (now - last_t) * 1000
    last_t = now
    idx += 1
    total += chunk
    gaps.append(gap_ms)
    sizes.append(len(chunk))
    flag = ''
    if len(chunk) > 20: flag += ' [BIG]'
    if gap_ms > 200: flag += ' [SLOW]'
    print(f't={t_ms:7.1f}ms  gap={gap_ms:6.1f}ms  size={len(chunk):3d}  preview={chunk[:25]!r}{flag}')

print()
print('=== SUMMARY ===')
print(f'First byte:    {first_byte_ms:.0f}ms' if first_byte_ms else 'no data')
print(f'Total chunks:  {idx}')
print(f'Total chars:   {len(total)}')
if sizes:
    print(f'Chunk size:    min={min(sizes)}  max={max(sizes)}  avg={sum(sizes)/len(sizes):.1f}')
if gaps:
    g = sorted(gaps)
    print(f'Gap ms:        min={min(gaps):.1f}  max={max(gaps):.1f}  avg={sum(gaps)/len(gaps):.1f}  median={g[len(g)//2]:.1f}  p90={g[int(len(g)*0.9)]:.1f}')
    big_chunks = sum(1 for s in sizes if s > 20)
    slow_gaps = sum(1 for x in gaps if x > 200)
    print(f'Chunks >20ch:  {big_chunks}/{len(sizes)} ({100*big_chunks/len(sizes):.0f}%)  <- 高比例说明上游 chunk 粒度粗')
    print(f'Gaps >200ms:   {slow_gaps}/{len(gaps)} ({100*slow_gaps/len(gaps):.0f}%)  <- 高比例说明上游卡顿/buffer')
print()
print('=== JUDGEMENT ===')
if sizes and gaps:
    avg_size = sum(sizes)/len(sizes)
    avg_gap = sum(gaps)/len(gaps)
    chars_per_sec = len(total) / (sum(gaps)/1000) if sum(gaps) > 0 else 0
    print(f'Effective speed: {chars_per_sec:.0f} chars/sec')
    if avg_size > 15:
        print('  ⚠️  Chunk 平均 >15 字 -> 上游粒度太粗,UI 会出现 \"跳字\" 感')
    elif avg_size > 5:
        print('  ⚠️  Chunk 平均 5-15 字 -> 中等粒度,够用但不极致流畅')
    else:
        print('  ✅ Chunk 平均 <5 字 -> 上游粒度细腻,问题不在上游')
    if avg_gap > 100:
        print('  ⚠️  Gap 平均 >100ms -> 上游推送间隔大,会出现停顿感')
    elif avg_gap > 40:
        print('  ⚠️  Gap 平均 40-100ms -> 间隔中等,基本接受')
    else:
        print('  ✅ Gap 平均 <40ms -> 上游推送均匀流畅')
"
