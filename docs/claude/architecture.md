# 详细架构参考

## Main Process (src/main/)

```
├── index.ts              Entry: initRoles → initSkills → initMcpServers → startHttpServer → createWindow
├── pi-agent-service.ts   Core AI: agentChat() AsyncGenerator, Pi framework 事件订阅
├── pi-event-adapter.ts   ★ 事件适配: Pi 事件 → OpenPipal 事件（thinking/text/tool/visualizer）
├── pi-tools.ts           AI 工具定义 + source-aware 过滤（desktop/extension）
├── pi-security.ts        三层安全: 分类器 + 用户确认 + 路径黑名单
├── http-server.ts        HTTP API (localhost:3031): SSE streaming + 静态文件
├── ipc-handlers.ts       ★ IPC 路由: agentChat 事件 → webContents.send
├── streaming-json-extractor.ts  流式 JSON 字段提取（visualizer/artifact content）
├── role-manager.ts       角色系统: learner/teacher/office
├── memory-store.ts       记忆存储层（JSONL）
├── memory-extractor.ts   自动记忆提取
├── memory-dreamer.ts     记忆整理（autoDream）
├── conversation-store.ts 会话持久化
├── window-tracker.ts     窗口跟随 + 全屏支持
├── app-detector.ts       前台应用检测（AppleScript）
├── mcp-manager.ts        MCP 客户端
├── skill-manager.ts      技能加载（读取时重扫盘，落盘即生效）
├── skill-import.ts       技能导入（本地文件夹 / GitHub tarball，零新依赖）
├── scheduler.ts          定时任务调度
└── app-config.ts         内置配置 + 工具规则
```

## Renderer (src/renderer/src/)

```
├── main.tsx              Entry: 环境检测 → web-api-shim 安装
├── web-api-shim.ts       浏览器模式 window.api（XHR/SSE）
├── App.tsx               ★ 根布局: title bar (z-10 drag) + sidebar + content area
├── stores/
│   ├── chatStore.ts      ★★★ 核心: 消息状态 + 所有事件处理（thinking/tool/stream）
│   ├── visualizerStore.ts  流式可视化状态
│   ├── artifactStore.ts    Artifact 面板状态
│   └── appStore.ts         全局应用状态（角色、视图）
├── chat/
│   └── messages.ts       ChatMessage v2 工厂函数 + 类型推断
├── types/index.ts        ChatMessage 类型定义（messageKind/thinkingContent/visualizerHtml）
├── components/
│   ├── ChatPanel.tsx      ★ 消息列表 + 流式文本/工具状态 + StreamingInlinePreview
│   ├── MessageBubble.tsx  ★ 消息分发: ThinkingMessageCard / ToolCallCard / PermissionCard / 文本
│   ├── StreamingInlinePreview.tsx  流式可视化（postMessage shell iframe，防闪烁）
│   ├── VisualizerInline.tsx  持久化可视化渲染（Shadow DOM）
│   ├── InputBar.tsx       输入框 + 图片粘贴 + 语音
│   ├── StatusBar.tsx      顶部状态栏
│   ├── Sidebar.tsx        侧边栏导航
│   ├── ArtifactPanel.tsx  Artifact 预览面板
│   └── messages/          各类消息卡片
│       ├── ToolCallCard.tsx      工具调用 + VisualizerEmbed
│       ├── BashOutputCard.tsx    终端输出
│       ├── FileResultCard.tsx    文件操作
│       ├── CodeExecutionCard.tsx 代码执行
│       ├── DocumentCard.tsx      文档生成
│       ├── AskUserForm.tsx       用户输入表单
│       └── ScreenshotCard.tsx    截图
└── styles/
    ├── openpipal-ds.css  官方静态层:daylight 冷中性阶 + ink action accent + sage 品牌位
    ├── glass.css         liquid glass 表面系统(tint/blur/rim/depth)+ .op-* 原语 + 扫光动效
    ├── tokens.css        --sw-* 运行时主题层(三层 token,applyTheme 算 RGB 三元组)
    ├── global.css        全局样式 + -webkit-app-region + prose-light
    └── shimmer.css       骨架屏 shimmer
```

