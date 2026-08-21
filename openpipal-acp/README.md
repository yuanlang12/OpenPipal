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
- Node.js ≥ 20.0.0（**只有单独安装这一种方式需要**；随包分发那份用 OpenPipal 自带的 Node）

## 安装

装了 OpenPipal 就已经有了——适配器随 App 一起分发，不用再装任何东西。
路径和启动命令在**设置 →「连接」**里直接给出（那一页还有「复制启动命令」按钮，
里面就是下面这段 JSON 的当前真实值）：

```json
{
  "command": "/Applications/OpenPipal.app/Contents/MacOS/OpenPipal",
  "args": ["/Applications/OpenPipal.app/Contents/Resources/acp/openpipal-acp.mjs"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

`command` 就是 OpenPipal 自己：`ELECTRON_RUN_AS_NODE=1` 让它当普通 Node 用，
所以这台机器不需要另外装 Node，也不需要 npm。

单独安装（不装 OpenPipal 桌面端就用不了，但适配器本身可以独立更新）：

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
      "command": "/Applications/OpenPipal.app/Contents/MacOS/OpenPipal",
      "args": ["/Applications/OpenPipal.app/Contents/Resources/acp/openpipal-acp.mjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "OPENPIPAL_ACP_V2": "1"
      }
    }
  }
}
```

单独装过 npm 包的话，`command` 换成 `openpipal-acp`、`args` 留空、去掉
`ELECTRON_RUN_AS_NODE` 即可，其余不变。

打开 Zed，运行 `agent: new thread` 命令，选 OpenPipal。

### ACP v2 Draft

`openpipal-acp` 同时保留 ACP v1，并提供 ACP v2 Draft 支持。由于官方仍把 v2 标为实验协议，v2 必须通过 `OPENPIPAL_ACP_V2=1` 显式开启；未开启时始终只协商 v1。

开启后，适配器会根据客户端 `initialize.protocolVersion` 为每条连接选择协议：

- v1 客户端继续使用原有 `session/prompt` 长请求和 `session/set_mode`
- v2 客户端使用即时 prompt acknowledgment，并通过 `state_update` 接收 running / idle / cancelled
- v2 消息和思考流都带稳定 `messageId`，工具调用统一使用 `tool_call_update`
- v2 支持 `session/list`、`session/resume`（含 `replayFrom: {"type":"start"}`）、`session/close` 和 `session/delete`
- 内置角色在 v2 中通过 `session/set_config_option` 暴露为 `category: "mode"` 的配置项

- v2 的 `session/list` 支持分页：每页 50 条，游标是 keyset（按 updatedAt 降序 + id 破平），翻页期间有会话被删或被顶上去也不漏不重
- v2 下 create_artifact / create_visualizer 的正文走 `tool_call_content_chunk` 追加到那次工具调用上（编辑器里能看着产物被写出来）；v1 没有这个通道，仍走 `_meta` 透传

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
3. **选择 Agent**：内置角色和你保存的自定义 Agent 一起出现在编辑器的 mode / 配置选择器里（v1 是 `session/set_mode`，v2 是 `session/set_config_option`）。内置角色的值是裸名（`learner` / `design`…），自定义 Agent 是 `agent:<id>`
4. 换人格只在**这条会话还没发过消息**时生效——和桌面端同一把锁（开聊后人格锁定，防误切）。已经聊起来的会话要换人，在编辑器里新开一个 thread
5. **`/goal` —— 设个目标让它自己跑完**：`/goal <要达成什么>` 之后，**每一轮结束桌面端都会用一个判官模型读目标和最近对话，判"到了没"；没到就自动再跑一轮**，直到判定完成或撞上限（8 轮，与 Claude Code Stop hook 的 BLOCK_CAP 对齐）。`/goal show` 看进度，`/goal clear` 清掉。目标达成或撞上限时编辑器里会收到一句结论。三条安全闸：判官出错一律放过（不许把对话卡死）、连续 3 轮判否强停、`ask_user` 永远打断循环
6. **斜杠命令**：本会话可用的技能会报成编辑器的斜杠命令（`available_commands_update`）。点一下 `/技能名 补充说明`，适配器把它翻成 OpenPipal 自己的强调格式 `<skill-request>技能名</skill-request>`——和在桌面端打 `@技能名` 是同一件事，不是"发了段带斜杠的文本"。换人格后命令列表会跟着换（自定义 Agent 只带它自己的技能）
7. 人格被外部改动（你在桌面端 / 浏览器插件里动了同一条空会话）时，**编辑器立刻跟上**：适配器启动时就跟桌面端接了一条常驻推送通道，桌面端一改就喊一声，v1 发 `current_mode_update`，v2 发 `config_option_update`，不用等你在编辑器里再说话。通道断了会退避重连；就算一直连不上也不影响正确性——每轮开跑前还有一次对账兜底，所以**任何情况下都不会拿错人格去跑**，最坏只是标签晚一点更正
5. 像在 OpenPipal 桌面端一样发消息、调用工具

