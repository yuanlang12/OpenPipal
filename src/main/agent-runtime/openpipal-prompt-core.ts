import { homedir } from 'os'
import { join } from 'path'
import { TOOL_RULES } from '../app-config'
import { resolveExecutionRoleName } from '../agent-overrides'
import { readMeMd, readToolsConfig } from '../agent-workspace-store'
import { listConversationArtifacts, coarseTypeFromFile } from '../artifact-store'
import { getArtifactStore } from '../artifact-registry'
import { conversationUploadsDir } from '../chat-uploads'
import { formatCliPrompt } from '../cli-registry'
import type { ModelConfig } from '../config-manager'
import { isAutoMemoryEnabled } from '../config-manager'
import { buildMemoryContext } from '../memory-store'
import { formatMemoriesForPrompt, getRecentMemories } from '../memory-manager'
import { getMcpToolIndex, hasVisibleMcpServer } from '../mcp-manager'
import { buildModelPromptAdapterSection } from '../model-prompt-adapter'
import { getCurrentRole, getRoleConfig } from '../role-manager'
import { getCurrentConfig, isDockedToTargetApp } from '../window-tracker'
import type { AgentOverrides, ChatSource } from './contracts'
import { dataPath } from '../data-root'
import { buildProjectContextPrompt, projectContextSnapshot } from './project-context'

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Windows 上把 shell 的形状说清楚：`bash` 是 Git Bash（POSIX 写法、盘符 /c/…），Windows 原生的
 * cmdlet / 注册表 / 服务走 `powershell`；这台机器没有 OS 沙箱。macOS / Linux 一个字不加——那里的
 * 提示词与此前逐字节相同。这是事实陈述不是纪律：模型不知道自己跑在哪个系统上，缺的是数据。
 */
export function platformShellNote(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return ''
  return '\n运行环境：Windows。`bash` 工具跑的是 Git Bash（POSIX 写法，盘符写成 /c/…）；Windows 原生命令（cmdlet、注册表、服务、.ps1）用 `powershell` 工具。这台机器没有系统沙箱，命令以用户的账号权限直接执行——不要碰凭据文件，删除类操作先说明再做。'
}

/**
 * `workingDir` 必须传**运行时真正会用的那个目录**（resolveOpenPipalWorkingDirectory 的结果），
 * 不是在这里现推的默认值。原来两个分支各自拼默认路径，于是用户在会话里选了仓库之后，
 * 提示词还在说工作目录是 Agent 自己的草稿区——模型照着这句话去找文件，找不到。
 */
