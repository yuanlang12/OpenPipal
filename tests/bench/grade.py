"""判分：打上 test_patch，跑 test_cmd + directives，按 SWE-bench 原样比对 F2P/P2P。

**判分子进程的环境必须是密封的，不能原样继承调用方。** 2026-08-26 被这条坑掉整整
40% 的样本：Playwright 的 workerHost 给每个 worker 硬塞 `FORCE_COLOR=1`
（node_modules/playwright/lib/runner/workerHost.js），execFileSync 一路继承到这里，
pytest>=7 认这个变量，于是 `-rA` 短摘要的每一行都以 ANSI 转义序列开头；
而官方 parser 判的是 `line.startswith("PASSED")` —— 一条都认不出来，parsed=0。
后果最恶劣的地方在于**它不报错**：所有测试静静地记成未过，两条臂拿到一模一样的
判负结果，看起来就像"模型没做出来"。手跑复现不了，因为普通 shell 里没有这个变量。

所以这里做两层：把颜色钉死关掉（`PY_COLORS=0` 在 pytest 的 should_do_markup 里优先级最高），
再在解析前无条件剥一遍 ANSI —— 万一哪个仓库的测试脚本自己上色，还有第二道网兜着。
"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, os, re, subprocess, sys
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import swb

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

def grade(inst, work, verbose=False):
    sp = swb.spec(inst)
    cmd = sp["test_cmd"] + " " + " ".join(swb.test_directives(inst))
    if cmd.startswith("./tests/runtests.py"):
        cmd = "python " + cmd
    env = dict(os.environ, PATH=os.path.join(work, ".venv", "bin") + ":" + os.environ["PATH"],
               VIRTUAL_ENV=os.path.join(work, ".venv"), LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8",
               SETUPTOOLS_SCM_PRETEND_VERSION=str(inst.get("version", "0")) + ".0",
               PY_COLORS="0", NO_COLOR="1")
    # 调用方可能带着这些进来（Playwright worker 就带 FORCE_COLOR），显式摘掉
    for k in ("FORCE_COLOR", "CLICOLOR_FORCE", "DEBUG_COLORS"):
        env.pop(k, None)
    p = subprocess.run(["bash", "-lc", cmd], cwd=work, env=env, capture_output=True, text=True, timeout=1800)
    log = ANSI.sub("", p.stdout + p.stderr)
    if verbose: print(log[-3000:])
    status = swb.parsers()[inst["repo"]](log, None)
    f2p = json.loads(inst["FAIL_TO_PASS"]) if isinstance(inst["FAIL_TO_PASS"], str) else inst["FAIL_TO_PASS"]
    p2p = json.loads(inst["PASS_TO_PASS"]) if isinstance(inst["PASS_TO_PASS"], str) else inst["PASS_TO_PASS"]
    def tally(ids):
        ok = [t for t in ids if status.get(t) == "PASSED"]
        return len(ok), len(ids), [t for t in ids if status.get(t) != "PASSED"]
    # `seen` = 我们**点名要的**那些测试里，parser 真给出了状态的条数。
    # 判「这次判分到底作不作数」要用它，不能用 parsed：pytest 自己的测试套件会在
    # 子进程里再跑一层 pytest，那层的输出照样被解析进来，parsed 于是不为零
    # （实测 pytest-10051 在坏环境下 parsed=5），可点名的那些一条都没命中。
    want = set(f2p) | set(p2p)
    seen = sum(1 for t in want if t in status)
    return {"f2p": tally(f2p), "p2p": tally(p2p), "parsed": len(status),
            "seen": seen, "expected": len(want), "log_tail": log[-800:]}

if __name__ == "__main__":
    iid, work = sys.argv[1], sys.argv[2]
    inst = [r for r in json.load(open(P("verified.json"))) if r["instance_id"] == iid][0]
    r = grade(inst, work)
    print(f"解析出 {r['parsed']} 条测试结果")
    print(f"F2P {r['f2p'][0]}/{r['f2p'][1]}  未过样例: {r['f2p'][2]}")
    print(f"P2P {r['p2p'][0]}/{r['p2p'][1]}  未过样例: {r['p2p'][2]}")
