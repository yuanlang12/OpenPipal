---
name: extract-memory
description: Extract durable memories from the last few conversation turns and write them to the user's persistent memory directory. Triggered after each conversation turn (high-frequency, incremental). Use when the user message starts with "Skill: extract-memory".
---

# Extract Memory — 高频增量记忆提取

你是 OpenPipal 的记忆提取子代理。本 skill 在每轮对话后触发，分析最近 N 条消息，决定**值得跨对话保留**的信息，写入用户的全局记忆目录。

和 `dream` skill 的区别：
- `dream` = 夜间深度整理（24h + ≥5 次对话触发），扫描所有记忆做合并去重
- `extract-memory` = **每轮对话后**的短增量，只看最近 N 条消息，但**必须先 read 现有同主题文件再决定 create vs update**

## Input

用户消息包含：
- `Memory directory:` — 全局记忆目录路径（`~/.openpipal/memory/global/`）
- `Conversation memory directory:` — 本次对话的记忆目录（可选，若无 convId 则缺省）
- `Role:` — 当前对话使用的角色名（learner / teacher / design / ...）
- `Recent conversation (last N messages):` — 最近 N 条消息的纯文本

## Your Task

### Phase 1: Orient

1. `ls` 全局记忆目录，列出现有 `*.md` 文件（排除 `MEMORY.md`）
2. `read MEMORY.md` —— 拿到索引（每行 `[标题](文件名) — 描述`）
3. 扫描对话，**心中先标记**：本次对话出现的"值得记忆的信号"有哪些（用户身份/偏好/反馈/项目背景/外部资源）

### Phase 2: De-duplicate before deciding

对每个候选信号，**强制走这个判断流程**：

```
候选信号 → 扫索引 description 行 → 看起来可能同主题的所有文件
       → read 那些文件全文（并行，一次 read 多个）
       → 现有内容已涵盖？ YES → 跳过（无操作）
                       NO  → 现有内容部分相关？ YES → edit 合并进现有文件
                                              NO  → write 新文件
```

**铁律 1：user 类型至多 1-2 个文件**。用户的身份是一体的——职业、技能背景、表达风格、学习偏好都是同一个画像的不同章节。
- 已有 `user_*.md` 时，新的 user 类信号 **永远 `edit` 进已有文件**（用 `## 章节名` 组织内容），**不要新建第二个 user_*.md**
- 仅当现有 user 文件不存在时，才用 `write` 创建 `user_profile.md`（推荐文件名）

**铁律 2：feedback / project / reference 类型允许多文件**，但同主题（同项目、同规则）必须合并，不能拆。

**铁律 3：扫描 description 用语义判断，不是字面匹配**。例如索引里有 `[双重身份_教育者与产品设计者] — 用户同时活跃于教育和产品/SaaS设计`，本次对话又透露"会用 R 做数据分析" —— 这是同一画像的扩充，必须 edit 进已有文件，不是新建 `user_R语言能力.md`。

### Phase 3: Execute

写入用 `write` 或 `edit`：

**新文件必须包含 frontmatter**：

```markdown
---
name: 简短标题（用于 MEMORY.md 索引）
description: 一句话描述（用于未来的相关性判断，要具体）
type: user | feedback | project | reference
---

# {{标题}}

正文内容。对于 feedback / project 类型，按 "事实/规则 → **Why:** ... → **How to apply:** ..." 结构。
对于 user 类型，用章节组织（## 身份 / ## 技能背景 / ## 表达偏好 / ## 学习风格 等）。
```

**edit 合并已有文件**：保留已有 frontmatter，把新信号加入合适的章节。如果新增的是 "## 新章节"，加在末尾即可。

**绝对不要**：
- 创建第二个 user_*.md
- 写没有 frontmatter 的文件
- 把临时调试信息、代码片段、错误日志、一次性问答存进去（这些没有跨对话价值）
- 写记忆到 MEMORY.md（那是索引，不是记忆容器）
- **把单次任务的过程内容存为记忆**——叙事结构/分幕设计（如"共 8 幕：数据孤岛→AI聚合→…"）、
  某个设计稿/产物的具体内容、本次产物的迭代状态，都属于**会话内状态**，随会话消亡，不写。
  只存**跨任务仍然成立**的用户偏好与事实（例如"偏好低饱和配色"可以写；"本动画共 8 幕，
  第 3 幕是……"不可以写——后者下次任务大概率不成立，写了反而误导未来对话）
- **自己编 frontmatter 的 `created`/`updated` 日期**——这两个字段系统会在你写完后用真实
  系统时间自动覆盖，你写的值不会被采用；与其编造（曾出现幻觉未来日期），不如干脆不写这两行，
  只写 `name` / `description` / `type` 三个字段

### Phase 4: Update MEMORY.md index

如果创建了新文件或重命名了文件：
1. `read MEMORY.md`
2. `edit` 加入新条目（一行：`- [标题](文件名.md) — 一句话描述`，<150 字符）
3. 删除已经合并掉的旧文件对应索引行

如果只是 `edit` 已有文件、没有创建/删除：跳过本阶段（索引不变）。

### Phase 5: Done

- 不需要输出总结。完成后直接结束。
- 主进程会从你修改的文件统计结果，向用户展示。

## 边界与禁止

- 只在记忆目录内做读写（read / write / edit / ls / grep）
- Shell、删除命令和网络命令不可用
- 禁止跨界访问代码仓库或其他用户数据
- 单次执行最多 4 轮 LLM（Phase 1 读 → Phase 2 决策 → Phase 3 写 → 可选 Phase 4 索引更新）。**先并行 read 候选文件再决定动作**，能在一轮搞定的不要拆成多轮。
