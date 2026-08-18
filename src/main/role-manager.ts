import { loadConfig, saveConfig } from './config-manager'
import * as fs from 'fs'
import { join, basename, resolve, sep } from 'path'
import { homedir } from 'os'
import { loadRoleFromDisk, seedSystemAgents } from './role-loader'
import { resolveDesignSystemDirectory } from './design-system-resource'
import { buildOptionalRoles } from './roles/optional-roles'
import { buildDesignRole } from './roles/design-role'
import { dataPath } from './data-root'
export {
  addDetectedApp,
  getDetectedApps,
  getDisabledApps,
  isAppDisabled,
  isAppFollowingEnabled,
  setAppFollowingEnabled,
  setDisabledApps
} from './app-follow-settings'

/**
 * Layout manifest —— 来自 ~/.openpipal/system-agents/<role>/layout.json
 * 文件存在即 feature 开启；不存在 = 普通 chat layout（默认）
 *
 * preferredLayout: 'study' = Cave 模式（Visualizer 主舞台 + Chat 缩右栏）
 * triggerOn: 'always' = 切到该角色立即生效；'hasSources' = 资料区有 source 才切
 *   （P2 完成 Sources 后改成 hasSources）
 */
export interface LayoutManifest {
  preferredLayout: 'study' | 'normal'
  triggerOn: 'always' | 'hasSources'
  transitionMs?: number
  chatSidebarWidth?: number
}

export interface RoleConfig {
  name: string
  displayName: string
  icon: string
  systemPrompt: string
  tools: string[]
  layoutManifest?: LayoutManifest
  /**
   * 角色头像 data URL —— 派生字段(非 agent.md 持久配置)。
   * 来源:system-agents/<role>/avatar.{png,jpg,...} 存在即读成 base64 data URL。
   * 无图时 undefined,渲染端回落到 Lucide 图标。文件式 opt-in,同 layout.json。
   */
  avatarDataUrl?: string
  /**
   * 文件式角色级记忆开关——agent.md frontmatter `memory: off` 关闭注入+抽取。
   * 缺省/其它值 = true（记忆照常）。design 关闭：跨会话偏好走设计系统/资产显式通道，
   * 隐式记忆（每轮注入 + 自动抽取任务过程内容）与其严格会话隔离哲学冲突。
   */
  memoryEnabled?: boolean
}

// 所有角色共享同一套内置工具
// 注意：每次加新工具都必须加到这里，否则会被 isToolAllowed 过滤掉，AI 完全看不到
// TODO: 将来改成 deny-list 模式 — 默认全部开放，只显式拒绝不该用的工具
// Stage 2 精简：删除了 load_skill / create_global_skill / create_agent_skill
// 遵循渐进式披露原则 — AI 用通用 read/write 加载和创建 skill，不需要专用工具
// 详见 CLAUDE.md 的"核心设计哲学"section
export const COMMON_TOOLS = [
  'capture_screenshot',
  'read_screen',
  'web_search',
  'ask_user',
  // questions_v2 故意不在 COMMON_TOOLS——它面板重，只适合设计/规划这类复杂 intake
  // 需要它的角色在自己的 tools 里显式加（见 design）
  'generate_document',
  'read_page_content',
  'create_visualizer',
  'create_artifact',
  'read_artifact',
  'edit_artifact',
  'render_artifact',
  'export_artifact',
  // 多步任务待办清单（保持复杂任务方向不偏离——通用能力，全角色可用）
  'update_todos',
  'execute_code',
  // 任务管理（定时 / webhook / 门控）
  'manage_task',
  // Phase 6d：环境感知 + 内容呈现（渐进式披露——AI 按需调 get_environment）
  'get_environment',
  'present_to_user',
  // subagent —— 委派子任务到隔离上下文的子 agent（~/.openpipal/subagents/*.md 定义档位）
  'subagent',
  // 浏览器控制（chrome.debugger，经扩展作用于真实 Chrome profile）—— 仅扩展连上时注入
  'browser_list_tabs',
  'browser_navigate',
  'browser_read_page',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
  'browser_select',
  'browser_scroll',
  // Pi 内置 Unix 工具 — 用于读写工作空间文件，包括 skill 的 SKILL.md
  'bash',
  'read',
  'write',
  'edit',
  'ls',
  'find',
  'grep'
]

