# SWE-bench Verified 评测台（不用 Docker）

**用途是对照，不是刷分。** 同一个模型、同一个端点、同一把凭据、同一份仓库快照、同一套判分，
让「裸 `pi` CLI」和「走我们这层壳的编码助手」跑同一批题——**差值才是我们这层的价值**。
绝对分不与官方榜单可比（环境不是官方镜像），这是明写的取舍。

配对对照的驱动在 `tests/e2e/swebench-ab.spec.ts`，A 臂的裸 CLI 驱动在 `tests/e2e/bench-arms.ts`。
这里放的是判分与题库准备的那一半。

## 脚本住仓库，数据住 scratch

脚本要进版本管理；几十 GB 的仓库快照和 venv 不能进。所以所有脚本都从
`BENCH_SCRATCH`（默认 `~/openpipal-bench/swebench`）下取数据；
影子运行那一套用 `SHADOW_SCRATCH`（默认 `~/openpipal-bench/shadow`）：

```
$BENCH_SCRATCH/
  verified.json        SWE-bench Verified 全 500 行原始数据
  corpus.json          筛出来的可复现题目
  prepared.jsonl       每道题的准备结果（含 baseline 天生红的 P2P 清单 p2p_bad）
  gold.jsonl           标准答案闸门的结论
  work/<iid>/          题目工作目录（仓库快照 + .venv）
  work/<iid>.test_patch
  .tools/  .specs/     跑判分用的 Python 与 swebench 两个版本的站点包
```

### ⚠️ 别把 scratch 指回 `/tmp`

**macOS 开机清 `/private/tmp`。** 2026-08-30 装系统更新重启，一次清掉了：三批跑批结果、
A/B 实验的 39 条原始记录（收工闸拆除的决定就是基于它们做的，现在无法复核），
以及**手写的 `tasks.json` 题面——那个没有任何脚本能重新生成**。
重建 venv 还要一个多小时（253 道题各建一个）。

这条建议早就写在这里了，只是当时没落到默认值上，所以又丢了一次。现在默认已经是家目录。

放家目录**不额外占盘**：`prep.py` / `shadow_prep.py` 用 `cp -c` 做 APFS 写时复制克隆，
而 `/private/tmp` 与 `$HOME` 在同一个 APFS 卷（都是 `/System/Volumes/Data`），克隆照样成立。

也**别改成 `os.tmpdir()`**：它在 macOS 解析到 `/private/var/folders/…`，而 `/private/var`
在 `pi-security.ts` 的 `deniedWorkspaceRoots()` subtree 里——工作目录判定会直接拒，
编码助手一个字节都写不进去，且两条臂一起判负、不报错。

## 流水线

```bash
export BENCH_SCRATCH=~/openpipal-bench/swebench   # 就是默认值，写出来是为了下一行好读
P=$BENCH_SCRATCH/.tools/bin/python

$P tests/bench/corpus.py                 # 1. 选题：挑不用 Docker 也能忠实复现的
$P tests/bench/prep_many.py 253 8        # 2. 准备：快照 + venv + baseline（8 线程，约 12 分钟）
$P tests/bench/gold_gate.py 6            # 3. 闸门：标准答案判不过的题不准进（不花模型的钱）

OPENPIPAL_CODING_LIVE=1 BENCH_N=40 BENCH_ARM_MS=480000 \
  npx playwright test swebench-ab --workers=4      # 4. 配对对照（花钱的一步）

node tests/bench/report.js               # 5. 配对汇总 + McNemar
```

辅助的两个：`regate.py <iid,iid>` 单独重跑几道题的闸门；
`scan_contam.py` 拿标准答案在某个可疑环境下重判一遍，量污染半径。

## 四条不能松的纪律

**① 防作弊：快照只留 base_commit 那一刻。**
直接 clone 会把含标准答案的未来提交一起拉下来。`prep.py` 用
`git archive → git init → 单条提交` 重建 `.git`，未来的历史根本不在磁盘上，
`git log --all` 只有一行。（Datacurve 的 DeepSWE 审计里，Opus 4.7 有 18% 的通过是
`git log --all` / `git show <gold-hash>` 读来的。）test_patch 在 agent 干完之后才打。

**② 标准答案闸门：判不了的题不准进。**
环境不是官方镜像。环境哪怕差一点，这道题上两条臂都只能是 ❌——花了钱、判据却恒为假，
**而且不报任何错**。所以只有「把官方标准答案打上去能判成解决」的题才准进题库。
这一步不花模型的钱。第一版没这道闸，15 道题里 7 道根本判不了。

