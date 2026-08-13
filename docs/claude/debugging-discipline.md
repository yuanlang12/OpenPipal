# Debugging Discipline — 修 bug 前先证伪假说

**核心原则**：不要在未经证伪的假说上盲查 debug。

修 bug 时若有"X 改动后 Y 坏了"的归因假说，**最快路径不是修 X，是先做最小代价的对照实验否决"X 引起 Y"**。如果 Y 在没 X 的状态下仍出现 → 假说被否决，砍掉一整条错误 debug 路径，避免几小时甚至几天的盲查投入。

## 标准操作步骤

1. **形式化假说**：明确写出"我认为 Y 由 X 引起"——X 必须是具体的变化（commit / 升级 / feature flag / 配置切换），Y 必须是具体的可观测现象。
2. **设计对照**：让 X 不发生而其他一切相同。最常用：
   - 升级回归 → `git checkout` 旧分支 + 装回旧版 dep
   - 新功能引入 → 临时关 feature flag / 注释掉新代码
   - 配置变更 → 切回旧配置
   - 模型/provider 切换 → 切回旧 provider
3. **跑同样的复现路径**：同样的 prompt、同样的输入、同样的操作序列。
4. **看 Y 是否仍出现**：
   - **仍出现** → 假说否决，X 不是根因。**砍掉整个 debug 方向**，转向其他可能根因（往往是更早就潜伏的 bug）
   - **不出现** → 假说成立，可在 X 上继续 debug（但仍要在 X 状态下找具体改动点）

## 何时必须用

- **改动后立刻报 bug**：用户报 bug 的时机紧跟某次 commit/升级/feature 上线 → 假说强烈倾向"是这次改动引起" → **必须先证伪**才能信
- **跨大版本升级后**：dep 跨 N 个 minor 版本时几乎一定有人怀疑"升级回归"——但 N 个版本里既有可能引入 bug 也有可能修了别的 bug → 直接 debug 容易跑偏
- **多变量同时改动**：不只改了一个东西时（如同时升级 + 配置变更）—— 必须 isolate 每个变量

## 何时跳过 / 简化

- **改动是 pure addition**（纯新增代码、新文件、新功能）且 bug 在新代码路径上 → 不必对照（必然是新代码引起，直接看新代码）
- **bug 在改动完全无关的子系统**（改 UI 看到 backend 错误）→ 假说本身就弱，不必费力对照
- **回滚成本极高**（已发版给用户、数据迁移已完成）→ 用近似对照替代：临时 feature flag、git stash 单文件、git bisect 自动化

## 近似对照——回滚成本高的场景

| 场景 | 近似对照方法 |
|---|---|
| dep 升级跨多版本 | git bisect dep 版本（二分而不是全回） |
| feature 已上线给用户 | 加临时 feature flag，只在测试场景关掉 |
| 数据迁移已发生 | 单条记录手工还原到旧 schema 跑测试 |
| 改动散落多文件 | `git stash --keep-index` 临时撤回部分改动 |
| 模型行为差异 | 切到第二个 provider 跑同样 prompt 排除模型特异 |

## 与既有 debug 纪律的关系

CLAUDE.md "Bug 修复规范"已有几条 anti-whack-a-mole 准则——它们形成完整闭环：

```
开 debug 前    → 证伪"是这次改动引起"假说    [本文档]
开始 debug 后  → 三段式根因/文件/方案让用户确认  [CLAUDE.md]
修复中         → build / tsc / UI 多层验证       [CLAUDE.md]
修复后         → 验证增量行为 + 关注回归          [CLAUDE.md]
卡住 2 次      → 停手 + 派 sub-agent 重新分析    [CLAUDE.md]
```

**证伪假说放在最前**——目的是让后面的步骤建立在正确方向上，避免"修 X 半天发现根本不是 X"。

## 历史案例：Pi 0.65 → 0.74 升级 + 假以为是的 regression（2026-05）

**背景**：升级 Pi 框架从 0.65.2 到 0.74.0（跨 9 minor 版本，含 agent-loop 大重构 +359 -137 行）。升级 commit 落地后用户立即报 bug：
- 现象 1：AI 输出在 ask_user 工具调用前后**重复 emit assistant 消息**
- 现象 2：用户点暂停**无法打断**会话

**第一假说**（错的）：Pi 0.74 重写 agent-loop 引入 turn 边界 / abort 语义变化，是升级 regression。

