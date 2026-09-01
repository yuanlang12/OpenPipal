"""影子运行的题目体检。三个方向，都是确定性的，不靠模型判断。

# 为什么必须有

拿自己仓库的历史提交当题目，有两条 SWE-bench 不存在的泄题路径，外加一条两边都有的**不可解**路径：

**① 任务描述抄了答案。** 任务描述是照着改动反写的，写的人看过 diff，
很容易把实现方向带进去。判据：标准答案新增行里的标识符，不许出现在任务描述里。

**② 仓库自己把答案写在文档里。** 这个项目的纪律要求「新机制 → mechanism-registry.md 登记」，
而文档和代码常在**同一轮工作**里提交——只是拆成了两个 commit。取父提交并不能绕开：
实案 `55c864633`（三处历史投影补回 messageKind）的父提交 `033a845` 就在 **95 秒前**，
它的 `mechanism-registry.md` 已经把三个改点连同故障形态原样写好了：

  > **三处历史投影必须携带 `messageKind`**：`chatStore.toApiMessages`（桌面）、
  > `scheduler.storedMessageToChatMessage`（定时任务）、`http-server.ts`（ACP/插件）
  > …任何一处丢掉，跨回合缓存静默全失（2026-08-18 实案）

编码助手 grep 一次就抄到全部答案，这道题量不出任何东西。

判据：标准答案改到的**文件名/函数名**，如果有 ≥2 个同时出现在快照的某一行文档里，
判为泄题——单个名字出现是正常的（文档本来就要提到模块），**多个改点凑在同一行**
才是「答案被写下来了」。

**③ 判据要求题面里推不出来的东西。** 前两条查「题目太容易」，这条查**反向**——
题目**不可能做对**。2026-08-28 归因发现：7 道题里有 4 道，判分绑死在只有看过标准答案
才知道的东西上，而这 4 道在 6 轮 A/B 里的 F2P 分数逐轮一模一样（`0/5`×6、`2/10`×5），
等于每跑一轮都在重复测同一件「猜不猜得中作者的命名」。三种形态，逐个判：

  **③a 命名契约**：F2P 测试从 `src/` import 了一个符号，这符号在父快照里**根本不存在**
      （grep 不到，只能凭空造），题面里又一个字没提。实案 `03472f433` 要求导出
      `questionsPreviewImageUrl`、`8b85caba9` 要求 `collectSidecarNames` /
      `readSidecarFiles` / `injectSidecarData`——行为全做对，名字没撞上，照样 0 分。

  **③b 源码文本断言**：测试 `readFileSync` 一个 `src/` 文件再 `toContain('...')` 断言
      源码字面量。实案 `92506183f` 有 9 条这种断言，要求原样复述作者写的
      `hasVisibleMcpServer('classin', overrides?.conversationId)`。这判的不是行为，
      是抄写。6 轮全是 `0/5`。

  **③c 魔数钉死**：题面明说「你自己拿捏」，判据却钉死一个具体数。实案 `e0a448b16`
      题面写「给个更站得住的数，并说清楚你凭什么定这个数」，判据要求恰好 `300_000`——
      模型给 120 秒还是 180 秒都是有理有据的答案，分数却只认作者当时选的那个。
      只判**期望值侧的 >=1000 魔数**，不判字符串（为什么不判，见 `EXPECTED` 那段注释）。

**③ 和 ① 会打架，这是对的。** ① 说「答案的标识符不许出现在题面」，③a 说「判据要的新符号
必须出现在题面」——同一个名字两头堵。解法不是放宽哪一头，而是分清两类符号：
**契约符号**（F2P 测试直接 import 的）是**规格**，写进题面天经地义，本来就该告诉干活的人
「你得导出个叫 X 的东西」；**实现符号**（其余新增标识符）才是答案，出现在题面就是抄。
所以 ① 现在排除契约符号后再判。

标准答案闸门抓不到这一层：作者的补丁天然能过作者自己的测试，闸门只会一路绿灯。

# 处置

判为泄题/不可解的题**直接剔掉**，不做手术。手动删文档行、或者把符号名补进题面，
都是一种判断，会引入我自己的偏见；而且补了之后到底该给多少上下文，本身没有客观答案。
宁可少一道题。
"""
import builtins as _builtins
import json, keyword, os, re, subprocess, sys
import os as _os

