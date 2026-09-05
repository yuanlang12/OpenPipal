/**
 * CLI Registry — 自动发现用户已安装的 CLI 工具 + 用户自定义注册
 *
 * 扫描 PATH 中常见的 SaaS/开发 CLI，将可用工具列表注入 Agent 的系统提示词，
 * 让 Agent 知道自己能调用哪些 CLI。用户可从 UI 注册自定义 CLI 工具。
 *
 * 安全说明：CLI 调用通过 execute_command 工具执行，受 pi-security.ts 三层安全模型保护。
 */

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { dataPath, getDataRoot } from './data-root'

export interface CliInfo {
  name: string
  command: string
  description: string
  category: 'dev' | 'saas' | 'system' | 'ai'
  builtIn: boolean
  version?: string
  installed?: boolean
}

// 预定义的 CLI 探测列表
const CLI_PROBES: Omit<CliInfo, 'version' | 'builtIn' | 'installed'>[] = [
  // 开发工具
  { name: 'GitHub CLI', command: 'gh', description: '管理 GitHub 仓库、PR、Issue', category: 'dev' },
  { name: 'Node.js', command: 'node', description: '执行 JavaScript/TypeScript', category: 'dev' },
  { name: 'npm', command: 'npm', description: 'Node.js 包管理', category: 'dev' },
  { name: 'pnpm', command: 'pnpm', description: '快速 Node.js 包管理', category: 'dev' },
  { name: 'bun', command: 'bun', description: '快速 JS 运行时和包管理', category: 'dev' },
  { name: 'Python', command: 'python3', description: '执行 Python 脚本', category: 'dev' },
  { name: 'pip', command: 'pip3', description: 'Python 包管理', category: 'dev' },
  { name: 'git', command: 'git', description: '版本控制', category: 'dev' },
  { name: 'Docker', command: 'docker', description: '容器管理', category: 'dev' },

  // SaaS CLI（软件 to CLI 趋势）
  { name: '飞书 CLI', command: 'lark-cli', description: '飞书/Lark 命令行工具：消息、日历、审批', category: 'saas' },
  { name: '钉钉 CLI', command: 'dingtalk', description: '钉钉命令行工具', category: 'saas' },
  { name: 'Vercel', command: 'vercel', description: '部署和管理 Vercel 项目', category: 'saas' },
  { name: 'Netlify', command: 'netlify', description: '部署和管理 Netlify 站点', category: 'saas' },
  { name: 'AWS CLI', command: 'aws', description: '管理 AWS 云服务', category: 'saas' },
  { name: 'Google Cloud', command: 'gcloud', description: '管理 GCP 云服务', category: 'saas' },
  { name: 'Azure CLI', command: 'az', description: '管理 Azure 云服务', category: 'saas' },
  { name: 'Supabase', command: 'supabase', description: 'Supabase 后端即服务', category: 'saas' },
  { name: 'Wrangler', command: 'wrangler', description: 'Cloudflare Workers 管理', category: 'saas' },

  // 系统工具
  { name: 'curl', command: 'curl', description: 'HTTP 请求', category: 'system' },
  { name: 'jq', command: 'jq', description: 'JSON 处理', category: 'system' },
  { name: 'ffmpeg', command: 'ffmpeg', description: '音视频处理', category: 'system' },
  { name: 'ImageMagick', command: 'convert', description: '图片处理', category: 'system' },

  // AI 工具
  { name: 'Ollama', command: 'ollama', description: '本地 LLM 运行', category: 'ai' },
]

// ---- 用户自定义 CLI 配置 ----

interface UserCliTool {
  name: string
  command: string
  description: string
  category: 'dev' | 'saas' | 'system' | 'ai'
}

function getUserCliConfigPath(): string {
  return dataPath('cli-tools.json')
}

function loadUserCliTools(): UserCliTool[] {
  const p = getUserCliConfigPath()
  if (!existsSync(p)) return []
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return [] }
}

function saveUserCliTools(tools: UserCliTool[]): void {
  const dir = getDataRoot()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getUserCliConfigPath(), JSON.stringify(tools, null, 2), 'utf-8')
}

// ---- 检测辅助 ----

/**
 * 命令名合法性：只接受裸命令名（PATH 查找用），不接受路径分隔符、空白与 shell 元字符。
 * 这两个探测函数的入参直接来自 IPC（cli:validate / cli:add），且不经 pi-security 三层
 * 确认，所以在进程边界上自己把关：拒绝路径 → 无法指向任意二进制；配合 execFile（不起
 * shell）→ 无法拼接命令。
 */
const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

export function isSafeCommandName(command: string): boolean {
  return SAFE_COMMAND_NAME.test(command)
}

// which 是 POSIX；Windows 用 where.exe（可能返回多行，取第一条）
const LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which'
function firstLine(stdout: string): string | null {
  return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null
}

