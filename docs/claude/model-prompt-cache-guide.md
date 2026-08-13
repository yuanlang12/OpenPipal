# 模型前缀缓存接入指南

这份说明用于新增或更换模型时检查提示词缓存。缓存属于服务商协议能力，不能只凭“接口兼容 OpenAI”推断行为相同。

## OpenPipal 的上下文不变量

1. 系统提示、工具定义等稳定内容放在请求前缀；当前轮的时间、产物状态等易变信息放在尾部。
2. 对话历史按发生顺序追加。不得为了省上下文，按消息年龄、工具名称或“结果已消费”删除中间内容。
3. 每个工具结果第一次进入历史时，最多保留约 12,000 Token，保留头尾并写明截断量；工具参数和图片引用保留。
4. 总上下文接近当前模型的 `contextWindow` 时，由 `history-compactor.ts` 一次性概括较早历史，保留最近消息原文。压缩会产生一次新的缓存前缀，之后继续从该前缀积累命中。

相关实现：

- `src/main/pi-agent-service.ts`：稳定系统前缀、运行时尾注、会话缓存键和历史装配
- `src/main/context-window-policy.ts`：单个工具结果的确定性限长
- `src/main/history-compactor.ts`：按模型 Token 窗口做整体压缩
- `src/main/config-manager.ts`：按服务商和模型注入流式选项
- `src/main/prompt-cache-fifo.ts`、`src/main/usage-log.ts`：缓存诊断与实际用量

## 共同提示词与模型补丁

OpenPipal 只维护一份通用提示词主体。模型差异按解析后的 preset 使用
`ModelConfig.systemPromptAdapter` 追加一个稳定的小型补丁：

- 默认不填，最终提示词与共同主体逐字节一致。
- 只有参数与能力配置无法解决、且消融测试证明存在稳定行为差异时才填写。
- 补丁属于精确的服务商+模型 preset，不按模型名称猜测，不广播给同名模型的其他网关。
- Qwen 不带提示词补丁。运行时参数按“服务商 + 模型”走：直连 Qwen3.7 使用
  `thinking_budget`，Token Plan 的 Qwen3.8 使用 Pi 原生 `reasoning_effort` 映射。
- 用户中途切换模型时重新解析 preset；模型本身变化通常已经会造成缓存冷启动，补丁变化不是额外需要规避的理由。
- 新增补丁时记录复现任务、基线、改动后结果和移除条件；模型升级后重新消融，能删则删。

## 不同服务商的断点

| 协议/服务商 | 缓存断点策略 | OpenPipal 接入要求 |
|---|---|---|
| OpenAI API，GPT-5.6 之前及其他支持自动缓存的模型 | 服务端按完全相同的请求前缀自动命中；`prompt_cache_key` 用于稳定路由 | 保持稳定前缀和工具顺序；同一会话使用稳定 key；不要因中间消息裁剪改写前缀 |
| OpenAI API，GPT-5.6 及之后支持显式断点的模型 | 优先在稳定系统前缀之后设置 `prompt_cache_breakpoint`；若没有显式设置，服务端选择的默认断点可能落在持续变化的尾部 | 只有底层 SDK 确认支持该字段后才启用，并增加请求体形状测试；当前 OpenPipal 的 `pi-ai` 0.84.1 接入未启用该字段，不能伪装成已实现 |
| Anthropic Messages API | 使用 `cache_control` 标注稳定块；支持时可选择较长保留期 | 继续走 Pi 的 Anthropic 方言，不发送 OpenAI 专用字段；确认系统块和工具块的断点位置 |
| Amazon Bedrock | 使用 Bedrock 的 `cachePoint` 语义 | 按 Bedrock 请求格式单独适配并捕获请求体测试，不复用 OpenAI/Anthropic 字段名 |
| Qwen、GLM 和其他 OpenAI-compatible 网关 | 各网关可能只有隐式缓存，也可能完全不支持；不存在通用显式断点字段 | 默认只保持前缀稳定，不擅自发送专有字段；以返回的 `cacheRead`/`cached_tokens` 和服务商文档为准 |