export const GENERAL_SYSTEM_PROMPT = `你是 OpenPipal，一个通用 AI 助手，帮助用户完成分析、创作、学习、办公和操作任务。

工作原则：
- 先理解用户想要的最终结果，选择足够可靠且最简单的完成方式。
- 优先使用用户已经提供的内容和上下文，不重复获取已有信息。
- 根据任务需要选择最直接、可靠的方法，不增加对结果没有实际帮助的步骤。
- 只有工具或技能能明显提高正确性、效率，或完成必要操作时才调用。
- 用户指定技能或任务明确匹配技能时，读取并遵循技能；其中的可选条件不能扩大成强制步骤。
- 获得足够信息后直接完成，不反复声明计划，不重复已经完成的工作。
- 只有关键信息缺失，且不同理解会显著改变结果时，才向用户确认。

回答简洁、直接，优先交付可直接使用的结果。`

const BUILTIN_ROLES: Record<string, RoleConfig> = {
  general: {
    name: 'general',
    displayName: 'OpenPipal',
    icon: '✦',
    systemPrompt: GENERAL_SYSTEM_PROMPT,
    tools: COMMON_TOOLS
  },
  // 两处展开而不是一处：设计助手能不能随某个发行走，与另外四个角色是各自独立的判断，
  // 各自对应一个可被裁剪脚本换成空实现的文件（文件式取舍，见两个模块自己的说明）
  ...buildOptionalRoles(COMMON_TOOLS),
  ...buildDesignRole(COMMON_TOOLS)
}

let currentRole: RoleConfig = BUILTIN_ROLES.general

// initRoles() 在启动路径上被调用多次（module load / IPC role:get-init-state / app.whenReady /
// HTTP /role/init-state），但 seedSystemAgents 每次都要为每个角色读文件 + 算 SHA-256 hash-diff——
// 同进程内只需播种一次。BUILTIN_ROLES 是固定常量集，当前没有"运行时新增角色需要重新 seed"的合法路径，
// 因此不留 force 参数；如未来出现该路径，再补一个显式 force 入口即可。
let seededThisProcess = false

function isBuiltinRoleName(roleName: unknown): roleName is string {
  return typeof roleName === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_ROLES, roleName)
}

/**
 * 取角色配置：先读磁盘文件（~/.openpipal/system-agents/<role>/agent.md），
 * 失败或文件不存在 → fallback 到代码种子。这样改 md 文件立即生效，删文件也能自愈
 *
 * 同时尝试挂载 layout.json（可选 manifest，文件存在即 feature 开启）
 */
function resolveRole(roleName: string): RoleConfig | null {
  // roleName reaches this function from HTTP, persisted conversations and IPC. Reject it before
  // any disk lookup so a path-shaped value can never escape system-agents/.
  if (!isBuiltinRoleName(roleName)) return null
  const fromDisk = loadRoleFromDisk(roleName, COMMON_TOOLS)
  const base = fromDisk || BUILTIN_ROLES[roleName]
  if (!base) return null

  let result: RoleConfig = base

  // 尝试加载 layout.json —— 文件存在即 feature 开启
  const rawLayout = readRoleManifest(roleName, 'layout.json') as Partial<LayoutManifest> | null
  if (rawLayout && (rawLayout.preferredLayout === 'study' || rawLayout.preferredLayout === 'normal')) {
    result = {
      ...result,
      layoutManifest: {
        preferredLayout: rawLayout.preferredLayout,
        triggerOn: rawLayout.triggerOn === 'hasSources' ? 'hasSources' : 'always',
        transitionMs: typeof rawLayout.transitionMs === 'number' ? rawLayout.transitionMs : undefined,
        chatSidebarWidth: typeof rawLayout.chatSidebarWidth === 'number' ? rawLayout.chatSidebarWidth : undefined
      }
    }
  }

  // 头像 —— system-agents/<role>/avatar.* 存在即读成 data URL(文件式 opt-in,同 layout.json)
  const avatarDataUrl = readRoleAvatarDataUrl(roleName)
  if (avatarDataUrl) result = { ...result, avatarDataUrl }

  return result
}

