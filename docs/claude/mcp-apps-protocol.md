# MCP Apps 协议参考(OpenPipal 实现视角)

> 仅收录 OpenPipal 实现时真正用到的部分。完整规范见 https://modelcontextprotocol.io/extensions/apps/overview

## 协议定位

MCP Apps 是 MCP 核心协议的**扩展**(Extension),让 server 能在 tool response 里返回**可交互的 HTML/JS UI**,在 host 侧沙盒 iframe 渲染,通过 postMessage 双向通信。

适用场景:数据探索、多参数表单、富媒体预览、实时监控面板、多步骤审批流。不适用:纯文本 / 简单 markdown / 单次确认。

## 两个核心 primitive 的耦合

```
工具定义(tools/list 返回项):
{
  name: "show_analytics",
  description: "...",
  _meta: {
    ui: {
      resourceUri: "ui://analytics/dashboard",
      permissions?: ["microphone", "camera"],  // 可选,请求额外能力
      csp?: {                                   // 可选,CSP 外源白名单
        scriptSrc: ["https://cdn.example.com"],
        styleSrc:  ["https://fonts.example.com"]
      }
    }
  }
}

UI Resource(resources/read 返回项):
{
  uri: "ui://analytics/dashboard",
  mimeType: "text/html",
  text: "<html>...</html>"   // 自包含 HTML,内联 JS/CSS
}
```

## 信号流(工具被调用时)

```
1. Host 检测到 tool._meta.ui.resourceUri  → 可预拉取 resource(streaming 优化)
2. AI 决定调用 tool → host 正常发 tools/call
3. Server 返回 result(MCP 标准格式)
4. Host 把 result 推给 iframe(postMessage)
5. iframe 里的 app 首次渲染或更新展示
6. 用户在 iframe 交互 → iframe postMessage 回 host,请求更多 tools/call
7. Host 代理转发到 server → 新数据回推到 iframe
```

**关键点**:UI 和 tool call **解耦**。同一个 `ui://` resource 可以被多个 tool 返回时共用,UI 永远是从 host 推送的 data 驱动渲染,不在 server 侧预渲染。

## postMessage JSON-RPC 方言

host 和 iframe 之间走 JSON-RPC over postMessage。关键方法:

| 方法 | 方向 | 用途 |
|---|---|---|
| `ui/initialize` | host → iframe | 建立连接,传递能力协商结果 |
| `tools/call` | iframe → host | iframe 请求 host 代理调用一个 MCP 工具 |
| `ui/update` | host → iframe | 推送新数据到 iframe |
| `ui/sendOpenLink` | iframe → host | iframe 请求打开外链(host 可拒绝) |
| `ui/contextUpdate` | iframe → host | iframe 告诉 agent 它当前的状态(影响后续 LLM context)|

其中 `tools/call` 是与 MCP 核心协议**同名**的方法——iframe 发出的 call 会被 host 代理到 server,相当于 iframe 多了一个"AI 的能力面"。

## 安全模型(OpenPipal 实现必须遵守)

- **Iframe sandbox**: 至少 `sandbox="allow-scripts"`,**不给** `allow-same-origin`(防止读 cookies)
- **CSP**: 根据 `_meta.ui.csp` 生成 Content-Security-Policy header / meta tag。未声明的外源一律拒绝
- **Tool call 代理权限**: iframe 发出的 `tools/call` 必须经过 OpenPipal `classifyToolRisk` — 即便原始 AI 已获用户确认,iframe 再次调用要重新判定
- **Permissions**: camera/mic 默认关闭,需要在 `_meta.ui.permissions` 声明且用户点确认才开

## OpenPipal 实现映射

| MCP Apps 概念 | OpenPipal 承载 |
|---|---|
| iframe host | `StreamingInlinePreview.tsx` / `VisualizerEmbed.tsx`(已有 iframe + postMessage) |
| UI resource 存储 | `visualizerStore` 新增 `mcp-app` 类型 artifact |
| tool call 反向路由 | iframe postMessage → renderer ipc → main → `mcp-manager.callTool` |
| 安全 gate | 复用 `pi-security.classifyToolRisk`,在代理入口拦截 |
| 内容持久化 | 复用 `ChatMessage.visualizerHtml`(已有),追加 `mcpAppMeta` 字段存 resourceUri / permissions / csp |

**禁止**:
- 新造 `mcp-app` 独立面板 / 独立存储路径 — 违反 artifact 管道统一原则
- iframe 直接发 HTTP 请求到 MCP server — 必须走 host 代理(安全边界)
- 把 UI resource 的全文塞进 system prompt — 违反 context budget

## 实现里程碑

| # | 描述 | 状态 |
|---|---|---|
| 1 | **检测**: `mcp-manager` 在 `listTools()` 后读取 `_meta.ui.resourceUri`,预拉取 `ui://` 资源 HTML | ✅ 已实现 |
| 2 | **渲染**: `artifactStore` 新增 `mcp-app` type,`McpAppPreview.tsx` 用 sandbox iframe 渲染 | ✅ 已实现 |
| 3 | **ui/initialize 握手**: host 收到 iframe 请求后回复初始 tool 结果 + capabilities | ✅ 已实现 |
| 4 | **反向 tools/call**: iframe → preload IPC `mcp:call-from-app` → 主进程三道门(同 server + risky 拒 + needs_confirmation 拒) → 原路回 | ✅ 已实现 |
| 5 | **捕获路径**: `pi-mcp-bridge` 在沙盒 `tools.call()` 后捕获带 UI 的调用,execute 结束以 `details.artifact` 返回 | ✅ 已实现 |
| 6 | **permissions 申请 + 用户确认**: 读 `_meta.ui.permissions`,弹 gate UI 列出申请项,用户允许后写入 `~/.openpipal/mcp-app-permissions.json`(per-server),iframe 设置 `allow="microphone; camera; ..."` 启用对应能力 | ✅ 已实现 |
| 7 | **CSP**: 根据 `_meta.ui.csp` 动态生成外源白名单 meta 标签 | ⏳ 待办 |
| 8 | **ui/update 主动推送**: server / host 主动向 iframe 推新数据(而非等 iframe 拉取) | ⏳ 待办 |
| 9 | **ui/contextUpdate 回写**: iframe → chatStore,下一轮 LLM 看到 App 状态 | ⏳ 待办 |

## 已知边界

- iframe 的 CSP 仅靠 sandbox 隔离,未根据 `_meta.ui.csp.scriptSrc` 生成 meta 标签
- `tools/call` 反向调用限定在 UI 所属 server 内,跨 server 调用被主进程拒绝
- permissions 授权按 server 维度持久化(粒度不到 tool / App 级):同 server 多个 App 共享同一组授权
- sandbox 始终是 `allow-scripts`,不放 `allow-same-origin`(防止读 host cookies / 父页 DOM)
- 不识别非标准 capability 名称(白名单内: microphone / camera / geolocation / clipboard-read / clipboard-write / fullscreen / autoplay)

## 非目标(明确不做)

- 不支持 `allow-same-origin` 的宽松 iframe
- 不实现 `@mcp-ui/client` React 组件库(和现有 VisualizerEmbed 冲突)
- 不主动缓存 UI resource 到磁盘(保持和现有 visualizer 一样,conversation 级持久化即可)

## 参考

- 官方规范: https://modelcontextprotocol.io/extensions/apps/overview
- 官方示例: https://github.com/modelcontextprotocol/ext-apps/tree/main/examples
- AppBridge SDK(我们不用,但可参考通信协议): https://apps.extensions.modelcontextprotocol.io/api/modules/app-bridge.html