### Liquid glass 的两层来源(改 chrome 前必读)

**第一层:macOS 原生材质。** `BrowserWindow` 挂 `vibrancy: 'under-window'` +
`visualEffectState: 'active'`(main/index.ts)。`backdrop-filter` 只能采样页面
自己的像素,**采不到桌面** —— 想让 chrome 真的磨砂透出背后的应用,只有
NSVisualEffectView 这一条路。因此渲染层必须让位:

- `.op-app-shell` **不能刷不透明底色**(刷了材质就被盖死,E2E 会红)。
- 透出材质的面:`.op-sidebar`(--glass-sidebar)、`.op-content-column`
  (--glass-canvas 82%)、标题栏、输入框。白膜越薄透出来越多。
- 窗口 `hasShadow: true` + 外壳 `border-radius: var(--radius-xl)` —— 一块浮着的
  玻璃必须有圆角和影子,否则只是「贴」在桌面上。(orb 模式已在 window-tracker
  里彻底移除,不用担心 72px 圆球被圆角/方影子毁掉。)

**第二层:窗口内的 pass-behind。** 玻璃还要有自家内容从底下穿过去:

- `.op-titlebar` **必须留在常规流里**(`relative z-30 h-10 shrink-0`)。
  ⚠️ Chromium 只从**常规流**元素收集 `-webkit-app-region: drag`,脱流元素
  (`absolute` / `fixed`)一律不计入窗口拖拽区 —— 把标题栏改成 absolute 会让整条
  标题栏拖不动窗口。2026-08 用 CGEvent 真机拖拽做过对照:static 能拖、
  absolute 和 fixed 都不能;和 backdrop-filter、vibrancy、圆角裁剪都无关。
- **标题栏方向没有 pass-behind**。曾经让滚动容器 `-top-10` 向上探进标题栏,
  但 `.op-app-body` 与 `.op-app-shell` 都是 `overflow: hidden`,探出去的部分会被
  裁掉 —— 像素实测那条带在「有内容滚到底下」和「没有」两种状态下完全一致。
  已移除;标题栏的通透感来自窗口 vibrancy。**别再恢复那个写法。**
  这两条的可执行副本在 `tests/e2e/liquid-glass-shell.spec.ts`,以那里为准。
- 输入区是 `.op-chat-dock`(absolute bottom),高度由 `ResizeObserver` 实测写进
  `--op-dock-h`,滚动容器用它算 `padding-bottom` / `scroll-padding-bottom`;
  底下垫一层 `.op-glass-veil` 把画布化开。
- 玻璃只上 chrome:标题栏 / 输入框 / 浮层菜单 / HUD 药丸 / 权限弹窗。
  **会话画布是不透明白**,侧栏是实心冷面 —— 它们底下没有内容流过,上玻璃
  只会得到一块浅灰矩形(欢迎页输入框因此用 `.op-composer-solid` 实心变体)。
- 动作色是 ink 不是色相:改 `DEFAULT_THEME.light.accent` 就整盘换掉七百多处
  `brand-*`;sage 只留在 `semantic.success` / orb / logo(`--sw-brand-sage`)。
- 窗口窄于挂靠宽度(<420px)时侧栏自动收起成 48px 图标条(App.tsx `narrowViewport`)。
  阈值刻意卡在 400 而不是更宽的断点:420~560px 之间靠 `min-w-0` + `truncate` 已经
  收得住,再往上收只会把历史列表这类常用信息藏掉(E2E `message-layout` 会红)。
  窄宽工具栏三条规矩:让**标签截断**,别给按钮 `shrink-0`(会横过去盖住发送键),
  也别给容器 `overflow-hidden`(会把 ModelControl 的上弹菜单裁掉)——这两个坑都踩过。