/** 头像候选文件名 → MIME。save IPC 统一写 avatar.png;这里兼容手动放置的其它格式 */
const AVATAR_CANDIDATES: Array<[string, string]> = [
  ['avatar.png', 'image/png'],
  ['avatar.jpg', 'image/jpeg'],
  ['avatar.jpeg', 'image/jpeg'],
  ['avatar.webp', 'image/webp'],
]

/**
 * 读取角色头像 → data URL。
 * 路径:~/.openpipal/system-agents/<role>/avatar.{png,jpg,jpeg,webp}
 * 无图 / 读失败 → undefined(渲染端回落 Lucide)。
 */
function readRoleAvatarDataUrl(roleName: string): string | undefined {
  if (!roleName) return undefined
  const dir = dataPath('system-agents', roleName)
  for (const [file, mime] of AVATAR_CANDIDATES) {
    const p = join(dir, file)
    try {
      if (!fs.existsSync(p)) continue
      const buf = fs.readFileSync(p)
      if (buf.length === 0) continue
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch { /* 该候选读失败,试下一个 */ }
  }
  return undefined
}

export function initRoles(): { hasRole: boolean; role: RoleConfig } {
  // 首启种子：把代码里的 4 个 role 写成 md 文件（已存在则不覆盖）——同进程内只播种一次
  if (!seededThisProcess) {
    seedSystemAgents(BUILTIN_ROLES, COMMON_TOOLS)
    seededThisProcess = true
  }

  const config = loadConfig()
  if (config.role) {
    const resolved = resolveRole(config.role)
    if (resolved) {
      currentRole = resolved
      console.log(`[Role] 加载角色: ${currentRole.displayName}（来源：${loadRoleFromDisk(config.role, COMMON_TOOLS) ? '文件' : '代码'}）`)
      return { hasRole: true, role: currentRole }
    }
  }
  // 未配置角色 → 落盘默认 general(通用助手),新用户开箱即用,不再弹强制选择
  config.role = currentRole.name
  saveConfig(config)
  console.log(`[Role] 未配置角色,自动使用默认: ${currentRole.displayName}`)
  return { hasRole: true, role: currentRole }
}

export function switchRole(roleName: string): RoleConfig | null {
  const role = resolveRole(roleName)
  if (!role) return null
  currentRole = role
  const config = loadConfig()
  config.role = roleName
  saveConfig(config)
  console.log(`[Role] 切换角色: ${role.displayName}`)
  return role
}

/**
 * 返回当前角色。每次调用都**重新**从磁盘读——这样用户改了 agent.md 后，
 * 下一轮对话就能用上新 prompt，不需要重启 app
 */
export function getCurrentRole(): RoleConfig {
  const fresh = resolveRole(currentRole.name)
  if (fresh) currentRole = fresh
  return currentRole
}

/**
 * 当前角色的资产库目录：~/.openpipal/workspace/assets/<role>/（按角色隔离）。
 * 单一来源——IPC（ipc-handlers）与 HTTP 镜像（http-server）共用，避免路径公式散落。
 */
export function getRoleAssetsDir(): string {
  return dataPath('workspace', 'assets', getCurrentRole().name)
}

export interface RoleAssetEntry { fileName: string; path: string; sizeBytes: number }
export interface RoleAssetsTree {
  brand: RoleAssetEntry[]
  refs: RoleAssetEntry[]
  docs: RoleAssetEntry[]
  kits: RoleAssetEntry[]
}

/**
 * 扫当前角色资产库（纯素材文件：logo/截图/brief 等）。单一来源——IPC 与 HTTP 镜像共用。
 * 文件扁平存根目录（历史约定，category 只是元数据标签）；子文件夹忽略。
 */
export function listRoleAssets(): RoleAssetsTree {
  const root = getRoleAssetsDir()
  const result: RoleAssetsTree = { brand: [], refs: [], docs: [], kits: [] }
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(root, e.name)
      if (e.isFile() && e.name.toLowerCase() !== 'readme.md') {
        result.brand.push({ fileName: e.name, path: p, sizeBytes: fs.statSync(p).size })
      }
    }
  } catch { /* 目录不存在就返回空 */ }
  return result
}