**对照实验**（10 分钟）：
1. `git checkout main`（升级未合）
2. `npm install --legacy-peer-deps`（装回 0.65.2）
3. `npx electron-vite build` + 启动
4. 浏览器 MCP reload，新建对话发**一字不差的同样 prompt**
5. 看 conversation 文件——0.65 上同样有 assistant 消息重复 emit

**结论**：假说否决。Pi 0.74 不是根因。

**真根因**：`src/main/pi-event-adapter.ts:248` 的 `message_end` fallback 路径只检查 `!this.textBuffer` 而忘了检查 `this.hasStreamedText`：
- LLM 流式 text → text_delta 累积 textBuffer + 设 `hasStreamedText`
- 工具调用触发 → toolcall_start flush textBuffer 为空
- 工具完成 → message_end 误触发 fallback (textBuffer 空) → **重新 emit text 一遍**

变量 `hasStreamedText` 早就声明且注释明确说"防止 message_end fallback 重复发送已流式的 text"——但 4-09 commit `2213cdb` 修同类 thinking bug 时漏改了 text 段。**从 3-31 ^487d1d4 起一直存在的潜伏 bug**，最近因复杂工具调用 prompt 触发率提升才被发现。

修复 1 行：`if (text)` → `if (text && !this.hasStreamedText)`。

**反思**：
- 如果直接信第一假说回退 Pi → 浪费一天回滚 + 等 Pi 0.75 修一个 Pi 没问题的 bug + 真正的 bug 继续潜伏
- 对照实验花了 10 分钟，**砍掉 "Pi 重写 agent-loop debug" 这整条数小时的错误路径**
- 还附带否决了"abort 失效"假说——大概率是重复 emit 让人误以为 abort 没生效（实际生效了，但 message_end 又把已流过的 text 重 emit 一次）

**经验**：升级 + bug 报告同时出现时，"是升级回归"是**最容易得出的**假说，但也是**最容易错**的——升级跨多版本时你看到的 X 包含数十个改动，假说粒度太粗。先证伪再修。

---

# 历史教训案例库（配合 CLAUDE.md「Bug 修复规范」使用）

CLAUDE.md 只保留规范条文，具体案例沉在这里。每条案例对应主文档的一条纪律。

## build ≠ 类型检查（对应：改签名必跑双 tsc）

`electron-vite` 用 esbuild，只做 transform，**不查未定义标识符 / 类型错误**。案例：`mcpArtifact` 重命名漏了一处 → build 通过 → 用户运行报 ReferenceError。Edit/Write hook 已自动跑双 tsc（见 `.claude/settings.json`），关注它的 `[tsc]` 输出。

## Playwright 报数必须读完整 summary 行（对应：禁止 tail/grep 截断报绿）

案例：41 个存量失败被 `| tail` 吞掉，"53 passed" 被连续多轮误读为全量全绿。回归判定用**通过集不变量**（改动前后通过的用例集合相同+新增），不是只看 passed 数字。失败集可从 `test-results/.last-run.json` 恢复。

## "看不见 / 数量不对"的 UI bug：先 DOM clipping，再数据流

任何"应该有但用户看不见"的元素，第一步查 DOM 渲染层：`getBoundingClientRect()` 看是否在 viewport 内、`getComputedStyle` 走祖先链查 `overflow != visible`。**不要**第一反应跳到 stale state / IPC schema / 字段不一致这些数据流假设。

案例：WelcomePage 模型下拉只显示 6 个里的最后 2 个，绕了 stale state / 双实例 / IPC 序列化 / React state pipeline 多轮假设，真因是 InputBar 卡片容器多了一个 `overflow-hidden`、popover 向上弹时上半截被父容器裁掉。正确路径 30 秒：DevTools 选中 popover → 看 ancestors 的 overflow → 立即定位。

**关联启发**：用户说"组件 A 渲染对、组件 B 渲染少"时，先 diff 两边容器 className——OpenPipal 多处 InputBar 是重复实现而非组件复用，className 极易漂移。

## 流式/增量渲染修复必须验证增量行为，不只是终态

历史踩坑：iframe streaming rewrite 终态对但中间 delta 被吞 / thinking dedup 第一次只处理了重投不处理流式 / tool selection 看起来对但缓存未失效 / questions_v2 终态路有收敛但**流式 delta 路直吃原始缓冲**（React #31 白屏，2026-07）。修完要手动触发 stream，一边流一边看 UI，不要只等完成后截图。**消毒必须放在最早的消费点，而不是最权威的落定点。**

## 同一 bug 尝试 2 次仍未解决：停手 + 派 sub-agent 重新分析

