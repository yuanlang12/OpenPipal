# OpenPipal

> 一个会自动贴到你正在用的那个 App 旁边的 AI 助手 —— macOS 原生应用 + 浏览器侧栏。

<p align="center">
  <a href="https://github.com/yuanlang12/OpenPipal/releases/latest">
    <img src="https://img.shields.io/github/v/release/yuanlang12/OpenPipal?label=download&color=14b8a6" alt="Download" />
  </a>
  <img src="https://img.shields.io/badge/platform-macOS-1c1917" alt="macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-14b8a6" alt="Apache-2.0" /></a>
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

你切到哪个应用，OpenPipal 就跟到哪儿，停在屏幕侧边——对话待在活儿旁边，而不是另开一个窗口。

**它不自带任何模型。** 每一次请求都从你的 Mac 直接发往你自己配置的 OpenAI 兼容端点：
你的密钥、你的服务商、你的账单。中间没有 OpenPipal 的服务器，因为根本就没有。

---

## 这一版包含什么

本仓库只附带**默认 OpenPipal Agent**。

另外五个内置 Agent（学习助手、教学助手、办公、设计、同传）依赖一套我们尚未完成自研
替换的设计运行时，因此不在本次开源发行内；等那套重写落地后它们会整体回归。自定义
Agent、技能、MCP、记忆和浏览器扩展都不受影响。

公开树由 [`scripts/make-open-source-cut.mjs`](scripts/make-open-source-cut.mjs) 依据
[`config/open-source-policy.json`](config/open-source-policy.json) 从我们的工作仓库裁出。
被裁掉的每一条路径都列在 `OPEN-SOURCE-CUT.json` 里——这份裁剪是可复现的，不是手工挑的。

---

## 安装

### 桌面端

1. 到 [Releases](https://github.com/yuanlang12/OpenPipal/releases/latest) 下载对应你 Mac 的
   `.dmg`（Apple Silicon 与 Intel 分开构建），把 `OpenPipal.app` 拖进 `Applications`。
2. **首次打开要右键 → 打开**，再在弹窗里确认一次。这个包没做 Apple 公证，直接双击会被
   macOS 拦下。只需要做这一次。
3. 进 **设置 → 模型**，添加一个预设，填 Base URL、API Key 和模型名。

### 浏览器扩展（可选）

1. 从同一个 Release 下载 `openpipal-extension-*.zip`，解压到任意目录。
2. 在 Chrome / Edge / Brave 打开 `chrome://extensions`，开启右上角的**开发者模式**。
3. 点**加载已解压的扩展程序**，选中刚才那个目录。

扩展和桌面端共用同一个 AI 实例，通过 `localhost:3031` 通信，所以**桌面端必须开着**。

---

## 支持的模型服务

任何讲 OpenAI 兼容协议的服务都能接。内置预设：

| 服务商 | Base URL | 示例模型 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat`、`deepseek-reasoner` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct` |
| 本地 Ollama | `http://localhost:11434/v1` | 你拉过的任意模型 |

---

## 它能做什么

- **跟随前台应用**——切窗口，OpenPipal 自己重新停靠
- **Visualizer**——模型实时渲染卡片、图表、白板和 Mermaid 图
- **技能**——内置文档、PDF、幻灯片、表格处理，外加技能创建器和工具安装器；
  也能从本地文件夹或 GitHub 仓库导入你自己的
- **长期记忆**——按 Agent 分开，默认关闭，存成你能直接读能改的 Markdown
- **MCP**——接任意 Model Context Protocol 服务器，Context7 和 DeepWiki 是内置预设
- **浏览器侧栏**——同一个助手，在浏览器里也能用

---

## 数据都在你自己机器上

```
~/.openpipal/
├── config.json     # 模型预设与应用设置
├── memory/         # 长期记忆，按 Agent 分目录
├── outputs/        # 模型产出的文件
├── conversations/  # 对话历史
└── skills/         # 你自己的技能
```

API Key 存在本机的 `config.json` 里，不会上传。删掉 `~/.openpipal/` 就等于清空一切。

---

## 从源码构建

需要 macOS、Node.js 22.19+ 和 npm。

```bash
npm ci
npx electron-vite build
npx electron .                   # 运行构建产物
```

检查：

```bash
npx tsc --noEmit -p tsconfig.node.json   # 主进程
npx tsc --noEmit -p tsconfig.web.json    # 渲染层
npx vitest run                           # 单元测试
npx playwright test                      # 端到端
```

`npm run dev` 是常用的热重载开发模式。打包用
`npx electron-builder --config electron-builder.yml`——注意这样出来的包未签名、未公证。

### 目录结构

| 路径 | 内容 |
|---|---|
| `src/main/` | Electron 主进程——Agent 运行时、工具、IPC、窗口停靠 |
| `src/renderer/` | React 界面，桌面端与浏览器侧栏共用 |
| `src/preload/` | 两者之间的 IPC 桥 |
| `src/shared/` | 双方共用的契约与多语言词条 |
| `openpipal-extension/` | Chrome 扩展 |
| `resources/skills/` | 内置技能 |
| `docs/` | 架构说明与开发记录 |

渲染层在桌面端走 preload IPC，在浏览器扩展里走 `:3031` 的 HTTP/SSE 垫片——
一套渲染层，两种传输。

---

## 常见问题

**macOS 提示无法验证开发者。** 右键 → 打开，别双击，然后确认。每次安装做一次就好。

**免费吗？** 应用免费。模型用量由服务商直接向你计费，OpenPipal 既不经手钱也不经手密钥。

**能跑本地模型吗？** 能。Base URL 填 `http://localhost:11434/v1` 接 Ollama，模型名填你拉过的。

**Windows / Linux？** 暂无计划。停靠行为依赖 macOS 的窗口 API。

**扩展没反应。** 确认桌面端在运行，扩展需要它监听 `localhost:3031`。

---

## 参与

Bug 和想法欢迎提到 [Issues](https://github.com/yuanlang12/OpenPipal/issues)。
提 PR 前请看 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题的私下报告方式见
[SECURITY.md](SECURITY.md)。

---

## 许可

[Apache-2.0](LICENSE)。第三方组件及其许可证列在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，内置技能的声明在
`resources/SKILLS-NOTICE.md`。
