# 课堂实时教学融合 — 路线图（待办）

**创建日期**：2026-04-23
**上下文 commit**：`6bfd575`（Phase 1-7 悬浮球 + 本地 STT + Presenter 呈现链路已落地）

## 背景与问题

当前 orb 模式端到端延迟 7-11 秒（STT 2s + AI 首 token 1.5s + 生成 HTML 2-3s + 第二次 LLM 调 present 1-2s + 窗口创建 0.5-1s）。对课堂实时教学来说，这会打断老师讲课节奏——即使压到 5 秒，一堂课触发 10 次就停 1 分钟。

**根因洞察**：老师讲课是**连续的**，AI 计算是**离散的**。现有设计让老师停下等 AI 把离散嵌入连续。正确范式是 AI 在老师背景工作，老师有需要时瞥一眼。

**用户偏好方向**：不追求"真降延迟"，追求**改变延迟的组成结构**——通过预制组件 + 课前预热，让绝大多数请求跳过 HTML 生成，直接命中快路径。

## 三层响应模型

| 层 | 触发 | 延迟 | 内容来源 |
|---|---|---|---|
| **Hot 预热** | 课前已缓存的精准匹配 | ~50ms | 读磁盘 artifact 文件 |
| **Warm 模板** | AI 选模板 + 填参数 | ~500ms（单次 LLM 决策，无 HTML 生成） | 预制 React 组件库 |
| **Cold 动态** | 模板库无法覆盖时，AI 从零生成 HTML（当前行为） | 3-5s | 现有 `create_visualizer` |

AI 决策顺序：老师语音请求 → 查 hot 缓存 → 查 warm 模板 → 都不行走 cold。预期**教学 80% 需求命中 hot/warm**。

## 架构对齐（不重复造轮子）

这条路径完美对齐 OpenPipal 已有模式：

- **"design" 角色的 kit/ref/spec**：就是预存资源 + agent 调用而非生成。teacher 角色复用这个模式。
- **文件式 > 字段式**：学段 / 学科通过 `system-agents/teacher/subject.json` / `grade.json` 加载，不改 TS schema。
- **Artifact 管道复用**：预热缓存复用现有 `~/.openpipal/artifacts/` 结构 + `ArtifactType` 分类，不新造 cache store。
- **Task / Dreamer 复用**：预热生成可以挂在现有 scheduled task 或夜间 dreamer 时段，不新建后台作业系统。

## 预制组件库（第一期：数学 4 个）

| 模板 | AI 参数 | 自带交互 |
|---|---|---|
| `<FunctionPlot>` | 函数表达式、x 范围、点标记 | 拖缩放、hover 坐标、参数滑块实时重绘 |
| `<NumberLine>` | 数值集合、标记位置 | 拖点、显隐区间 |
| `<Matrix>` | 行列数据 | 单元格编辑、行列运算按钮 |
| `<GeometryDemo>` | 点线面集合、关系 | 拖点、角度自动显示、距离测量 |

技术栈：SVG + 轻量 JS（如 `function-plot.js` ~18KB），不依赖重型库。**第一期 4 个覆盖中学数学 70% 场景**。

### 关键交互设计

**第一次触发不调 AI**——只有模板 + 默认值直接渲染。用户在 UI 上拖拽/点击/修改参数时**才调 AI** 做智能扩展。绝大多数教学场景根本不需要 AI 重新生成，预制模板 + 用户交互已经够。

## 预热机制（课前备课）

```
老师课前对 OpenPipal 说（或通过 UI 上传）：
  "这节课讲二次函数 y=ax²+bx+c，学生初三，重点讲对称轴和顶点"

OpenPipal 后台（可以在夜间 dreamer 时段跑）：
  ├─ 生成 3 个预期可视化 artifact（不同 a/b/c 的对比图）
  ├─ 每个打标签：{topic: '二次函数', concept: '对称轴'}
  └─ 写入 ~/.openpipal/artifacts/cache/teacher-classin-YYYYMMDD/

课上老师说"画一个 y=x²-2x+1 给他们看"：
  ├─ AI 查缓存 → 命中"二次函数"标签 → 50ms present
  └─ 未命中 → 走模板（500ms）
```

