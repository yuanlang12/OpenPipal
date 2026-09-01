"""重建 baseline —— 不重建 venv，只把每道题的 baseline 判分重跑一遍。

什么时候要跑：判分链路改过（parser、环境、扣除规则），或者怀疑 `prepared.jsonl` 里的
`p2p_bad`（baseline 天生红的 P2P 排除集）不可信。

2026-08-26 就撞上一次：老版本把 `p2p_bad` 截断到 4 条，22 道题对不上
（`xarray-3305` 实际坏 62 条只记了 4 条），另有 11 道 baseline `parsed=0`——
测试根本没跑起来却照样进了题库。截断的方向是让判分**更严**，会造成两条臂同时假阴性。

**故意带着 `FORCE_COLOR=1` 跑。** 那正是 Playwright worker 塞给判分子进程的环境，
也正是当初让 parser 一条都认不出来、把 40 道废掉 16 道的那个变量。既然 grade.py 已经
把颜色钉死了，baseline 就该在这种最恶劣的环境里重建——这样万一哪天防线又漏了，
在这一步就当场暴露，而不是等花完模型的钱才发现。
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)

sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from grade import grade

OUT = P("prepared.jsonl")
INST = {}


def sh(cmd, cwd):
    return subprocess.run(["bash", "-lc", cmd], cwd=cwd, capture_output=True, text=True)


def one(rec):
    iid = rec["iid"]
    work = P("work", iid)
    keep = {k: rec.get(k) for k in ("iid", "repo", "difficulty", "py", "env_s")}
    try:
        sh("git checkout -q -- . ; git clean -qfd -e .venv", work)
        c = sh("git apply %s" % P("work", iid + ".test_patch"), work)
        if c.returncode:
            return dict(keep, ok=False, why="test_patch 打不上: " + (c.stderr or "")[-200:])
        t0 = time.time()
        g = grade(INST[iid], work)
        out = dict(keep, ok=True, grade_s=round(time.time() - t0, 1),
                   f2p=g["f2p"][:2], p2p=g["p2p"][:2], p2p_bad=g["p2p"][2], parsed=g["parsed"])
        # 两条淘汰规则，缺一不可
        if g["parsed"] == 0:
            # baseline 根本没跑起来。这种题的 p2p_bad 是垃圾，进了题库会一路污染下去。
            out["ok"] = False
            out["why"] = "baseline parsed=0，测试没跑起来"
        elif g["f2p"][0] != 0:
            # 不改代码就已经过了，这题量不到东西
            out["ok"] = False
            out["why"] = "baseline 下 F2P 已经绿了 %s" % (g["f2p"][:2],)
        return out
    except Exception as e:
        return dict(keep, ok=False, why="%s: %s" % (type(e).__name__, e))
    finally:
        sh("git checkout -q -- . ; git clean -qfd -e .venv", work)


if __name__ == "__main__":
    jobs = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    INST = {r["instance_id"]: r for r in json.load(open(P("verified.json")))}
    recs = [json.loads(l) for l in open(OUT) if l.strip()]
    todo = [r for r in recs if r.get("ok")]
    print("重建 %d 道的 baseline，并发 %d（带 FORCE_COLOR=1 跑，验证判分环境真的密封）"
          % (len(todo), jobs), flush=True)
    _os.environ["FORCE_COLOR"] = "1"
    t0 = time.time()
    with ThreadPoolExecutor(jobs) as ex:
        res = list(ex.map(one, todo))
    # 没进 todo 的（本来就 ok=false）原样留着
    keepers = {r["iid"] for r in todo}
    merged = [r for r in recs if r["iid"] not in keepers] + res
    with open(OUT, "w") as f:
        for r in merged:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    okn = sum(1 for r in res if r["ok"])
    print("\n用时 %ds —— %d/%d 仍然可用" % (round(time.time() - t0), okn, len(res)), flush=True)
    for r in res:
        if not r["ok"]:
            print("  剔除 %s：%s" % (r["iid"], r.get("why", "")[:90]), flush=True)
    # 和旧数据对比：排除集变了多少
    old = {r["iid"]: r for r in recs}
    changed = [r for r in res if r["ok"] and len(r["p2p_bad"]) != len(old[r["iid"]].get("p2p_bad") or [])]
    print("\n排除集条数变了的 %d 道：" % len(changed), flush=True)
    for r in changed[:20]:
        print("  %-32s %d -> %d" % (r["iid"], len(old[r["iid"]].get("p2p_bad") or []), len(r["p2p_bad"])),
              flush=True)
