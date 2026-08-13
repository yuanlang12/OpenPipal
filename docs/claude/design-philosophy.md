# 核心设计哲学

设计新能力或新工具时必须遵循以下两条原则。

## 渐进式披露（Progressive Disclosure）— 所有"对 AI 可见的资源"都必须遵循

这是 OpenPipal 和 Anthropic Agent Skills 规范共享的核心原则：**不要一次性把所有可能用到的资源塞进系统提示词，只暴露索引，让 AI 按需加载**。

三层加载模型（必须按此结构设计任何新能力）：

```
Tier 1 — 索引层（system prompt，always loaded）
  只含元数据：name, description, location/path
  成本：O(N × ~50 tokens)，N 是资源数量
  示例：formatSkillsForPrompt() 输出的 XML 索引

Tier 2 — 入口层（按需单次加载）
  AI 判断"我要用这个"后，用通用 read 工具读入口文件
  只加载一个文件（如 SKILL.md 主文件、memory/{name}.md）
  成本：~1-5K tokens per load

Tier 3 — 子资源层（按需二次加载）
  入口文件里指引 AI 读取具体的子资源
  AI 根据当前任务决定要读哪一个（不是全部）
  成本：最精准，只付必要的 tokens
```

**违反原则的反模式**（代码审查时警惕）：

