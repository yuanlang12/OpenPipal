# OpenPipal v2.0 升级迭代计划

> 基于 v1.0 全面代码审查制定，按「收益/成本比」排序
> 制定日期：2026-03-17

---

## 阶段总览

| 阶段 | 主题 | 周期 | 核心目标 |
|------|------|------|---------|
| **Phase 1** | 体验打磨 | 1~2 周 | 新用户 5 分钟内产出价值 |
| **Phase 2** | 架构加固 | 2~3 周 | 可维护性、可扩展性、可监控 |
| **Phase 3** | 能力扩展 | 3~4 周 | 多模态、自动更新、高级记忆 |

---

## Phase 1：体验打磨（1~2 周）

目标：让非技术用户也能零配置上手，5 分钟内体验到核心价值。

### 1.1 零配置首次体验

**问题**：用户必须自行配置 API Key 才能使用，流失严重。

**方案**：
- 内置一个默认的 API 中转服务地址（你们自己搭建的 proxy，或合作方提供的试用额度）
- `config-manager.ts` 新增逻辑：无用户配置时 fallback 到内置默认值
- 设置页明确提示「使用内置服务（免费额度有限）」和「使用自己的 API Key（无限制）」两个选项

**改动文件**：
- `src/main/config-manager.ts` — 添加 fallback 默认配置
- `src/renderer/src/components/Settings.tsx` — 添加免费/自定义切换 UI

**验收标准**：新装用户不打开设置就能直接聊天。

---

### 1.2 首次引导消息

**问题**：角色选择后面对空白界面，不知道能做什么。

**方案**：
- 角色选择完成后，自动插入一条 assistant 消息作为引导
- 每个角色有不同的引导内容和示例操作建议
- ChatPanel 的「建议卡片」区域改为更醒目的首次引导样式

**改动文件**：
- `src/renderer/src/components/ChatPanel.tsx` — 改造建议卡片为引导卡片
- `src/renderer/src/App.tsx` — 角色选择回调中触发引导

**引导内容示例**：

| 角色 | 引导消息 |
|------|---------|
| learner | 「试试选中课本上的一段文字，然后问我。或者直接把不会的题目截图发给我。」 |
| teacher | 「需要备课？告诉我课程主题，我来帮你设计教学方案。」 |
| office | 「我可以帮你写周报、整理会议纪要、分析数据。直接说你需要什么。」 |

---

### 1.3 消息气泡视觉升级

**问题**：用户/助手消息视觉区分度低，窄窗阅读体验差。

**方案**：
- 用户消息：右对齐 + 品牌深色背景（`bg-brand-600 text-white`）
- 助手消息：左对齐 + 白底灰边框（保持现状）
- 头像区：助手消息左侧显示角色 emoji 小头像（16px）

**改动文件**：
- `src/renderer/src/components/MessageBubble.tsx` — 调整布局和配色

**具体改动**：
```
当前：isUser ? 'bg-surface-700 text-surface-0' : 'bg-surface-0 border border-surface-100'
改为：isUser ? 'bg-brand-600 text-white' : 'bg-white border border-surface-100'
```

---

### 1.4 工具卡片默认折叠

**问题**：工具调用结果展示完整 JSON，普通用户看不懂，占屏幕空间。

**方案**：
- ToolCallCard 默认折叠（当前 `expanded` 初始值从 `false` 改为 `false` — 已是 false，确认保持）
- 折叠状态显示：工具图标 + 人性化名称 + 一句话结果摘要（前 50 字）
- 展开后才显示完整参数和输出

**改动文件**：
- `src/renderer/src/components/MessageBubble.tsx` — ToolCallCard 添加摘要显示

---

### 1.5 加载骨架屏

**问题**：初始化和对话切换时白屏，用户感知为「卡住了」。

**方案**：
- 新增 `Skeleton.tsx` 组件，模拟 3-4 条消息的灰色占位块
- 在 `App.tsx` 的 `!initialized || convLoading` 分支使用
- 对话切换时也显示骨架屏

**改动文件**：
- 新增 `src/renderer/src/components/Skeleton.tsx`
- `src/renderer/src/App.tsx` — 替换白屏为骨架屏