> 注意：表中的模型代际是接入检查点，不是永久硬编码名单。服务商协议会更新，新增模型时必须重新核对其官方文档和实际响应。

## Qwen 运行时选择（新增模型时必读）

Pi 的模型目录和 OpenPipal 的连接配置各管一半：Pi 负责已知服务商+模型的
协议能力、上下文窗口、最大输出和思考档位映射；OpenPipal 保留用户自己的
`baseUrl`、API key 与可选能力覆盖。不要再从 Groq 等通用兼容模板借 Qwen 元数据。

| 服务商 + 模型 | 运行时模型来源 | 思考请求 | OpenPipal “高”档 |
|---|---|---|---|
| DashScope 直连 Qwen3.7 Plus | 复用 Pi 原生 Qwen 目录，保留 DashScope URL | `enable_thinking` + `thinking_budget` | 32K token 预算 |
| Qwen Token Plan / Token Plan CN 的 Qwen3.8 Max Preview | Pi 原生 `qwen-token-plan` / `qwen-token-plan-cn` | `enable_thinking` + `reasoning_effort` | Pi 自动钳制为 `xhigh` |
| 非官方/代理 Qwen 网关 | 自定义 OpenAI-compatible 模板 | 默认仅 `enable_thinking`；只有设置页明确声明预算才发 `thinking_budget` | 取服务商或模型设置 |

新增 Qwen 模型时，先检查当前 Pi 目录是否已有对应的“服务商 + model id”组合；有则保留
其 `compat`、`thinkingLevelMap`、`contextWindow` 和 `maxTokens`，仅覆盖用户连接信息。没有时
才退回自定义模板，并为该网关补一条请求体形状测试。特别是不要因为模型名里含 Qwen 就给
Qwen3.8 注入 `thinking_budget`，也不要把 Qwen3.7 的预算规则广播到 Token Plan。

### Pi 与 Electron 的运行时边界

三个直接 `@earendil-works/pi-*` 包在当前 Runtime v2 检查点精确锁定为
`0.84.1`；pi-core 使用包根公开的 `Agent`，不使用该版本仍未实现的
`AgentHarness` scaffold。
Electron `43.3.0` 内嵌的 Node 已高于 `pi-agent-core` 声明的 `>=22.19.0`
下限，但版本可加载不等于产品适配完成。`legacy` 仍是默认 Runtime，
`pi-core` 只通过显式开发/验收开关选择；只有真实 provider、工具、持久化、
取消、安全与打包回归全部通过后，才可讨论把它设为发布默认。

新增模型时不要机械地升级三个 Pi 包。版本更新必须作为独立兼容性变更，
并在临时打包的 `.app` 中回归：启动、技能扫描、普通对话、工具调用和
Qwen3.7/Qwen3.8 请求，再决定是否更新锁定版本。

## 新增模型的必做检查

1. 明确真实协议方言、`baseUrl` 和服务商，不要只看模型名称。
2. 填写正确的 `contextWindow`、图片/思考/工具能力位。
3. 查官方文档：缓存是自动前缀、显式断点，还是不支持；是否支持较长保留期。
4. 确认稳定系统提示和工具定义没有混入时间戳、随机 ID、当前产物状态。
5. 若需新增缓存字段，在服务商适配层注入；不得把专有字段广播给所有 OpenAI-compatible 网关。
6. 增加请求体形状测试：断点位置必须在稳定前缀末尾，动态运行时信息必须在其后。
7. 做一次冷请求和至少两次相同前缀的热请求，记录真实的 `cacheRead`/`cached_tokens`；再做一轮含工具调用的连续请求。
8. 触发一次历史整体压缩，允许压缩后的首请求未命中，但后续追加请求应重新建立命中。

判定缓存是否有效只看服务商返回的用量数据。请求成功、延迟变短或本地日志中出现缓存键，都不能单独证明命中。

参考：

- OpenAI Prompt Caching: <https://platform.openai.com/docs/guides/prompt-caching>
- Anthropic Prompt Caching: <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- Amazon Bedrock Prompt Caching: <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html>