**③ 两条臂就地跑在同一个目录里，跑完各自还原，不复制副本。**
venv 里的可编辑安装把模板的绝对路径写死在 `__editable___<pkg>_finder.py` 里，
副本中的 `import <pkg>` 仍然解析回模板。于是 agent 改副本永远不生效——两条臂都必然判负、
不报任何错；更糟的是聪明一点的 agent 会顺着路径去改模板，A 臂的修复就漏给了 B 臂看
（实测 3 个模板被写脏）。

**④ 判分子进程的环境必须密封，不能原样继承调用方。** 见下。

## 判分为什么不能继承调用方的环境（2026-08-26，废掉 40% 样本的那次）

Playwright 的 workerHost 给每个 worker 进程**硬塞 `FORCE_COLOR=1`**
（`node_modules/playwright/lib/runner/workerHost.js`）。`execFileSync` 一路继承到判分脚本，
pytest>=7 认这个变量，于是 `-rA` 短摘要的每一行都以 ANSI 转义序列开头；
而 SWE-bench 官方 parser 判的是 `line.startswith("PASSED")`——一条都认不出来。

后果的形状值得记住：

- `parsed` 变成 0，**所有测试静静地记成未过**，没有任何报错；
- 两条臂拿到**逐条一模一样**的判负结果，看起来就像"这批题模型都做不出来"；
- **手跑复现不了**——普通 shell 里没有这个变量，所以标准答案闸门（手跑的）全绿，
  实跑（Playwright 里的）全灭，两边对不上却谁也说不清；
- 40 道题里废了 16 道（requests 4、xarray 8、pylint 1、pytest 3），
  A 臂的真实分数从"32.5%"变成 54.2%。

现在钉了两道：`grade.py` 里 `PY_COLORS=0` + `NO_COLOR=1` + 主动摘掉 `FORCE_COLOR`
（`should_do_markup` 里 `PY_COLORS` 优先级最高），解析前再无条件剥一遍 ANSI；
`swebench-ab.spec.ts` 的 `judge()` 里也摘一次。

**一般化的教训**：判分是"确定性归代码"的那一半，它的环境必须是显式构造的，
不能是"调用方碰巧带进来的那些"。任何让判据静默恒假的东西都比崩溃更危险——
崩溃会被看见，静默判负会被当成模型能力写进报告。

## test_patch 只重置测试文件，不还原整棵树

官方 harness 的做法是 `git checkout <base> -- <测试文件>` 再打补丁：以官方测试为准，
**但不碰 agent 的源码修复**。我们第一版图省事写成"`git apply` 失败就 `git checkout -- .`
整棵树还原再打"——那等于把 agent 的修复一起扔了，F2P 必然全红。

这条路**恰好在 agent 动过测试文件时才触发**，也就是说：agent 越是老老实实先写测试再改代码，
越容易被判负。判据和好行为反相关，是最坏的一种 bug。现在按官方做法只重置目标文件
（补丁新建的文件在 base 里不存在，`git checkout` 会失败，那种直接删掉重来）。

## 结果里每个字段是干什么的

`ab-results.jsonl` 每行一道题，两条臂各一份：

| 字段 | 用途 |
|---|---|
| `resolved` | F2P 全绿 **且** P2P 里 baseline 本来就绿的仍然全绿 |
| `f2p` / `p2p` | `[通过数, 总数]` |
| `parsed` | **解析出多少条测试结果**。分辨"改坏了几条"和"整套没跑起来"的唯一凭据——`parsed≈0` 就是后者 |
| `p2p_new_fail_n` / `p2p_new_fail` | 新坏掉的 P2P 条数（全量）与样例（截断到 6 条）。只看截断后的样例会把"全灭"误读成"坏了 6 条" |
| `test_patch_conflict` | 官方测试补丁打不上。正常应当恒为 false |
| `patch` / `untracked` | **agent 到底改了什么**。`git diff` 看不见未跟踪文件，而 agent 常写 `reproduce.py` / `conftest.py` 这类自查脚本——一个根目录下的坏 `conftest.py` 就能让整套 collection 失败 |
| `types` | 事件类型直方图。光看事件总数分不清「调了 30 次工具」和「吐了 300 个文本增量」 |

