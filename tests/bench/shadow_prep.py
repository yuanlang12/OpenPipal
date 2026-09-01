"""影子运行：拿 openpipal 自己的真实提交当题目。

# 为什么要有这套（SWE-bench 答不了的那部分）

SWE-bench 每道题都是：单个 Python 仓库、单个 bug、有现成测试判对错、环境已建好、
需求无歧义。跑完 40 道我们知道了「干净的 Python bug 修复它 75% 能一次做对」，
但下面这些**一次都没测**，而它们恰好是这个项目的日常：

  - 一行 TypeScript 都没测（这里有双 tsconfig、主/渲染进程边界、preload IPC）
  - 类型检查完全没进判据（`build ≠ 类型检查` 是这个项目的红线）
  - 「改完有没有打坏别的地方」只在被改文件的范围内验过

所以这套的判据是三条，缺一不可：
  1. **F2P**：这次提交新加/改的测试，必须从红变绿；
  2. **整套单测不回归**：2000+ 条全跑，baseline 本来就红的除外；
  3. **双 tsc 不新增类型错**：`tsconfig.node.json` 与 `tsconfig.web.json`，
     相对 baseline 一条新错都不许有（baseline 本来就红的逐题扣除，和单测同一套规矩）。

第 3 条是 SWE-bench 结构上给不了的，而 40 道题里最大的短板恰恰是
「改了生产者不改消费者」——TypeScript 的类型检查正是抓这个的。

# 判据怎么来的：不用人工标注

每道题的 F2P 集合是**算出来的**，不是手写的：
  baseline(父提交)        → 失败集合 bad
  父提交 + 官方测试补丁    → 失败集合 t，  F2P = t - bad
  再 + 官方源码补丁       → 失败集合 s，  闸门要求 F2P ∩ s = 空 且 s - bad = 空
闸门过不了的题直接剔掉——环境差一点就恒判负且不报错，这一课在 SWE-bench 那边
已经花过 40% 的样本学了一遍。

# 防作弊

快照只保留父提交那一刻的工作树，`.git` 重建成单条提交——**这次提交本身和它之后的历史
都不在磁盘上**。官方测试补丁在 agent 干完之后才打，全程看不见。

注意一处这个项目特有的泄题风险：`CLAUDE.md` 与 `docs/claude/*.md` 经常在同一次提交里
记录这次改动的结论。快照取父提交就绕开了——那时候文档还没写。但**同一批里更早的提交
可能已经把答案写进文档**，这属于真实工作条件（日常干活时文档就是在的），不作处理。

# node_modules

用 APFS 写时复制（`cp -c`）挂进每个工作目录，几乎不占额外磁盘。
依赖是 HEAD 那份、源码是历史那份，会有版本错配——所以 baseline 里天生红的那些
逐题扣除，**agent 和标准答案扣的是同一批**。
"""
import collections, json, os, re, shutil, subprocess, sys, time
import os as _os

BENCH_ROOT = _os.getenv("SHADOW_SCRATCH") or _os.path.expanduser("~/openpipal-bench/shadow")
# 仓库根 = 本脚本的上上级（tests/bench/x.py -> 仓库根）。不写死绝对路径：
# 换台机器就废，而且会把本机目录名带进版本管理。
REPO = _os.getenv("SHADOW_REPO") or _os.path.dirname(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))


def P(*parts):
    return _os.path.join(BENCH_ROOT, *parts)


def sh(cmd, cwd, timeout=1800, env=None):
    return subprocess.run(["bash", "-lc", cmd], cwd=cwd, capture_output=True, text=True,
                          timeout=timeout, env=env)


# vitest 的逐条结果：`✓ 文件 > 用例名 3ms` / `× 文件 > 用例名`
LINE = re.compile(r"^\s*(?P<mark>[✓×✗↓])\s+(?P<name>\S.*?)(?:\s+\d+ms)?\s*$")


def run_unit(work, files=None):
    """跑单测，返回 {用例全名: 是否通过}。不传 files 就跑整套。

    环境显式钉死颜色：判分靠解析输出，而 ANSI 转义会让匹配全落空。
    这一课在 SWE-bench 那边花了 40% 的样本——见 README「判分为什么不能继承调用方的环境」。
    """
    env = dict(os.environ, PATH=os.path.join(work, "node_modules", ".bin") + ":" + os.environ["PATH"],
               NO_COLOR="1", CI="1")
    env.pop("FORCE_COLOR", None)
    env.pop("CLICOLOR_FORCE", None)
    cmd = "npx vitest run --reporter=verbose --no-color"
    if files:
        cmd += " " + " ".join(files)
    p = sh(cmd, work, env=env)
    log = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", p.stdout + p.stderr)
    out = {}
    for line in log.split("\n"):
        m = LINE.match(line)
        if not m:
            continue
        name = m.group("name").strip()
        if " > " not in name:
            continue
        out[name] = m.group("mark") == "✓"
    return out, log


def failing(res):
    return {k for k, ok in res.items() if not ok}