/** 检查命令是否可用 */
export function isAvailable(command: string): string | null {
  if (!isSafeCommandName(command)) return null
  try {
    // execFile 不起 shell：命令名即使含元字符也只会被当作要查找的文件名，不会被拼接执行
    const result = execFileSync(LOOKUP_COMMAND, [command], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return firstLine(result)
  } catch {
    return null
  }
}

/** 尝试获取版本 */
function getVersion(command: string): string | undefined {
  if (!isSafeCommandName(command)) return undefined
  try {
    const result = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return result.split('\n')[0].trim().substring(0, 50) || undefined
  } catch {
    return undefined
  }
}

// ---- 主逻辑 ----

let cachedClis: CliInfo[] | null = null

/**
 * 扫描并返回已安装的 CLI 工具列表（内置 + 用户自定义）。
 * 结果被缓存，整个应用生命周期只扫描一次（除非手动 refresh）。
 */
/** 合并内置 + 用户注册的探测列表（用户注册的优先，覆盖同名内置） */
function collectProbes(): Array<Omit<CliInfo, 'version' | 'installed'>> {
  const seenCommands = new Set<string>()
  const allProbes: Array<Omit<CliInfo, 'version' | 'installed'>> = []
  for (const t of loadUserCliTools()) {
    allProbes.push({ ...t, builtIn: false })
    seenCommands.add(t.command)
  }
  for (const p of CLI_PROBES) {
    if (!seenCommands.has(p.command)) allProbes.push({ ...p, builtIn: true })
  }
  return allProbes
}

export function getAvailableClis(): CliInfo[] {
  if (cachedClis) return cachedClis

  console.log('[CLI] 开始扫描已安装的 CLI 工具（同步）...')

  const result: CliInfo[] = collectProbes().map(probe => {
    const path = isAvailable(probe.command)
    return { ...probe, version: path ? getVersion(probe.command) : undefined, installed: !!path }
  })

  console.log(`[CLI] 发现 ${result.filter(c => c.installed).length}/${result.length} 个 CLI 工具已安装`)
  cachedClis = result
  return result
}

const execFileAsync = promisify(execFile)

async function probeAsync(command: string): Promise<{ path: string | null; version?: string }> {
  if (!isSafeCommandName(command)) return { path: null }
  let path: string | null = null
  try {
    const { stdout } = await execFileAsync(LOOKUP_COMMAND, [command], { encoding: 'utf-8', timeout: 2000 })
    path = firstLine(stdout)
  } catch {
    return { path: null }
  }
  try {
    const { stdout } = await execFileAsync(command, ['--version'], { encoding: 'utf-8', timeout: 3000 })
    return { path, version: stdout.split('\n')[0].trim().substring(0, 50) || undefined }
  } catch {
    return { path }
  }
}

/**
 * 启动时异步预热探测缓存。
 *
 * 为什么需要：getAvailableClis() 用 execFileSync 串行探 20+ 个命令（which + --version，
 * 每个最多 2s/3s 超时），实测 ~2.7s。它挂在系统提示词装配路径上（formatCliPrompt），
 * 于是"启动后第一条消息"要先同步卡满这 2.7s——execFileSync 会把 Electron 主线程整个
 * 冻住，IPC 不回、窗口不刷新，系统就显示转圈光标。
 *
 * 这里在启动空闲期用并行 execFile 把同一份缓存填好，等用户敲完第一句时已是命中路径。
 * 不改 getAvailableClis 的同步签名：预热没跑完就发消息，仍走老路径，只是慢，不会错。
 */
export async function warmCliCache(): Promise<void> {
  if (cachedClis) return
  const probes = collectProbes()
  const result = await Promise.all(
    probes.map(async probe => {
      const { path, version } = await probeAsync(probe.command)
      return { ...probe, version, installed: !!path }
    })
  )
  if (cachedClis) return          // 期间被同步路径抢先填了就不覆盖
  cachedClis = result
  console.log(`[CLI] 预热完成：${result.filter(c => c.installed).length}/${result.length} 个已安装`)
}

/**
 * 生成 CLI 可用列表的提示词片段，注入到 Agent 的系统提示词。
 */
export function formatCliPrompt(): string {
  const clis = getAvailableClis().filter(c => c.installed)
  if (clis.length === 0) return ''

  const grouped: Record<string, CliInfo[]> = {}
  for (const cli of clis) {
    if (!grouped[cli.category]) grouped[cli.category] = []
    grouped[cli.category].push(cli)
  }

  const categoryNames: Record<string, string> = {
    dev: '开发工具',
    saas: 'SaaS/企业服务',
    system: '系统工具',
    ai: 'AI 工具',
  }

  let prompt = '\n\n## 可用 CLI 工具\n\n你可以通过 execute_command 工具调用以下已安装的 CLI：\n'

  for (const [cat, tools] of Object.entries(grouped)) {
    prompt += `\n**${categoryNames[cat] || cat}**：`
    prompt += tools.map(t => `\`${t.command}\`(${t.description})`).join('、')
  }

  prompt += '\n\n使用示例：调用 bash 工具，command 参数传入完整命令字符串（如 `gh issue list`）。'

  return prompt
}

// ---- 用户管理 API ----

export function addUserCliTool(tool: { name: string; command: string; description: string; category?: string }): void {
  // 入库前拦一道：注册表会被写进系统提示词并被探测函数执行，不收非裸命令名
  if (!isSafeCommandName(tool.command)) {
    throw new Error(`非法命令名：${tool.command}`)
  }
  const tools = loadUserCliTools()
  // 去重：同 command 覆盖
  const existing = tools.findIndex(t => t.command === tool.command)
  const entry: UserCliTool = {
    name: tool.name,
    command: tool.command,
    description: tool.description,
    category: (tool.category as UserCliTool['category']) || 'saas',
  }
  if (existing !== -1) {
    tools[existing] = entry
  } else {
    tools.push(entry)
  }
  saveUserCliTools(tools)
  cachedClis = null  // 清缓存，下次重新扫描
}

export function removeUserCliTool(command: string): void {
  const tools = loadUserCliTools().filter(t => t.command !== command)
  saveUserCliTools(tools)
  cachedClis = null
}

/** 强制重新扫描（用于设置中手动刷新） */
export function refreshClis(): CliInfo[] {
  cachedClis = null
  return getAvailableClis()
}
