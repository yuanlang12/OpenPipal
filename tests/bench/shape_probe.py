"""形状题探针：一道题的分数有多少是绑在「题面里推不出来的内部命名」上的。

# 为什么要有这个

SWE-bench 判分靠维护者当时写的隐藏测试。那些测试是**照着已经合入的实现**写的，
于是经常直接点名实现里的内部符号——某个关键字参数、某个 helper 函数、某个私有属性。
凡是这种题，行为做得再对，只要名字没恰好撞上，就是 0 分。

实例（2026-08-26 逐个人工核过）：
  django__django-14011  判分要求构造参数叫 `connections_override`，题面 1907 字零命中；
                        而唯一能验证「连接泄漏修好没」的测试被标准答案自己加进了 sqlite 跳过表，
                        **根本没参与判分**——判的全是 API 形状。
  pytest-dev__pytest-10356  要求参数叫 `consider_mro`，题面 5278 字零命中。
  pylint-dev__pylint-4661   标准答案用 `appdirs.user_cache_dir`（**缓存**目录），
                        而题面白纸黑字要求 `~/.local/share`（**数据**目录）——标准答案跟题面相反。

不校准这一层，任何 SWE-bench 分数都读不准：它同时**低估**了模型的可用性
（行为对了照样 0 分）和**高估**了它的可信度（能跑但不可合入的补丁照样满分）。

# 判据

一个标识符算「题面推不出来」，要同时满足：
  1. 出现在官方测试补丁的**新增行**里（判分依赖它）；
  2. 出现在标准答案的**新增行**里（是这次实现引入的）；
  3. **不**出现在标准答案/测试补丁的上下文行或删除行里（不是原本就有的）；
  4. **不**出现在题面里（agent 看不到）；
  5. 【强判据，需要仓库快照】**不**出现在 base_commit 的仓库里（读代码也找不到）。

第 5 条是关键：仓库里已有的名字，agent 靠 grep 能找到，不算「猜」。
没有快照的题只能用弱判据，结果会偏高——所以两个数分开报，不混在一起。

# 已知局限（别过度解读）

- 「形状题」和「难题」在小样本上分不开：标记为形状题的那批标准答案通常也更长。
  所以按标准答案新增行数分层再看，别直接把两组通过率之差当成形状题的代价。
- 名字对不上不一定就不可赢：有些名字能从题面语义自然推出（比如题面说
  "add a `strict` option" 时猜 `strict=`）。这个探针不做语义判断，只做字面比对，
  所以它给的是**上界**，要拿它当筛子而不是判决。
"""
import builtins as _builtins
import json, keyword, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import os as _os
# 题库、仓库快照住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)

# 三个字符起步：一两个字母的名字（i / x / db）噪声太大，且几乎不可能是判分靠的那种名字
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")

# 语言噪声：关键字、内置名，以及测试/diff 里遍地都是的词
NOISE = set(keyword.kwlist) | set(dir(_builtins)) | {
    "self", "cls", "args", "kwargs", "def", "class", "import", "from", "return",
    "assert", "test", "tests", "testing", "pytest", "unittest", "mock", "patch",
    "None", "True", "False", "and", "or", "not", "with", "for", "while",
    "raises", "fixture", "parametrize", "mark", "skipif", "xfail", "monkeypatch",
    "tmp", "tmpdir", "tmp_path", "capsys", "setUp", "tearDown", "setUpClass",
    "assertEqual", "assertTrue", "assertFalse", "assertRaises", "assertIn",
    "assertIsNone", "assertIsNotNone", "assertNotEqual", "assertRaisesMessage",
    "py", "python", "utf", "encoding", "None", "obj", "res", "ret", "val", "value",
    "key", "name", "data", "result", "expected", "actual", "output", "input",
    "file", "path", "line", "lines", "text", "msg", "err", "error", "exc",
    "doc", "docstring", "TODO", "noqa", "pylint", "flake8", "mypy",
}


def added(diff):
    """补丁里的新增行（跳过 `+++` 文件头）"""
    return [l[1:] for l in diff.split("\n") if l.startswith("+") and not l.startswith("+++")]


def kept(diff):
    """补丁里的上下文行与删除行 —— 这些内容改动之前就存在"""
    return [l[1:] for l in diff.split("\n")
            if (l.startswith("-") and not l.startswith("---")) or l.startswith(" ")]