def confirm_regress(work, candidates):
    """候选回归再验一次：只重跑它们所在的文件，两次都红才算真回归。

    **为什么必须有这一步。** 套件里有靠墙钟断言的测试——`quickjs-sandbox-abort.test.ts`
    的 `wallTimeoutMs: 250` 那条，实测耗时 257~330ms，本来就压在预算边缘。
    2026-08-31 实测：同一份代码、同样命令跑 5 遍全量单测，第 5 遍比前 4 遍多红一条。
    而回归判据是「新红即判负」，一点容忍都没有，于是那天 `6b34c7ddd` 被闸门剔出题库，
    理由是「新增回归 = quickjs 墙钟那条」——复跑 5 遍全绿，那次是假的。一道好题就这么没了。
    同一个式子在 `shadow_judge.py` 打分时也用，所以模型真做对的一次同样会被冤枉。

    **这是永久机制，不是能力拐杖**：按「如果模型是完美的，这机制还需要吗」判——需要，
    完美的模型照样会被抖动测试误判。属于竞态那一类，不登记日落条件。

    **代价**：模型引入的偶发 bug 可能被重试放过去。相比「稳定地把对的判成错的」，换得值。

    只重跑候选所在的文件，不是整套——几秒，不是几十秒。
    重跑里没出现的用例保守当红（可能整个文件崩了），只有明确转绿的才放过。
    """
    if not candidates:
        return []
    files = sorted({t.split(" > ", 1)[0] for t in candidates if " > " in t})
    if not files:
        return sorted(candidates)
    again, _ = run_unit(work, files)
    return sorted(t for t in candidates if again.get(t) is not True)


# tsc 报错有两种形态，**都要认**：
#   带位置：`src/x.ts(601,27): error TS2802: ...`  —— 行列号扔掉（改几行代码整份文件行号就
#           全平移，带行号比对会把一条老错认成一条新错）
#   全局：  `error TS18003: No inputs were found in config file ...`
#           `error TS5083: Cannot read file 'tsconfig.node.json'`
#           —— 没有文件前缀。第一版只写了带位置那条，于是**删掉/改名一个被 include 的文件、
#           或者写坏 tsconfig，都会解析出空集合、判成"没有新增类型错"**——而那正是判据 3
#           要抓的形态。签名里补一个 `(global)` 占位当文件名。
TSC_POS_ERR = re.compile(r"^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.*)$", re.M)
TSC_GLOBAL_ERR = re.compile(r"^error (TS\d+): (.*)$", re.M)


def tsc_errs(text):
    out = {"%s|%s|%s" % (f, code, msg.strip())
           for f, _, _, code, msg in TSC_POS_ERR.findall(text)}
    out |= {"(global)|%s|%s" % (code, msg.strip())
            for code, msg in TSC_GLOBAL_ERR.findall(text)}
    return out


def tsc(work):
    """双 tsc —— main 与 renderer 各一份。改签名只跑一份等于没跑。

    连**每条报错**一起返回，因为 tsc 不能当绝对判据用：工作目录的 node_modules 是 HEAD 那份、
    源码是历史那份，老提交上 baseline 自己就红（实测 `6919551`：`tldraw` 模块整个不见了、
    `pi-ai` 少了 `completeSimple` 导出——都是依赖版本错配，跟这道题一个字的关系都没有）。
    拿绝对干净当门槛，等于按提交年份筛题，还筛得悄无声息。单测那边早就在扣 baseline
    （「agent 和标准答案扣的是同一批」），tsc 只是当初漏了，这里补上。
    """
    out = {}
    for proj in ("tsconfig.node.json", "tsconfig.web.json"):
        p = sh("npx tsc --noEmit -p %s" % proj, work)
        log = p.stdout + p.stderr
        out[proj] = {"ok": p.returncode == 0, "tail": log[-600:], "errs": sorted(tsc_errs(log))}
    return out


def tsc_new(ty, baseline):
    """相对 baseline **新增**的类型错误。baseline 为空 = 退化成绝对判据（老题库无缝兼容）。

    **按条数比，不按集合比。** 只做集合差的话，「某文件本来就有一条 TS2345，agent 又在
    同一文件引入五条一模一样的」会被算成零新增——而「改了生产者不改消费者」恰好就长这样
    （同一条报错在多个调用点重复）。单测那边数的是失败条数，这里对齐同一口径。

    另外**退出码仍是硬判据**：tsc 崩了、`npx` 没解析到、配置读不出来，都可能一条 `error TSxxxx`
    都不打印。只看解析出来的错误集合等于把这些静默判成干净。
    """
    new = {}
    for proj, v in ty.items():
        base = collections.Counter(baseline.get(proj, []))
        cur = collections.Counter(v.get("errs", []))
        d = sorted((cur - base).elements())
        if d:
            new[proj] = d
        elif not v.get("ok", True) and not base:
            # 非零退出但一条错都没解析出来，且 baseline 当时是干净的 → 判据坏了，不许判成绿
            new[proj] = ["(退出码非零但解析不到任何 TSxxxx —— 多半是 tsc 自己没跑起来)"]
    return new


