# openpipal-acp

[![npm](https://img.shields.io/badge/npm-openpipal--acp-cb3837)](https://www.npmjs.com/package/openpipal-acp) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

ACP (Agent Client Protocol) adapter for [OpenPipal](https://openpipal.io) — 把 OpenPipal 桌面端的 Agent（4 内置角色 + 你保存的所有自定义 Agent）暴露给任何 ACP-compatible 编辑器：**Zed / JetBrains / Neovim / Obsidian** 等。

## 它是什么

```
[Zed/JetBrains/...]  ←ACP stdio→  [openpipal-acp]  ←HTTP/SSE→  [OpenPipal 桌面端]  →  [LLM]
                                  纯协议翻译器                  你的 Agent 在这跑
```

`openpipal-acp` 是 **纯协议翻译器**——不调 LLM、不持有 API key、不存对话。所有真活在 OpenPipal 桌面端做。这意味着：

- 你在 OpenPipal 桌面端创建的 Agent，Zed 里同样可用
- 对话历史、记忆、skills 完全和桌面端共享
- 在 Zed 里发送的消息会落盘到桌面端会话存储（重启不丢），在桌面端打开该会话即可查看历史
- API key 仅保存在 OpenPipal 桌面端，openpipal-acp 永远拿不到

## 前提

- macOS（OpenPipal 桌面端目前只支持 macOS）
- OpenPipal 桌面端运行中（`localhost:3031` 监听）
- Node.js ≥ 20.0.0

## 安装

```bash
npm install -g openpipal-acp
```

## 配置

### Zed

`~/.config/zed/settings.json`：

```json
{
  "agent_servers": {
    "OpenPipal": {
      "command": "openpipal-acp",
      "args": [],
      "env": {
        "OPENPIPAL_ACP_V2": "1"
      }
    }
  }
}
```

打开 Zed，运行 `agent: new thread` 命令，选 OpenPipal。

### ACP v2 Draft

`openpipal-acp` 同时保留 ACP v1，并提供 ACP v2 Draft 支持。由于官方仍把 v2 标为实验协议，v2 必须通过 `OPENPIPAL_ACP_V2=1` 显式开启；未开启时始终只协商 v1。

开启后，适配器会根据客户端 `initialize.protocolVersion` 为每条连接选择协议：

- v1 客户端继续使用原有 `session/prompt` 长请求和 `session/set_mode`
- v2 客户端使用即时 prompt acknowledgment，并通过 `state_update` 接收 running / idle / cancelled
- v2 消息和思考流都带稳定 `messageId`，工具调用统一使用 `tool_call_update`
- v2 支持 `session/list`、`session/resume`（含 `replayFrom: {"type":"start"}`）、`session/close` 和 `session/delete`
- 内置角色在 v2 中通过 `session/set_config_option` 暴露为 `category: "mode"` 的配置项

v2 仍是 Draft，升级 SDK 时应重新运行 `npm run test:protocol`，确认草案没有发生不兼容变化。

### JetBrains（IntelliJ / WebStorm / PyCharm 等）

通过 [Junie](https://www.jetbrains.com/junie/) 或其他 ACP 客户端插件，添加 custom agent server：

```
Command: openpipal-acp
Args: (none)
```

### Neovim

通过 [agent-client-protocol.nvim](https://github.com/agent-client-protocol-nvim) 或类似插件：

```lua
require('acp').setup({
  agents = {
    openpipal = { command = 'openpipal-acp' }
  }
})
```

## 使用

1. 打开 OpenPipal 桌面端（macOS 应用）
2. 在你的编辑器里启动 ACP thread/session 选 OpenPipal
3. **选择 Agent**：openpipal-acp 会通过 `_meta.openpipal.io/agents` 暴露 OpenPipal 的 4 内置角色（学习助手 / 教师 / 办公 / 设计）+ 你保存的自定义 Agent
4. 通过编辑器的 mode 切换功能切换内置角色（v1 使用 `session/set_mode`，v2 使用 `session/set_config_option`）
5. 像在 OpenPipal 桌面端一样发消息、调用工具

## 故障排除

### "OpenPipal 桌面端未启动"

→ 先打开 OpenPipal 桌面端（确认 `lsof -iTCP:3031` 有 Electron 监听）。

### Zed 连接成功但消息无响应

→ 在 OpenPipal 桌面端 Settings → Models 确认 API key + 模型都配了。openpipal-acp 不持有任何凭据——所有 LLM 调用走桌面端。

### 看到 `📎 Artifact: ...` / `📊 Visualizer: ...` 但无内容

→ 这是有意的 fallback——OpenPipal 的 artifact / visualizer 是 HTML/SVG/canvas，外部编辑器无法直接渲染。完整版在 OpenPipal 桌面端侧栏查看。

### 切换自定义 Agent 失败

→ 当前版本只支持 4 个内置角色通过协议配置切换。自定义 Agent 需要在 `session/new` 时通过 `_meta.openpipal.io/agentId` 选择。

## MCP server 注入（Stage 9）

openpipal-acp 实现了 ACP 标准的 `session/new.mcpServers` 字段——你在编辑器里配置的外部 MCP server 会在 session 创建时通过 HTTP 注入到 OpenPipal 桌面端，**仅在本 ACP session 范围内可见**，不污染桌面端的全局 MCP 配置和其他 ACP session。v1 支持 http / sse / stdio；v2 Draft 按新协议支持 http / stdio。

### Zed 示例

`~/.config/zed/settings.json`：

```json
{
  "agent_servers": {
    "OpenPipal": {
      "command": "openpipal-acp",
      "args": [],
      "env": {
        "OPENPIPAL_ACP_V2": "1"
      }
    }
  },
  "context_servers": {
    "context7": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": {}
    }
  }
}
```

Zed 会把 `context_servers` 透传给 `session/new.mcpServers`，openpipal-acp 注入到桌面端，AI 可通过 `mcp_execute` 调用。

### 生命周期

- **注册**：`newSession` 在创建桌面端 conversation 后立即 `POST /api/acp/sessions/:id/mcp` 注入。
- **可见性**：仅本 session 的 conversation 看得到，其他对话和桌面端正常路径完全无感。
- **清理**：ACP 进程收到 `SIGINT/SIGTERM/SIGHUP` 或 `beforeExit` 时自动 `DELETE` 注销所有注入过 MCP 的 session；连接和子进程随之关闭。
- **本机认证**：除公开的健康检查外，适配器发往桌面端的所有动态请求（会话、角色、聊天流和 session MCP 注册/清理）都会携带桌面端创建的受保护本机令牌。编辑器配置无需写入令牌；适配器默认从权限受限的 `~/.openpipal/acp-mcp.token` 读取，单独部署时可显式设置 `OPENPIPAL_ACP_TOKEN`。

### Agent capabilities

`initialize` 响应里声明：

```json
{
  "agentCapabilities": {
    "loadSession": false,
    "mcpCapabilities": { "http": true, "sse": true }
  }
}
```

stdio 是 ACP 默认（McpServer 无 `type` 字段），http / sse 通过 `mcpCapabilities` 显式声明。

ACP v2 使用新的 capability 结构：`capabilities.session.mcp.stdio/http` 都是对象型 support marker，不再使用 v1 的布尔字段。

### 部分失败行为

单个 MCP server 连接失败 ≠ session 创建失败。失败信息写到 stderr，session 仍可用——只是缺那个 server 的工具。返回值结构：`{ registered: [{name, toolCount}], failed: [{name, error}] }`。

## 已知限制

- `/role/switch` 是 OpenPipal 全局态——多个 ACP 客户端同时切换会互相影响
- 自定义 Agent 不在 ACP modes 列表里（暂只通过 `_meta.openpipal.io/agents` 暴露给客户端，运行时切换待定）
- Visualizer / Artifact / questions_v2 等 OpenPipal 特色 UI 在外部编辑器中以 markdown summary 显示，完整体验仅在桌面端
- ACP v2 仍是官方 Draft，默认关闭；发布前必须重新验证 Zed 当前版本和官方 SDK

## 开发

```bash
git clone https://github.com/openpipal/openpipal-acp # TODO 定 repo URL
cd openpipal-acp
npm install
npm run build       # tsup → dist/index.js
npm run typecheck   # tsc --noEmit
npm run test:protocol       # 离线 v1/v2 协议兼容测试，不启动 Electron
node scripts/e2e-stage4.mjs  # 自动 E2E 测试（需桌面端运行）
```

## License

MIT
