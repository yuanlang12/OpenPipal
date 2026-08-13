# Agent Workspace 设计文档

> 每个对话可以成为一个活的、会成长的 Agent 工作空间。

## 核心理念

- 文件系统就是 Agent 的大脑 — 透明、可移植、工具友好
- 对话优先 — 默认是普通对话，用户主动「保存为我的 Agent」才创建实体
- 渐进式成长 — agent.md 从对话中抽离，通过 auto-dreaming 持续优化

## 目标架构

```
~/.openpipal/agents/{agent-id}/
├── agent.md              # 人格 + system prompt
├── memory/
│   ├── MEMORY.md          # 记忆索引
│   └── *.md               # auto-extracted 记忆文件
├── skills/
│   └── {skill-name}/SKILL.md
├── tools/
│   └── mcp.json           # Agent 专属 MCP 工具配置
├── tasks/
│   └── scheduled.json     # Agent 的定时任务
├── artifacts/
│   ├── *.html             # 产出物（visualizer 等）
│   └── *.svg
├── conversations/
│   └── {conv-id}.jsonl    # 来自此 Agent 的会话历史
└── meta.json              # 名称、图标、创建时间
```

## 设计决策

### 1. Agent 粒度

- 对话是主要实体，侧边栏展示对话列表（不变）
- Agent 是可选的持久配置，通过「保存为 Agent」创建
- 从 Agent 发起的对话在侧边栏显示来源标签（如 `[英语外教]`）
- Agent 出现在「我的 Agents」页面

### 2. Agent 创建流程

```
用户在普通对话中点击「保存为我的 Agent」
    ↓
分析当前对话内容，一次性抽离：
  - agent.md: 人格、专长、行为偏好
  - memory/: 从对话中提取的领域知识
  - meta.json: AI 生成名称 + 图标建议
    ↓
Agent 出现在「我的 Agents」列表
    ↓
后续每次与该 Agent 对话结束后，auto-dreaming：
  - 分析新对话内容
  - 渐进式更新 memory/ 和 agent.md
```

### 3. 能力范围

**全局（所有对话/Agent 共享）：**
- 内置工具：搜索、截图、读屏
- 全局记忆：用户画像（现有 memory-extractor 机制）

**Agent 级（独有）：**
- agent.md（system prompt，覆盖默认角色）
- memory/（领域知识）
- skills/（专属技能）
- tools/mcp.json（专属 MCP 工具）
- tasks/（定时任务）
- artifacts/（产出物）

**普通对话**继续使用现有的全局记忆系统，不做改动。

### 4. 分享和导出

暂不实现。后续考虑：
- 导出 agent.md + skills 作为可分享模板
- 导入时创建新 Agent 实例
- memory/conversations 包含敏感信息，默认不导出

### 5. 与现有架构的兼容

- 现有对话流程不变（conversation-store.ts）
- 新增 agent-store.ts 管理 Agent 实体
- pi-agent-service.ts 的 agentChat() 注入 Agent 的 agent.md 作为 system prompt
- 现有全局记忆系统保持不变，Agent 记忆独立运行

## 实现分期

### Phase 1: 目录结构 + 保存为 Agent（本次）

**范围：**
1. Agent 目录结构创建和管理（agent-store.ts）
2. 「保存为我的 Agent」功能：
   - UI：对话页面添加保存按钮
   - 后端：分析对话内容，生成 agent.md + memory + meta.json
3. 「我的 Agents」列表展示
4. 不改动现有对话流程

**不包含：**
- 从 Agent 发起对话（Phase 2）
- Agent 级 skills/tools/tasks（Phase 2+）
- auto-dreaming 持续优化（Phase 2）
- 分享导出（远期）

### Phase 2: 从 Agent 发起对话

- 从「我的 Agents」点击 Agent → 发起新对话
- agent.md 注入 system prompt
- Agent memory 注入上下文
- 侧边栏对话列表显示来源标签
- auto-dreaming：对话结束后自动更新 Agent memory

### Phase 3: Agent 级工具和技能

- Agent 专属 MCP 工具配置
- Agent 专属 skills
- Agent 定时任务
- artifacts 持久化到 Agent 目录

### Phase 4: 分享与模板市场

- Agent 导出（配置模板）
- Agent 导入
- 社区 Agent 模板
