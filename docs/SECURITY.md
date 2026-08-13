# OpenPipal 安全策略

> 源文件：`src/main/pi-security.ts`, `src/main/sandbox-manager.ts`
> 最后更新：2026-08-10

## 设计原则

1. **不牺牲能力**：安全检查不应阉割 Agent 能力。safe 操作自动放行，needs_confirmation 操作弹窗让用户决定，只有 risky 操作才主动阻止。
2. **纵深防御**：三层安全模型，每层独立工作，内层不可被外层绕过。
3. **最小权限**：默认拒绝未知操作，明确列入白名单的才放行。
4. **参考标准**：Claude Code auto mode（分类器+升级）、LobsterAI（权限门控+沙箱）。

## 三层安全模型

```
Layer 1: 工具风险分类器（每次 beforeToolCall）
  → safe: 自动放行，零延迟
  → risky: 阻止并返回原因，Agent 自动换方案
  → needs_confirmation: 升级到 Layer 2

Layer 2: 用户确认（Renderer UI；桌面 IPC / 会话 SSE + HTTP 回传）
  → 显示工具名、参数摘要、风险原因
  → 用户点「允许」或「拒绝」
  → 各通道按自身超时和执行生命周期 fail closed；无可用通道即拒绝

Layer 3: 硬性边界（不可绕过，即使 Layer 1/2 放行也会拦截）
  → 敏感路径黑名单
  → 系统目录禁写
  → 符号链接追踪（防止通过 symlink 绕过路径检查）
```

## 分类规则

### safe（自动放行）
- 只读内置工具：`read_screen`, `read_page_content`, `recall_memory`, `load_skill`, `web_search`, `capture_screenshot`
- 用户交互工具：`ask_user`
- 自有数据写入：`save_memory`（写入 `~/.openpipal/` 目录）
- 文件读取：`read_file`（路径在允许目录内时）
- MCP 工具名以 `get_`, `list_`, `query_`, `search_`, `resolve`, `fetch_` 开头

### needs_confirmation（弹窗确认）
- 所有命令执行：`execute_command`, `bash`, `shell`（非危险模式的）
- `generate_document`（创建本地文件）
- `write_file`（路径在允许目录内时）
- MCP 工具名以 `create_`, `add_`, `edit_`, `modify_`, `update_`, `set_` 开头
- MCP 工具名以 `delete_`, `remove_`, `drop_`, `stop_`, `end_` 开头
- 文件写入操作（路径在允许范围内）
- 所有未分类的工具

### risky（直接阻止）
- 匹配危险 bash 模式：`rm -rf`, `sudo`, `chmod 777`, `git push --force`, `dd if=`, `eval`, `curl|sh` 等
- 路径指向敏感目录（见下方黑名单）
- 路径指向系统目录（`/etc`, `/System`, `/usr` 等）
- 路径不在允许的工作目录内

## 敏感路径黑名单

以下路径即使在用户主目录内也**绝对拒绝**访问：

| 路径 | 说明 |
|------|------|
| `~/.ssh/` | SSH 密钥 |
| `~/.aws/` | AWS 凭证 |
| `~/.gnupg/` | GPG 密钥 |
| `~/.config/gcloud/` | Google Cloud 凭证 |
| `~/.docker/` | Docker 配置和凭证 |
| `~/.kube/` | Kubernetes 配置 |
| `~/.npmrc` | npm 凭证 |
| `~/.netrc` | 网络凭证 |
| `~/.bash_history`, `~/.zsh_history` | 命令历史 |
| `~/.env`, `~/.credentials` | 通用凭证文件 |
| `~/.password-store/` | 密码管理器 |

## 允许的工作目录

| 路径 | 说明 |
|------|------|
| `~/.openpipal/` | OpenPipal 数据目录 |
| `~/Documents/` | 用户文档 |
| `~/Desktop/` | 桌面 |
| `~/Downloads/` | 下载目录 |
| `/tmp/`, `os.tmpdir()` | 临时目录 |

## MCP 工具安全策略

MCP 工具通过 Pi Agent 的 `beforeToolCall` hook **统一经过分类器检查**。分类规则：

1. **按名称前缀推断操作类型**（见上方分类规则）
2. **参数中的文件路径同样受 Layer 3 硬性边界约束**
3. 所有 MCP 工具对所有角色开放（角色白名单不过滤 MCP 工具——这是设计决策，因为 MCP 工具已经有安全分类器保护）

## 权限审批流程

### 桌面模式（Electron）
1. 分类器判定 `needs_confirmation`
2. `createDesktopPermissionHandler` 通过 `agent:permission-request` 把请求发给
   Renderer 的确认 UI；会话内联请求使用 `permission:inline-request`
3. Renderer 分别通过 `agent:permission-response` 或
   `permission:inline-response` 回传用户决定
4. 用户明确允许后才执行；拒绝、超时、执行已中止或窗口不可用时均拒绝
5. 只有用户明确选择会话级授权时才记录对应工具/站点许可