`patch` 和 `parsed` 是第一批跑完之后补的——**没有它们，事后没法区分"模型做错了"和"评测台坏了"**，
这一课花了 40% 的样本才学会。

## baseline 扣除法

uv venv 不是官方镜像，少数 P2P 会因 Python 小版本差异天生变红
（例：django 3.0 跑在 py3.8 上，6 条 `http.cookies` 测试）。`prep.py` 在 baseline 阶段把这些记进
`p2p_bad`，判分时逐题扣除。**两条臂扣的是同一批**，差值不受影响；绝对分因此不与官方榜单可比。

## 为什么不用官方 Docker 镜像

这台机器直连 `registry-1.docker.io` 直接 EOF，国内镜像站（daocloud）又把 swebench 挡在
白名单外（`denied: this image is not in the allowlist`），500 个官方镜像一个都拉不到。
所以环境改成 uv venv 就地建：只收 Python 小版本对得上、且不需要编译 C/Cython 扩展的仓库
（django / sympy / pytest / pylint / requests / flask / xarray，共 253 道）。
sphinx（tox 套娃）、matplotlib / scikit-learn / astropy / seaborn（老版本在 arm64 上编不动）排除。

## 形状题探针（`shape_probe.py`）

**问题**：SWE-bench 的隐藏测试是维护者**照着已合入的实现**写的，于是常常直接点名实现里的
内部符号——某个关键字参数、某个 helper、某个私有属性。凡是这种题，行为做得再对，
名字没恰好撞上就是 0 分。不校准这一层，任何 SWE-bench 分数都读不准。

**判据**（一个标识符算「题面推不出来」要同时满足）：
1. 出现在官方测试补丁的新增行里（判分依赖它）；
2. 出现在标准答案的新增行里（是这次实现引入的）；
3. 在测试里是**绑定用法**——`import` / 关键字实参 / 属性访问 / 调用。
   这四种对不上会直接抛 ImportError / TypeError / AttributeError / NameError，
   整个测试文件当场崩，行为再对也没机会跑到。**这一条不能省**：只看「名字出现过」
   会把测试局部变量算进来（自检时 `pylint-8898` 就被一个叫 `quantifier` 的局部变量误报）；
4. 不出现在题面里；
5. **不出现在 base_commit 的仓库里**——仓库里已有的名字 agent 靠 grep 能找到，不算「猜」。
   这一条把候选滤掉 70%，是弱判据和强判据的全部差距。

**自检**（人工核过答案的 8 道，8/8 全对）：

| 题 | 强判据 | 人工结论 |
|---|---|---|
| django-14011 | 🚩 `_close_connections` 等 | 不可赢（要猜 `connections_override`，且唯一的行为测试被 gold 自己加进 sqlite 跳过表） |
| pytest-10356 | 🚩 `consider_mro` | 不可赢 |
| pylint-4661 | 🚩 `appdirs` `user_cache_dir` | 不可赢（标准答案与题面相反：题面要 data 目录，gold 用 cache 目录） |
| pylint-4551 | 🚩 `get_annotation` `infer_node` | 不可赢 |
| xarray-4629 / sympy-13091 / django-13925 / pylint-8898 | 不标记 | 口径干净（后三道是真能力失败） |

**结论（2026-08-26 跑全 500 道，7.9 秒）**：

- 有仓库快照可用强判据的 253 道里，**8 道（3.2%，95% CI [1.6%, 6.1%]）** 是形状题；
- 全 500 道弱判据 48 道（9.6%），按同一批的滤除比例外推 → **全集约 14 道（2.8%）**【推断，另 247 道无快照可验】；
- **集中在特定仓库**：pylint 3/10（30%）、django 4/118、pytest 1/19，
  而 sympy 0/75、xarray 0/22、requests 0/8 一道没有。pylint 是基线的十倍——
  和它「标准答案自己只有 4/9 过闸门」是同一个现象；
- **命中时是绝对的**：我们跑过的 40 道里被标记的 4 道，**两条臂全部 0/4**，
  未标记的 36 道两条臂都是 27/36 = 75%。Fisher 双尾 **p = 0.0078**。

所以报分时应当写成 **75%（n=36，95% CI [59%, 86%]）**，并注明剔除了 4 道形状题。
形状题总体只占 3% 左右，**SWE-bench 的分数被压低的幅度不大**——但选题时该主动避开，
因为这些题上花的钱百分之百拿不到信息。