## 权限确认

高风险工具（写文件、执行命令等）需要授权时，**授权框出现在你的编辑器里**，不用切回桌面端：

```
[桌面端 Pi Agent 请求授权] → SSE permission 事件 → [openpipal-acp]
   → session/request_permission → [Zed/JetBrains 弹出授权框] → 你选择
   → POST /api/permission → [桌面端继续这一轮]
```

三个选项：**允许一次** / **本次会话内始终允许**（映射成桌面端的会话级放行）/ **拒绝**。
ACP 标准里的 `reject_always` 没有提供——OpenPipal 没有会话级拒绝名单，给一个点了不生效的选项比不给更糟。

失败一律按拒绝处理：客户端不支持反向请求、报错、或你点了取消，适配器都会把"拒绝"回传给桌面端，
不会让那一轮永远挂着。v2 会话在等待期间处于 `state_update: requires_action`，选完回到 `running`。

## 故障排除

### "OpenPipal 桌面端未启动"

→ 先打开 OpenPipal 桌面端（确认 `lsof -iTCP:3031` 有 Electron 监听）。

### Zed 连接成功但消息无响应

→ 在 OpenPipal 桌面端 Settings → Models 确认 API key + 模型都配了。openpipal-acp 不持有任何凭据——所有 LLM 调用走桌面端。

### 看到 `📎 Artifact: ...` / `📊 Visualizer: ...` 但无内容

→ 这是有意的 fallback——OpenPipal 的 artifact / visualizer 是 HTML/SVG/canvas，外部编辑器无法直接渲染。完整版在 OpenPipal 桌面端侧栏查看。

### 切换自定义 Agent 失败

→ 报 `locked after the first message` 就是这条会话已经开聊了：人格在首条消息后锁定，新开 thread 即可。
→ 报"不是已保存的 OpenPipal Agent"就是值写错了：自定义 Agent 必须是 `agent:<id>` 形式，`id` 见
`initialize._meta.openpipal.io/agents` 或 `session/new` 返回的 modes / configOptions。

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
- 人格（内置角色 / 自定义 Agent）在会话发出第一条消息后锁定，中途换人要新开 thread——这与桌面端一致，不是 ACP 的限制
- Visualizer / Artifact / questions_v2 等 OpenPipal 特色 UI 在外部编辑器中以 markdown summary 显示，完整体验仅在桌面端
- ACP v2 仍是官方 Draft，默认关闭；发布前必须重新验证 Zed 当前版本和官方 SDK
- 授权只支持 allow_once / allow_always / reject_once；`reject_always` 不映射（桌面端没有会话级拒绝名单）
- 编辑器断开后仍在飞的授权请求会被自动拒绝——不再回落到桌面弹窗

## 开发

```bash
git clone https://github.com/openpipal/openpipal-acp # TODO 定 repo URL
cd openpipal-acp
npm install
npm run build       # tsup → dist/index.js
npm run typecheck   # tsc --noEmit
npm run test:protocol       # 离线 v1/v2 协议兼容测试，不启动 Electron
node scripts/e2e-stage4.mjs  # 自动 E2E 测试（需桌面端运行）
# 真机验收（真 Electron + 真 :3031 + 真适配器二进制，模型指向死端口，不花钱）：
#   npx playwright test tests/e2e/acp-desktop-live.spec.ts   （在仓库根目录跑）
```

## License

MIT