BENCH_ROOT = _os.getenv("SHADOW_SCRATCH") or _os.path.expanduser("~/openpipal-bench/shadow")
# 仓库根 = 本脚本的上上级（tests/bench/x.py -> 仓库根）。不写死绝对路径：
# 换台机器就废，而且会把本机目录名带进版本管理。
REPO = _os.getenv("SHADOW_REPO") or _os.path.dirname(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))


def P(*parts):
    return _os.path.join(BENCH_ROOT, *parts)


IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")
# 只认**代码形态**的标识符。第一版把 create / text / path / Model / message 这类
# 普通英文词也算进来，14 道里报了 13 道泄题——那是判据坏了，不是真泄题。
# 代码形态 = 驼峰（fooBar / FooBar 且含小写转大写）或含下划线。普通英文单词两者都不满足，
# 而 `messageKind` / `toApiMessages` / `storedMessageToChatMessage` 这类真答案全满足。
CODEY = re.compile(r"(?:[a-z][A-Z])|_")
# 品牌名/产品名在驼峰规则下会被误判成代码标识符，但用户报问题时本来就会说
# 「我用的是 DeepSeek」「ClassIn 里打不开」——那是现象不是泄题。
BRANDS = {"OpenAI", "OpenRouter", "DeepSeek", "ClassIn", "OpenPipal", "GitHub", "JavaScript",
          "TypeScript", "macOS", "iOS", "PyPI", "GraphQL", "OAuth", "WebSocket", "JSON",
          "MacBook", "AppleScript", "SwiftUI", "XCode", "DashScope", "OpenCode", "iCloud"}
NOISE = set(keyword.kwlist) | set(dir(_builtins)) | BRANDS


def codey(names):
    return {n for n in names if CODEY.search(n) and n not in NOISE}


def added_idents(patch_text):
    out = set()
    for l in patch_text.split("\n"):
        if l.startswith("+") and not l.startswith("+++"):
            out.update(IDENT.findall(l[1:]))
    return codey(out)


def changed_files(commit):
    """这次改动碰了哪些源文件（只取文件名）。

    文档点名**单个**模块是正常的——`quick-navigation.md` 的职责就是「改 X 去看 Y 文件」，
    那是日常干活时本来就有的路标，不算泄题。真泄题是**同一行里既点名多个被改文件、
    又出现这次新引入的标识符**——那等于把「改哪几处、加什么」直接写好了。
    """
    p = subprocess.run(["git", "show", commit, "--", "src/"], cwd=REPO,
                       capture_output=True, text=True).stdout
    out = {}
    for f in re.findall(r"^\+\+\+ b/(\S+)", p, re.M):
        b = os.path.basename(f)
        # 一个文件给两种写法：文档里写的是 `chatStore.toApiMessages`、
        # `scheduler.storedMessageToChatMessage`，只匹配 `chatStore.ts` 会漏掉——
        # 而那正是本项目真出现过的那条泄题（见文件头）。
        # **按源文件去重**：`config-manager` 和 `config-manager.ts` 是同一个文件，不能算两处。
        out[f] = {b, os.path.splitext(b)[0]}
    return out


# —— ③ 可解性判据 ——
# 只认指向 src/ 的模块说明符。测试之间互相 import helper 不算契约（那是测试自己的事）。
SRC_SPEC = re.compile(r"(?:^|/)src/")
# `import { a, b as c } from '../../src/x'`
NAMED_IMPORT = re.compile(r"import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]")
# `const { a, b } = await import('../../src/x')` / `= require('../../src/x')`
DYN_IMPORT = re.compile(
    r"(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*['\"]([^'\"]+)['\"]")
