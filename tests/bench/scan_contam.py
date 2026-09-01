"""量污染半径：对已跑过的 40 道题，逐个打上官方标准答案，在 FORCE_COLOR=1（对照实验里
Playwright worker 强塞的环境）下判分。判不过 = 那道题在对照实验里本就不可能判过，结果作废。
零模型调用。"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROWS = json.load(open(P("verified.json")))
AB = [json.loads(l) for l in open(P("ab-results.jsonl")) if l.strip()]
PREP = {r["iid"]: r for r in (json.loads(l) for l in open(P("prepared.jsonl")) if l.strip())}
PY = P(".tools/bin/python")
OUT = P("contam.jsonl")


def restore(work):
    subprocess.run(["bash", "-lc", "git checkout -q -- . ; git clean -qfd -e .venv"], cwd=work,
                   capture_output=True)


def one(iid):
    work = P("work", iid)
    inst = [x for x in ROWS if x["instance_id"] == iid][0]
    gold = P("work", iid + ".gold_scan.patch")
    open(gold, "w").write(inst["patch"] + "\n")
    excl = "@@".join(PREP.get(iid, {}).get("p2p_bad", []))
    try:
        restore(work)
        subprocess.run(["bash", "-lc", f"git apply {gold}"], cwd=work, capture_output=True)
        env = dict(os.environ, FORCE_COLOR="1")   # 复现 Playwright worker 的环境
        p = subprocess.run([PY, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "bench_one.py"), iid, work, excl],
                           capture_output=True, text=True, env=env, timeout=2400)
        r = json.loads(p.stdout.strip().split("\n")[-1])
    except Exception as e:
        r = {"iid": iid, "resolved": False, "parsed": -1, "error": str(e)[:200]}
    finally:
        restore(work)
        if os.path.exists(gold):
            os.remove(gold)
    rec = {"iid": iid, "gradable_under_forcecolor": bool(r.get("resolved")),
           "parsed": r.get("parsed"), "f2p": r.get("f2p")}
    with open(OUT, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(("OK  " if rec["gradable_under_forcecolor"] else "污染"), iid, "parsed=" + str(rec["parsed"]),
          flush=True)
    return rec


done = set()
if os.path.exists(OUT):
    done = {json.loads(l)["iid"] for l in open(OUT) if l.strip()}
todo = [r["iid"] for r in AB if r["iid"] not in done]
print(f"待扫 {len(todo)} 道（已完成 {len(done)}）", flush=True)
with ThreadPoolExecutor(3) as ex:
    list(ex.map(one, todo))
res = [json.loads(l) for l in open(OUT) if l.strip()]
bad = [r for r in res if not r["gradable_under_forcecolor"]]
print(f"\n==== 共 {len(res)} 道，其中 {len(bad)} 道在对照实验里根本判不了 ====", flush=True)
for r in bad:
    print("  ", r["iid"], "parsed=" + str(r["parsed"]), flush=True)
