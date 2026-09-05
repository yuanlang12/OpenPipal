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
- **破坏性但可逆**的命令：`rm -rf`、`git reset --hard`、`git clean -fdx`、`git push --force`、`find -delete`
  （编码工作里的日常操作——回滚失败改动、重装依赖、强推自己的分支。硬拒它们等于让 agent 在需要
  回滚时走投无路；`git push --force-with-lease` 是安全替代，不在此列，直接放行）
- 所有未分类的工具

### risky（直接阻止）
- 匹配**不可逆**命令：`sudo`、`mkfs`、`dd if=`、`curl|sh`、`chmod 777`，以及命令位置上的 shell `eval` / `exec`
  （只在行首或 `;` `&&` `||` `|` `(` 之后匹配——否则 `npm run test:eval`、`npm exec tsc` 会被误伤）
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
| `~/.git-credentials`、`~/.config/git/credentials` | git credential.helper=store 的明文凭证 |
| `~/.config/gh`、`~/.config/hub` | GitHub CLI 的 oauth token |
| `~/.gitconfig.local` | 常见的「把 token 塞进 url.insteadOf」私有配置 |
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

## 项目入口文档注入的边界

工作目录里的 `AGENTS.md` / `CLAUDE.md` 会被**原文读进系统提示词**（`main/agent-runtime/project-context.ts`）。
这条路径是直接 `readFileSync`，**不过工具层的读取黑名单**，所以边界由它自己守：

| 边界 | 拦的是什么 |
|------|-----------|
| 只走 `[仓库根 .. 工作目录]` | 没有 `.git` 就只看工作目录本层。爬到 `~` 或 `/` 会把用户其它项目、甚至全局私人规矩拽进本次对话 |
| 工作目录在 `~/.openpipal/**` 时整段不注入 | 助手自己的草稿区里的 md 是它自己的产物，注入等于自问自答 |
| 软链解析（`realpathSync.native`）后必须仍在仓库内 | `AGENTS.md -> ~/.ssh/id_rsa` 会把凭证原文送进系统提示词、随每一轮请求发给模型服务商 |
| 单文件 1MB 上限、整段 8k token 上限 | 一份失控的文档不该吃掉整个上下文窗口 |

注入的正文里明确声明它们是**项目配置而不是用户指令**：无权放宽安全边界、无权替用户授权。
第三方仓库里的 `AGENTS.md` 属于不可信内容，出现"忽略先前指令"这类文本时按可疑内容处理。

回归：`tests/unit/project-context-injection.test.ts`

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
| bash（普通命令） | risky（无沙箱时 shell 整条禁用） | safe（OS 已保护） |
| bash（不可逆，如 sudo/mkfs） | risky | risky（Layer 3 不可绕过） |
| bash（可逆破坏性，如 rm -rf） | risky（shell 已禁用） | needs_confirmation |
| 文件写入（允许路径内） | needs_confirmation | safe（沙箱限制写入范围） |
| 敏感路径访问 | risky | risky（Layer 3 不可绕过） |

### 三条执行通道同一套判据

`bash` / `execute_code(bash)` / `execute_code(python|js)` 共用 `assessDestructiveCommand()`：

- 此前只有 bash 通道过危险命令表，python 里 `subprocess.run(["git","reset","--hard"])` 是静默放行的。
  堵一扇门开一扇窗，模型会绕（2026-07-26 实案：`rm` 被拦 → 改用 `shutil.rmtree` 删了上个会话的产物）。
- 非 shell 语言额外扫一遍「摊平引号与逗号」后的文本，让参数数组写法也能被同一套规则看见。
  该摊平**只用于 needs_confirmation 档**——多问一次的代价远小于漏过；risky 档仍只看原文，
  避免字符串里提一句 `sudo` 就把整段代码硬拒。

### 文件系统配置

| 规则 | 路径 |
|------|------|
| denyRead | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.docker`, `~/.kube`, `~/.npmrc`, `~/.netrc`, `~/.password-store`, `~/.credentials` |
| allowWrite | `.`（工作目录）, `~/Documents`, `~/Desktop`, `~/Downloads`, `~/.openpipal`, `/tmp` |
| denyWrite | `.env`, `.git/hooks` |

### 网络配置

默认白名单分两组：**模型服务**（api.anthropic.com 等，不通就没法对话）与**取包/取代码**
（registry.npmjs.org、registry.yarnpkg.com、github.com、codeload.github.com、
objects.githubusercontent.com、raw.githubusercontent.com、pypi.org、files.pythonhosted.org）。
第二组是编码场景的最低要求——实测缺了它，`curl https://github.com` 与
`git ls-remote https://github.com/...` 都被代理挡成 `CONNECT tunnel failed, response 403`。