# 解构里可能写 `a as b` / `a: b`——契约名是**左边**那个，右边是本地别名，作者随便叫
BINDING = re.compile(r"([A-Za-z_$][\w$]*)")
# ③b：读源码原文再做字面断言
READ_SRC = re.compile(r"readFileSync\s*\(\s*['\"]([^'\"]*src/[^'\"]+)['\"]")
ASSERT_TEXT = re.compile(r"\.(?:toContain|toMatch)\s*\(")
# ③c：断言**期望值**那一侧钉死的魔数。三重收窄，每一重都是被误报逼出来的：
#   1. 只看 `.toBe(...)` / `.toEqual(...)` 的**括号内**，不看整行——整行会把
#      `expect(resolve('75000')).toBe(...)` 里的**输入参数**也算进来，那不是要求，是喂进去的料。
#   2. 只看 >=1000 的数——0/1/2/3、下标、长度几乎全是行为断言的正常零件。
#   3. **完全不看字符串**。第一版把断言里的字符串也算钉死，14 道报了 11 道不可解，
#      而里头 `6b34c7ddd`（改文案的题，通过率 5/6）被报的 `'1 automation'` / `'新建自动化'`
#      恰恰**就是这道题要交付的东西**，题面也写了「1 个是 automation，3 个是 automations」——
#      只是没原样写成这个拼法，字面比对就漏了。`24bec7adc` 被报的那几条更离谱，是断言的
#      失败提示语，根本不是要求。这和文件头记的那次教训是同一种：判据坏了，不是题坏了。
#      文案类需求本来就该靠字符串判，靠字面比对区分不了「该给的规格」和「猜作者的措辞」，
#      所以这一路交给人读，不设自动闸。
EXPECTED = re.compile(r"\.(?:toBe|toEqual|toStrictEqual)\s*\(([^)]*)\)")
BIG_NUM = re.compile(r"\b(\d[\d_]{3,})\b")
# 数字**藏在字符串里**就不是魔数：`http://www.w3.org/2000/svg` 的 2000 是 XML 命名空间，
# `'not-a-real-model-9999'` 的 9999 是编出来的 fixture id。先把字符串抠掉再找数。
STR_LIT = re.compile(r"""(['"`])(?:\\.|(?!\1).)*\1""")
LINE_COMMENT = re.compile(r"//.*$")


def name_in_text(name, text):
    """题面里有没有原样提到这个标识符。

    边界用 `(?<![\\w$])`/`(?![\\w$])` 而不是 `\\b`：`\\b` 在 `$` 处也算边界，
    于是 `$refs` 会在 `my$refs` 里命中。① 和 ③a 问的是同一个问题，必须用同一把尺。
    """
    return bool(re.search(r"(?<![\w$])%s(?![\w$])" % re.escape(name), text))


def _sides(patch_text):
    """把补丁拆成 (新增行, 其余行)。其余 = 上下文 + 删除行 = 「本来就有的」。"""
    add, rest = [], []
    for l in patch_text.split("\n"):
        if l.startswith("+++") or l.startswith("---"):
            continue
        (add if l.startswith("+") else rest).append(l[1:] if l[:1] in "+-" else l)
    return add, rest


