# 机制台账（Mechanism Registry）—— 分层与日落条件

> 判定公式：**"如果模型是完美的，这个机制还需要存在吗？"**
> 是 → 永久架构；否 → 能力拐杖，出生时必须登记日落条件。
> 配套原则见 CLAUDE.md「机制分层与日落」；设计哲学见 [design-philosophy.md](design-philosophy.md)。

## 第一层：永久架构（模型无关，越强越值钱）

竞态、并发、成本、信任边界、数据治理与模型智能无关。这一层放心加，永不日落。

| 机制 | 位置 | 解决的确定性问题 |
|---|---|---|
| artifact 注册表 + 同步落盘 | `pi-tools.ts` / `artifact-store.ts` | create→render/edit 的落盘竞态 |
| 按会话 abort（P3，规划中） | `ipc-handlers.ts` | 会话 B 发消息误杀会话 A 的流 |
| 前缀缓存三原则（stablePrefix / runtime-context 尾注 / 历史字节单调化）+ 按服务商设置缓存路由、保留时长和显式断点 | `pi-agent-service.ts` / `config-manager.ts`（`withSessionStreamOptions` + `resolveCacheRetentionForModel`）/ `model-prompt-cache-guide.md` | token 成本。OpenAI、Anthropic、Bedrock 与兼容网关的断点字段不同；新增模型必须按维护指南核对官方协议、捕获请求体并用真实 cached token 验收，不能把专有字段广播给所有网关 |
| 历史整体压缩（按模型 Token 窗口保近概括远，触发=字符估算 ∨ 实报锚点双信号） | `history-compactor.ts` / `context-window-policy.ts` | 上下文经济学——平时保持追加式历史；单个工具结果首次进入时确定性限长；只有总量接近模型窗口时整体概括较早历史，不按年龄、工具名或“是否消费”卸载。**证据式预算**（2026-08-06）：服务商每轮实报的 prompt tokens（`recordMeasuredPromptTokens` 锚点）与字符估算取或触发——估算只覆盖历史消息且对代码/中文系统性低估，曾三层近似同向漂移致 129k 载荷静默穿过 99k 阈值（deepseek 128k 窗实案）；实测值覆盖完整载荷（system+tools+注入），对齐 pi-ai `estimateContextTokens` 的锚点思路。锚点按 model 校验不跨模型沿用，进程内存态、重启冷启动一轮回落估算 |
| 上下文溢出自愈（length+近零输出分型 → 强制压缩重建 → 原地重试一次） | `empty-completion-guard.ts`（`isContextOverflowCompletion`）/ `pi-agent-service.ts`（`rebuildAfterOverflow`） | 资源耗尽型失败的处方与流式抖动相反——窗口满时盲目续跑每次再追加消息只会更糟（2026-08-06 实案：三连撞墙全走了续跑）。判据对齐 pi-ai `utils/overflow` 判据三（pi 自家只在 pi-coding-agent AgentSession 消费，裸 Agent 层缺位，宿主自建）。压不动或重试仍空 → 报"窗口上限"真话文案（不再怪罪服务商）。窗口溢出是物理约束，模型再完美也会遇到，永久 |
| Agent Plugins 校验与失败边界（manifest 闭集校验 / 路径不出插件根 / env 禁嵌密钥与保留键 / 单 server 失败不连坐） | `plugin-manager.ts` | 第三方包进入本机执行链路的安全与数据治理——插件目录来自外部（GitHub/文件夹），路径逃逸、伪造 command、非环回 http 都是不可逆/高代价错误，硬拒绝正当。失败边界遵循规范：包无效→拒包；mcp.json 无效→只禁该包 MCP；单条 server 无效→只跳该条 |
| 工具轨迹跨轮完整回放 | `tool-trail.ts` / `pi-agent-service.ts`（convertHistoryToPiMessages）/ `chat/messages.ts`（放行 role:'tool'） | 上下文正确性——跨轮保留工具名、完整参数、结果、图片或附件引用并恢复成成对的 Pi toolCall/toolResult。单个超长结果由 `context-window-policy.ts` 保留头尾，总量由统一历史压缩兜底；不再存在类内预算、回执替换、三档衰减或消费后卸载 |
| 用量落盘（`usage.jsonl` 逐次调用记账：input/cacheRead/cacheWrite/output + `trailTok`/`trailMsgs` 轨迹占比 + 每轮汇总；8MB 滚一代；`usage-report.mjs` 按模型分组出命中率与轨迹占比） | `usage-log.ts` / `pi-agent-service.ts`（Usage 观测点）/ `scripts/diagnostics/usage-report.mjs` | 成本可观测性——多轮对话成本是 N²（一"轮"里每次工具调用都是一次完整重发），唯一的减法是前缀缓存，而**命中率不可推断、只能实测**（网关是否做隐式缓存、TTL 多长、前缀被哪次改写打断，都不写在任何文档里）。没有这份记录，缓存策略是否有效只能靠猜。只观测不改行为，写失败一律吞掉 |
| 三层安全 + artifact sidecar 写封锁 | `pi-security.ts` | 信任边界（写封锁兼有"产物存储单一写入方"的数据完整性不变量） |
| EPHEMERAL_ARTIFACT_TYPES 标准 | `artifact-store.ts` | 数据治理——垃圾输入带来垃圾输出 |
| 测试/对话统一管线 + content-type 守卫 + 辅助路径思考口径统一（`resolveAuxThinkingLevel`/`auxCompletionTuning`：标题生成/记忆抽取/dreamer/extractor/simple-completion/GoalChecker 与主链路同款"能力位→'low'"决策，开思考同步 +2048 maxTokens 余量） | `config-manager.ts` | 双路径漂移；200+HTML 假成功；硬编码关思考被强制思考模型 400 拒（2026-07-23 实案：qwen3.8-max-preview 致 TitleGen/记忆抽取/GoalChecker 每轮静默失败）。已知例外：subagent-runner 仍硬编码 'off'——子代理模型由 profile 钉住且刻意选低价档，若某 profile 钉强制思考模型会复现同款 400 |
| 能力位体系（supportsImages / supportsThinking / contextWindow / supportsEffortDial 派生） | `config-manager.ts` | 声明式模型适配——同时是拐杖的自动日落开关。Qwen 按“服务商默认 + 单模型覆盖”解析 `thinking_budget`：官方 Model Studio 的非 Coder Qwen3 自动使用保守三档，第三方网关默认只显示开关，显式配置预算后才亮档位菜单；新增服务商必须用真实请求确认其是否透传该字段 |
| 服务商实体化（configVersion 2：modelProviders + providerId 挂接 + resolvePresetConfig 解析视图 + loadConfig 惰性迁移带 .bak） | `config-manager.ts` | 数据治理——连接信息单一事实源（换 key 一处生效、9 预设去重成 7 实体实测）；红线附带修复：内置 .env 连接信息与模型名此前经预设编辑路径明文可见，现 IPC 边界拒发 + 掩码（短 key 全遮防"前6后4"整段泄露） |
| voice-tool-truncate 结果保真 | `voice-tool-truncate.ts` | 语音信道的物理带宽约束 |
| 随消息图片落盘 + 路径事实注入（官方 uploads/ 形状） | `chat-uploads.ts` / `pi-agent-service.ts` / `dcRuntime.ts` / `dc-headless.ts` / `dc-export.ts` | 信息缺口非能力问题——粘贴图只进视觉上下文时磁盘上无文件可引用，模型再完美也无法引用不存在的文件（2026-07-22 实案：找图 → 全盘 find → TCC 连环弹窗）。落盘 `artifacts/<conv>/uploads/pasted-<ts>-<i>.png` + 消息注入路径事实；srcdoc 预览 data URI 内联、headless 导出内联、交付包随包拷贝，四条消费路径同源 |
| 主目录/全盘遍历需确认（`detectHomeWideScan`） | `pi-security.ts` | 隐私暴露面治理——读操作无破坏性但 `find ~` 触达桌面/iCloud/照片全域（含 TCC 连环弹窗）；沙箱只管写与网络不管读隐私，故不因沙箱降级。明确子目录不拦；永久（隐私边界与模型能力无关） |
| 角色辅助文件 seed hash 自愈（`seedRoleExtraFiles`） | `role-loader.ts` | 升级通路/数据治理——此前"存在即跳过"导致 preflow.json 等辅助文件的种子更新永远到不了存量安装（2026-07-22 模板扩展实案：新模板选项无法下发）。与 agent.md 同款语义：未被用户改过（hash 对账）→ 自动升级；改过 → 用户权威；无 hash 的存量文件内容恰好等于种子 → 补记 hash 打通后续通路 |
| API key 按请求显式注入（`withSessionStreamOptions`〔原 withSessionApiKey，2026-07-23 扩展为通用会话流选项注入器,兼管 cacheRetention〕 + 三处 completeSimple 显式 apiKey） | `config-manager.ts` / `pi-agent-service.ts` / `subagent-runner.ts` / `evolver-agent.ts` / `agent-dreamer.ts` / `agent-extractor.ts` / `memory-store.ts` | 多租户凭证正确性——process.env 是进程级单例，与"同进程多会话各持 key"结构性互斥（会话专属模型上线后并发互踩 401 实案）。契约依据：pi-ai 公开 API `StreamOptions.apiKey` 显式优先于 env（0.74→0.80.10 逐字核验稳定；0.80 新 api 层仅认 options.apiKey 且新增 ProviderEnv 请求级作用域——上游同向演进）。安全审计（2026-07-21）：key 流向仅 `createClient→Authorization 头`，全 provider 源码零日志涉键，onPayload 观测钩子只见请求体见不到头；对比 env 承载反而收窄暴露面（env 会被 agent 的 bash 子进程继承）。分发核验：安装包对本机全部 8 个密钥指纹 0 命中、无 .env 随包（electron-builder 排除项生效）。env 仍设置仅作未覆盖路径兜底 |
| session-artifacts 清单带"最后真实修改"（磁盘 mtime） | `pi-agent-service.ts` / `artifact-store.ts` | 外部状态可观测性——模型无法凭上下文知道工具调用是否真的落了盘；"声称改过 vs 磁盘事实"可对账（2026-07 叙述式完成实案的证据面，配合第二层"宣布后停手"催促） |
| 开源发行签字门闩（策略即清单 + 内容哈希绑定签字 + 签字只落候选侧） | `config/open-source-policy.json` / `scripts/make-open-source-cut.mjs` / `scripts/verify-open-source-candidate.mjs` / `tests/unit/open-source-candidate.test.ts` | 数据治理——「哪些文件可以对外公开」是所有者的决定，不是 agent 的判断。套判定公式：模型再完美也不该替人决定他的私仓发布什么，与能力无关，永久。机制：每条路径由唯一一条终局规则分类；每条规则的批准**绑定候选树的内容哈希**，内容改一个字节则 17 条签字全部自动失效（`RULE_REVIEW_PENDING`），必须重签而不是重跑。校验器只读已提交的 git 对象（`evidenceOnly`），工作区脏不脏都不影响定论。**2026-08-13 实案（本机制的第一次失效）**：agent 改了 6 个文件后，用「重新钉哈希」把失效的签字重新激活——门闩正确报了 15 条 PENDING，但重钉这个动作既是正常流程的一步、又是使签字复活的开关，两件事没分离。根因是私仓那份策略带着 APPROVED：它可以被无限次重新裁剪，等于一张空白支票。修法不是加检查，而是把签字的**存放位置**从可再生的模板挪到不可再生的成品——私仓侧签字栏常驻 `PENDING`（`signingSurface: candidate-only`），所有者签的是算完哈希之后的候选提交；`open-source-candidate.test.ts` 有一条断言钉住「私仓策略不得带签字」。退出条件：无，永久 |
| artifact 写入对账门闩（`lastKnownMtimeMs` 基线 + `evaluateArtifactWriteGuard`） | `artifact-registry.ts` / `pi-tools.ts` | 数据治理/竞态——用户经 UI 直改 artifact 落盘后，`create_artifact` 同 id 全量重发从不读盘会静默覆盖用户的修改；套判定公式：模型再完美也不知道用户在它两轮之间改了磁盘，这是外部状态可观测性缺口，不是模型能力问题，永久成立。机制：`upsert`/`read_artifact`/`edit_artifact` 成功后把磁盘 mtime 记为基线，`create_artifact` 写入前对账磁盘当前 mtime 是否领先基线超过 1.5s 容差，领先则拒绝并指路 read_artifact（读/改后基线刷新，循环收敛）。**diff 证据链（2026-07-21 补全下半程）**：mtime 只能证明"被改过"，模型上下文里未必有它自己上一版原文，光靠 read 全文无从识别哪些字是用户改的（信息缺口非能力问题——2026-07-20 真机实测：模型 read 后重做仍丢用户改的标题）。注册表另存 `lastAgentContent` 快照（create/edit 写出后刷新、read 不动），read_artifact 发现磁盘与快照不一致时把 `buildExternalEditEvidence` 算出的 diff 附进读取结果——保不保留、怎么整合由模型判断（确定性归代码，判断力归模型）。2026-07-21 真机验收（生产 app + qwen 主档）：证据必达有铁证（无历史单轮行为探针，模型精确复述用户直改的改前/改后，唯一信息源即 diff 块）；行为面实证=风格重做保住了用户改的标题语义（此前同场景标题被整个丢弃），弱档丢"明显像脚手架"的标记后缀属合理裁量——diff 是证据不是命令，符合设计意图。已知限制：注册表是内存态，应用重启后首个回合无基线不设防、无快照不出 diff——可接受，重启后模型上下文里通常也没有旧内容可覆盖，谈不上"覆盖用户修改"。退出条件：无，永久（`artifact:save` 这条 UI 直改路径本就是意料之中的外部写入源，不是待消灭的过渡态）。 |