### 浏览器扩展模式（HTTP）
1. 分类器判定 `needs_confirmation`
2. 活跃且归属于扩展的聊天 SSE 流收到权限请求；请求不会回落到无关的
   桌面窗口
3. 已认证的浏览器客户端通过 `POST /api/permission` 回传
   `requestId`、执行/会话标识和允许/拒绝决定
4. 无活动流、标识不匹配、请求已过期或解析器不可用时 fail closed；HTTP
   返回明确失败，工具不执行
5. 无持久会话的 HTTP turn 只能批准本次操作，不能创建持久的会话级授权
6. 旧的 `autoApproveHandler` 已废除，浏览器入口不会自动批准

### 已实现的桥接通道

- 普通桌面确认：`agent:permission-request` / `agent:permission-response`
- 桌面会话内联确认：`permission:inline-request` /
  `permission:inline-response`
- 扩展会话确认：聊天 SSE 权限事件 / `POST /api/permission`
- Preload API：`onPermissionRequest()`, `respondPermission()`,
  `onPermissionRequestInline()`, `respondPermissionInline()`

## Agent 能力升级安全检查清单

每次升级 Agent 能力时，必须检查以下项目：

- [ ] 新增的工具是否已在分类器中注册（safe/risky/needs_confirmation）？
- [ ] 新增的 MCP 服务是否有破坏性操作？其工具名前缀是否被正确分类？
- [ ] 新增的文件操作是否受路径边界约束？
- [ ] 新增的网络操作是否有数据泄露风险？
- [ ] 是否需要更新敏感路径黑名单？
- [ ] 是否需要更新允许的工作目录？

## OS 级沙箱（sandbox-runtime）

> 源文件：`src/main/sandbox-manager.ts`
> 依赖：`@anthropic-ai/sandbox-runtime`

### 工作原理

OpenPipal 集成了 Anthropic 的 Sandbox Runtime (SRT)，在 macOS 上通过 Seatbelt (`sandbox-exec`) 实现 **进程级别** 的文件系统和网络隔离。

```
应用启动 → initSandbox()
                ↓
        平台支持？ ──否──→ 降级到三层安全模型
                ↓是
        SRT.initialize(config)
                ↓
        沙箱就绪 ──→ bash 工具通过 SRT.wrapWithSandbox() 包装命令
```

### 沙箱生效时的安全降级

| 操作 | 无沙箱 | 有沙箱 |
|------|--------|--------|
| bash（非危险命令） | needs_confirmation | safe（OS 已保护） |
| bash（危险命令如 rm -rf） | risky | risky（Layer 3 不可绕过） |
| 文件写入（允许路径内） | needs_confirmation | safe（沙箱限制写入范围） |
| 敏感路径访问 | risky | risky（Layer 3 不可绕过） |

### 文件系统配置

| 规则 | 路径 |
|------|------|
| denyRead | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.docker`, `~/.kube`, `~/.npmrc`, `~/.netrc`, `~/.password-store`, `~/.credentials` |
| allowWrite | `.`（工作目录）, `~/Documents`, `~/Desktop`, `~/Downloads`, `~/.openpipal`, `/tmp` |
| denyWrite | `.env`, `.git/hooks` |

### 网络配置

默认只允许已知 AI API 域名出站，可通过环境变量 `OPENPIPAL_ALLOWED_DOMAINS` 扩展（逗号分隔）。

### 环境变量过滤

沙箱化的 bash 命令执行前，自动移除以下敏感环境变量：
- 显式列表：`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`, `TAVILY_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`
- 模式匹配：所有以 `_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, `_CREDENTIAL` 结尾的变量

### Graceful Fallback

如果沙箱在以下情况下不可用，应用自动降级到现有三层安全模型：
- 非 macOS 平台
- Seatbelt 工具缺失
- 初始化异常

## 审计日志

所有工具调用自动记录到 `~/.openpipal/audit.log`：

```
[2026-03-31T10:00:00.000Z] TOOL=bash ARGS={"command":"ls -la"} RESULT=safe SANDBOX=true
[2026-03-31T10:00:01.000Z] TOOL=write ARGS={"path":"./test.ts"} RESULT=safe SANDBOX=true
```

日志使用非阻塞写入（`appendFile`），不影响工具执行性能。

## 权限审批策略变更

- **废除 `autoApproveHandler`**：浏览器扩展模式不再自动批准所有 needs_confirmation 请求
- **默认拒绝**：如果没有可用且匹配当前执行的 Renderer/SSE 审批通道，所有
  needs_confirmation 请求默认拒绝
- 桌面、内联和扩展响应最终都进入受执行/会话标识约束的权限解析器

## 未来规划

- **审批 UI 完善**：补齐键盘/焦点、超时提示和可审计的会话级授权管理
- **用户可配置白名单/黑名单**：在设置中添加路径白名单编辑器
- **审计日志 UI**：在设置页面展示工具调用历史和安全事件
