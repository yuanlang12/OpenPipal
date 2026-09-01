"""闸门：一道题只有在**标准答案能判成解决**时才准进对照实验的题库。

为什么必须有这道闸：环境不是官方 Docker 镜像，是就地建的 venv。环境哪怕差一点
（依赖版本、Python 小版本、测试指令），这道题上两条臂都只能是 ❌ —— 花了钱、
判据却恒为假，而且**不会报错**。用标准答案当探针，不花模型的钱就能把这些题挑出来。

就地跑，不复制：venv 里的可编辑安装把模板绝对路径写死了（`__editable___*_finder.py`），
复制出去之后 `import <pkg>` 仍然解析回模板 —— agent 改副本永远不生效，两条臂还会
通过模板互相串味（实测 3 个模板被写脏）。
"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor, as_completed

def sh(cmd, cwd, timeout=2400):
    return subprocess.run(["bash", "-lc", cmd], cwd=cwd, capture_output=True, text=True, timeout=timeout)

def restore(work):
    sh("git checkout -q -- . ; git clean -qfd -e .venv", work)

def one(rec):
    iid = rec["iid"]
    work = P("work", iid)
    gp = P("work", iid + ".gold")
    try:
        inst = INST[iid]
        open(gp, "w").write(inst["patch"])
        restore(work)
        ap = sh(f"git apply {gp}", work)
        if ap.returncode:
            return {"iid": iid, "gold_ok": False, "why": "标准答案打不上: " + (ap.stderr or "")[-160:]}
        # **故意跑在最恶劣的环境里。** 闸门当初全绿、实跑全灭，唯一的差别就是实跑是从
        # Playwright worker 里起的、环境里带着 FORCE_COLOR=1（pytest>=7 因此给 -rA 摘要上色，
        # 官方 parser 一条都认不出来，所有测试静默判负）。闸门要是继续跑在干净 shell 里，
        # 它就永远发现不了这类环境漂移——那正是它该拦下的东西。
        out = subprocess.run([P(".tools/bin/python"), _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "bench_one.py"), iid, work,
                              "@@".join(rec.get("p2p_bad") or [])], capture_output=True, text=True, timeout=2400,
                             env=dict(_os.environ, FORCE_COLOR="1", CLICOLOR_FORCE="1"))
        if out.returncode:
            return {"iid": iid, "gold_ok": False, "why": "判分崩了: " + (out.stderr or "")[-160:]}
        r = json.loads(out.stdout.strip().split("\n")[-1])
        return {"iid": iid, "gold_ok": r["resolved"], "f2p": r["f2p"], "p2p": r["p2p"],
                "parsed": r.get("parsed"), "p2p_new_fail_n": r.get("p2p_new_fail_n"),
                "p2p_new_fail": r["p2p_new_fail"][:3]}
    except Exception as e:
        return {"iid": iid, "gold_ok": False, "why": f"{type(e).__name__}: {e}"}
    finally:
        restore(work)

INST = {}
if __name__ == "__main__":
    INST = {r["instance_id"]: r for r in json.load(open(P("verified.json")))}
    recs = [json.loads(l) for l in open(P("prepared.jsonl")) if l.strip()]
    recs = [r for r in recs if r.get("ok")]
    jobs = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    out = open(P("gold.jsonl"), "w")
    ok = 0
    with ThreadPoolExecutor(jobs) as ex:
        futs = [ex.submit(one, r) for r in recs]
        for i, f in enumerate(as_completed(futs), 1):
            r = f.result(); ok += bool(r["gold_ok"])
            out.write(json.dumps(r, ensure_ascii=False) + "\n"); out.flush()
            print(f"[{i}/{len(recs)}] {'✅' if r['gold_ok'] else '❌'} {r['iid']} {r.get('why','')[:70]}", flush=True)
    print(f"\n通过闸门 {ok}/{len(recs)}")