## 学段/学科差异化

通过 `system-agents/teacher/` 下的配置文件（文件式约定）：

```
system-agents/teacher/
├── subject.json       # 数学/物理/语文/英语/...
├── grade.json         # 小学/初中/高中/大学
└── templates/
    ├── math/*.tsx     # 数学模板
    ├── physics/*.tsx  # 物理模板
    ├── chinese/*.tsx  # 语文模板
    └── english/*.tsx  # 英语模板
```

不同学段学科加载不同模板集 + 不同参数默认值（小学 vs 大学的函数图默认复杂度不同）。

## 分阶段实施

| 阶段 | 工作量 | 新增模式 | 里程碑验证 |
|---|---|---|---|
| **POC**：`FunctionPlot` 模板 + `invoke_template` pi-tool | 1 天 | 新 pi-tool + 一个 React 模板 | 老师说"画 y=x²+2x" → 组件 <500ms 在 Presenter 渲染 + 自带缩放 |
| **扩展模板库**：+3 个数学模板 | 1 天 | 模板 loader 抽象 | AI 在"画"/"展示"/"演示"类请求中正确选模板 |
| **备课预热**：显式触发 + artifact 缓存查询 | 1 天 | 复用现有 task / memory / artifact 系统 | 老师说"备课" → 背景生成 → 课上命中 50ms present |
| **学段学科分化**：role 元数据 + 模板筛选 | 0.5 天 | `system-agents/teacher/*.json` 文件式约定 | 切换"小学数学" vs "高中数学" 模板库自动切换 |
| **其它学科 POC**（可选）：物理 + 语文各 2 个模板 | 2 天 | — | 覆盖主要学科 |

总计约 5.5 天（可分多次投入）。

## 未决决策点

开工前需与用户确认：

1. **模板渲染载体**：
   - A = React 组件（和 OpenPipal renderer 一致，可重用，需要 Presenter 窗口访问 renderer bundle）
   - B = HTML + JS 模板字符串（快速落地但修改麻烦）
   - **倾向 A**（对齐现有 VisualizerEmbed）

2. **预热触发**：
   - A = 显式（老师主动说"我要备这堂课"）
   - B = 隐式（OpenPipal 从 ClassIn 日历 / 课程资料自动推断）
   - **先做 A，B 后续扩展**

3. **学科第一优先级**：数学是 POC 最合适（已有完整 demo 链路），之后扩展的优先级待用户拍板（物理？语文？英语？）

## 相关文件（未来改动锚点）

- `src/main/pi-tools.ts`：新增 `invoke_template` pi-tool（注意三处登记：pi-tools / role-manager COMMON_TOOLS / pi-security classifyToolRisk）
- `src/renderer/src/components/PresenterView.tsx`：扩展为能渲染 React 组件（不仅 iframe srcdoc）
- `src/renderer/src/templates/math/*.tsx`：新建目录，放数学模板
- `system-agents/teacher/`：新建子目录 + 配置文件
- `~/.openpipal/artifacts/cache/`：新增缓存子目录（预热产物）

## 不要做的事

- ❌ 不要为这个功能新建 `classroom-*` 命名空间的 IPC / store / cache 抽象——全部复用现有 `chat:* / assets:* / artifact:*`
- ❌ 不要把模板变成"schema + configurator UI"（那会退化成普通的工具箱，失去"AI 选模板 + 填参数"的价值）
- ❌ 不要为每个学科各做一套 `*Agent` 类——用文件配置驱动同一个 teacher agent，保持架构 Unix 化

---

_备忘写于跨 commit `6bfd575` 之后，因用户想先处理别的事。恢复工作时从本文件的"分阶段实施"POC 开始。_