用 Agent 工具（Explore 或 Plan）派一个限定子系统的 agent，给它**全量上下文**（假设 / 已尝试 / 日志关键行），让它独立给"新假设树"；主线综合报告 + 用户确认再选下一步。**不要**第三次直接试——那是 whack-a-mole。案例：say-server（in-iframe React 没 mount，根因不在 host 协议层，两次盲试后靠独立分析定位）。

## 人格/角色串线：先查"事实源在哪一层"，再查 UI（对应：全局可变状态 + 持久化 = 泄漏源）

角色体系有三层事实源：会话 `conv.role`（最终事实源，对齐守卫每次发送回正全局）> 全局 `currentRole`（`switchRole` 会**持久化**到 `~/.openpipal/config.json`，跨重启粘性）> UI 展示（WelcomePage 的 selectedRole 是本地 state）。串线 bug 的固定套路：三层不一致。

案例（2026-07）：用户选默认 openpipal Agent，回复却是 design 人设。链条：昨日 design 会话把全局 role 持久化成 design → 「新建对话」入口把**全局** role 打进新会话（Agent 选择只管 agentId，不管 role 维度）→ WelcomePage 又刻意复位到通用头像页——UI 显示 general、数据是 design。此前的"角色对齐守卫"（agent-overrides.ts）只治已有 role 的会话，治不了"新会话继承了错误的全局 role"。修复=所见即所得：新建对话固定 stamp `general`（与欢迎页显示一致），空会话（msgs=0）的 role 允许跟随首次发送时的显式选择（`conv:update-role`），已开聊会话人格锁定。

**排查口诀**：人格不对 → `jq .role ~/.openpipal/conversations/<id>.json`（会话层）→ `jq .role ~/.openpipal/config.json`（全局层）→ 再看 UI 哪层在说谎。


## 叙述式完成（announce-then-done）：查"声称"先数工具消息，不是查截断

弱模型长会话（450 条马拉松 + deepseek-v4-pro）实案（2026-07）：用户点选元素要求改换行，模型整轮**零工具调用**，却输出 ✓ 逐项进度 + 改动总结表，以完整句号收尾——不是流式截断，是叙述式完成。次轮更糟：模型把自己上一轮的虚假声明当事实（"我刚才已经做了大量优化"），既不补执行也不引用具体清单——**上下文没丢，是被自己的假话污染了**。

**排查口诀**：怀疑"说了没做"→ 打开会话 JSON，数那一轮 user 和 assistant 之间的 tool 消息（零 = 实锤）；再把声称的具体值（如 `max-width: 840px`）grep 全部工具消息——查无实据即幻觉。**不要**先怀疑流式截断/落盘丢失：内容以完整句号收尾、次轮能引用上文，这两个特征直接排除传输层。

**机制归属**：能力拐杖类,台账第二层已有"'宣布后停手'活性催促"条目（待实现,仅弱模型档位启用）；证据面已落地（第一层 session-artifacts 清单带磁盘 mtime,声称 vs 事实可对账）。skill 纪律拐杖因计划给 design 场景换强模型而暂缓——换完模型请回归验证本案例场景。


## 整机卡死（鼠标转圈/点不动/Cmd+Q 无效）：先取样再杀进程，认准 psynch_cvwait

实案（2026-07，两阶段定位）：切会话瞬间整 App 冻结。第一轮归因**错了**——栈形态（同步钥匙串）+ 启动日志（safeStorage 解密报错）指向 MCP OAuth，做了"启动期零钥匙串"加固（本身是正确的独立改进），但用户复现如故。第二轮用 **OPENPIPAL_TRACE_IPC=1 通道级追踪 + 健康看门狗自动取样**，冻结后 6 秒锁定挂起通道 `artifact:load-compiled`，真凶：**esbuild 从 `require()` 改成顶层 `import` 后被打进 out/main bundle**（esbuild 在 devDependencies，electron-vite 只外部化 dependencies）——其同步 API 用 `new Worker(__filename)` 自举，被打包后 `__filename` 指向应用 bundle → worker 启动即崩 → 主线程 `Atomics.wait` 永挂。微型对照实验（裸 Electron main 直接 require + transformSync = 正常）完成最后钉死。