---

### 1.6 插件离线提示

**问题**：桌面端未运行时，浏览器插件 Side Panel 一直加载中，无反馈。

**方案**：
- `sidepanel.js` 的健康检查失败时，显示清晰的离线提示
- 提示内容：「请先启动 OpenPipal 桌面端」+ 重试按钮
- 重试按钮点击后重新尝试连接

**改动文件**：
- `openpipal-extension/sidepanel.js` — 改善错误提示 UI
- `openpipal-extension/sidepanel.html` — 调整错误区域样式

---

### 1.7 Settings 组件拆分

**问题**：Settings.tsx 452 行，混合了模型配置、应用跟随、关于三个无关功能。

**方案**：
- 拆分为 Tab 式布局
- `Settings.tsx` — 只保留 Tab 容器 + 遮罩
- `ModelSettings.tsx` — 模型配置（提供商、Key、模型选择、测试连接）
- `AppSettings.tsx` — 应用跟随开关、检测应用列表
- `AboutSection.tsx` — 版本号、反馈链接

**改动文件**：
- 拆分 `src/renderer/src/components/Settings.tsx`
- 新增 3 个子组件文件

---

## Phase 2：架构加固（2~3 周）

目标：提升代码可维护性，为未来功能扩展打好基础。

### 2.1 Zustand 状态管理

**问题**：App.tsx 成为状态中枢（7 个 useState + 6 个 callback），props 逐层传递。

**方案**：引入 Zustand，拆分为 3 个 store。

**新增依赖**：`zustand`

**Store 设计**：

```typescript
// stores/chatStore.ts
interface ChatStore {
  messages: ChatMessage[]
  isStreaming: boolean
  streamingContent: string
  toolStatus: string | null
  sendMessage: (content: string, images?: string[]) => void
  abortChat: () => void
  clearMessages: () => void
  regenerate: () => void
  editAndResend: (id: string, content: string) => void
}

// stores/appStore.ts
interface AppStore {
  initialized: boolean
  currentRole: RoleInfo | null
  allRoles: RoleInfo[]
  conversations: ConversationSummary[]
  activeConversationId: string | null
  showSettings: boolean
  showConversations: boolean
  init: () => Promise<void>
  switchRole: (name: string) => Promise<void>
  // ...
}

// stores/configStore.ts
interface ConfigStore {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  load: () => Promise<void>
  save: () => Promise<void>
  testConnection: () => Promise<boolean>
}
```

**改动文件**：
- 新增 `src/renderer/src/stores/chatStore.ts`
- 新增 `src/renderer/src/stores/appStore.ts`
- 新增 `src/renderer/src/stores/configStore.ts`
- 重写 `src/renderer/src/App.tsx`（从 170 行精简到 ~50 行）
- 重写 `src/renderer/src/hooks/useChat.ts`（逻辑移入 store）
- 重写 `src/renderer/src/hooks/useConversation.ts`（逻辑移入 store）
- 所有组件改为从 store 直接读取状态（消除 prop drilling）

---

### 2.2 AI Service 模块拆分

**问题**：`ai-service.ts` 单文件 512 行，职责过多。

**方案**：拆分为 4 个模块。

```
src/main/
├── ai-service.ts          → 仅保留 agentChat 主循环（~80 行）
├── ai/
│   ├── tool-definitions.ts  → buildTools()，所有工具 schema 定义
│   ├── tool-executor.ts     → executeTool(name, args, source)，工具分发和执行
│   └── prompt-builder.ts    → buildSystemPrompt(role, config, skillIndex, memories)
```

**改动文件**：
- 拆分 `src/main/ai-service.ts`
- 新增 `src/main/ai/` 目录和 3 个文件

---

### 2.3 MessageBubble 组件拆分

**问题**：MessageBubble.tsx 430 行，包含 6 个内联子组件。

**方案**：