function buildWorkspaceLayoutPrompt(
  workspaceId: string | undefined,
  roleName: string,
  memoryEnabled: boolean,
  workingDir: string
): string {
  const home = process.env.HOME || '~'
  // 记忆关闭时整段撤掉：留着等于让模型照着一个用户已关掉的子系统读写，属悬空指令
  const memoryFormat = !memoryEnabled ? '' : `
**记忆文件格式（每个文件是一条记忆）：**
\\\`\\\`\\\`markdown
---
name: 记忆主题
description: 一句话摘要
type: user|project|feedback|reference
scope: global
created: 2025-01-01T00:00:00.000Z
updated: 2025-01-01T00:00:00.000Z
---

记忆正文（Markdown）
\\\`\\\`\\\``

  if (workspaceId) {
    const agentDir = `${home}/.openpipal/agents/${workspaceId}/`
    const meMd = readMeMd(workspaceId)
    const meMdSection = meMd ? `\n\n## 关于用户\n\n${meMd}` : ''
    const workspaceDir = workingDir
    const memoryRules = memoryEnabled
      ? `- 新记忆 → \`write\` 到 \`${agentDir}memory/{topic}.md\`\n- 搜索记忆 → \`grep\` 搜索 \`${agentDir}memory/\`\n`
      : ''
    return `

## 你的工作空间

位置：\`${agentDir}\`
工作目录：\`${workspaceDir}\`（你的 bash/代码执行都在这个目录下运行，安装依赖也在这里）${platformShellNote()}

\`\`\`
${agentDir}
├── agent.md                 # 你的人格（已在 system prompt 中）
├── me.md                    # 用户画像
├── memory/{name}.md          # 长期记忆
├── skills/{name}/SKILL.md    # 专属技能
├── tools/config.json         # 工具配置
├── workspace/                # 默认工作目录（用户没另选目录时就在这里干活）
└── outputs/                  # 产物目录（generate_document 产出、对用户可见的文档）
\`\`\`

**规则：**
- 所有文件操作、代码执行、依赖安装都在 \`${workspaceDir}\` 内进行
- 不要用 sudo，不要安装到全局路径
- npm/pip 依赖用本地安装（\`npm install\` 而非 \`npm install -g\`）
- 新技能 → \`write\` 到 \`${agentDir}skills/{skill-name}/SKILL.md\`
${memoryRules}- 生成给用户的文档（generate_document）会自动保存到 \`${agentDir}outputs/\`，用户可在右侧 workspace 的"产物"区块看到
${memoryFormat}${meMdSection}
`
  }

  // 工作目录会跟着用户选的项目走，资产库不会——它是本助手的跨会话素材，永远住在数据目录里。
  // 两者曾经共用一个变量，于是用户一选仓库，资产库路径就跟着漂进了别人的项目里。
  const assetLibrary = `${dataPath('workspace')}/assets/${roleName}/`
  const globalMemoryRules = memoryEnabled
    ? `- 新记忆 → \`write\` 到 \`${home}/.openpipal/memory/{topic}.md\`\n- 搜索记忆 → \`grep\` 搜索 \`${home}/.openpipal/memory/\`\n`
    : ''
  return `

## 你的工作空间

位置：\`${home}/.openpipal/\`
工作目录：\`${workingDir}\`（你的 bash/代码执行都在这个目录下运行，安装依赖也在这里）${platformShellNote()}

\`\`\`
${home}/.openpipal/
├── workspace/                 # 默认工作目录与素材区（用户没另选目录时就在这里干活）
│   └── assets/${roleName}/      # ⭐ 本助手专属资产库（按角色隔离；需要素材时 ls/read）
├── skills/{name}/SKILL.md     # 全局技能库
├── memory/{name}.md            # 全局记忆
├── agents/{id}/                # 独立 Agent 工作空间
└── outputs/                    # generate_document 产出
\`\`\`

**规则：**
- 所有文件操作、代码执行、依赖安装都在 \`${workingDir}\` 内进行
- 不要用 sudo，不要安装到全局路径
- 新技能 → \`write\` 到 \`${home}/.openpipal/skills/{skill-name}/SKILL.md\`；从 GitHub 装现成技能可 bash \`git clone --depth 1 <仓库> ${home}/.openpipal/skills/<name>\`，保存后立即生效无需重启
${globalMemoryRules}
**资产库**：你的专属资产库在 \`${assetLibrary}\`（跟工作目录无关，换项目也不变）。做视觉/设计/文案/写作类、需要品牌或参考素材时，用 \`ls\` 扫一眼它，有就 \`read\` 进来当锚点；没有且任务对品牌敏感 → \`ask_user\` 让用户补充，别凭空造风格。注意：库里是**跨会话常驻**素材（历史项目遗留物可能混在其中）——只引用与当前任务明确相关的文件；本次会话的专属来源以 <conversation-brief> 里的 initial-assets 为准，优先于库。
${memoryFormat}
`
}

