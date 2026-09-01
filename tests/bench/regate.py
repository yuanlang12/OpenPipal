import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, sys
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import gold_gate as G
from concurrent.futures import ThreadPoolExecutor, as_completed
G.INST = {r["instance_id"]: r for r in json.load(open(P("verified.json")))}
prep = {json.loads(l)["iid"]: json.loads(l) for l in open(P("prepared.jsonl")) if l.strip()}
ids = sys.argv[1].split(",")
res = []
with ThreadPoolExecutor(5) as ex:
    futs = [ex.submit(G.one, prep[i]) for i in ids if i in prep]
    for f in as_completed(futs):
        r = f.result(); res.append(r)
        print(("✅" if r["gold_ok"] else "❌") + " " + json.dumps(r, ensure_ascii=False), flush=True)
# 把这批的结论合并回 gold.jsonl（同 iid 以新的为准）
old = [json.loads(l) for l in open(P("gold.jsonl")) if l.strip()]
new = {r["iid"]: r for r in old}
for r in res: new[r["iid"]] = r
with open(P("gold.jsonl"), "w") as f:
    for r in new.values(): f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"\n合并后题库 {sum(1 for r in new.values() if r['gold_ok'])}/{len(new)}")