- blur 用 `--glass-blur-chrome/panel`(26/20px)而不是官方的 40/64px:官方那套是
  给「玻璃浮在天空上」调的,天空是平滑渐变糊多少都行;我们底下是 13-15px 正文,
  糊到 64px 只剩一团雾,折射反而读不出形状。tint 同理压到 60/68%。

## Browser Extension (../openpipal-extension/)

```
├── manifest.json         Manifest V3: sidePanel, activeTab, scripting
├── background.js         Service worker: opens side panel on icon click
├── content.js            Content script: page text extraction, receives subtitle data from inject.js
├── inject.js             MAIN world script: YouTube subtitle collection (MutationObserver on CC captions), Bilibili data
├── sidepanel.html        Thin shell: iframe loading localhost:3031 + version display
├── sidepanel.js          Context forwarding: extract context → POST /context + postMessage to iframe
└── icons/                Extension icons
```

The extension is a **thin shell** — no chat UI of its own. Side panel iframes `localhost:3031`.

---

## Environment-Aware Tool Filtering

Tools filtered by `source` parameter (`'desktop' | 'extension'`):

| Tool | Desktop | Extension | Notes |
|------|---------|-----------|-------|
| capture_screenshot | ✓ | ✗ | Browser has page content via tool |
| read_screen | ✓ | ✗ | Browser has page content via tool |
| read_page_content | ✗ | ✓ | Reads browserContext from /context |
| web_search | ✓ | ✓ | |
| ask_user | ✓ | ✓ | |
| save/recall_memory | ✓ | ✓ | |
| generate_document | ✓ | ✓ | |
| bash | ✓ | ✓ | Pi 内置，经安全层分类 |
| read | ✓ | ✓ | Pi 内置，路径经安全层检查 |
| write | ✓ | ✓ | Pi 内置，needs_confirmation |
| edit | ✓ | ✓ | Pi 内置，diff 编辑 |
| ls / find / grep | ✓ | ✓ | Pi 内置 |
| MCP tools | ✓ all roles | ✓ all roles | No role filtering on MCP |

## Browser App Detection