def idents(lines):
    out = set()
    for l in lines:
        out.update(IDENT.findall(l))
    return out - NOISE


def repo_has(work, names):
    """这些名字在 base_commit 的仓库里能不能 grep 到。一次 rg 问完，别一个名字一趟。"""
    if not names or not os.path.isdir(work):
        return set()
    pat = "|".join(re.escape(n) for n in sorted(names))
    p = subprocess.run(
        ["rg", "--no-filename", "--no-line-number", "-o", "-e", pat,
         "--glob", "!.venv", "--glob", "!.git", "--glob", "!*.lock", "."],
        cwd=work, capture_output=True, text=True, timeout=180)
    return set(p.stdout.split())


def binding(name, lines):
    """这个名字在测试里是不是**卡住实现**的那种用法。

    自检时发现光看「名字在不在测试里出现」太松：测试里的局部变量也会被算进来
    （pylint-8898 就被一个叫 `quantifier` 的测试局部变量误报，而那道其实是干净的能力失败）。
    真正让「名字对不上 = 0 分」的，是这四种用法——它们对不上会直接抛异常，
    整个测试文件当场崩，行为做得再对也没机会跑到：

      from x import name / import name   →  ImportError
      f(..., name=...)                   →  TypeError: unexpected keyword argument
      obj.name                           →  AttributeError
      name(...)                          →  NameError
    """
    pats = [
        r"\bimport\b[^\n]*\b%s\b" % re.escape(name),   # import / from ... import
        r"[(,]\s*%s\s*=" % re.escape(name),            # 关键字实参
        r"\.%s\b" % re.escape(name),                   # 属性访问
        r"\b%s\s*\(" % re.escape(name),                # 调用
    ]
    blob = "\n".join(lines)
    return any(re.search(p, blob) for p in pats)


def one(inst):
    iid = inst["instance_id"]
    ps = inst["problem_statement"] or ""
    gold, tp = inst["patch"], inst["test_patch"]

    tp_add = added(tp)
    need = idents(tp_add)                       # 判分依赖的名字
    new = idents(added(gold))                   # 这次实现引入的名字
    cand = need & new
    # 题面里出现过的（整词或作为子串出现，比如题面写了 `foo_bar()` 而测试用 `foo_bar`）
    cand = {c for c in cand if c not in ps and c.lower() not in ps.lower()}
    # 只留「对不上就抛异常」的那种用法
    cand = {c for c in cand if binding(c, tp_add)}

    # 弱判据：拿补丁的上下文行当「原本就有」的近似。仓库快照在时不用它，用真 grep。
    weak = sorted(cand - (idents(kept(gold)) | idents(kept(tp))))

    work = P("work", iid)
    has_repo = os.path.isdir(work)
    # 强判据：base_commit 的仓库里 grep 得到的名字，agent 读代码就能找到，不算「猜」
    strong = sorted(cand - repo_has(work, cand)) if has_repo else None

    return {"iid": iid, "repo": inst["repo"], "difficulty": inst.get("difficulty"),
            "gold_added": len(added(gold)), "ps_len": len(ps),
            "weak_n": len(weak), "weak": weak[:8],
            "has_repo": has_repo, "strong_n": len(strong) if has_repo else None,
            "strong": (strong or [])[:8]}


if __name__ == "__main__":
    rows = json.load(open(P("verified.json")))
    with ThreadPoolExecutor(int(sys.argv[1]) if len(sys.argv) > 1 else 8) as ex:
        res = list(ex.map(one, rows))
    with open(P("shape.jsonl"), "w") as f:
        for r in res:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    withrepo = [r for r in res if r["has_repo"]]
    print("全 %d 道；有仓库快照可用强判据的 %d 道" % (len(res), len(withrepo)))
    for thr in (1, 2, 3):
        print("  弱判据 >=%d 个推不出的名字：%d 道（%.0f%%）| 强判据：%d/%d 道（%.0f%%）"
              % (thr,
                 sum(1 for r in res if r["weak_n"] >= thr), 100 * sum(1 for r in res if r["weak_n"] >= thr) / len(res),
                 sum(1 for r in withrepo if r["strong_n"] >= thr), len(withrepo),
                 100 * sum(1 for r in withrepo if r["strong_n"] >= thr) / len(withrepo)))
