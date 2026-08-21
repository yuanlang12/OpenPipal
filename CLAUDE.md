# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**本文档 = 核心原则 + 高频协作契约，其余一切靠文末「入口目录」渐进式披露。** 上下文再大，注意力也是稀缺的——细节住在子文档里，需要时再读。

## Project Overview

OpenPipal is a macOS Electron app + Chrome extension — a universal AI companion that auto-docks beside any foreground app. Desktop and extension share one React renderer and one AI backend (electron-vite, React 18, Tailwind, TypeScript). Renderer ↔ Main 通过 preload IPC（桌面）或 web-api-shim HTTP/SSE :3031（插件）通信。

## 核心原则

1. **渐进式披露** —— 对 AI 可见的一切资源（文档、工具、上下文注入）都按需暴露，而不是预先全量加载。这条同时管产品设计（给 agent 的工具与提示词）和本文档体系自身。
2. **如无必要，勿增实体** —— 三行重复代码优于过早抽象；不做假设性错误处理；通用工具优先于专用工具（能用 bash/现有 MCP 解决的不新造工具）。
3. **不要重复造轮子，可以升级轮子** —— 文件式 > 字段式（文件存在即 feature 开启，不加 TS schema 字段）；复用命名空间（不新造 IPC 前缀/存储目录/角色专属 config 字段）；默认 opt-in（不启用时代码路径走不到、零影响）；交付物与过程物分治（复用管道 ≠ 同等待遇）。
4. **机制分层与日落** —— 为未来更强的模型设计。判定公式："如果模型是完美的，这机制还需要吗？"是 → 永久架构（竞态/缓存/安全/数据治理，放心加）；否 → 能力拐杖，出生时必须登记日落条件并带退出机制（能力位门控 > 逃生舱口 > 文件式开关 > 硬编码禁止）。优先证据式反馈（给模型事实让它判断），硬拒绝只用于不可逆/高代价错误。**确定性归代码，判断力归模型。**

## 沟通风格

先讲用户视角的结果（对用这个 App 的老师/学生来说变了什么：更好、更快、还是更准），再讲实现细节。UI 文案和解释一律大白话，禁用"基本盘 / 沉淀 / 抽象化表述"这类产品黑话。被问"这样更好了吗"，答具体可观察的差别，不答架构描述。

## 协作契约（每次对话生效）

- 简洁输出，深入推理；代码优先，注释只在逻辑不自明时加；编辑优于重写；不重复读已读文件；不要拍马屁式开头结尾。**用户指令永远优先于本文件。**
- **探索**：修 bug 先查 [quick-navigation.md](docs/claude/quick-navigation.md) 定位文件；跨子系统任务先派 sub-agent 分治研究、综合后等用户确认再编码；3 次 Read 找不到目标改用 Grep/Glob。
- **新功能**（涉及 3+ 文件）：拆 4-6 个可验证阶段逐段实现；同一阶段卡住 2 次停下来给用户替代方案。
- **UI/UX 改动**：写码前先用三句话说清交互模型——用户看见什么 / 什么进文档持久化 / 什么是渲染时算出来的——等确认再动手；改完真机截图目视验收（观感问题读代码看不出来）。
- **Bug 修复**：修前写三点等确认（Root cause / Files / Proposed fix）。修后：build 通过但 **build ≠ 类型检查**（改签名必跑双 tsc）；测试报数读完整 summary 行、回归看通过集不变量；UI 变更目视验证、流式修复验证增量行为；"看不见"类 bug 先查 DOM clipping 再查数据流；"改动后坏了"先对照实验证伪；同一 bug 两次未解停手派 agent 独立分析。案例库 → [debugging-discipline.md](docs/claude/debugging-discipline.md)。
- **先有证据，再下结论**：根因、成本估算、服务健康度都不许靠推断——先写最小隔离探针脚本，或把真实数字对上，并说明证据出自哪个凭证/环境/构建。证据不全就明确标成假设，不和已验证的结论混在一句里说。

## 红线（违反即事故）

- 新增 pi-tool 必须**三处登记**：`pi-tools.ts` 定义 / `role-manager.ts` COMMON_TOOLS / `pi-security.ts` classifyToolRisk——缺一则 AI 看不到工具或 IPC 卡死（详见 quick-navigation.md）。
- 改 `openpipal-extension/` 必须 bump `manifest.json` version；改 renderer 必须 `npx electron-vite build` 插件才能看到。
- Settings 页面不得暴露内置 API Key、Base URL、模型名称。

## 高频命令

```bash
npm run dev                                  # 开发模式
npx electron-vite build && npx electron .    # 快速重建+启动
npx tsc --noEmit -p tsconfig.node.json       # main 类型检查（renderer 用 tsconfig.web.json）
npx vitest run                               # 单测
npx playwright test                          # E2E
```

## 构建与打包验证

宣称"打好包了"或请用户上机测试之前，按序走完三步，一步都不许跳：

1. 先跑完整 `npx electron-vite build`（renderer 改动不 build，插件和装机版看到的都是旧代码）；
2. 再打包 / 安装；
3. 再确认 /Applications 里正在跑的那个二进制就是新构建——查版本号或某个可见标记，别默认安装成功。

**没真正执行过命令，就绝不说"运行时已验证"，要说"尚未运行时验证"。** 装机版专属故障（Cannot find module 等 dev 复现不了的）→ [debugging-discipline.md](docs/claude/debugging-discipline.md)。

## 入口目录（渐进式披露：什么时候读什么）

| 场景 | 读 |
|---|---|
| 修 bug / 定位子系统文件、新增工具三处登记、安全体系 | [quick-navigation.md](docs/claude/quick-navigation.md) |
| 设计新能力/新工具/新展示物（含架构反例库、workspace 检查清单、渐进式披露细则） | [design-philosophy.md](docs/claude/design-philosophy.md) |
| 新增/评审门闩拐杖、升级模型档位（机制台账：分层/日落条件/退出方式） | [mechanism-registry.md](docs/claude/mechanism-registry.md) |
| bug 卡住、疑似回归、需要对照实验（含历史教训案例库） | [debugging-discipline.md](docs/claude/debugging-discipline.md) |
| 架构细节：文件清单/数据流/HTTP API/Data Paths/MCP/平台与测试细节 | [architecture.md](docs/claude/architecture.md) |
| 设计 system prompt / 工具注入策略 | [context-budget.md](docs/claude/context-budget.md) |
| 已知限制/窗口跟随行为 | [known-limitations.md](docs/claude/known-limitations.md) |
| 改 design 角色（官方对标提示词原文） | [anthropic-design-agent-prompt.md](docs/claude/anthropic-design-agent-prompt.md) |
| 课堂实时教学优化（未实现路线图） | [classroom-realtime-roadmap.md](docs/claude/classroom-realtime-roadmap.md) |
| MCP 动态 UI / iframe 双向通信 | [mcp-apps-protocol.md](docs/claude/mcp-apps-protocol.md) |

**文档维护路由**：新 bug 定位路径 → quick-navigation.md 表；新机制 → mechanism-registry.md 登记；架构/数据流 → architecture.md；哲学/反例 → design-philosophy.md；教训案例 → debugging-discipline.md。**本文件只收核心原则与高频契约的变更**；低频内容进子文档、这里只留入口。
