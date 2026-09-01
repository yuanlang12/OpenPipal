"""并行准备。瓶颈是 uv pip install（网络+磁盘），不是推理 —— 用线程池就够，不需要开 agent。"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from prep import prepare

OUT = P("prepared.jsonl")

def done_ids():
    if not os.path.exists(OUT): return set()
    return {json.loads(l)["iid"] for l in open(OUT) if l.strip()}

def main(items, jobs):
    have = done_ids()
    todo = [x for x in items if x["iid"] not in have]
    print(f"待办 {len(todo)}（已完成 {len(have)}），并发 {jobs}", flush=True)
    t0 = time.time(); n = 0
    with ThreadPoolExecutor(jobs) as ex, open(OUT, "a") as f:
        futs = {ex.submit(_one, x): x for x in todo}
        for fu in as_completed(futs):
            r = fu.result(); n += 1
            f.write(json.dumps(r, ensure_ascii=False) + "\n"); f.flush()
            flag = "ok" if r.get("ok") else "×"
            print(f"[{n}/{len(todo)}] {flag} {r['iid']} {r.get('why','')[:90]}", flush=True)
    print(f"用时 {round(time.time()-t0,1)}s", flush=True)

def _one(x):
    try:
        r = prepare(x["iid"], x["py"])
        r["repo"] = x["repo"]; r["difficulty"] = x["difficulty"]
        # baseline 必须是「F2P 全红」——否则这题不需要改代码就已经过了，量不到东西
        if r.get("ok") and r["f2p"][0] != 0:
            r["ok"] = False; r["why"] = f"baseline 下 F2P 已经绿了 {r['f2p']}，这题验不到东西"
        return r
    except Exception as e:
        return {"iid": x["iid"], "repo": x["repo"], "ok": False, "why": f"{type(e).__name__}: {e}"}

if __name__ == "__main__":
    items = json.load(open(P("corpus.json")))
    lim = int(sys.argv[1]) if len(sys.argv) > 1 else len(items)
    jobs = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    main(items[:lim], jobs)
