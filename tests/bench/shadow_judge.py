"""影子运行判分。用法：shadow_judge.py <commit> <workdir>

三条判据，缺一不可（比 SWE-bench 多了最后一条）：

  1. **F2P 全绿** —— 这次提交新加/改的测试必须由红转绿。测试补丁在 agent 干完之后才打。
  2. **整套单测不回归** —— 2000+ 条全跑，baseline 本来就红的逐题扣除。
     不是只跑被改文件那几条：40 道 SWE-bench 里最大的短板就是「改了生产者不改消费者」，
     而那种缺陷只有全量回归才照得出来。
  3. **双 tsc 不新增类型错** —— `tsconfig.node.json` 与 `tsconfig.web.json`，
     相对 baseline 一条新错都不许有。这条是 SWE-bench 结构上给不了的：它全是 Python，
     没有类型系统。而「改一个函数签名、忘了改三个调用点」正是类型检查一抓一个准的东西。
     这个项目的红线原话是「build ≠ 类型检查，改签名必跑双 tsc」。
     **扣 baseline 而不是要求绝对干净**：工作目录的依赖是 HEAD 那份、源码是历史那份，
     老提交上 baseline 自己就红，绝对判据会让那些题恒判负（见 `shadow_prep.tsc`）。
     和单测同一套规矩——agent 和标准答案扣的是同一批。

判分前先把 agent 到底改了什么原样存下来（含**未跟踪文件**）——
`git diff` 看不见 agent 写的自查脚本，而一个落在仓库根的坏 `conftest.py`/`vitest.config`
就能让整套测试塌掉。没有这份记录，事后分不清「模型做错了」和「评测台坏了」。
"""
import json, os, re, subprocess, sys
import os as _os

BENCH_ROOT = _os.getenv("SHADOW_SCRATCH") or _os.path.expanduser("~/openpipal-bench/shadow")


def P(*parts):
    return _os.path.join(BENCH_ROOT, *parts)


sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from shadow_prep import run_unit, failing, tsc, tsc_new, sh, confirm_regress


def apply_test_patch(work, tp):
    """打官方测试补丁，**只重置它要动的那些测试文件**，不碰 agent 的源码修复。

    整棵树 `git checkout -- .` 是错的：那会把 agent 的修复一起扔掉，判据恒为假。
    而且那条路恰好在 agent 动过测试文件时才触发——agent 越是老实先写测试再改代码
    越容易被判负，判据和好行为反相关。（这一课在 SWE-bench 那边踩过。）
    """
    targets = set()
    for a, b in re.findall(r"^diff --git a/(\S+) b/(\S+)", open(tp, encoding="utf-8").read(), re.M):
        targets.update((a, b))
    for t in sorted(targets):
        if sh("git checkout HEAD -- %s" % json.dumps(t), work).returncode:
            sh("rm -rf %s" % json.dumps(t), work)   # base 里没有 = 补丁新建的文件
    return sh("git apply %s" % json.dumps(tp), work)


def main():
    commit, work = sys.argv[1], sys.argv[2]
    rec = [json.loads(l) for l in open(P("prepared.jsonl")) if l.strip()]
    rec = [r for r in rec if r["commit"] == commit][0]

    # 先留证据，再动树
    patch = sh("git diff HEAD", work).stdout[:200_000]
    untracked = [f for f in sh(
        "git ls-files --others --exclude-standard -- . ':(exclude)node_modules'", work
    ).stdout.strip().split("\n") if f]

    ap = apply_test_patch(work, P(commit + ".test.patch"))
    res, log = run_unit(work)
    bad = set(rec["baseline_bad"])
    f2p = set(rec["f2p"])

    f2p_pass = sorted(t for t in f2p if res.get(t) is True)
    f2p_fail = sorted(f2p - set(f2p_pass))
    # 抖动会把模型真做对的一次判成「打坏了别处」——新红的那几条重跑一遍再定罪
    # （理由与实测见 shadow_prep.confirm_regress）
    regress = confirm_regress(work, failing(res) - bad - f2p)
    ty = tsc(work)
    # 老题库没记 baseline_tsc → 空集 → 退化成绝对判据，和改动前逐字等价
    ty_new = tsc_new(ty, rec.get("baseline_tsc") or {})

    # 「判不了」和「没做对」必须分开：一条点名测试都没解析到 = harness 坏了，不是模型错了
    seen = sum(1 for t in f2p if t in res)
    gradable = bool(res) and seen > 0 and ap.returncode == 0

    resolved = gradable and not f2p_fail and not regress and not ty_new

    print(json.dumps({
        "commit": commit, "resolved": resolved, "gradable": gradable,
        "f2p": [len(f2p_pass), len(f2p)], "f2p_fail": f2p_fail[:6],
        "regress_n": len(regress), "regress": regress[:6],
        # `tsc` 保持「这一投有没有新增类型错」的布尔口径——下游报表按它读，别改契约
        "tsc": {k: k not in ty_new for k in ty},
        "tsc_new": ty_new,
        "tsc_tail": {k: v["tail"] for k, v in ty.items() if k in ty_new},
        "total_tests": len(res), "seen": seen, "test_patch_conflict": ap.returncode != 0,
        "patch": patch, "untracked": untracked,
        "log_tail": "" if resolved else log[-1500:],
    }, ensure_ascii=False))


main()