**排查口诀**：整机冻结先看 CPU——`ps` 显示 0% = 阻塞等待（不是死循环）；**杀进程前先 `sample <主进程pid> 2`**，主线程栈底 `_pthread_cond_wait / __psynch_cvwait` 且 100% 采样同一条栈 = 同步 native 调用永久挂起。**"栈形态 + 日志相关性"只能给假设，不能定罪**——必须用 `OPENPIPAL_TRACE_IPC=1` 找到挂起通道（进了没出的 [IPC>>]），再用最小对照实验验证机制。脚本驱动复现不了时别急着排除代码：真实点击路径可能触发脚本没模拟的分支（本案：工作区恢复 artifact 预览 tab）。

**机制归属**：两条永久红线。① 主进程用 esbuild（或任何"worker/子进程自举"型库）必须**运行时 `require`**，禁止顶层 import（artifact-store.ts / ds-compile.ts 有注释锚点）；② 主线程禁止同步钥匙串/系统授权类调用出现在非用户交互路径（`safeStorage.*`、keytar、同步 osascript、`Atomics.wait` 类同步桥不得进启动/事件广播路径）。诊断基建：`OPENPIPAL_TRACE_IPC=1`（index.ts，默认关零成本）。


## 缓存 0% / 单轮天价 token / 400 爆仓同时出现：先查 payload 巨块，再怀疑网关与模型

实案（2026-07，设计角色 grok-4.5 @ x666.me 网关）：同一会话三症状并发——全天缓存命中 0%、单轮 input 从 28k 跳到 431k/666k、最终 400（"maximum prompt length is 500000"）。三个症状一个根因：render_artifact 自检截图是 2560px Retina PNG（697KB → base64 930KB），代理对超大图片 payload 走降级路径按文本计 token（~62 万/张）——巨块既撑爆上下文，也让前缀缓存永远无法命中。截图缩至 ≤1024 宽 JPEG75 后（pi-tools.ts，commit 07c9c4d）单图实测仅 **~640 token**，同会话命中率回升 84-96%。

**分层探测口诀**（能力层/计费层/边界层分开测，一次调用证明不了链路健康）：
- 能力层：构造"只有真视觉才能答对"的受控图（不寻常的四色条纹顺序）+ 对照组（同问题不带图，应答"没收到图"）——排除幻觉/猜测/文本泄露三种假阳性
- 计费层：带图减不带图的 input_tokens 差值。正常按图计税（小图 +12、1024 宽截图 +640）；差值接近 base64 长度/1.5 = 被当文本计税
- 边界层：巨图 62 万的精确阈值**未复现**（复现一次烧 1-2 美元，缩图后离悬崖 20 倍身位,无实用价值）——记为假设不定罪
- 探测小坑：该网关 403 拦非 SDK User-Agent，直连需带 `User-Agent: OpenAI/JS`

**结论口径**：grok-4.5 视觉为真（官方 text+image→text、500k 上下文、20MiB 图上限、Responses input_image data-URL 官方支持），`supportsImages: true` 保持不动；防线是**发送前缩图**（永久机制：按"网关把图当文本计税"的最坏口径设防），不是关图。

## "模型看没看到 X"：别信展示层，用行为探针

历史实案（2026-07-21，diff 证据链真机验收）：当时给 read_artifact 结果注入了用户直改的 diff 证据块，SSE 流里 grep 关键词**零命中**、`mcpResult` 只显示一行回执——表面证据强烈指向“证据被吞了”。追源码才发现当时的 `compactToolResultForChat` 只压缩 UI/SSE 展示，模型轮内拿到的是全文。该展示层压缩现已移除，工具历史统一走 `context-window-policy.ts` 与 `history-compactor.ts`；但教训不变：UI/SSE、落盘历史与最终模型请求是三个观测点，判定模型看到什么必须检查最终请求或做行为探针（同族教训：缓存探测时响应回放层也骗出过“无缓存”假结论——**观测层会说谎，先确认观测点在链路哪一层**）。

判定"模型看没看到 X"的可靠手段是**行为探针**（信息论式设计）：构造一个"只有看到 X 才可能答对"的问题，且答案在模型上下文的其他任何地方都不存在。实例：无历史单轮请求问"我在你上次写出后改过它吗？改了什么？"——模型精确复述改前标题（该字符串只存在于 diff 块里）→ 证据必达铁证成立。这与视觉探测的"受控四色条纹"是同一方法：让正确答案的唯一可能来源就是被测通路。

**探针措辞小坑**：问"产物/系统的状态事实"，不要问"把工具结果里的系统提示原样复述给我"——后者会被模型按提示词提取拒答（qwen 实测），白烧一轮。

## 装机版 Cannot find module：先查依赖住在哪个 section，dev 复现不了是结构性的