```
src/renderer/src/components/
├── MessageBubble.tsx        → 主分发组件（~60 行）
├── messages/
│   ├── UserMessage.tsx       → 用户消息 + 编辑功能
│   ├── AssistantMessage.tsx  → 助手消息 + Markdown + 操作按钮
│   ├── ToolCallCard.tsx      → 工具调用卡片
│   ├── DocumentCard.tsx      → 文档产出卡片
│   ├── ScreenshotCard.tsx    → 截图展示
│   ├── SearchResultCard.tsx  → 搜索结果展示
│   └── shared/
│       ├── CopyButton.tsx    → 复制按钮（双格式）
│       └── PasteButton.tsx   → 粘贴到应用按钮
```

---

### 2.4 类型统一和常量提取

**问题**：`RoleInfo` 在 4 个文件中重复定义，魔法数字散落各处。

**方案**：

```typescript
// src/renderer/src/types/index.ts — 统一类型
export interface RoleInfo {
  name: string
  displayName: string
  icon: string
}

// src/renderer/src/constants.ts — 统一常量
export const LONG_CONVERSATION_THRESHOLD = 30
export const STREAMING_DEBOUNCE_MS = 500
export const NEAR_BOTTOM_THRESHOLD = 60
```

> 2026-07-30 更新：固定“仅保留最近 5 条图片”的方案已废弃。图片与工具轨迹按顺序保留，接近模型 Token 窗口时统一做历史整体压缩。

**改动文件**：
- 更新 `src/renderer/src/types/index.ts`
- 新增 `src/renderer/src/constants.ts`
- 更新所有引用 RoleInfo 的组件

---

### 2.5 图标库统一

**问题**：所有图标是 inline SVG，维护痛苦，约有 30+ 处 SVG 代码块。

**方案**：
- 安装 `lucide-react`（轻量、Tree-shakeable、TypeScript 友好）
- 逐步替换 inline SVG

**示例**：
```typescript
// Before (5 行)
<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
</svg>

// After (1 行)
<Check className="w-3 h-3" />
```

**新增依赖**：`lucide-react`

---

### 2.6 核心模块单元测试

**问题**：主进程核心逻辑零测试覆盖。

**方案**：使用 vitest，覆盖关键模块。

**新增依赖**：`vitest`

**测试文件**：
```
tests/unit/
├── memory-manager.test.ts     → 存储/检索/格式化
├── mcp-manager.test.ts        → resolveRefs JSON Schema 处理
├── role-manager.test.ts       → 工具白名单过滤
├── tool-executor.test.ts      → 工具分发逻辑
└── prompt-builder.test.ts     → System prompt 构建
```

---

### 2.7 Sentry 错误追踪

**问题**：生产环境无法看到用户的错误日志。

**方案**：
- 集成 `@sentry/electron`
- 主进程和渲染进程都初始化
- 捕获：未处理异常、AI API 错误、MCP 连接失败
- 默认关闭，用户在设置中可开启「帮助改善 OpenPipal」

**新增依赖**：`@sentry/electron`

**改动文件**：
- `src/main/index.ts` — 初始化 Sentry
- `src/renderer/src/main.tsx` — 渲染进程初始化
- `src/renderer/src/components/Settings.tsx` — 添加开关

---

### 2.8 HTTP Server 路由器化

**问题**：`http-server.ts` 15+ 端点用 if/else 字符串匹配，继续增长不可维护。

**方案**：不引入框架，抽出轻量路由器模式。

```typescript
// src/main/http-server.ts 顶部

type Handler = (req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => void | Promise<void>

const routes: { method: string; pattern: RegExp; handler: Handler }[] = []

function route(method: string, path: string, handler: Handler) {
  // 将 /api/conversations/:id/messages 转为正则
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$')
  routes.push({ method, pattern, handler })
}

// 注册路由
route('GET', '/health', handleHealth)
route('POST', '/chat/stream', handleChatStream)
route('POST', '/context', handleContext)
route('GET', '/api/conversations', handleListConversations)
route('GET', '/api/conversations/:id/messages', handleGetMessages)
// ...
```

---

## Phase 3：能力扩展（3~4 周）

目标：增加多模态能力，提升产品竞争力。

### 3.1 暗色模式

**问题**：只有亮色主题，夜间使用刺眼。

