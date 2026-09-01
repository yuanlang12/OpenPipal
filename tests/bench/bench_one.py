"""判一次 agent 跑完之后的成绩。用法：bench_one.py <iid> <workdir> [排除的P2P用@@分隔]

判据（比官方多一条扣除项，因为环境是 uv venv 不是官方镜像）：
  RESOLVED = F2P 全绿 且 P2P 里"baseline 本来就绿的那些"仍然全绿。
baseline 天生红的 P2P 先扣掉——两条臂扣的是同一批，差值不受影响。
"""
import json, os, re, subprocess, sys
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)

sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import swb
from grade import grade


def sh(cmd, cwd):
    return subprocess.run(["bash", "-lc", cmd], cwd=cwd, capture_output=True, text=True)


def apply_test_patch(work, tp):
    """把官方测试补丁打上去，**只重置它要动的那些测试文件**。

    这一步的分寸很要命。官方 harness 的做法是 `git checkout <base> -- <测试文件>` 再打补丁：
    以官方测试为准、但**不碰 agent 的源码修复**。

    我们第一版图省事写成了 `git apply` 失败就 `git checkout -q -- .` 整棵树还原再打——
    那等于把 agent 的修复一起扔了，F2P 必然全红。而这条路**恰好在 agent 动过测试文件时才触发**，
    也就是说：agent 越是老老实实先写测试再改代码，越容易被判负。判据和行为反相关，最坏的一种 bug。

    补丁新建的文件在 base 里不存在，`git checkout` 会报 pathspec 不匹配 —— 那种直接删掉重来。
    """
    targets = set()
    for a, b in re.findall(r"^diff --git a/(\S+) b/(\S+)", open(tp, encoding="utf-8").read(), re.M):
        targets.add(a)
        targets.add(b)
    for t in sorted(targets):
        if sh("git checkout HEAD -- %s" % json.dumps(t), work).returncode:
            sh("rm -rf %s" % json.dumps(t), work)   # base 里没有 = 补丁新建的文件
    return sh("git apply %s" % json.dumps(tp), work)


def main():
    iid, work = sys.argv[1], sys.argv[2]
    excl = set(sys.argv[3].split("@@")) if len(sys.argv) > 3 and sys.argv[3] else set()
    inst = [r for r in json.load(open(P("verified.json"))) if r["instance_id"] == iid][0]
    tp = P("work", iid + ".test_patch")
    # 先把 agent 改了什么记下来，再动树
    diff = sh("git diff --stat HEAD", work).stdout
    ap = apply_test_patch(work, tp)
    g = grade(inst, work)
    f2p_ok, f2p_n, f2p_bad = g["f2p"]
    p2p_bad = [t for t in g["p2p"][2] if t not in excl]
    # 「判不了」和「没做对」必须是两种结果。
    # parser 一条点名测试都没认出来时，F2P/P2P 会全部记成未过——形状和「模型啥也没做对」
    # 一模一样，却是 harness 坏了。不把这两件事分开，判分链路故障就会被当成模型能力写进报告。
    gradable = g["expected"] == 0 or g["seen"] > 0
    resolved = gradable and f2p_ok == f2p_n and not p2p_bad
    print(json.dumps({
        "iid": iid, "resolved": resolved, "gradable": gradable,
        "f2p": [f2p_ok, f2p_n], "p2p": [g["p2p"][0], g["p2p"][1]],
        "seen": g["seen"], "expected": g["expected"], "parsed": g["parsed"],
        "p2p_new_fail_n": len(p2p_bad), "p2p_new_fail": p2p_bad[:6],
        "diffstat": diff.strip()[-400:], "test_patch_conflict": ap.returncode != 0,
        "test_patch_err": (ap.stderr or "")[-200:] if ap.returncode else "",
        # 判负时留一段日志尾巴——没有它，事后连"为什么没过"都答不上来
        "log_tail": "" if resolved else g["log_tail"],
    }, ensure_ascii=False))
    if not gradable:
        # 退出码仍然是 0：这里抛异常会让 A 臂判分一崩、B 臂根本没机会跑，
        # 已经花掉的真模型调用直接作废。拦截交给上游的 expect.soft。
        print("WARN 点名的 %d 条测试一条都没解析到，本行不可用于计分" % g["expected"], file=sys.stderr)


main()