## 第二层：能力拐杖（为当前弱模型建，到期必拆）

日落触发是**能力实证，不是日历**：换上某档模型后实测该行为可靠，才拆。
细分两种：**零成本型**（输入干净时是 no-op，不限制模型）可长期保留；**拒绝式/约束式**（reject、强制步骤、自动干预）有误伤面，模型越强误伤越多，必须日落。

| 机制 | 类型 | 存在理由 | 日落条件（能力实证） | 退出方式 | 误伤面 |
|---|---|---|---|---|---|
| legacy Runtime 回滚阀门（`OPENPIPAL_AGENT_RUNTIME=legacy` 保留旧实现整条路径） | 零成本型（不选就走不到，对默认路径零影响） | 2026-08-10 默认已切 pi-core（20/20 受控样本 + 两家服务商连续性矩阵各一次通过）。但曾出现一次**至今未归因**的 legacy 静默挂起，根因未明前需要一个改一个环境变量就能退回去的通道 | ①pi-core 作为默认稳定运行一个观察期且零不可归因挂起，**且** ②那次挂起的根因已查明或已被证明缓解 | 按 `docs/architecture/runtime-v2-migration.md` 的删除计划执行；**先拆 `pi-tools.ts` 与语音管线的耦合**（它表面是 legacy 门面，实际 `realtime-tool-bridge.ts` 在用，机械删会坏语音且编译期无信号） | 低（不选就不触发；代价是每次产品改动要在两个 Runtime 各改一遍，已有多次实例） |
| 动画门闩（taskType 绑定 / anti-inline / 截断检测 / 重复创建去重） | 拒绝式 | qwen3.6/3.7 无视模板选择、内联引擎源码、截断落盘 | 模型可靠按 roleBrief.taskType 产出且不内联 | 已有逃生舱 `<!-- non-anim -->`；整体拆除删 `pi-tools.ts` 门闩块 | 中（正当的非动画首产物需声明逃逸） |
| 文件工具改道提示（`fileToolHint`：execute_code 的代码命中纯文件读写特征 → 结果尾部附一行"本机有 read/grep/edit/write"） | 零成本型（只附文本，不拦不改行为） | 模型有 grep/read/edit 却用 `open(路径).read()` + 正则找内容（2026-07-29 design 实案）。绕道三笔代价：多一次用户确认（沙箱未启用时 execute_code 每次要点允许）、整篇文件进上下文、产物脱离 artifact 管线 | 连续多轮 execute_code 零命中该正则（模型自发优先选文件工具） | 删 `file-tool-hint.ts` 与 `pi-tools.ts` 里那一处拼接 | 极低（只是多一行提示；`open()` 为真计算而读时提示无害，模型可无视） |
| 回执门闩（artifact 三工具 + write/edit 文件通道 + execute_code 代码通道，拒绝 `[内容已保存…]` 占位入正文） | 拒绝式 | 模型把上下文压缩回执当正文复制：11KB 场景被覆写成 73 字节（2026-07 实案 ①）；write 文件通道漏拦致 bow-os 设计 token ×2 + 教案 21552 字符被覆写（2026-07-26 实案 ②，教案不可恢复）；write 被拦后模型改走 execute_code python 写文件（实案 ③，同日） | 模型可靠区分回执与正文（换强模型后跑改稿回归） | 删 `pi-tools.ts` 三处 + `pi-security.ts` classifyToolRisk 两处 `containsReceiptPlaceholder` 检查；识别函数保留（UI 损坏态提示复用） | 极低（正文合法包含该串≈不可能；edit old_string/oldText 已豁免供修复）。若门闩生效后仍出现回执落盘，即证明存在执行侧重放路径，需另查 |
| questions_v2 宽容解析（schema Union + 叶子元素收敛） | 零成本 | 弱模型 schema 偏差双向（结构发扁/叶子发胖），曾致 React #31 白屏 | 无需日落——干净输入零成本，属 Postel 法则 | — | 零 |
| 逐屏文本摘要自检（代替视觉核对） | 能力位门控 | qwen3.7-max 无视觉 + photon WASM 失效 | **自动**：`supportsImages !== false` 时截图直接入工具结果 | 换视觉模型即自动升级，零改动 | 零 |
| advisor 档位（执行弱模型 + 工具调强模型问建议） | 经济性 | 成本套利：大部分 token 走便宜档 | 执行档自身判断力足够时降为可选 | 删 `~/.openpipal/subagents/advisor.md` 一个文件 | 低（多一跳延迟） |
| 流式残片取证 ring buffer（`window.__dcStreamDebug`，dev-only） | 诊断拐杖 | 流式期"顶部裸属性文本"残片未逐字节归因（实验已证伪残 tag 直漏假设），需真实复现样本定罪 | 残片根因定罪并修复后即拆 | 删 `HtmlPreview.tsx` 的 `recordStreamDebug` 及三处调用 | 零（DEV 构建外是 no-op） |
| design 角色 memory: off | 文件式开关 | 记忆抽取把任务过程存成跨会话偏好（污染实案） | 记忆系统治理完成（抽取质量可信） | 删 agent.md 一行 frontmatter | 低（失去跨会话个性化） |
| "宣布后停手"活性催促（已确认待实现） | 干预式 | 弱模型 announce-then-stop（零工具调用即结束 turn） | **出生即带**：仅弱模型档位启用，强模型档位不注入 | 按模型档位配置，非硬编码 | 中（误判正常文本回答为空转） |
| SKILL_USAGE_NUDGE（技能索引尾部催促"匹配就先 read SKILL.md"） | 零成本 | 官方 docs 原话 "models don't always do this"——弱模型见索引不读正文（Pi 研究时发现的漏登记拐杖，2026-07 补记） | 无需日落——纯提示词一句，强模型本就会读，不构成约束 | 删 `skill-manager.ts` SKILL_USAGE_NUDGE 常量即退 | 零 |
| 空完成盲目续跑（thinking-only/空 content 时注入一条内部续跑提示重试一次；2026-08-06 补登记——出生时漏登） | 干预式 | 弱模型/部分网关正常收流但只回思考不回正文（流式抖动或"只想不说"）；pi agent-loop 对此完全不处理直接收尾 | 换强模型后连续多轮零触发（`[Pi] 检测到空完成` 日志计数） | 删 `empty-completion-guard.ts` 的续跑提示分支（溢出分型与自愈属第一层，保留）；调用点不动 | 低（重试前已确认无正文无工具调用，不会重复执行操作；2026-08-06 起溢出型失败已分流，不再误吃这药） |