**方案**：
- Tailwind 已配好 surface 色板，添加 `dark:` 变体
- 跟随系统偏好（`prefers-color-scheme`）
- 设置中提供手动切换（自动 / 亮色 / 暗色）

**改动文件**：
- `tailwind.config.js` — 添加 `darkMode: 'class'`
- `src/renderer/src/styles/global.css` — 添加 dark 变体样式
- 所有组件 — 添加 `dark:` class（批量替换）
- `src/renderer/src/components/Settings.tsx` — 添加主题切换

**色彩映射**：
| 亮色 | 暗色 |
|------|------|
| `bg-surface-0` (#fafaf9) | `dark:bg-surface-800` (#1c1917) |
| `bg-white` | `dark:bg-surface-700` (#292524) |
| `text-surface-700` (#292524) | `dark:text-surface-100` (#e7e5e4) |
| `border-surface-100` | `dark:border-surface-600` |
| `bg-brand-600` | `dark:bg-brand-500`（保持品牌色鲜明度） |

---

### 3.2 语音输入

**问题**：学习场景下打字提问不够自然。

**方案**：
- 桌面端：使用 Web Speech API（Chromium 内置）
- InputBar 添加麦克风按钮（按住说话 / 点击开始-停止）
- 识别结果自动填入输入框（用户可编辑后发送）

**改动文件**：
- `src/renderer/src/components/InputBar.tsx` — 添加语音按钮
- 新增 `src/renderer/src/hooks/useSpeechRecognition.ts`

---

### 3.3 TTS 语音朗读

**问题**：助手回复只能看不能听。

**方案**：
- 使用 Web Speech Synthesis API（免费、离线）
- 助手消息底部添加「朗读」按钮（音符图标）
- 支持暂停/继续
- 中文语音选择系统默认

**改动文件**：
- `src/renderer/src/components/MessageBubble.tsx` — 添加朗读按钮
- 新增 `src/renderer/src/hooks/useTTS.ts`

---

### 3.4 文件上传（PDF/DOCX）

**问题**：只能粘贴图片，不能上传文档。

**方案**：
- InputBar 添加附件按钮（📎）
- 主进程添加文件解析：
  - PDF → `pdf-parse`（npm 包）
  - DOCX → `mammoth`（npm 包）
- 解析结果作为用户消息的附加内容发送
- UI 显示文件缩略图（文件名 + 图标 + 大小）

**新增依赖**：`pdf-parse`, `mammoth`

**改动文件**：
- `src/renderer/src/components/InputBar.tsx` — 添加附件按钮
- 新增 `src/main/file-parser.ts` — PDF/DOCX 文本提取
- `src/main/ipc-handlers.ts` — 新增 `file:parse` IPC 通道
- `src/preload/index.ts` — 暴露 `parseFile` 方法

---

### 3.5 electron-updater 自动更新

**问题**：用户需要手动下载新版本。

**方案**：
- 使用 `electron-updater`（已有 electron-builder）
- GitHub Releases 作为更新源
- 后台静默检查（每 6 小时一次）
- 发现更新时在 StatusBar 显示小红点
- 用户点击后提示下载更新

**新增依赖**：`electron-updater`

**改动文件**：
- `src/main/index.ts` — 初始化 autoUpdater
- 新增 `src/main/updater.ts` — 更新逻辑
- `src/renderer/src/components/StatusBar.tsx` — 添加更新提示
- `electron-builder.yml` — 配置 publish 字段

---

### 3.6 记忆系统语义搜索

**问题**：关键词搜索在记忆量大时不够用。

**方案（分阶段）**：

**短期（Phase 3 内）**：
- 给记忆加上结构化索引：`{ role, date, topic }`
- 支持按日期范围筛选
- 按 topic 分组显示

**中期（Phase 3 后）**：
- 本地 embedding：`@xenova/transformers`（Transformers.js）
- 使用 `all-MiniLM-L6-v2` 模型（~23MB，本地运行）
- 记忆保存时生成 embedding，查询时余弦相似度匹配

**改动文件**：
- `src/main/memory-manager.ts` — 添加索引和语义搜索

---

### 3.7 浏览器插件右键菜单

**问题**：选中文字后需要手动打开 Side Panel 再粘贴。

**方案**：
- `manifest.json` 添加 `contextMenus` 权限
- 注册右键菜单项：「用 OpenPipal 解释」「用 OpenPipal 翻译」
- 点击后：打开 Side Panel + 自动发送选中文本

**改动文件**：
- `openpipal-extension/manifest.json` — 添加权限
- `openpipal-extension/background.js` — 注册右键菜单和处理逻辑

---

## 依赖变更汇总

| 阶段 | 新增依赖 | 说明 |
|------|---------|------|
| Phase 2 | `zustand` | 状态管理 |
| Phase 2 | `lucide-react` | 图标库 |
| Phase 2 | `vitest` (dev) | 单元测试 |
| Phase 2 | `@sentry/electron` | 错误追踪 |
| Phase 3 | `pdf-parse` | PDF 解析 |
| Phase 3 | `mammoth` | DOCX 解析 |
| Phase 3 | `electron-updater` | 自动更新 |
| Phase 3（中期） | `@xenova/transformers` | 本地 embedding |
| Phase 5 | `i18next`、`react-i18next` | 系统语言检测与简体中文/英文界面切换 |

---

## 不做的事（明确排除）

> 2026-08-09 更新：i18n 已进入 Phase 5 实施范围，不再属于本表的排除项。

| 排除项 | 原因 |
|--------|------|
| Redux / MobX | Zustand 完全满足需求，更轻量 |
| Express / Koa | 自制轻量路由器 + 原生 http 已够用 |
| 新增内置角色 | 3 个已够，后续做用户自定义角色 |
| Windows / Linux 版本 | 先把 macOS 做到极致 |
| React Router | 单页应用不需要路由，条件渲染已足够 |
| 微前端 / Module Federation | 项目规模不需要 |

---

## 里程碑检查点

### Phase 1 完成标准 ✅ (2026-03-25)
- [x] 新用户无需配置 API Key 即可首次对话
- [x] 角色选择后看到引导消息，知道能做什么
- [x] 消息气泡左右分明，阅读体验流畅（brand-600 用户气泡 + 助手 emoji 头像）
- [x] 工具卡片默认折叠，不干扰阅读（折叠时显示前 50 字摘要）
- [x] 初始化和切换对话有骨架屏过渡（Skeleton.tsx）
- [x] 插件离线时有明确提示
- [x] 设置页拆分为 Tab，每个功能区独立（ModelSettings / AppSettings / AboutSection）
- [x] RoleInfo 类型统一到 types/index.ts（提前完成 Phase 2 的 2.4 部分）
- [x] E2E 测试 7 个新用例，全部 30 个测试通过

### Phase 2 完成标准（高收益项 ✅ 2026-03-25）
- [x] App.tsx 215→104 行，Zustand 消除 prop drilling（appStore + chatStore）
- [ ] ai-service.ts 拆分为 4 个模块，主循环 < 100 行（当前 pi-agent-service.ts 254 行）— 跳过
- [x] MessageBubble 拆分为 8 个独立组件（448→100 行 + 7 个子组件）
- [x] RoleInfo 等类型全局唯一定义 ← Phase 1 已提前完成
- [x] 图标全部使用 lucide-react（35 处 inline SVG 替换，15 个文件）
- [ ] vitest 覆盖 5 个核心模块 — 跳过
- [ ] Sentry 集成 — 跳过
- [ ] HTTP 路由器化 — 跳过
- [x] E2E 测试选择器迁移到 data-testid，30 个测试全部通过

### Phase 3 完成标准
- [x] 暗色模式跟随系统，可手动切换（darkMode: 'class' + 21 个文件 dark: 变体 + prose-light 暗色覆盖）
- [ ] 语音输入可用，中文识别准确
- [ ] TTS 朗读可用，中文发音自然
- [ ] PDF/DOCX 文件可上传并被 AI 分析
- [ ] 自动更新检测，用户一键升级
- [ ] 记忆系统支持日期范围筛选
- [ ] 浏览器右键菜单「用 OpenPipal 解释」可用