def in_parent(commit, names):
    """这些名字在**父快照**里存不存在。存在 = agent 能 grep 到，不算凭空猜。"""
    have = set()
    for n in names:
        r = subprocess.run(["git", "grep", "-qw", n, commit + "^"],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode == 0:
            have.add(n)
    return have


def area_dir(area):
    return "src/" if area == "src" else "tests/"


def patch_text(commit, area):
    """题库里备好的补丁优先；没有就现从 git 取——**选题阶段**要在建题库之前就能筛。

    建一道题的题库要跑三遍整套单测（baseline / 加测试 / 加答案），十几分钟起。
    而「判据要不要凭空猜命名」用 git 里的补丁就能算，秒级。顺序反过来，
    就是拿十几分钟去确认一道注定不可解的题。
    """
    f = P("%s.%s.patch" % (commit, area))
    if os.path.exists(f):
        return open(f, encoding="utf-8").read()
    return subprocess.run(["git", "diff", commit + "^", commit, "--", area_dir(area)],
                          cwd=REPO, capture_output=True, text=True).stdout


def test_files(commit):
    """这次提交动了哪些测试文件（删除的除外）。"""
    out = []
    for f in re.findall(r"^\+\+\+ b/(tests/\S+)", patch_text(commit, "test"), re.M):
        if f != "/dev/null":
            out.append(f)
    return out


def imports_from_src(text):
    """一份**完整源码**里，从 `src/` import 进来的符号名。"""
    out = set()
    for rx in (NAMED_IMPORT, DYN_IMPORT):
        for names, spec in rx.findall(text):
            if not SRC_SPEC.search(spec):
                continue
            for part in names.split(","):
                m = BINDING.search(part)
                if m:
                    out.add(m.group(1))
    return out - NOISE


def test_file_texts(commit):
    """打完补丁之后那几份**完整**测试文件的正文。

    ③a 和 ③b 要的是同一批文件的同一份正文（一个找 import、一个找 readFileSync），
    以前各自 `git show` 一遍——两条循环，两倍子进程，而且已经开始各写各的了。
    """
    out = []
    for f in test_files(commit):
        p = subprocess.run(["git", "show", "%s:%s" % (commit, f)], cwd=REPO,
                           capture_output=True, text=True)
        if p.returncode == 0:
            out.append(p.stdout)
    return out


def contract_syms(commit, texts=None):
    """F2P 测试从 src/ 拿了哪些符号——这些是**规格**，不是答案。

    读的是 `git show <commit>:<测试文件>`，也就是**打完补丁之后那份完整文件**，
    不从补丁正文重建。重建这条路试过两版、漏了两次，最后发现它根本走不通：
    **统一 diff 里没有整份文件**。压垮它的是 git 的 hunk 头——
    `@@ -4,6 +4,7 @@ import {` 会把「这段改动位于哪条语句里」写在 `@@` 后面，
    于是新符号是加进一条 import 列表的，而那条 `import {` 只存在于 hunk 头，
    补丁正文里一个字都没有。实案 `7313616`（判据要求猜中 `containsReceiptPlaceholder`）
    就是这么漏过去的，真跑一轮才发现。读整份文件之后这一类漏判在构造上就不存在了。
    """
    out = set()
    for text in (test_file_texts(commit) if texts is None else texts):
        out |= imports_from_src(text)
    return out


def solvable(commit, task_text):
    """判据要的东西，题面里推得出来吗？推不出来的题**不可解**，剔掉。

    `task_text` 传空串就是**选题模式**：这时 ③a/③c 报的不是「不可解」，
    而是**题面必须写明的规格**——写题的人照着这张单子写，题就是可解的。
    """
    text = patch_text(commit, "test")
    if not text.strip():
        return {"ok": False, "why": "没有测试改动，这题没判据", "contract": []}
    add, rest = _sides(text)
    in_task = lambda n: name_in_text(n, task_text)

    # 整份测试文件只读一次，③a 和 ③b 共用
    texts = test_file_texts(commit)

    # ③a 命名契约：测试要的符号，父快照里没有 + 题面里没提 = 只能凭空猜中作者的命名
    contract = contract_syms(commit, texts)
    novel = sorted(contract - in_parent(commit, contract))
    naming = [n for n in novel if not in_task(n)]

    # ③b 源码文本断言：读 src 原文再 toContain —— 判的是抄写，不是行为。
    # `readFileSync` 那一行常常是**上下文行**（这次提交只往下面追加断言），所以读整份
    # 测试文件来找它，只在新增行里数断言条数——和 ③a 同一个教训：补丁里没有整份文件。
    src_reads = set()
    for text in texts:
        src_reads |= set(READ_SRC.findall(text))
    textual = len([l for l in add if ASSERT_TEXT.search(l)]) if src_reads else 0

    # ③c 魔数钉死：新增断言的**期望值**里有个 >=1000 的数，而这个数在别处推不出来
    was = "\n".join(rest).replace("_", "")
    bare = task_text.replace("_", "").replace(",", "")
    expected_nums, supplied = set(), set()
    for l in add:
        code = LINE_COMMENT.sub("", l)          # 注释里出现不算「测试喂的」——
        rest_of_line = code                     # `// pi 那边是 300_000` 是出处说明，不是输入
        for m in EXPECTED.finditer(code):
            expected_nums.update(BIG_NUM.findall(STR_LIT.sub("''", m.group(1))))
            rest_of_line = rest_of_line.replace(m.group(0), "")
        # 期望值以外的位置出现过 = **测试自己喂进去的**，读回来只是往返，不是隐藏要求。
        # 实案 `7484622e5`：`goConfig({ contextWindow: 128_000 })` 后 `.toBe(128_000)`。
        supplied.update(BIG_NUM.findall(STR_LIT.sub("''", rest_of_line)))
    pinned = sorted(n for n in expected_nums - supplied
                    if n.replace("_", "") not in was and n.replace("_", "") not in bare)

    why = []
    if naming:
        why.append("判据要求凭空猜中命名 %s" % naming[:4])
    if textual:
        why.append("判据是源码文本断言（%d 条，读 %s）" % (textual, sorted(src_reads)[:2]))
    if pinned:
        why.append("判据钉死题面推不出的魔数 %s" % pinned[:4])
    return {"ok": not why, "why": "；".join(why), "contract": sorted(contract),
            "naming": naming, "textual_n": textual, "src_reads": sorted(src_reads),
            "pinned": pinned}


def doc_leak(commit, gold):
    """② 父提交的文档里有没有把答案写下来。

    走 `git grep <父提交>` 而不是 grep 工作目录——工作目录要先建题库（跑三遍整套单测，
    十几分钟一道），而这条判据 git 里就能算。选题阶段就该筛掉，别等建完才发现白干。
    """
    if not gold:
        return []
    files = changed_files(commit)
    pat = "|".join(re.escape(g) for g in sorted(gold))
    try:
        p = subprocess.run(["git", "grep", "-nE", pat, commit + "^", "--",
                            "*.md", ":!node_modules"], cwd=REPO,
                           capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        p = None
    # **退出码必须看**。git grep 的约定是 0=有命中、1=无命中、>1=出错（模式太长、
    # 正则太复杂、revision 不存在……）。只看 stdout 的话，出错和"没泄题"长得一模一样，
    # 这道闸就静默恒假——本仓库已经为"判据静默恒假"付过一次学费（见 README 判分那节）。
    # 出错时**按泄题算**（fail-closed）：宁可少一道题，也不能放一道已经泄了答案的进语料。
    if p is None or p.returncode > 1:
        why = "git grep 超时" if p is None else "git grep 退出码 %d" % p.returncode
        return [{"line": "(%s —— 查不了就按泄题算)" % why, "new": [], "files": []}]
    hits = []
    for line in p.stdout.split("\n"):
        if not line.strip():
            continue
        new_hits = {g for g in gold if g in line}
        # 数的是**不同源文件**，不是名字变体
        file_hits = {f for f, names in files.items() if any(n in line for n in names)}
        if new_hits and len(file_hits) >= 2:
            hits.append({"line": line[:200], "new": sorted(new_hits)[:5],
                         "files": sorted(os.path.basename(f) for f in file_hits)})
    return hits


def check(commit, task_text):
    src_patch = P(commit + ".src.patch")
    if not os.path.exists(src_patch):
        return {"commit": commit, "ok": False, "task_leak": [], "doc_leak_n": 0, "doc_leak": [],
                "why": "找不到 src 补丁，题库没准备好"}
    gold = added_idents(open(src_patch, encoding="utf-8").read())

    # ③ 可解性先算——① 要用它的结果
    sv = solvable(commit, task_text)

    # ① 任务描述里有没有抄标准答案的标识符。
    # **契约符号除外**：F2P 测试直接 import 的那些是规格不是答案，题面写明「你得导出个叫 X 的」
    # 天经地义；不除外的话它们会和 ③a 两头堵死，同一个名字写不写都判负（见文件头）。
    impl = gold - set(sv["contract"])
    # 和 `solvable()` 里的 `in_task` 用**同一个**边界判据。`\b` 对含 `$` 的标识符是错的
    # （`$refs` 会在更大的词里命中），两处不一致就会让 ① 和 ③a 对同一个名字给出相反结论——
    # 正是文件头说已经解决掉的那个两头堵。
    in_task = sorted(g for g in impl if name_in_text(g, task_text))

    doc_hits = doc_leak(commit, gold)

    ok = not in_task and not doc_hits and sv["ok"]
    return {"commit": commit, "ok": ok, "solvable": sv["ok"],
            "task_leak": in_task[:8], "doc_leak_n": len(doc_hits), "doc_leak": doc_hits[:3],
            "contract": sv["contract"], "naming": sv.get("naming", []),
            "textual_n": sv.get("textual_n", 0), "src_reads": sv.get("src_reads", []),
            "pinned": sv.get("pinned", []),
            "why": "" if ok else ("任务描述抄了 %s；" % in_task[:5] if in_task else "")
                                 + ("快照文档里已写好答案（%d 行）；" % len(doc_hits) if doc_hits else "")
                                 + sv["why"]}


def screen(commit):
    """选题预筛：只用 git，不建题库。回答两件事——这题能不能要、题面必须写明什么。"""
    sv = solvable(commit, "")            # 空题面 = 把所有「题面里推不出的东西」全列出来
    src = patch_text(commit, "src")
    docs = doc_leak(commit, added_idents(src))
    files = re.findall(r"^\+\+\+ b/(src/\S+)", src, re.M)
    tests_new = len(re.findall(r"^--- /dev/null", patch_text(commit, "test"), re.M))
    tests_all = len(re.findall(r"^\+\+\+ b/(tests/\S+)", patch_text(commit, "test"), re.M))
    # 子系统按 src 下的第一层目录分（main / renderer / shared / preload）
    subsys = sorted({f.split("/")[1] for f in files if f.count("/") > 1})
    return {"commit": commit,
            "subject": subprocess.run(["git", "log", "-1", "--format=%s", commit], cwd=REPO,
                                      capture_output=True, text=True).stdout.strip(),
            "src_files": files, "src_lines": len(re.findall(r"^\+[^+]", src, re.M)),
            "subsys": subsys, "tests_new": tests_new, "tests_modified": tests_all - tests_new,
            # ③b 读源码原文做断言、② 文档已写好答案——两条题面都救不回来，是死刑
            "fatal": bool(sv.get("textual_n")) or bool(docs),
            "doc_leak": [d["line"] for d in docs[:2]],
            # ③a/③c 是**写题要求**：这些名字/数必须出现在题面里，否则这题不可解
            "must_state": sv.get("naming", []) + sv.get("pinned", []),
            "src_reads": sv.get("src_reads", [])}


# ---- 自检 ----
# 判据现在读的是**完整测试文件**（见 `contract_syms` 的文件头），所以早先那三次漏判
# （整条新增 / 多行 import / 加进已有列表）在构造上已经不可能再发生——补丁怎么切都不影响
# 一份完整源码。这里钉住的是剩下那件仍然可能写错的事：**哪些 import 算契约**。
SELFTEST = [
    (u"单行", u"import { alpha } from '../../src/main/x'", {"alpha"}),
    (u"多行 + 别名", u"import {\n  beta,\n  gamma as g\n} from '../../src/main/x'", {"beta", "gamma"}),
    (u"动态 import", u"const { eps } = await import('../../src/main/x')", {"eps"}),
    (u"require", u"const { zeta } = require('../../src/shared/y')", {"zeta"}),
    (u"非 src 不算", u"import { helper } from './helpers'", set()),
    (u"type-only 也算契约", u"import type { Shape } from '../../src/shared/y'", {"Shape"}),
]

if __name__ == "__main__" and "--selftest" in sys.argv:
    bad = 0
    for name, src, want in SELFTEST:
        got = imports_from_src(src)
        ok = got == want
        bad += not ok
        print("%s %s  期望=%s 实得=%s" % ("OK" if ok else "XX", name, sorted(want), sorted(got)))
    print("自检 %s" % ("通过" if not bad else "失败 %d 条" % bad))
    sys.exit(1 if bad else 0)


if __name__ == "__main__" and "--screen" in sys.argv:
    commits = [a for a in sys.argv[1:] if a != "--screen"]
    rows = [screen(c) for c in commits]
    print("%-11s %-4s %-5s %-3s %-4s %-22s %s"
          % ("commit", "判据", "src行", "文件", "改测", "子系统", "题面必须写明"))
    for r in rows:
        print("%-11s %-4s %-5s %-3s %-4s %-22s %s"
              % (r["commit"][:9], ("文档" if r["doc_leak"] else "死刑") if r["fatal"] else ("要求" if r["must_state"] else "干净"),
                 r["src_lines"], len(r["src_files"]),
                 "%d改%d新" % (r["tests_modified"], r["tests_new"]),
                 "/".join(r["subsys"])[:22], ", ".join(map(str, r["must_state"][:4]))))
    json.dump(rows, open(P("screen.json"), "w"), ensure_ascii=False, indent=1)
    ok = [r for r in rows if not r["fatal"] and not r["must_state"]]
    print("\n判据干净（题面随便写都可解）：%d/%d  %s"
          % (len(ok), len(rows), ",".join(r["commit"][:9] for r in ok)))
    sys.exit(0)

if __name__ == "__main__":
    tasks = json.load(open(P("tasks.json")))
    res = [check(t["commit"], t["task"]) for t in tasks]
    json.dump(res, open(P("leakcheck.json"), "w"), ensure_ascii=False, indent=1)
    good = [r for r in res if r["ok"]]
    leaked = [r for r in res if not r["ok"] and r.get("solvable")]
    unsolvable = [r for r in res if not r.get("solvable", True)]
    print("题目体检：%d/%d 可用（泄题 %d，不可解 %d）"
          % (len(good), len(res), len(leaked), len(unsolvable)))
    for r in res:
        if r["ok"]:
            continue
        print("\n❌ %s  %s" % (r["commit"], r["why"]))
        for d in r["doc_leak"]:
            print("     文档: %s" % d["line"])
            print("     新增标识符: %s   被改文件: %s" % (d["new"], d["files"]))
        if r.get("naming"):
            print("     ③a 凭空猜命名: %s" % r["naming"][:6])
        if r.get("textual_n"):
            print("     ③b 源码文本断言 %d 条，读: %s" % (r["textual_n"], r["src_reads"][:3]))
        if r.get("pinned"):
            print("     ③c 钉死的魔数: %s" % r["pinned"][:6])
    print("\n可用的题号：" + ",".join(r["commit"] for r in good))