When a browser becomes frontmost, desktop app does NOT follow it. Instead:
1. `app-detector.ts` detects browser via `BROWSER_APPS` set
2. `window-tracker.ts` shows a custom floating prompt (right-top corner, cursor's screen)
3. Prompt offers "一起工作" → opens `localhost:3031/extension` install guide page
4. One prompt per app launch (debounced)

## HTTP API (localhost:3031)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/chat/stream` | POST | **SSE streaming** chat (used by web-api-shim) |
| `/chat` | POST | Non-streaming chat (backward compat) |
| `/context` | POST | Receive browser page context |
| `/extension` | GET | Extension install guide page |
| `/role/*` | GET/POST | Role management API |
| `/api/acp/sessions/:id/mcp` | POST/DELETE | ACP session 级 MCP 注入/注销（session/new.mcpServers） |
| `/*` | GET | Static files (serves built React renderer) |

### ACP 会话数据流（openpipal-acp 适配器，2026-07 联调定稿）

`source` 三值语义：`desktop`/`extension` 的会话由 renderer 落盘；**`acp` 的 renderer 不在场，
落盘归服务端**——`/chat/stream` 对 acp 来源在请求侧从会话存储重建历史（只取 user/assistant 文本，
工具消息不回放），流结束后 `appendMessages` 落盘本轮 user+assistant 增量。ACP 客户端每轮**只应发送
最新一条消息**（历史由服务端自带；客户端再内联一份=纯冗余）。已知代价：跨轮第 2 轮起有一次
"上一轮末条消息 RC 有界失配"（同桌面路径的 P1 设计），表现为该轮缓存命中偏低，功能无影响。
外部客户端（taco_ultra，2026-07-16）实测：新 tarball 部署即落盘生效、跨轮记忆通过（青竹-4729 测试）、
Clio 风格结构化任务正常出结果。

## YouTube Subtitle Extraction

```
inject.js (MAIN world, bypasses CSP)
  → auto-clicks CC button to enable subtitles
  → MutationObserver on .ytp-caption-segment collects rendered text
  → accumulates over time as video plays
  → postMessage to content.js with collected text

content.js (isolated world)
  → receives subtitle text from inject.js via postMessage
  → responds to EXTRACT_CONTEXT with { subtitles, pageContent, selectedText, ... }

sidepanel.js
  → POST /context to backend (stored as browserContext)

AI calls read_page_content tool
  → reads getBrowserContext() → returns subtitles + page content
```

Note: YouTube blocks inline script injection (CSP/Trusted Types) and subtitle URL fetching (POT tokens). Solution: declare inject.js with `world: "MAIN"` in manifest, collect from rendered DOM instead of fetching URLs.

## PDF 页面正文直读管线

Chrome 内置 PDF 查看器不允许 content script 注入、DOM 也无正文（PDFium 插件渲染），`EXTRACT_CONTEXT` 必失败：

```
sidepanel.js（EXTRACT_CONTEXT 失败的 catch 分支）
  → fetch(tab.url, {credentials:'include'}) 带 cookie 取字节（校验 content-type/%PDF- 魔数、>30MB 放弃）
  → pdfBase64 随 ctx 一并 POST /context
pdf-context.ts resolvePdfIntoCache
  → parsePdfBuffer（file-parser.ts，pdf-parse 懒 import）解析
  → 按 url（去 hash）存 pdfTextCache（容量 5，含负缓存 note，如"疑似扫描版"/"HTTP 401"）
fillPdfPageContentFromCache
  → 在 /context 与 resolveAndInjectContext 两处同步回填 browserContext.pageContent
     （后者必须回填：每条聊天消息自带的空 pageContent context 会覆盖掉已解析的正文）
AI 调 read_page_content(offset, maxChars) → 分段读取解析结果
```

## AI Tool Loop

System prompt: `role.systemPrompt + appContext + TOOL_RULES + skillIndex + memoryContext`. TOOL_RULES is minimal (3 lines: one tool per round, use returned IDs, confirm before destructive ops). AI chooses tools based on their descriptions, not rules.

## Skills（技能注入）

技能 = 目录约定：含 `SKILL.md` 的目录即一个技能（文件存在即开启，无需改代码）。`skill-manager.ts` 负责扫描与注入。

**五类来源** —— 四个全局根（同名碰撞优先级 built-in > user > 插件 > MCP）+ 每 agent 专属：
- 内置 `resources/skills/`（随 app 出厂，如 pdf / frontend-design / skill-creator）
- 用户 `~/.openpipal/skills/`
- 插件 `~/.openpipal/plugins/<name>/skills/`（Agent Plugins 标准包，见下节）
- MCP `~/.openpipal/skills/_mcp/<server>/`
- Agent 专属 `~/.openpipal/agents/<workspaceId>/skills/` —— 与上面全局根**隔离**（2026-07 拍板，替代此前的"合并全局"）

**两级作用域**（`buildSkillIndexForContext({ workspaceId })` / `listSkillsMeta(workspaceId)` 共用同一分支）：
- **全局会话**（无 workspaceId）：索引恒为全量，唯一的收窄手段是「技能和工具」里显式禁用某技能（`skillsConfig.disabled`）。此前存在两处白名单（会话级 `conversationConfig.enabledSkills`、Agent 模板 `enabledSkills`），都已删除——它们让 system prompt 随选择变化（前缀缓存逐轮失效），且模型看不见未选中的技能。用户在输入框选技能现在是**单条消息内的强调**：发送时把 `<skill-request>名称</skill-request>` 合并进那条用户消息（`renderer/src/chat/skillRequest.ts` 组装、`messages/UserMessage.tsx` 解析成 pill），发完即清空，不进会话配置、不改 system prompt。
- **独立智能体**（带 workspaceId）：**只看自己的 `~/.openpipal/agents/<workspaceId>/skills/` 目录**，完全不合并全局技能。目录不存在或为空 → 索引为空字符串，零注入。自有目录里的技能**不受**全局禁用列表影响——显式装进自己的目录 = 显式启用。想让独立智能体用上某个全局技能，就把那个技能目录复制/软链进它自己的 skills 目录（文件式而非字段式）。输入框「+ → 添加技能」picker 同理：会话绑定了独立智能体时只列该 agent 自有目录的技能（`window.api.listSkills(workspaceId)`），全局会话不变；自有技能为空时 picker 显示"这个智能体还没有自己的技能"的空态。

**两层渐进式披露**：
- *索引*（name + description + location 的 XML）：`buildSkillPromptSection`（= `buildSkillIndexForContext` + 一段催用引导 `SKILL_USAGE_NUDGE`）注入系统提示词，**每轮重建、永不因 token 阈值裁剪**（不像 MCP/CLI 工具索引有 `tools.search()` 兜底）。
- *正文*（完整 SKILL.md + 配套脚本）：模型按 location 用通用 `read` 工具**按需加载**（Stage 2 已删除专用 `load_skill` 工具，统一走 read/write）。

**两条 prompt 构建路径都注入技能**（共用 `buildSkillPromptSection`，避免行为漂移）：
- 主 agent / Workspace Agent → `pi-agent-service.ts` `buildSystemPrompt`
- 子 agent（subagent 工具派生）→ `subagent-runner.ts` `runChildAgent`（**此前不走 buildSystemPrompt，曾完全拿不到技能索引**；现已补齐，传入 `options.workspaceId`——子 agent 由独立智能体派生时会拿到父级 workspaceId，因此与父级同域隔离；否则走全局）

UI：模型 `read` 一个 `/skills/.../SKILL.md` 时，`FileResultCard` 检测 `fileName==='SKILL.md' && path.includes('/skills/')`，渲染为醒目的「技能」卡片而非普通"读取文件"。

## Agent Plugins（插件系统，2026-08-07 接入）

采纳 [agent-plugins.org](https://agent-plugins.org/specification) 1.0.0 开放标准（Amazon/Cursor/Microsoft/OpenAI/Vercel TSC）。**产品概念口径：「插件」=标准包（技能+工具的集合）；「工具」=MCP server+CLI（ToolsHub 原"插件"tab 已改名）；浏览器扩展不再叫"插件"**。

一个插件 = `~/.openpipal/plugins/<name>/` 目录：`plugin.json`（manifest，$schema+name 必填）+ `skills/`（直接子目录含 SKILL.md）+ `mcp.json`（stdio/streamable-http server）。

- `plugin-manager.ts` —— 发现/校验/组件映射（无状态每次重扫）。manifest 无效→整包拒绝；mcp.json 无效→仅禁 MCP；单 server 无效→仅跳该条（规范失败边界）。路径安全：一切解析后必须留在插件根内（realpath 校验）；占位符仅 `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`。
- `plugin-import.ts` —— 安装（本地文件夹 / GitHub，复用 skill-import 的 `downloadGithubRepo`）/卸载/启停，一次调用完成校验→落盘→刷新。
- 组件流向：技能经 `listPluginSkillDirs()` 进 `scanAllSkills()` 的 skillPaths；MCP server 经 `getPluginMcpServers()` 在 `initMcpServers()` 尾批连接，名字带 `<plugin>:` 前缀，`pluginName` 标记贯穿到状态 UI（不给删除入口，生命周期随插件）。**不新增 pi-tool，三处登记红线不触发**。
- 数据目录：`~/.openpipal/plugins/`（包体）、`~/.openpipal/plugin-data/<name>/`（跨更新保留，卸载即删）、`~/.openpipal/plugins.config.json`（disabled 列表）。
- UI：主导航「插件」→ ToolsHub 三 tab（插件/技能/工具）；SkillsHub 技能行有「插件 · 名称」来源徽章。

## Role System

Three built-in roles persisted in `~/.openpipal/config.json`. First launch shows RoleSelector. StatusBar provides switch dropdown. Roles control system prompt and built-in tool whitelist. MCP tools are available to ALL roles.

## Memory System

JSONL at `~/.openpipal/memory/<role>/memories.jsonl`. `save_memory`/`recall_memory` tools. Keyword search. `generate_document` saves to `~/.openpipal/outputs/`.

## DC（Design Component / .dc.html）管线 —— 2026-07 dc 路线

design 角色的设计交付物采纳 claude.ai Claude Design 同源的单文件格式（决策与对表证据见 `design-workbench-contracts.md` 的 2026-07-02 对账更新，官方教学归档 `claude-design-dc-prompt.md`）。

**数据流**：
```
模型: read dc-authoring SKILL.md → create_artifact(type=html, content=完整 .dc.html)
  └─ pi-tools.ts create_artifact 门闩：design 角色整页 HTML 无 <x-dc> → 拒绝并指路技能
     （首行 <!-- non-dc: 原因 --> 可豁免纯 canvas/WebGL 例外）
渲染: HtmlPreview 检测 <x-dc> → dcRuntime.inlineDcRuntime() 把 ./support.js 引用替换为
  内联运行时（?raw import 自 resources/dc-runtime/support.js，srcdoc 无法解析相对路径）
参数面板: support.js boot 后 postMessage __dc_booted{propsMeta} → HtmlPreview 渲染
  DcTweaksPanel（enum/boolean/color/int/float/text 控件）→ 改动经 BRIDGE_SCRIPT 的
  dc:set-props 中转调 window.__dcSetProps（sandbox 无 allow-same-origin，父窗口摸不到
  contentWindow 函数）→ debounce 800ms 持久化到 content 的 data-prop-overrides 属性
  （运行时只读 data-props，多余属性透明）→ 重挂载时父侧读出并重放
回声跳载: 自己写回的 content 变更不重载 iframe（selfEditRef），保住运行时状态
导出: ArtifactTab 导出按钮 → IPC artifact:export-dc / POST /api/artifact/export-dc →
  dc-export.ts 装配 ~/.openpipal/outputs/<project>/（.dc.html 注入本地 vendor 引用 +
  调参重放脚本 + support.js + vendor/react*18.3.1，断网可开；window.React+ReactDOM
  同时在位时 support.js 跳过 unpkg CDN）
```

**关键约束**：support.js 是冻结 ABI（1595 行生成物，来自 Clio 交付物、经对表验证为官方教学的严格超集），不改它——适配一律写在注入桥或宿主侧。E2E：`tests/e2e/dc-render.spec.ts`（渲染/面板/持久化/重放/导出 6 用例），黄金样例 `tests/fixtures/dc/`。

## 导出管线（mp4 / pptx / Agent 工具）

- `dc-capture.ts` — 共享 CDP 捕获层（evalChecked/轮询/滚动条免疫/视口仿真/整数 clip）。⚠️ loadURL 必须 await 完成后才能 debugger.attach + Page.enable，反序会让 Page.enable 无限挂起。
- `dc-video-export.ts` — 动画 mp4：引擎 seek 协议逐帧 + DOM 真值（尺寸/时长）+ 分辨率守卫 + ffmpeg。
- `dc-pptx-export.ts` — deck 逐页截图 PPTX：deck-stage 的 `noscale` 属性 + `__openpipal_presenting` postMessage 是组件预留的导出钩子（去缩放/藏导轨），`goTo(i)` 翻页、`data-deck-skip` 页排除；OOXML 手写最小结构（python-pptx 参考模板校验），系统 zip 打包，1px=9525 EMU。
- `pi-tools.ts` export_artifact — Agent 侧导出（mp4/pdf/standalone-html/project-zip/pptx），证据式校验文本（ffprobe/页数/大小），落 `~/.openpipal/outputs`；成功结果携带文件元数据，因此会话右侧能精确显示本会话交付物，不依赖扫描全局目录。

## 关键数据流（从 CLAUDE.md 下沉）

```
AI 事件流: Pi Agent → PiEventAdapter.adapt() → eventQueue → agentChat() yield
  ├─ Electron: ipc-handlers.ts → webContents.send() → preload bridge → chatStore
  └─ Browser:  http-server.ts SSE → web-api-shim EventSource → chatStore

Thinking 消息（单轨渲染）:
  onThinking → 立即创建 ThinkingMessage in messages[] → 150ms throttle 更新
  onThinkingEnd → 只清 thinkBuf，保留 activeThinkingId（吸收重复）
  onToolStart/onStreamEnd → 清 activeThinkingId（phase boundary）
  ⚠️ Pi/Qwen 框架每个 thinking 阶段发两次：流式 delta + 完整重投

Visualizer 流式预览:
  onVisualizerDelta → visualizerStore.startStreaming/updateStreaming
  StreamingInlinePreview: shell iframe + postMessage（不替换 srcdoc，防闪烁）
  onToolEnd → visualizerHtml 存入 ChatMessage → VisualizerEmbed 持久渲染
```

## Data Paths

- `~/.openpipal/config.json` — User config (role, disabledApps, detectedApps)。**模型配置 schema v2（configVersion=2，2026-07-28）**：`modelProviders[]` 服务商实体（连接字段唯一事实源：baseUrl/apiKey/apiFormat，内置服务 builtin 打标）+ `modelPresets[]` 经 `providerId` 挂接（模型级字段住 preset.config，连接字段为迁移遗留缓存、仅悬空兜底）。消费方一律经 `resolvePresetConfig` 拿合并后的扁平 ModelConfig——换 key 改服务商实体一处生效。v1→v2 由 `loadConfig` 惰性迁移（幂等、留 `.bak-pre-providers`），红线守卫：内置服务商/预设的连接信息与模型名不出主进程（`config:get-preset` 对 builtin 拒发、列表侧掩码/改名）
- `~/.openpipal/memory/<role>/memories.jsonl` — Persistent memories per role
- `~/.openpipal/conversations/artifacts/<conversationId>/` — 当前会话的持久 artifact；右侧“输出”优先展示这一层及该会话明确导出的文件。
- `~/.openpipal/outputs/` — 全局会话的已导出文件；与 `~/.openpipal/agents/<workspaceId>/outputs/` 一起仅由用户主动打开的“作品”索引，绝不回灌到某个会话的右侧摘要或模型上下文。
- `~/.openpipal/skills/` — Skill definitions
- `mcp-servers.json` (repo root) — MCP server definitions

## MCP Integration

Config in `mcp-servers.json` (repo root). MCP tools available to ALL roles — no role filtering. Current servers: `classin` (教学管理), `context7` (库文档), `deepwiki` (GitHub 仓库分析). 不要重复造轮子：新增能力先查现有 MCP server。

## Styling

Tailwind with custom tokens in `tailwind.config.js`: `brand-*` (teal), `surface-*` (stone). Fonts: SF Pro + PingFang SC.

## Platform Notes

- macOS only for desktop. Browser extension works cross-platform.
- **环境检测**：`main.tsx` 检查 `window.api` 是否存在——Electron 由 preload 提供；浏览器安装 `web-api-shim.ts`（HTTP/SSE）。`StatusBar.tsx` 按 `window.__OPENPIPAL_ENV__` 适配。
- **E2E 测试**：Playwright（`tests/e2e/`），用 `addInitScript` mock `window.api`；renderer E2E dev server 用 `src/renderer/vite.config.ts`（独立于 electron-vite 配置）。
- Extension side panel iframes `localhost:3031` — requires desktop app running.
- `web-api-shim.ts` sets `window.__OPENPIPAL_ENV__ = 'browser'` for UI adaptation.
- Browser prompt: BrowserWindow floating at cursor's screen right-top, 10s auto-dismiss, once per launch.