## 第三层：提示词脚手架（随模型档位可换，最先拆）

步骤脚本对强模型是降智约束。全部走文件式（`system-agents/<role>/agent.md`、`skills/*/SKILL.md`），按角色/按模型替换，不涉及代码。

| 脚手架 | 位置 | 说明 |
|---|---|---|
| design 步骤绑定（步骤1 taskType 绑定、步骤8 核对文本摘要） | `system-agents/design/agent.md`（seed 在 `role-manager.ts`，seedhash 保护） | 弱模型需要显式步骤；强模型给目标+证据即可 |
| 全局替换 grep 纪律、逐幕 edit 骨架 | 同上 + `skills/animation-basics/SKILL.md` | 防弱模型整文件重写/一次性长产出截断 |
| SKILL.md 间距硬规则（8px 系统/abs≥16px） | 四份设计类 SKILL.md | 强模型有设计判断力后可放宽为参考值 |
| VOICE_ETIQUETTE | `realtime-session.ts` | 语音场景礼仪，偏永久（信道特性非模型能力） |

## 出生规范（新增机制必须遵守）

1. **先判层**：用判定公式定层级；拐杖必须在本台账登记（表格加一行），声明日落条件、退出方式、误伤面。
2. **优先证据式，慎用拒绝式**：给模型事实（文本摘要、lint 结果、截图）让它自己判断——证据式随模型智能升值；硬 reject 只用于**不可逆或高代价错误**（截断产物落盘、敏感路径写入）。
3. **拐杖必须带退出机制**，优先级：能力位门控（自动退场）> 逃生舱口（模型可声明穿过）> 文件式开关（删文件即退）> 硬编码（禁止——必须人拆的拐杖不许进主干）。
4. **升级模型时的例行动作**：翻本台账第二、三层，逐项做能力实证，满足日落条件的当场拆。