/**
 * 角色资产库子文件夹中的长期档案。teacher 的个人教学风格以「风格.md」为权威入口；
 * 根目录 SKILL.md 只用于兼容旧档案，不能作为新教学风格的产物结构。
 * 档案位于 ~/.openpipal/workspace/assets/teacher/<名称>/，由会话简报显式传给角色。
 * listRoleAssets 只列散文件、忽略子文件夹，两者互不干扰。
 */
export function getRoleSystemEntryFile(dirPath: string): '风格.md' | 'SKILL.md' | null {
  if (fs.existsSync(join(dirPath, '风格.md'))) return '风格.md'
  if (fs.existsSync(join(dirPath, 'SKILL.md'))) return 'SKILL.md'
  return null
}

export function listRoleSystemFolders(): Array<{ name: string; path: string; description?: string; entryFile: string }> {
  const root = getRoleAssetsDir()
  const out: Array<{ name: string; path: string; description?: string; entryFile: string }> = []
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue
      const p = join(root, e.name)
      const entryFile = getRoleSystemEntryFile(p)
      if (!entryFile) continue
      out.push({
        name: e.name,
        path: p,
        description: parseSkillFrontmatter(join(p, entryFile)).description,
        entryFile
      })
    }
  } catch { /* 目录不存在就返回空 */ }
  return out
}

export interface RoleSystemTreeEntry { name: string; kind: 'dir' | 'file'; sizeBytes?: number; children?: RoleSystemTreeEntry[] }

/**
 * 档案预览的目录树——限定在角色资产库内（resolve 后前缀校验，越界返回空）。
 * 递归一次给全（档案很小，左侧目录树需要完整结构）；文件夹排前、按名排序、跳过隐藏文件、深度上限防环。
 */
export function listRoleSystemTree(dirPath: string, depth = 0): RoleSystemTreeEntry[] {
  const root = resolve(getRoleAssetsDir())
  const target = resolve(dirPath)
  if ((target !== root && !target.startsWith(root + sep)) || depth > 6) return []
  const out: RoleSystemTreeEntry[] = []
  try {
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) out.push({ name: e.name, kind: 'dir', children: listRoleSystemTree(join(target, e.name), depth + 1) })
      else out.push({ name: e.name, kind: 'file', sizeBytes: fs.statSync(join(target, e.name)).size })
    }
  } catch { /* 目录不存在返回空 */ }
  return out.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1)
}

/**
 * 设计系统一等产物库：~/.openpipal/design-systems/<名称>/（含 SKILL.md 的文件夹 = 一套系统）。
 * 刻意与角色资产库分离——agent 的开工扫库扫不到这里；只有会话简报选用时注入路径指针
 * （官方 Claude Design 的 project 绑定同款语义：不绑定 = 读不到 = 不存在）。
 */
export function getDesignSystemsRoot(): string {
  return dataPath('design-systems')
}

export function listDesignSystems(): Array<{ name: string; path: string }> {
  const root = getDesignSystemsRoot()
  const out: Array<{ name: string; path: string }> = []
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue
      const p = resolveDesignSystemDirectory(e.name)
      if (!p) continue
      try {
        const skillInfo = fs.lstatSync(join(p, 'SKILL.md'))
        if (skillInfo.isFile() && !skillInfo.isSymbolicLink()) out.push({ name: e.name, path: p })
      } catch { /* SKILL.md missing or raced away */ }
    }
  } catch { /* 目录不存在就返回空 */ }
  return out
}

