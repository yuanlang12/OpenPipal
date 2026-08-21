# Quick Navigation —— 按 bug 类型定位文件

> 修 bug / 改子系统前先查本表，不要从根目录漫读。新 bug 类型的定位路径加到本表。

| Bug 类型 | 首先看 | 然后看 |
|---|---|---|
| 消息顺序/重复/丢失 | `stores/chatStore.ts`（事件处理） | `main/pi-event-adapter.ts`（事件适配） |
| dc 设计稿渲染/参数面板/导出（`.dc.html`） | `renderer/components/artifacts/dcRuntime.ts`（检测+内联+overrides 读写）、`HtmlPreview.tsx`（`__dc_booted`/`dc:set-props` 桥） | `main/dc-export.ts`（离线导出装配）、`resources/dc-runtime/`（support.js 冻结 ABI + React vendor）、`main/pi-tools.ts` create_artifact 的 dc 门闩 |
| mp4/pptx/handoff 导出、Agent 导出工具 | `main/dc-video-export.ts`（seek 协议逐帧）、`main/dc-pptx-export.ts`（deck 逐页截图+OOXML，`captureDeckStageFrames` 供 handoff 复用）、`main/dc-handoff-export.ts`（交接包：HANDOFF.md+design+reference+tokens） | `main/dc-capture.ts`（共享 CDP 捕获层）、`main/pi-tools.ts` export_artifact、`main/export-artifact-validate.ts`（格式门槛+校验文本纯函数） |
| 首启引导（全屏四步 / Mark 引导动线） | `components/OnboardingOverlay.tsx`（步骤/插画/Mark 落点，落点约定：永远压在白色 mock 窗口上） | `main/config-manager.ts` `onboardingCompleted`、`ipc-handlers.ts` `onboarding:*`；E2E 截图 `tests/e2e/onboarding.spec.ts` |
| 消息渲染/样式 | `components/MessageBubble.tsx` | `components/messages/*.tsx`（各类卡片） |
| Thinking 显示异常 | `stores/chatStore.ts`（onThinking/onThinkingEnd） | `MessageBubble.tsx`（ThinkingMessageCard） |
| 流式预览/可视化 | `components/StreamingInlinePreview.tsx` | `stores/visualizerStore.ts` |
| 工具调用结果 | `messages/ToolCallCard.tsx` | `chatStore.ts`（onToolStart/onToolEnd） |
| IPC 事件不到达 | `main/ipc-handlers.ts`（事件路由） | `preload/index.ts`（IPC bridge） |
| SSE/浏览器模式 | `web-api-shim.ts`（SSE 客户端） | `main/http-server.ts`（SSE 服务端） |
| AI 工具选择/安全 | `main/pi-tools.ts` | `main/pi-security.ts` |
| 编辑器（Zed/JetBrains）里工具卡住不动、授权框跑到桌面端 | 桌面侧 `main/http-server.ts` `writePermissionToStream`（活动流按 conversationId 索引，extension/acp 都收）+ `/api/permission` （native 主体经 `isAcpPermissionResponder` 钉死在自己那条活着的流上） | 适配器侧 `openpipal-acp/src/translator.ts` `case 'permission'` → `agent.ts` `createPermissionBridge` 反向调客户端 `session/request_permission`，裁决经 `http-client.ts` `respondPermission` 回传。**bridge 必须 fail closed**：不回传桌面端就永远 block 在等裁决 |
| 设置页「连接」tab 空着 / 状态不刷新 | 拼装在 `main/acp-status.ts`（会话来自 `config.acp` 标记，适配器不写标记就一条都不显示）；活跃态在 `main/acp-session-registry.ts` 纯内存，进程重启即清空 | 推送链路 `notifyAcpStatusChanged()` → `acp:status-changed` → `renderer/components/AcpConnections.tsx` 重新取快照；端口现问 `http-server.getHttpListeningPort()` |
| 编辑器里选不到自定义 Agent / 换人格没生效 | 适配器 `openpipal-acp/src/agent.ts` `personaOptions`（内置角色裸名 + 自定义 Agent `agent:<uuid>`，一个下拉两类）、`setPersona`、`syncPersonaFromDisk`（每轮开跑前对账并回推 current_mode_update / config_option_update）；切回内置角色必须同时发 `workspaceId: null`，不清就等于没切 | 桌面侧 `http-server.ts` PATCH `/api/conversations/:id` 收 `workspaceId` → `conversation-store.updateConversationWorkspace`，与 `updateConversationRole` **共用「开聊后拒绝」那把锁**；resume 以磁盘 `workspaceId` 为准 |
| 在桌面端改了会话，编辑器（Zed）那边没跟上 | 推送侧：`main/conversation-events.ts`（唯一发布出口，发布点在 `conversation-store` 四个写函数里）→ `http-server.ts` `GET /api/acp/events`（native 专用 SSE，带 ready + 15s 心跳）| 订阅侧：`openpipal-acp/src/agent.ts` `runDesktopEventLoop`（退避重连，只在状态翻转时打日志）→ `onConversationChanged` → `syncPersonaFromDisk`。**通道断了不影响正确性**：每轮开跑前还有一次对账兜底，最坏只是标签晚更正 |
| ACP 相关的已知问题（评审确认但还没修） | [acp-review-backlog.md](../acp-review-backlog.md)——15 条，带 file:line 与实测数字，按"值不值得现在修"排 | 已修的 15 条见该文件末尾；回归用例在 `conversation-config-atomicity.test.ts` / `protocol-compat-smoke.mjs` / `acp-desktop-live.spec.ts` / `teacher-skill-isolation.test.ts` |
| 编辑器要怎么启动适配器 / 打包后 ACP 连不上 | `main/acp-adapter-launch.ts`（打包态 `process.resourcesPath/acp/openpipal-acp.mjs`，开发态仓库里的 `openpipal-acp/dist/index.js`；文件不在返回 null）+ `electron-builder.yml` extraResources + `package.json` `build:acp` | 命令形如"用 App 自己当 Node"：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`。**必须是 `.mjs`**——Resources 下没有 package.json，`.js` 会被当 CommonJS 解，import 直接语法报错。守卫在 `electron-builder-release-boundary.test.ts` |
| 编辑器的斜杠菜单少了角色专属技能 | `http-server.ts` `GET /api/skills` 的 `role` 参数 → `skill-manager.resolveSkillScope`（**列表与提示词索引共用它**，这是"模型看得见、菜单里没有"的唯一防线）；适配器侧 `agent.ts` `publishCommands` 传 `session.role` | 三档作用域：workspaceId → 只看自定义 Agent 自己的；role → 全局 + 该角色专属（角色专属优先且不受全局禁用影响）；都不传 → 只有全局。回归在 `teacher-skill-isolation.test.ts` |
| 编辑器里没有斜杠命令 / 点了没效果 / 产物不流式 / 会话列表翻不完 | 适配器 `openpipal-acp/src/agent.ts`：`publishCommands`（命令用通知发，必须晚于 session/new 的响应）、`applySkillCommand`（`/名` → `<skill-request>名</skill-request>`）、`listV2Sessions`（keyset 游标，不是 offset） | 桌面侧 `http-server.ts` `GET /api/skills`（**改完必须 `npx electron-vite build`，否则 out/main 还是旧的、新路由 404 成 HTML**）；流式产物只有 `artifact_delta`/`visualizer_delta` 有真增量，`tool_progress` 只有字符数 |
| `/goal` 设了不生效 / 不自动续跑 / 判定不回写 | 状态构造与读写只有一处：`main/conversation-goal.ts`（`buildConversationGoal` 的 maxTurns 是 goal loop 的行为契约，改了两边都变）；桌面走 `chat:set-goal` IPC，ACP 走 `/api/conversations/:id/goal` | 判定循环在 `pi-agent-service.ts` 「8.5 Goal checkpoint」：GoalChecker 出错**一律放过**（fallback=true→ok=true）、连续 3 轮判否强停、`ask_user` 永远打断；状态靠 `goal_update` 事件回写（ACP 由 http-server 落盘，渲染层不在场）|
| 窗口拖拽/定位 | `App.tsx`（title bar） | `main/window-tracker.ts` |
| 语音能力不如文字/工具用不了 | `main/realtime-tool-bridge.ts`（工具集+执行）、`main/voice-tool-truncate.ts`（结果保真，丢 id/path 找这里） | `main/realtime-session.ts`（`VOICE_ETIQUETTE` + `handleVoiceFunctionCall` 链式 + `create_response` 接管） |
| 语音转录/VAD/打断/记忆 | `main/realtime-provider.ts`（`turn_detection`/`input_audio_transcription`） | `renderer/hooks/useRealtimeVoice.ts`（采集/节拍/记忆触发）、`main/memory-extractor.ts`（每会话游标） |
| 浏览器控制（客户端经插件控浏览器/CDP） | `main/browser-control.ts`（:3031 反向 WS 通道）、`openpipal-extension/background.js`（`bcExecute` 走 chrome.debugger） | `main/browser-tools.ts`（`browser_*` pi-tools）、`main/browser-policy.ts` + `browser-policy-store.ts`（站点轴安全，接 `pi-security`） |
| 上下文超限/历史压缩/带图历史 400 | `main/context-window-policy.ts`（单个工具结果限长）+ `main/history-compactor.ts`（按模型 Token 窗口整体压缩，只改模型载荷不动 UI） | `main/config-manager.ts`（`supportsImages`/`contextWindow` 能力位）、`chatStore.ts` `toApiMessages`（图片与工具轨迹完整传递）；缓存断点见 `model-prompt-cache-guide.md` |
| 缓存命中率低/账单比预期贵（功能全正常） | `main/agent-runtime/pi-message-conversion.ts`（`buildRuntimeContextMessage` 实发与回放同源，字节差一个空白就断）；读侧三处历史投影必须带 `messageKind`：`chatStore.toApiMessages` / `scheduler.storedMessageToChatMessage` / `http-server.ts` 内联 map | 写侧"谁把 RC 快照存进磁盘"：桌面是 renderer（`chatStore` 的 `onRuntimeContext`），ACP/定时任务是 `pi-event-adapter.createTranscriptCollector.finishRuntimeContext()`。实测靠 `scripts/diagnostics/usage-report.mjs` 看每轮首次调用的命中率 |
| 模型配置/连接测试/baseUrl | `main/config-manager.ts`（testConnection 与对话同管线 + /v1 探测补全） | `renderer/components/ModelSettings.tsx` |
| 角色前置页/设计系统 chip/历史产物列表 | `renderer/components/RolePreflowPanel.tsx`（manifest 驱动）+ `system-agents/<role>/preflow.json` | `main/role-manager.ts` `listRoleAssets`、`main/artifact-store.ts` `listArtifactHistory`、简报注入 `pi-agent-service.ts` |
| 工作目录选不了/选完不生效（欢迎页与对话页表现不一致） | `renderer/components/shared/WorkingDirBar.tsx`（贴输入框边缘的目录条，两页共用一份；`placement` 只决定贴上还是贴下） | 挂载点：`WelcomePage.tsx`（输入框下）与 `InputBar.tsx`（输入框上）；状态在 `chatStore.conversationConfig.workingDir`，靠负外边距 + 输入框 `relative z-10` 压出"贴边"观感 |
| 输入框打 `/` 不出面板 / 技能没被强调 / 路径被当成指令 | `renderer/components/shared/SkillMention.tsx`（`/` 面板 + 镜像层着色；`commands` 只在行首给，InputBar 传 `/goal`，欢迎页不传） | 词法在 `renderer/chat/skillRequest.ts`：`isTriggerBoundary`（行首或空白后的 `/` 才算触发符，`src/pdf` 因此不命中）、`findSkillMentions` 只认已知名单、`expandSkillMentions` 发送时换成 `<skill-request>`；编辑器侧同一套说法在 `openpipal-acp/src/agent.ts` `applySkillCommand` |
| 输入框上传（+ 选文件/拖拽/粘贴路径）分流不对 | `renderer/components/shared/useComposerFileIntake.ts`（图片内联 / study 布局收进知识库 / 其余上传成待发附件，两页共用一份规则） | 挂载点：`WelcomePage.tsx` 与 `InputBar.tsx`（两页 + 按钮都直开选择器，对话页另有拖拽与粘贴路径）；附件状态在 `chatStore.pendingFileAttachments`，发送时只传路径不进正文 |
| 自检实时画面（输入框上方固定槽/设备外框） | `renderer/components/SelfCheckPreview.tsx`（卡 + 模块级 store）+ `renderer/chat/selfCheck.ts`（纯逻辑：外框选择/结论解析/目标产物回溯）；挂载点在 `App.tsx` ChatPanel 与 InputBar 之间 | 触发靠 `liveStreamStore.toolStatus === 'render_artifact'`；自检本体在 `main/pi-tools.ts` render_artifact（隐藏窗口真渲染+console+重叠 lint+文本摘要）。结论文本走 tool-end 的 `mcpResult` 位（`pi-event-adapter` 通用分支把**所有**内置工具的结果文本都放这个位置，名字带 mcp 只是历史包袱） |
| 设计系统查看（画廊卡墙/文件浏览器/顶栏切换） | `renderer/components/artifacts/DesignSystemView.tsx`（外壳+「全部文件」下拉）→ `DesignSystemGallery.tsx`（卡墙+逐卡评审）/ `DesignSystemFiles.tsx`（Finder 式，≥560px 分栏、窄版推进式） | `main/role-manager.ts` `getDesignSystemManifest`（`groups`/`kits` 给画廊、`files` 给文件视图，`scanDsFiles` 如实扫盘）；文本/图片走受控 API，iframe 走按单套系统绑定的进程期只读 capability 路径 |
| 插件（Agent Plugins 包）装不上/技能或 MCP 没生效 | `main/plugin-manager.ts`（manifest 校验+组件发现，失败原因都在 `warnings`/`invalid` 字段） | `main/plugin-import.ts`（安装/卸载/启停）、技能接入点 `skill-manager.ts` `scanAllSkills` skillPaths、MCP 接入点 `mcp-manager.ts` `initMcpServers` 尾批（server 名带 `<plugin>:` 前缀）；UI `ToolsHub.tsx` PluginsTab |
| 画布圈画/点选评论、Tweaks 停靠条、Reload 门闩（预览不更新/更新打断操作） | `artifacts/HtmlPreview.tsx`（BRIDGE_SCRIPT `_onStroke*` 圈画 + `ui:interact` 上报；宿主 `isCanvasBusy`/`applyPendingDoc` 门闩、`submitStrokeComment` 截图链） | `DcTweaksPanel.tsx`（停靠条）、`chatStore.pendingAnnotations` + `InputBar.tsx`（`<canvas-annotation>` 拼接+截图并入 images）、IPC `window:capture-region`（对可见窗口 `capturePage`，非系统截屏权限路径） |
| design 查出别的规划/项目的内容（串味） | `pi-agent-service.ts` 资产库注入段（`workspace/assets/<role>/` 是**跨会话常驻**库，system prompt 指示模型主动 ls） | `ipc-handlers.ts` `assets:upload-to-category`（preflow 来源落 `workspace/uploads/`，**不再入库**）；简报按会话注入走 `initialAssets` |

## 新增 pi-tool 必须三处登记

加工具只在 `pi-tools.ts` 写定义**不够**。任何漏掉都会让 AI 看不到、或走保守路径（默认 confirm）导致 IPC 卡死。历史教训：`present_to_user` 漏了 pi-security 登记，序列化大 HTML 参数时 IPC 失败 → 30 秒权限超时 → 自动拒绝 → 用户看到"长时间无反应"。

1. **`src/main/pi-tools.ts`** — 工具定义（name / description / parameters / execute）
2. **`src/main/role-manager.ts` COMMON_TOOLS** — 白名单（否则 `isToolAllowed` 过滤掉，AI 根本收不到 schema）
3. **`src/main/pi-security.ts` `classifyToolRisk`** — 安全分类（默认走 `needs_confirmation`，大参数工具会把 IPC 卡死）

排查顺序：AI 没调工具 → 查 role-manager 白名单；AI 看到但执行卡住 → 查 pi-security 分类。

## 新增 dc 预制件（starter component）必须五处登记

与 pi-tool 三处登记同类风险：任何漏项在对应渲染/导出路径**静默失效**（预览白屏 placeholder / 导出裂引用），无报错。以 ios-frame（2026-07 移植）为对照样例：

1. **`resources/dc-runtime/<name>.js(x)`** — 预制件本体（官方原文件照搬，头部保留 `@ds-adherence-ignore` 注释）。含 JSX 的还要一份 `<name>.compiled.js`（esbuild 转译 + animations.compiled.js 同款 React 就绪轮询包装，离线免 Babel）
2. **`src/renderer/src/components/artifacts/dcRuntime.ts`** — `?raw` 导入 + `KNOWN_SIBLINGS` fromRe + `resolveKnownRaw`（预览内联，共两三处同文件）
3. **`src/main/dc-headless.ts` resolve** — render_artifact 自检 / PDF/MP4 无头渲染
4. **`src/main/dc-export.ts` resolveExportSibling** — 导出随包拷贝（JSX 预制件 copyFrom 用 compiled 版）
5. **技能文档** — `dc-authoring/SKILL.md` 预制件清单（"唯 N 支持"计数要改！）+ 对应形态技能的用法节；顺手补 `dc-handoff-export.ts describeDesignFile` 的友好名

排查顺序：预览 placeholder → 查 dcRuntime.ts；导出打开裂 → 查 dc-export.ts；render_artifact 自检空白 → 查 dc-headless.ts；模型不用新预制件 → 查技能文档"唯 N"清单。

反向陷阱（2026-07 实案，一坑两跌）：白名单登记了但**工具实体从未创建**——`createCodingTools()` 只含 read/bash/edit/write，grep/find/ls 必须再调 `createGrepTool/createFindTool/createLsTool` 显式创建。白名单对不存在的名字静默落空、无任何报错，症状是"模型顽固用 bash 摸目录"，先后两轮被误诊为提示词/模型习惯问题。补上实体后又跌进第三处：`classifyToolRisk` 的 READONLY/文件分支都不认识它们 → 每次列目录弹确认、一次内联请求挂满 1800s 超时自动拒绝（注意 pi-security 有**两套**登记：`assessToolScope` 认识 ≠ `classifyToolRisk` 认识）。行为异常先对账"环境给没给能力"，再怀疑模型没听话。

## 安全体系

三层安全：分类器（safe/risky/confirm）→ 用户确认弹窗 → 路径黑名单（.ssh/.aws/.gnupg）。源文件 `src/main/pi-security.ts`，详见 [../SECURITY.md](../SECURITY.md)。新增工具/MCP 服务时必须检查安全分类和路径边界。