def snapshot(commit, work):
    parent = sh("git rev-parse %s^" % commit, REPO).stdout.strip()
    if os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(work)
    # 只导出父提交那一刻的工作树；这次提交与之后的历史根本不落盘
    subprocess.run("git archive %s | tar -x -C %s" % (parent, work), shell=True, cwd=REPO, check=True)
    subprocess.run(["cp", "-c", "-R", os.path.join(REPO, "node_modules"),
                    os.path.join(work, "node_modules")], check=True)
    # .git 重建成单条提交：`git log` 里只有一行，未来的历史不存在
    for c in ["git init -q .",
              "git config gc.auto 0", "git config core.compression 0",
              "printf 'node_modules/\\n' > .git/info/exclude",
              "git add -A .",
              "git -c user.email=b@b -c user.name=bench commit -qm 'base snapshot'"]:
        sh(c, work)
    return parent


# 快照里的单测总数低于这个数，「整套单测不回归」这条判据就形同虚设——
# 实测 2026-06-03 的快照只有 9 个测试文件 / 70 条，改坏 scheduler / config / artifact
# 一条都照不出来；同一个仓库到 8 月已经是 202 个文件 / 1638 条。
# **这个数是拍的，不是算出来的**：440 和 556 条能覆到主要子系统，70 条不能，界划在中间。
# 不静默剔题也不静默收题——这类题照跑，但结果里带着 `thin_suite`，读数时别把
# 「没测出回归」读成「没有回归」。
THIN_SUITE = int(os.getenv("SHADOW_THIN_SUITE", "300"))


def prepare(commit):
    work = P("work", commit)
    t0 = time.time()
    parent = snapshot(commit, work)
    src_patch, test_patch = P(commit + ".src.patch"), P(commit + ".test.patch")
    open(src_patch, "w").write(sh("git diff %s %s -- src/" % (parent, commit), REPO).stdout)
    open(test_patch, "w").write(sh("git diff %s %s -- tests/" % (parent, commit), REPO).stdout)
    subject = sh("git log -1 --format=%%s %s" % commit, REPO).stdout.strip()
    body = sh("git log -1 --format=%%b %s" % commit, REPO).stdout.strip()

    base, _ = run_unit(work)                       # ① baseline
    base_ty = tsc(work)                            # baseline 的类型错误，之后逐题扣除
    bad = failing(base)
    if not base:
        return {"commit": commit, "ok": False, "why": "baseline 一条测试都没解析到"}

    if sh("git apply %s" % test_patch, work).returncode:
        return {"commit": commit, "ok": False, "why": "官方测试补丁打不上"}
    with_test, _ = run_unit(work)                  # ② 只加官方测试
    f2p = sorted(failing(with_test) - bad)
    if not f2p:
        return {"commit": commit, "ok": False, "why": "官方测试在旧代码上就是绿的，这题验不到东西"}

    if sh("git apply %s" % src_patch, work).returncode:
        return {"commit": commit, "ok": False, "why": "官方源码补丁打不上"}
    with_src, _ = run_unit(work)                   # ③ 再加官方修复 → 闸门
    still = sorted(set(f2p) & failing(with_src))
    regress = confirm_regress(work, failing(with_src) - bad - set(f2p))
    ty = tsc(work)
    base_tsc = {k: v["errs"] for k, v in base_ty.items()}
    ty_new = tsc_new(ty, base_tsc)
    sh("git checkout -q -- . ; git clean -qfd -e node_modules", work)

    gate = (not still) and (not regress) and not ty_new
    return {"commit": commit, "parent": parent, "ok": gate, "subject": subject, "body": body,
            "f2p": f2p, "f2p_n": len(f2p), "baseline_bad": sorted(bad), "baseline_bad_n": len(bad),
            "baseline_tsc": base_tsc, "baseline_tsc_n": sum(len(v) for v in base_tsc.values()),
            "total_tests": len(base), "thin_suite": len(base) < THIN_SUITE,
            "prep_s": round(time.time() - t0, 1),
            "why": "" if gate else "闸门未过：标准答案下仍红 %s / 新回归 %s / 新增类型错 %s"
                   % (still[:3], regress[:3], [e for v in ty_new.values() for e in v][:2])}


if __name__ == "__main__":
    os.makedirs(P("work"), exist_ok=True)
    out = P("prepared.jsonl")
    done = set()
    if os.path.exists(out):
        done = {json.loads(l)["commit"] for l in open(out) if l.strip()}
    todo = [c for c in sys.argv[1:] if c not in done]
    print("待办 %d 个提交（已完成 %d）" % (len(todo), len(done)), flush=True)
    with open(out, "a") as f:
        for i, c in enumerate(todo, 1):
            try:
                r = prepare(c)
            except Exception as e:
                r = {"commit": c, "ok": False, "why": "%s: %s" % (type(e).__name__, e)}
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            f.flush()
            print("[%d/%d] %s %s  F2P=%s  baseline红=%s  单测=%s%s  %s"
                  % (i, len(todo), "OK " if r.get("ok") else "剔除", c[:9],
                     r.get("f2p_n", "-"), r.get("baseline_bad_n", "-"), r.get("total_tests", "-"),
                     " ⚠回归判据形同虚设" if r.get("thin_suite") else "",
                     r.get("why", "")[:90]), flush=True)