// ---- 设计系统评审记录（画廊逐卡 赞/踩 + 评语）----
// 文件式：落在系统目录内的 _review.json（_ 前缀不进卡片扫描）。渲染端读写走 IPC，
// agent 侧无需新工具——发布收尾时 pi-tools 读同一文件做证据式提示。
export interface DsCardReview { verdict: 'up' | 'down'; comment?: string; at: number }
export interface DsReview { updatedAt: number; cards: Record<string, DsCardReview> }

function dsReviewPath(name: string): string | null {
  const dir = resolveDesignSystemDirectory(name)
  if (!dir) return null
  return join(dir, '_review.json')
}

export function getDsReview(name: string): DsReview | null {
  const p = dsReviewPath(name)
  if (!p || !fs.existsSync(p)) return null
  try {
    const info = fs.lstatSync(p)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (parsed && typeof parsed === 'object' && parsed.cards && typeof parsed.cards === 'object') return parsed
  } catch { /* 损坏视为无记录 */ }
  return null
}

export function saveDsReview(name: string, review: DsReview): boolean {
  const p = dsReviewPath(name)
  if (!p || !review || typeof review !== 'object' || !review.cards || typeof review.cards !== 'object') return false
  let fd: number | undefined
  try {
    try {
      const info = fs.lstatSync(p)
      if (!info.isFile() || info.isSymbolicLink()) return false
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return false
    }
    fd = fs.openSync(
      p,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    if (!fs.fstatSync(fd).isFile()) return false
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, JSON.stringify({ ...review, updatedAt: Date.now() }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// ---- 设计系统画廊 manifest ----
// 单套设计系统的结构化描述：卡片按组、UI kits、README。renderer 侧本地声明同形状（不跨 bundle import）。
export interface DsCardMeta { rel: string; name: string; subtitle?: string; group: string; w: number; h: number }
export interface DsKitMeta { rel: string; label: string }
/** 文件浏览器视图的目录树节点（对标官方 Design 的 Finder 式文件列表）；dir 无 size/mtime（列表里显示 —） */
export interface DsFileNode {
  name: string
  rel: string
  kind: 'dir' | 'file'
  size?: number
  mtime?: number
  children?: DsFileNode[]
}
export interface DesignSystemManifest {
  name: string          // 文件夹名（即 id）
  title: string         // SKILL.md frontmatter 的 name，无则文件夹名
  description?: string  // SKILL.md frontmatter 的 description
  path: string          // 绝对路径（仅展示）
  groups: { group: string; cards: DsCardMeta[] }[]
  kits: DsKitMeta[]     // ui_kits/<dir>/index.html，label=目录名
  readme?: string       // README.md / readme.md 的相对路径（大小写不敏感）
  files: DsFileNode[]   // 整套系统的目录树（文件浏览器视图用；画廊分支不消费）
}

// 卡片扫描排除的目录：ui_kits 单独归 kits，其余是素材/依赖/构建产物
// screenshots/shared 是构建基建非展示内容（openpipal-design-system 实测）；slides 保留——幻灯模板是系统真内容
const DS_EXCLUDE_DIRS = new Set(['ui_kits', 'assets', 'fonts', 'node_modules', 'screenshots', 'shared'])

// SKILL.md frontmatter 只抓 name / description（简单行解析，不引 yaml 库）
function parseSkillFrontmatter(skillPath: string): { name?: string; description?: string } {
  try {
    const info = fs.lstatSync(skillPath)
    if (!info.isFile() || info.isSymbolicLink()) return {}
    const raw = fs.readFileSync(skillPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    if (lines[0]?.trim() !== '---') return {}
    const out: { name?: string; description?: string } = {}
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') break
      const m = lines[i].match(/^(name|description)\s*:\s*(.*)$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1] as 'name' | 'description'] = v
    }
    return out
  } catch {
    return {}
  }
}

// 读文件前 n 字节（@dsCard 头只在首部）
function readHead(p: string, n = 500): string {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(n)
      const bytes = fs.readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, bytes).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

// 解析 <!-- @dsCard group="" viewport="WxH" subtitle="" name="" -->（属性顺序任意、单双引号都容）
function parseDsCardHeader(head: string): { group?: string; name?: string; subtitle?: string; w?: number; h?: number } | null {
  const tag = head.match(/<!--\s*@dsCard\b([\s\S]*?)-->/)
  if (!tag) return null
  const body = tag[1]
  const attr = (k: string): string | undefined => {
    const m = body.match(new RegExp(k + '\\s*=\\s*(["\'])(.*?)\\1'))
    return m ? m[2] : undefined
  }
  const out: { group?: string; name?: string; subtitle?: string; w?: number; h?: number } = {
    group: attr('group'), name: attr('name'), subtitle: attr('subtitle')
  }
  const vp = attr('viewport')
  const vm = vp?.match(/^\s*(\d+)\s*[xX]\s*(\d+)\s*$/)
  if (vm) { out.w = parseInt(vm[1], 10); out.h = parseInt(vm[2], 10) }
  return out
}

// 文件浏览器视图的目录树：如实反映磁盘，刻意不复用卡片扫描的 DS_EXCLUDE_DIRS——
// 那条规则回答的是"哪些 html 值得当卡片展示"，这里回答的是"这套系统里到底有什么文件"
// （assets/fonts/ui_kits 都要能翻）。只藏三类：隐藏文件、依赖/构建噪音、我方记账文件 _review.json。
const DS_FILES_HIDDEN = new Set(['node_modules', '_review.json'])

function scanDsFiles(absDir: string, relDir: string, depth: number): DsFileNode[] {
  if (depth > 4) return []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch { return [] }
  const out: DsFileNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || DS_FILES_HIDDEN.has(e.name)) continue
    const rel = relDir ? `${relDir}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push({ name: e.name, rel, kind: 'dir', children: scanDsFiles(join(absDir, e.name), rel, depth + 1) })
      continue
    }
    if (!e.isFile()) continue
    let size: number | undefined
    let mtime: number | undefined
    try {
      const st = fs.statSync(join(absDir, e.name))
      size = st.size
      mtime = st.mtimeMs
    } catch { /* 竞态删除：不给大小/时间，条目仍列出 */ }
    out.push({ name: e.name, rel, kind: 'file', size, mtime })
  }
  // 文件夹排前、组内按名（中文按拼音）——与角色档案树 listRoleSystemTree 同一套排序手感
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1))
}

// 文件名 → 卡名：去 .html / .card 后缀，分隔符转空格并标题化
function titleizeCardName(fileName: string): string {
  const base = fileName.replace(/\.html$/i, '').replace(/\.card$/i, '').replace(/[-_.]+/g, ' ').trim()
  return base.replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * 扫描单套设计系统 → 结构化 manifest（画廊渲染 + 静态伺服的数据源）。
 * name 含 '/'、'\\'、'..' 或目录不存在 → null。
 * 卡片来自 <ds> 下 *.html（深度≤3，排除 ui_kits/assets/fonts/node_modules/_ 开头目录）；
 * 有 @dsCard 头用其 group/name/subtitle/viewport，无头兜底到 顶层目录名 + 文件名标题化 + 700x400。
 */
export function getDesignSystemManifest(name: string): DesignSystemManifest | null {
  const dir = resolveDesignSystemDirectory(name)
  if (!dir) return null

  const fm = parseSkillFrontmatter(join(dir, 'SKILL.md'))

  // 递归扫卡片。dirDepth: 已下探的目录层数（root=0），最多到 3（覆盖 components/core/*.card.html 等）
  const cards: DsCardMeta[] = []
  const walk = (absDir: string, relDir: string, dirDepth: number): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.startsWith('_') || e.name.startsWith('.') || DS_EXCLUDE_DIRS.has(e.name)) continue
        if (dirDepth < 3) walk(join(absDir, e.name), rel, dirDepth + 1)
        continue
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.html')) continue
      const header = parseDsCardHeader(readHead(join(absDir, e.name)))
      const topDir = relDir ? relDir.split('/')[0] : 'general'
      const h = Math.min(header?.h ?? 400, 640)
      cards.push({
        rel,
        name: header?.name || titleizeCardName(e.name),
        subtitle: header?.subtitle,
        group: header?.group || topDir,
        w: header?.w ?? 700,
        h
      })
    }
  }
  walk(dir, '', 0)

  // 分组：组顺序按首次出现，组内按文件名排序
  const groupOrder: string[] = []
  const groupMap = new Map<string, DsCardMeta[]>()
  for (const c of cards) {
    if (!groupMap.has(c.group)) { groupMap.set(c.group, []); groupOrder.push(c.group) }
    groupMap.get(c.group)!.push(c)
  }
  const groups = groupOrder.map(g => ({
    group: g,
    cards: groupMap.get(g)!.sort((a, b) =>
      (a.rel.split('/').pop() || '').localeCompare(b.rel.split('/').pop() || ''))
  }))

  // UI kits：ui_kits/<dir>/index.html
  const kits: DsKitMeta[] = []
  try {
    const kitsRoot = join(dir, 'ui_kits')
    const kitsRootInfo = fs.lstatSync(kitsRoot)
    if (!kitsRootInfo.isDirectory() || kitsRootInfo.isSymbolicLink()) throw new Error('unsafe ui_kits directory')
    for (const e of fs.readdirSync(kitsRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue
      const indexPath = join(kitsRoot, e.name, 'index.html')
      let indexInfo: fs.Stats
      try { indexInfo = fs.lstatSync(indexPath) } catch { continue }
      if (indexInfo.isFile() && !indexInfo.isSymbolicLink()) {
        kits.push({ rel: `ui_kits/${e.name}/index.html`, label: e.name })
      }
    }
  } catch { /* 无 ui_kits 目录 */ }
  kits.sort((a, b) => a.label.localeCompare(b.label))

  // README（大小写不敏感）
  let readme: string | undefined
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase() === 'readme.md') { readme = e.name; break }
    }
  } catch { /* ignore */ }

  return { name, title: fm.name || name, description: fm.description, path: dir, groups, kits, readme, files: scanDsFiles(dir, '', 0) }
}

export function getAllRoles(): RoleConfig[] {
  return Object.keys(BUILTIN_ROLES).map(name => resolveRole(name) || BUILTIN_ROLES[name])
}

/**
 * 按名字取角色配置——不依赖全局 currentRole，供"按会话角色而非当前角色判断"的场景用
 * （如记忆抽取要按会话归属的角色而非可能已被语音/HTTP 切走的全局角色）。找不到返回 null。
 */
export function getRoleConfig(roleName: string): RoleConfig | null {
  return resolveRole(roleName)
}

/**
 * 检查工具是否允许使用
 * 内置工具按角色白名单过滤，MCP 工具对所有角色开放
 */
export function isToolAllowed(toolName: string, isMcp: boolean): boolean {
  if (isMcp) return true
  return currentRole.tools.includes(toolName)
}

/**
 * 读取角色的可选 manifest 文件
 * 路径：~/.openpipal/system-agents/<role>/<fileName>
 * 遵循 "文件存在即 feature 开启" 的 OpenPipal 约定
 * 文件不存在或解析失败返回 null —— 调用方应视为 "此角色未启用该 feature"
 *
 * 示例：readRoleManifest('design', 'preflow.json') → 返回 design 的前置页配置
 */
export function readRoleManifest(roleName: string, fileName: string): any | null {
  if (!isBuiltinRoleName(roleName)) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(fileName) || basename(fileName) !== fileName) return null
  const root = dataPath('system-agents')
  const roleDir = join(root, roleName)
  const filePath = join(roleDir, fileName)
  try {
    if (!fs.existsSync(filePath)) return null
    const fileInfo = fs.lstatSync(filePath)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return null
    const realRoot = fs.realpathSync(root)
    const realRoleDir = fs.realpathSync(roleDir)
    const realFile = fs.realpathSync(filePath)
    if (realRoleDir !== join(realRoot, roleName)) return null
    if (realFile !== join(realRoleDir, fileName) || !realFile.startsWith(realRoot + sep)) return null
    const content = fs.readFileSync(realFile, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    console.warn(`[Role] 读取 ${roleName}/${fileName} 失败:`, (err as any)?.message)
    return null
  }
}