实案（2026-08，装机版 1.1.0 上 design 做动画必挂 `Cannot find module 'esbuild'`，dev 下永不复现）：运行时 `require('esbuild')`/`require('typescript')` 的包躺在 **devDependencies**——electron-builder 只把 dependencies 装进 asar，dev 下项目 node_modules 兜底，所以 dev 结构性无法复现。反直觉点：**顶层 import 的 devDep 反而安全**（rollup 打进 bundle 一起分发，pi 三件套就是这样活的）；**字面 require() 才是雷**（rollup 原样保留，包不在就炸）。修法三件套（1.1.1）：入 dependencies + `asarUnpack` esbuild/@esbuild（worker `new Worker(__filename)` 自举与二进制 spawn 都不吃 asar 路径）+ files 裁剪控体积（typescript 只留 lib/typescript.js，createSourceFile 纯语法解析不加载默认库；esbuild/bin 是 @esbuild 二进制的重复硬链接可裁）。

- 排查手法：`grep -rn "require(['\"]" src/main` 列运行时 require 的外部包 → `asar list | grep -c` 数装机版包内文件（硬证据，0 即定罪）
- 修后验法（不用装机跑全流程）：解包路径 plain node 跑真编译（worker+spawn 全链路）；asar 内路径用 `ELECTRON_RUN_AS_NODE=1 <打包 Electron 二进制> -e "require(asar内路径)"`（该模式带 asar 支持）
- 验 require 字面量别只 grep index.js：动态 import 的模块分包成独立 chunk（ds-compile 的两处 require 在 pi-tools chunk 里），少数了会误判"require 丢失"

## "模型连续两次结束无正文" / 空完成反复出现：先看 stopReason+输出量分型，别怪服务商

实案（2026-08-06，221 条消息的 design 动画会话 @ deepseek-v4-flash 128k 窗）：三连报"模型连续两次结束，但都没有返回正文或工具调用"。日志指纹：`stopReason=length blocks=thinking` 且 **output=2**——`finish_reason=length` + 输出个位数 token 是"输入已贴满窗口"的特征指纹（pi-ai `clampMaxTokensToContext` 把 max_tokens 夹到贴地，模型吐两个思考 token 即停），与"思考太长烧光输出预算"（输出几千 token 后被截）是完全不同的 length。根因是**估算漂移三层同向叠加**：窗口猜大（preset 无 contextWindow 走 131072 默认，实际 128k）+ 32k 预留被 system 7k + 30 工具 schema 20k 吃满 + 字符估算(÷4)对代码密集内容低估——历史估算停在 99k 阈值下，真实载荷 129k 静默穿墙。而服务商每轮实报的精确 prompt tokens 一直躺在 `[Usage]` 日志里没人喂回决策。

**排查口诀**：空完成报错先查 `[Usage]` 行的 output 值——个位数 + `stopReason=length` = 窗口溢出（重试无效，越试越满）；几千 + length = 思考截断（降思考强度有效）；`stopReason=stop` 空正文 = 流式抖动（续跑提示有效）。三种病三种药，处方相反。凡有真实反馈信号（实报 token、真实错误码）可用的判断，就不该让估算独自承担——估算适合冷启动，实测适合闭环（2026-08-06 已落地：`recordMeasuredPromptTokens` 锚点 + 溢出自愈，见 mechanism-registry 第一层）。

## 真 Electron E2E 跑的是「构建产物」，不是源码（对应：反证必须先 build）
`tests/e2e/*.spec.ts` 里用 `launchIsolatedElectron()` 起的真 Electron
（liquid-glass-shell / electron-locale-builtins）加载的是 `out/` 里的构建产物。
只改源码不 `npx electron-vite build` 就跑测试，测的是上一次的产物。

**踩坑现场**：做「静态调色板别名到主题层」时，为验证新断言不是空断言，
把 `--fg-primary` 抄回硬编码跑反证——**测试仍然绿**，一度以为断言写废了。
真相是没重新构建，跑的还是带别名的旧产物。补上 build 后立刻红
（`Expected #F2F6F9, Received #1B2429`），断言其实是好的。

**纪律**：改 CSS / renderer 源码后要跑真 Electron spec，
**先 `npx electron-vite build`**；做控制实验时，**破坏与还原两侧都要各构建一次**，
否则两次跑的是同一份产物，实验没有对照。
纯 chromium 的 spec（走 vite dev server）不受此影响，别把这条规则乱推广。