两个环境变量语义不同，别混（逗号分隔）：

| 变量 | 语义 | 用在什么时候 |
|---|---|---|
| `OPENPIPAL_ALLOWED_DOMAINS` | **整表替换** | 想**收窄**：只放行你列出的这几个域 |
| `OPENPIPAL_EXTRA_ALLOWED_DOMAINS` | **在默认表上追加** | 想**加一个**公司私有 registry |

分成两个而不是把前者改成追加：改语义会让"用它收窄"的人静默失去收窄效果（安全方向的回归）；
而只有前者时，想加一个域就得把整张默认表重抄一遍，抄漏一个 AI API 域就是整个应用连不上模型。

**SSH 走不通，而且补不了**：SRT 只代理 HTTP/HTTPS，沙箱里 DNS 也不放行，
`ssh git@github.com` 卡在 `Could not resolve hostname`。git 只能走 HTTPS。

### 环境变量过滤

沙箱化的 bash 命令执行前，自动移除以下敏感环境变量：
- 显式列表：`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`, `TAVILY_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`
- 模式匹配：所有以 `_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, `_CREDENTIAL` 结尾的变量

### Graceful Fallback

如果沙箱在以下情况下不可用，应用自动降级到现有三层安全模型：
- macOS / Linux 之外的平台（Windows，见下一节）
- Seatbelt 工具缺失
- 初始化异常

两种"没沙箱"在分类器里是分开判的：macOS / Linux **本该有沙箱却没起来**是故障，bash / execute_code 整条禁掉（fail-closed）；Windows **根本没有可用的 OS 沙箱**，走下面这套。

### Windows：没有 OS 沙箱时的边界

`@anthropic-ai/sandbox-runtime` 只有 Seatbelt（macOS）与 bubblewrap（Linux）两个后端，Windows 上没有等价物。Windows 版因此不带 OS 沙箱，边界就是**用户自己的账号权限**，应用层这样补：

- **每条命令交给用户裁决**：`bash`（Git Bash）/ `powershell` / `execute_code` 一律 `needs_confirmation`，确认卡理由写明"本平台没有系统沙箱，这条命令会以你的账号权限直接执行"。"本次会话允许"只记住完全相同的那一条命令；"完全允许"档吃掉普通命令的确认，但破坏性命令（rm -rf / Remove-Item -Recurse / git reset --hard …）与用户目录/整盘遍历仍然每次问。
- **凭据路径文本闸**：命令或代码里**写明**了凭据位置（`~/.ssh`、`~/.aws`、`%APPDATA%\GitHub CLI`、`.env`、`~/.openpipal/config.json` 等）直接拒绝，不给"点允许"的机会。它认不全（变量拼接、子解释器），所以是逐条确认之上的加一道，不是替代。`.env.example` 这类模板、`~/.openpipal/workspace` 与 `skills` 不在其列。
- **路径表按平台取**：系统目录禁写（`%SystemRoot%`、`Program Files`、`ProgramData`）、工作根禁区（盘根、`C:\Users`、`AppData`）、凭据目录（点目录那一套加 `%APPDATA%` 下的 gh / gcloud / gnupg / PowerShell 历史）都有 Windows 版本；比较时折叠大小写。
- **PowerShell 与 bash 同一张危险命令表**：Format-Volume / diskpart / `irm … | iex` / Invoke-Expression / RunAs / reg delete HKLM / Set-MpPreference -Disable 硬拒；Remove-Item -Recurse|-Force、rd /s /q、del /s /q、管道删除、HKCU 注册表删除、清空回收站需确认。

这是最低防线，不是沙箱的替代品：不可信仓库的 postinstall、提示词注入让 agent 跑的命令，在这里能挡住的只有"文本上认得出"的那部分。需要隔离的 Windows 用户，后续路线是 WSL2 里复用 bubblewrap 后端。


> **已知代价**：`GITHUB_TOKEN` / `GH_TOKEN` / `NPM_TOKEN` 也在剥离之列（`*_TOKEN` 通配），
> 因此沙箱内的 `git push`、私有源安装**无法用环境变量凭证认证**；SSH 又因为不被代理而走不通。
> 读侧不受影响：公开仓库的 clone/fetch/ls-remote、npm/pip 安装都实测可用。
> 是否为编码场景放行 git 凭证是一次显式的信任取舍，目前**保持剥离**，未开口子。

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