- ❌ 在 system prompt 里直接注入 SKILL.md 的完整内容
- ❌ 写一个 `load_skill(name)` 工具一次性返回 SKILL.md + 所有 references/*.md（tier 3 退化为 tier 2）
- ❌ 让 AI 在每次对话开始时"预加载"可能用到的所有记忆
- ❌ 把 artifacts 目录里所有历史产物一起塞进 prompt

**正确的实现模式**：

- ✅ 索引层：只含 name + description + path
- ✅ 加载层：AI 用通用 read 工具读单个文件
- ✅ 让 AI 自主决定何时加载、加载哪个
- ✅ 入口文件（如 SKILL.md）用相对路径引用子资源，让 AI 自主跳转

**适用范围**：这个原则应该贯穿 OpenPipal 所有"资源型能力"的设计：
- Skills（已实现，见 `skill-manager.ts` + Pi 的 `loadSkills()`）
- Memory（当前是 eager loading，短小精悍可以接受，但如果 memory 变大要升级为渐进式）
- Artifacts（HTML 产物、生成的文档等，将来必须按需加载）
- Tools/MCP configs（Agent 专属工具配置也应该懒加载）
- Scheduled Tasks（定时任务的元数据 vs 完整 prompt）

**一个例外**：system prompt 里的工作空间布局描述（`buildWorkspaceLayoutPrompt`）不走渐进式披露 — 它是**always-needed context**，每次对话都要用。但它只含路径规则，不含资源内容，所以成本有限且值得。

**评估标准**：设计新能力时问自己 —
1. 这个资源的**索引**有多大？（tier 1 成本）
2. AI 需要它的**概率**是多少？（决定是否要 tier 2/3）
3. 能用通用 read/write 工具加载吗？如果不能，为什么要引入专用工具？
4. 专用工具的 description 会占多少 tokens？和通用工具相比，值得吗？

**历史参考**：`Pi skills refactor` memory 文件记录了 OpenPipal 从自写 skill-manager（违反渐进式披露）迁移到 Pi 的 `loadSkills()` 的过程。Stage 2 删除了 `load_skill` / `create_*_skill` 专用工具，彻底 Unix 化。这是渐进式披露原则在实践中的范本。

---

## 通用工具优先（Unix 哲学 + CLI 优先）— 新增能力的工具设计必须遵循

**核心理念**：AI 是程序员，不是按钮操作员。每多一个 tool definition 就是多一个"按钮"，每轮对话固定多消耗 200-500 tokens。优先让 AI 用已有的通用工具（bash/read/write/grep）组合完成任务，而非新增专用工具。

**工具分层原则**：

```
第 1 优先：能用现有 Unix 工具（bash/read/write/edit/ls/find/grep）组合完成吗？
  → 是：只需在 buildWorkspaceLayoutPrompt 里告诉 AI 路径和文件格式即可
  → 例：记忆读写 = write + grep + read 到 memory/ 目录

第 2 优先：能暴露为 CLI 命令让 AI 通过 bash 调用吗？
  → 是：实现为 CLI，零额外 tool definition 开销
  → 例：openpipal schedule create --cron "0 9 * * *" --prompt "..."

第 3 优先：必须作为原生 tool definition 吗？
  → 仅当工具需要触发 renderer UI（如 ask_user, create_visualizer, create_artifact）
  → 或需要平台原生 API（如 capture_screenshot, read_screen）
```

**违反原则的反模式**：

- ❌ 为纯文件 I/O 操作新增专用工具（如旧版 `save_memory` / `recall_memory` / `load_skill`）
- ❌ 为 HTTP API 调用新增专用工具（AI 可以用 bash + curl 或 execute_code 调用）
- ❌ 在 tool description 里教 AI 如何选择工具（浪费 tokens，AI 根据 name + description 自己判断）
- ❌ 为每个 MCP server 的工具写独立的 tool definition（用 tool_search + call_mcp_tool 网关）

**实际效果**：OpenPipal 通过这个原则已经完成了两轮工具精简：
1. Stage 2 Skills 重构：删除 `load_skill` / `create_global_skill` / `create_agent_skill` 3 个专用工具
2. 记忆 Unix 化：删除 `save_memory` / `recall_memory` 2 个专用工具

每删一个工具省 ~300-500 tokens/轮，5 个工具合计省 ~1700 tokens/轮。

## 产品架构原则——细则与反例库（配合 CLAUDE.md「产品架构原则」使用）

CLAUDE.md 保留原则条文，细则、反例、检查清单沉在这里。

### 文件式 > 字段式（细则）

OpenPipal 已有一致的 opt-in 模式——`tools/config.json`、`skills/{name}/SKILL.md`、`memory/*.md`、`workspace/assets/`、`system-agents/<role>/`、`agents/<id>/`。核心约定：**文件存在即 feature 开启**。用户/未来 agent 直接加减目录即可，无需改 TypeScript schema、无需改代码。

不要因为"加一个 TS 字段只要 5 分钟"就省事——字段式要改接口、要分发 schema、要改前后端序列化、用户无法 override。文件约定才是 OpenPipal 一贯的 opt-in 机制。

### 能力归属判定

- 只有一个角色用 → 放**该角色目录**里的一个可选文件
- 多个角色可能都用 → 放**框架层**，通过机制（manifest / hook / 约定）而非硬编码暴露给所有角色

### 复用命名空间，不要新造

- 不给特定能力新造 IPC 前缀（❌ `design:xxx`）——复用通用命名（✅ `chat:xxx` / `assets:xxx`）
- 不给特定能力新造存储目录——复用 `workspace/assets/`、`system-agents/<role>/` 等已有结构
- 不给特定角色加专属 `ConversationConfig` 字段——用通用桶（`conversationConfig.roleBrief[roleName]`）+ 角色目录里的文件声明

### opt-in 验证标准

新能力不启用时对现有 agent 零影响：不被使用时代码路径走不到；不用它的 agent 不会因它变慢/变繁琐。否则就不是真正的 opt-in。

### 典型反例（历史真实犯过/差点犯的）

- ❌ `design:preflow-submit` IPC → ✅ `chat:preflow-submit` 通用事件
- ❌ `ConversationConfig.design: { fidelity, taskType }` 专属字段 → ✅ `conversationConfig.roleBrief[roleName]` 通用桶 + `system-agents/design/preflow.json` 文件声明
- ❌ 把长期资料做成每个 Agent 的通用“资产”页签 → ✅ 设计长期资料归设计系统；本次任务资料归“来源”；不设混合用途的常驻资料库
- ❌ `RoleConfig.preflow: PreflowManifest` TS 字段 → ✅ `system-agents/<role>/preflow.json` 文件，role-manager 按路径读取
- ❌ `pendingQuestionsV2` state + `WorkspaceTabKind='questions'` + 独立 QuestionsTab（Phase 3 首版犯过）→ ✅ `ArtifactType` 加 `'questions'`，走统一 artifactStore → useArtifactWorkspaceBridge → ArtifactTab switch case

### 新 workspace 展示物检查清单

设计新"侧栏可展示产物"（deck、白板、diagram、tweaks 控制台、comment 面板等）前自问：

1. 它是 agent 通过工具产出的吗？→ 是 → 工具 execute 返回 `details.artifact = { type: 'xxx', content: ... }`
2. 它在 WorkspacePanel 侧栏展示吗？→ 是 → 加到 `ArtifactType` union，在 `ArtifactTab` switch 加 case，**禁止**新增 `WorkspaceTabKind`
3. 它需要打断 agent loop（像 ask_user / questions_v2）？→ 是 → **只有** loop break 语义走独立 event adapter 分支，UI 展示部分仍走 artifact 管道
4. 它是用户会带走/回看/迭代的**交付物**，还是过程 UI 载体（todos/questions 这类）？→ 过程物加进 `EPHEMERAL_ARTIFACT_TYPES`（artifact-store.ts）：复用管道但不落盘/不进历史/不进模型清单/不参与去重，用完即清。**复用管道 ≠ 同等待遇**——没有这个标准，产物层会变垃圾场，垃圾输入带来垃圾输出。

content 字段任意字符串：HTML / Markdown / `JSON.stringify(payload)` 都可，ArtifactTab case 里按需反序列化。