function formatArtifactAge(deltaMs: number): string {
  if (deltaMs < 60_000) return '刚刚'
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function buildArtifactInventoryPrompt(conversationId?: string): string {
  if (!conversationId) return ''
  let entries: ReturnType<typeof listConversationArtifacts>
  try {
    entries = listConversationArtifacts(conversationId)
  } catch {
    return ''
  }
  if (entries.length === 0) return ''

  const shown = entries.slice(-15)
  const omitted = entries.length - shown.length
  const now = Date.now()
  const lines = shown.map((entry) => {
    const record = getArtifactStore().getRecord(entry.id)
    const type = record?.type || (entry.file.endsWith('.json') ? 'json' : coarseTypeFromFile(entry.file))
    const age = entry.mtimeMs ? formatArtifactAge(now - entry.mtimeMs) : ''
    return `- ${entry.id} · ${escapeXml(entry.title || record?.title || '(无标题)')} · ${type}${age ? ` · 最后真实修改: ${age}` : ''}`
  })
  return (
    '\n\n<session-artifacts>\n' + lines.join('\n') + '\n</session-artifacts>\n' +
    (omitted > 0
      ? `以上是本会话**最近的 ${shown.length} 个**产物（旧在上新在下），另有 ${omitted} 个更早产物未列出——用户提到清单之外的旧产物时，直接用它的**标题**调 edit_artifact/create_artifact，系统会按标题解析，别新建。`
      : '以上是本会话已存在的全部产物（旧在上新在下）。') +
    '用户要求修改/迭代/重做任何已有产物时：**直接用清单里的 id**（或标题）调 edit_artifact（小改）或 create_artifact 带同 id（整篇重做，原地替换）。禁止因为"找不到"而新建同类产物，禁止凭记忆编 id。' +
    '不确定某个产物**现在**长什么样时，先用 read_artifact 读一遍原文，再动手 edit_artifact——别凭记忆猜片段，old_string 逐字不一致会不命中。' +
    '"最后真实修改"时间是磁盘事实：如果对话中声称做过某次修改、但对应产物的修改时间早于那次声称，说明那次修改实际未执行，以磁盘状态为准。'
  )
}

function buildConversationBriefPrompt(
  overrides: AgentOverrides | undefined,
  roleName: string,
  projectContextInjected: boolean
): string {
  if (!overrides) return ''
  const { projectName, roleBrief, initialAssets } = overrides
  const currentBrief = roleBrief?.[roleName] || {}
  const hasBrief = Object.keys(currentBrief).length > 0
  const hasAssets = !!initialAssets?.length
  if (!hasBrief && !hasAssets && !projectName) return ''

  const lines = ['\n\n<conversation-brief>']
  if (projectName) lines.push(`  <project>${escapeXml(projectName)}</project>`)
  if (hasBrief) {
    lines.push('  <role-brief>')
    for (const [key, value] of Object.entries(currentBrief)) {
      lines.push(`    <${key}>${escapeXml(Array.isArray(value) ? value.join(', ') : String(value ?? ''))}</${key}>`)
    }
    lines.push('  </role-brief>')
  }
  if (hasAssets) {
    lines.push('  <initial-assets>')
    for (const asset of initialAssets!) {
      lines.push(`    <asset category="${asset.category}" path="${escapeXml(asset.path)}" source="${asset.sourceType}">${escapeXml(asset.fileName)}</asset>`)
    }
    lines.push('  </initial-assets>')
  }
  lines.push('</conversation-brief>\n')
  lines.push('上面是用户在新建对话时**明确填写/点选**的前置信息——它们是用户已经做出的决定，不是参考建议。<role-brief> 里的每个字段直接采纳执行：交付形态类字段（如 taskType）就是最终产出形态，**禁止**根据对话措辞重新推断任务类型，也不要把它当开放问题再问一遍。只有用户在对话中明确改口时才以新指示为准。')
  if (hasAssets) {
    lines.push('', '**资产读取规则**（按 source 类型用对应工具，不要凭空忽略）：')
    lines.push('- source="upload" 或 "screenshot" → path 是本地文件，用 `read` 工具读（图片直接读，文本/md 也直接读）')
    lines.push('- source="figma" → Figma 解析尚未接入：**如实告诉用户暂时读不了 Figma 链接**，请对方贴设计截图（source="screenshot"）或导出代码/token，绝不要假装读过或凭记忆编造其内容')
    const entryDocStep = projectContextInjected
      ? '①入口文档（AGENTS.md/CLAUDE.md）已在 <project_context> 里原文注入，**不要重复 read**；只补读 README/package.json 这类它没覆盖的'
      : '①优先读 README/AGENTS.md/package.json 等入口文档（信息密度最高）'
    lines.push('- source="codebase" → path 可能是本地目录或 GitHub URL。本地目录的标准动线：' + entryDocStep + '②用**专用 ls 工具**看顶层结构（不要 bash 跑 ls -la/find——噪音大；专用 ls/find/grep 遵循仓库 ignore 规则并带遍历/输出硬上限）③找具体内容用 grep 定位再 read。**禁止全量遍历读完整个库**；GitHub 可走 deepwiki MCP 分析')
    lines.push('- category="design-system" → path 是设计系统文件夹：**先读其中 SKILL.md**，再按其指引读 README/tokens/组件文件；组件目录里每个组件的 `.prompt.md` 是该组件的权威用法说明——要用/复刻哪个组件，动手前先读它对应的 .prompt.md。产出必须遵循它的 tokens、组件与禁令——设计系统优先于任何自选审美')
    lines.push('- 选了设计系统且交付 dc 产物时：把 token 文件的 `:root { --… }` 声明块**原样拷进 helmet `<style>`**（dc 样式例外之一，见 dc-authoring 技能），正文样式一律 `var(--token)` 引用——禁止把 token 值手抄成字面量，手抄=断链，用户改主题无法全局联动')
    if (initialAssets!.some((asset) => asset.category === 'role-system')) {
      lines.push('- category="role-system" → path 是本助手的长期档案文件夹（如教师的个人教学风格）：**先读其中「风格.md」**，再按当前任务读取它指向的相关子内容。这里只能是用户本人确认过的个人选择、判断、经验和偏好；它是需要结合情境采用的专业参考，不是学校规定或强制模板。当前任务、学生与班级的真实情况优先，冲突时说明为什么本次需要调整。旧档案若还没有「风格.md」，才兼容读取根目录的 SKILL.md；不要继续沿用或写回旧结构')
    }
    lines.push('除 codebase 目录外，任何资产你都应该**在开工前读完**（codebase 按上一条渐进式读取）。只看 path 不读 = 丢失用户给的最关键上下文。')
  }
  return lines.join('\n')
}

const MEMORY_SNAPSHOT_CAP = 30
const memoryContextSnapshots = new Map<string, string>()

function memoryContext(conversationId: string, roleName: string): string {
  const snapshotKey = `${conversationId}:${roleName}`
  const cached = memoryContextSnapshots.get(snapshotKey)
  if (cached !== undefined) return cached
  const built = buildMemoryContext(conversationId) || formatMemoriesForPrompt(getRecentMemories(roleName, 5))
  if (memoryContextSnapshots.size >= MEMORY_SNAPSHOT_CAP) {
    const oldest = memoryContextSnapshots.keys().next().value
    if (oldest !== undefined) memoryContextSnapshots.delete(oldest)
  }
  memoryContextSnapshots.set(snapshotKey, built)
  return built
}

/**
 * 只读档的提示段。
 *
 * 工具已经在 `filterOpenPipalTools` 那层收窄了，模型压根看不到 write / edit / bash——
 * 但"看不见"和"知道自己现在不能动手"是两回事：不说清楚，它会把"没有编辑工具"当成
 * 环境故障，去试 execute_code、试 bash、试各种绕法，白烧几轮。说清楚了它就转去汇报。
 *
 * 顺带解决角色提示词里"改用 `edit` 做精确替换"这句在只读档下变成假话的问题
 * （tests/unit/role-prompt-tool-drift.test.ts 盯的就是这类漂移）。
 */
function buildPermissionTierPrompt(tier: AgentOverrides['permissionTier']): string {
  if (tier !== 'readonly') return ''
  return `

## 本次会话是只读档

用户把这次会话设成**只看不动**。你手上只有读取类工具（\`read\` / \`ls\` / \`find\` / \`grep\` / 截屏 / 搜索），
**没有 \`write\` / \`edit\` / \`bash\`，也没有任何会改动东西的工具**。角色提示词里凡是让你动手的话
（改文件、跑测试、跑构建），这一档一律不适用——别说"我改一下""我跑一下"，那些现在做不到。

该做的是：把问题查清楚，然后讲结论——哪几个文件、哪几行、建议怎么改、你的判断依据是什么。
真要动手，告诉用户切到"自动审核"档，**不要自己找绕法**。`
}

export interface PreparedOpenPipalSystemPrompt {
  skillContext: { workspaceId?: string; roleName: string }
  render(skillPromptSection?: string): string
}

/** Capture volatile prompt inputs once before any asynchronous resource load. */
export function prepareOpenPipalSystemPrompt(
  source: ChatSource,
  overrides?: AgentOverrides,
  options?: { stablePrefix?: boolean; modelConfig?: ModelConfig }
): PreparedOpenPipalSystemPrompt {
  const config = getCurrentConfig()
  // Resolve the execution's captured role once. Only contexts that predate the
  // roleName contract (voice/subagent compatibility paths) fall back to the UI
  // default, and that fallback is still captured synchronously here.
  const executionRoleName = resolveExecutionRoleName(overrides)
  const role = getRoleConfig(executionRoleName) || getCurrentRole()
  // pi-core loads skills asynchronously after this preparation step. Pin the
  // compatibility resolution onto the same overrides object so its later tool
  // composition cannot observe another conversation's global role.
  if (overrides && overrides.roleName === undefined) overrides.roleName = role.name
  const stablePrefix = !!options?.stablePrefix
  const basePrompt = overrides?.systemPrompt || role.systemPrompt
  const modelAdapter = buildModelPromptAdapterSection(options?.modelConfig)
  // 记忆总闸：全局开关关掉时，注入与提示词里的记忆指引一并撤掉，避免"半关"
  const memoryOn = isAutoMemoryEnabled() && role.memoryEnabled !== false
  const effectiveWorkingDir = resolveOpenPipalWorkingDirectory(overrides).workingDir
  const workspace = buildWorkspaceLayoutPrompt(overrides?.workspaceId, role.name, memoryOn, effectiveWorkingDir)
  // 项目入口文档（AGENTS.md / CLAUDE.md）：只有工作目录确实指向用户的项目、且那里真有
  // 这份文件时才有内容。默认工作目录在 Agent 自己的数据区，project-context 直接返回空串
  // ——不用这个能力的会话在提示词里看不到任何痕迹。
  const projectContext = stablePrefix && overrides?.conversationId
    ? projectContextSnapshot(overrides.conversationId, effectiveWorkingDir)
    : buildProjectContextPrompt(effectiveWorkingDir)
  // ClassIn UID 只在本会话确实挂载了 classin 工具时才注入。
  // 原来的条件是「环境变量有值就注入」,于是默认助手这种跟 ClassIn 毫无关系的会话
  // 也会在系统提示里拿到用户 UID —— 被问「你是谁」时模型会顺口把它报出来,
  // 而且每一次请求都把这个标识发给用户配置的第三方端点。
  // 凭据只该在用得上它的工具在场时才进上下文。
  const classinUid = process.env.CLASSIN_SID || ''
  const classinMounted = classinUid !== '' && hasVisibleMcpServer('classin', overrides?.conversationId)
  const userContext = classinMounted
    ? `\n\n当前用户的 ClassIn UID 是 ${classinUid}，在调用 ClassIn 相关工具时，使用此 UID 作为 mainTeacherUid 和 teacherUid。`
    : ''
  // 前台应用名只有在**真的挂靠**时才进提示词。
  // 原来的条件是 displayName !== processName —— 那只是「这个应用在内置目标表里」的
  // 间接信号,和「用户是否同意被观察」无关:跟随开关关着也照样注入。
  const appContext = stablePrefix || !isDockedToTargetApp()
    ? ''
    : `\n\n用户当前正在使用 ${config.displayName}。`
  const now = new Date()
  const timeContext = stablePrefix
    ? ''
    : `\n\n当前真实时间：${now.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })}。凡涉及"今天/现在/最近/最新"等时间判断，一律以此为准，不要使用训练数据里的日期。`
  const memories = !memoryOn
    ? ''
    : (stablePrefix && overrides?.conversationId
        ? memoryContext(overrides.conversationId, role.name)
        : (buildMemoryContext(overrides?.conversationId) || formatMemoriesForPrompt(getRecentMemories(role.name, 5))))
  const cliAndMcp = getMcpToolIndex(overrides?.conversationId) + formatCliPrompt()
  const toolNamesTokens = Math.ceil(cliAndMcp.length / 4)
  const toolNamesThreshold = 200_000 * 0.10
  let toolNames: string
  if (toolNamesTokens > toolNamesThreshold) {
    toolNames = '\n\n## 工具发现\nMCP 工具和 CLI 工具较多，名字索引已精简。请用 mcp_execute 的 tools.search(query) 按需发现 MCP 工具；CLI 工具直接用 bash 调用。'
    console.log(`[SystemPrompt] MCP+CLI 工具索引 ${toolNamesTokens} tokens 超过阈值 ${toolNamesThreshold}，切换搜索模式`)
  } else {
    toolNames = cliAndMcp
  }
  const permissionTier = buildPermissionTierPrompt(overrides?.permissionTier)
  const brief = buildConversationBriefPrompt(overrides, role.name, projectContext !== '')
  const artifacts = stablePrefix ? '' : buildArtifactInventoryPrompt(overrides?.conversationId)
  return {
    skillContext: { workspaceId: overrides?.workspaceId, roleName: role.name },
    render(skillPromptSection = ''): string {
      return basePrompt + modelAdapter + appContext + timeContext + workspace + projectContext + brief + artifacts + permissionTier + TOOL_RULES + userContext + skillPromptSection + toolNames + memories
    }
  }
}

export function buildOpenPipalSystemPromptCore(
  source: ChatSource,
  overrides?: AgentOverrides,
  options?: { stablePrefix?: boolean; modelConfig?: ModelConfig; skillPromptSection?: string }
): string {
  const prepared = prepareOpenPipalSystemPrompt(source, overrides, options)
  return prepared.render(options?.skillPromptSection)
}

export function buildOpenPipalRuntimeContext(conversationId?: string): string {
  const config = getCurrentConfig()
  const now = new Date()
  const time = `当前真实时间：${now.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })}。凡涉及"今天/现在/最近/最新"等时间判断，一律以此为准，不要使用训练数据里的日期。`
  const app = config.displayName !== config.processName ? `用户当前正在使用 ${config.displayName}。` : ''
  const uploads = conversationId
    ? `本会话图片资产目录:${conversationUploadsDir(conversationId)}(用户给出本地图片的绝对路径时,先用 bash 把文件复制进该目录,再在 dc 文档里用相对路径 uploads/<文件名> 引用;不要直接引用目录外的绝对路径——预览与导出都解析不了)。`
    : ''
  const lines = ['\n\n<runtime-context>', time]
  if (app) lines.push(app)
  if (uploads) lines.push(uploads)
  let block = lines.join('\n')
  const inventory = buildArtifactInventoryPrompt(conversationId)
  if (inventory) block += inventory
  return block + '\n</runtime-context>'
}

/** Default working directory resolution shared by both Runtime implementations. */
export function resolveOpenPipalWorkingDirectory(overrides?: AgentOverrides): {
  workspaceId?: string
  workingDir: string
  disabledTools?: string[]
  mcpServers?: ReturnType<typeof readToolsConfig>['mcpServers']
} {
  const workspaceId = overrides?.workspaceId
  const toolsConfig = workspaceId ? readToolsConfig(workspaceId) : undefined
  return {
    workspaceId,
    workingDir: overrides?.workingDir || toolsConfig?.workingDir || dataPath('workspace'),
    disabledTools: toolsConfig?.disabledTools,
    mcpServers: toolsConfig?.mcpServers
  }
}
