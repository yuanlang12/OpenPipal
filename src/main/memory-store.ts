/**
 * Memory Store — 两层 Markdown 记忆文件系统
 *
 * 替代旧的 JSONL 存储（memory-manager.ts），使用 frontmatter Markdown 文件。
 * 两层结构：
 *   global/       — 全局记忆（跨对话持久，始终加载索引）
 *   conversations/ — 对话记忆（按 convId 情境激活）
 *
 * 参考 CC-Source 的 memdir/ 模块设计。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  appendFileSync
} from 'fs'
import { join, basename, resolve, sep } from 'path'
import { homedir } from 'os'
import { completeSimple } from '@earendil-works/pi-ai/compat'
import { stripJsonFence } from './simple-completion'
import { getDataRoot } from './data-root'

// ---- Types ----

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
export type MemoryScope = 'global' | 'conversation'

export interface MemoryFile {
  name: string
  description: string
  type: MemoryType
  scope: MemoryScope
  content: string
  filename: string
  conversationId?: string
  created: string
  updated: string
}

export interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  name: string | null
  description: string | null
  type: MemoryType | undefined
}

export interface ExtractionMemory {
  name: string
  description: string
  type: MemoryType
  scope: MemoryScope
  content: string
  action: 'create' | 'update'
  updateFile?: string
}

// ---- Constants ----

const OPENPIPAL_DIR = getDataRoot()
const MEMORY_ROOT = join(OPENPIPAL_DIR, 'memory')
const GLOBAL_DIR = join(MEMORY_ROOT, 'global')
const CONVERSATIONS_DIR = join(MEMORY_ROOT, 'conversations')

const MEMORY_INDEX = 'MEMORY.md'
const MAX_INDEX_LINES = 100
const MAX_INDEX_BYTES = 15_000

// ---- Path Helpers ----

export function getMemoryRoot(): string {
  return MEMORY_ROOT
}

export function getGlobalMemoryDir(): string {
  return GLOBAL_DIR
}

export function getConversationMemoryDir(convId: string): string {
  return join(CONVERSATIONS_DIR, convId)
}

/**
 * 路径是否在记忆根目录内（边界安全）。
 * 用 root + sep 比较，避免 `/…/memory-evil/` 这类前缀绕过；resolve 已归一化 `..` 段。
 * 给 ipc-handlers / http-server 的记忆相关接口复用，集中一处审计。
 */
export function isWithinMemoryRoot(p: string): boolean {
  const root = resolve(MEMORY_ROOT)
  const target = resolve(p)
  return target === root || target.startsWith(root + sep)
}

export function ensureMemoryDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// ---- Frontmatter Parsing ----

interface ParsedFrontmatter {
  name?: string
  description?: string
  type?: string
  scope?: string
  created?: string
  updated?: string
}

function parseFrontmatter(content: string): { meta: ParsedFrontmatter; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content.trim() }

  const rawMeta = match[1]
  const body = match[2].trim()
  const meta: ParsedFrontmatter = {}

  for (const line of rawMeta.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) {
      const key = kv[1] as keyof ParsedFrontmatter
      meta[key] = kv[2].trim()
    }
  }

  return { meta, body }
}

function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (!raw) return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}

function buildFrontmatter(memory: {
  name: string
  description: string
  type: MemoryType
  created: string
  updated: string
}): string {
  return [
    '---',
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    `type: ${memory.type}`,
    `created: ${memory.created}`,
    `updated: ${memory.updated}`,
    '---',
    ''
  ].join('\n')
}

// ---- Filename Generation ----

function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen)
}

function generateFilename(type: MemoryType, name: string, dir: string): string {
  return resolveNameCollision(dir, `${type}_${slugify(name)}.md`)
}

/** 同名文件已存在时生成不冲突的文件名(foo.md → foo_1.md / foo_2.md …) */
function resolveNameCollision(dir: string, filename: string): string {
  if (!existsSync(join(dir, filename))) return filename
  const dot = filename.lastIndexOf('.')
  const base = dot >= 0 ? filename.slice(0, dot) : filename
  const ext = dot >= 0 ? filename.slice(dot) : ''
  let i = 1
  while (existsSync(join(dir, `${base}_${i}${ext}`))) i++
  return `${base}_${i}${ext}`
}

// ---- Scan & Read ----

/**
 * 扫描目录下所有 .md 文件的 frontmatter（不读全文），排除 MEMORY.md。
 * 按 mtime 降序返回（最新优先）。
 */
export function scanMemoryFiles(dir: string): MemoryHeader[] {
  if (!existsSync(dir)) return []

  const headers: MemoryHeader[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.md')) continue
      if (entry.name === MEMORY_INDEX) continue

      const filePath = join(dir, entry.name)
      try {
        const stat = statSync(filePath)
        const fd = openSync(filePath, 'r')
        let bytesRead: number
        const buf = Buffer.alloc(1024)
        try {
          bytesRead = readSync(fd, buf, 0, 1024, 0)
        } finally {
          closeSync(fd)
        }
        const head = buf.toString('utf-8', 0, bytesRead)
        const { meta } = parseFrontmatter(head)

        headers.push({
          filename: entry.name,
          filePath,
          mtimeMs: stat.mtimeMs,
          name: meta.name || null,
          description: meta.description || null,
          type: parseMemoryType(meta.type)
        })
      } catch {
        // 跳过损坏的文件
      }
    }
  } catch {
    return []
  }

  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 读取完整记忆文件（frontmatter + 内容）
 */
export function readMemoryFile(filePath: string): MemoryFile | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const { meta, body } = parseFrontmatter(raw)

    // 从路径推断 scope
    const isGlobal = filePath.startsWith(GLOBAL_DIR)
    const scope: MemoryScope = isGlobal ? 'global' : 'conversation'

    // 从路径提取 conversationId
    let conversationId: string | undefined
    if (!isGlobal && filePath.startsWith(CONVERSATIONS_DIR)) {
      const relative = filePath.slice(CONVERSATIONS_DIR.length + 1)
      conversationId = relative.split('/')[0]
    }

    return {
      name: meta.name || basename(filePath, '.md'),
      description: meta.description || '',
      type: parseMemoryType(meta.type) || 'project',
      scope,
      content: body,
      filename: basename(filePath),
      conversationId,
      created: meta.created || new Date().toISOString(),
      updated: meta.updated || new Date().toISOString()
    }
  } catch {
    return null
  }
}

/**
 * 读取 MEMORY.md 索引内容
 */
export function readMemoryIndex(dir: string): string {
  const indexPath = join(dir, MEMORY_INDEX)
  if (!existsSync(indexPath)) return ''
  try {
    const raw = readFileSync(indexPath, 'utf-8').trim()
    if (!raw) return ''

    const lines = raw.split('\n')
    if (lines.length > MAX_INDEX_LINES || raw.length > MAX_INDEX_BYTES) {
      return lines.slice(0, MAX_INDEX_LINES).join('\n') +
        `\n\n> ⚠ 索引已截断（${lines.length} 行 / 限制 ${MAX_INDEX_LINES} 行）。建议提示用户运行"立即整理"触发 dream 合并重叠记忆，或主动归档过期 project_*.md 文件。`
    }
    return raw
  } catch {
    return ''
  }
}

/**
 * 给索引的每一行附加新鲜度标记。
 * 超过 staleThresholdDays（默认 30 天）的文件，在那行末尾加上 "⚠ N 天前更新"。
 *
 * 用 MEMORY.md 行里的 (filename.md) 反查 headers 拿 mtime——比额外解析每个文件的
 * frontmatter `updated:` 更便宜。
 */
function annotateIndexWithFreshness(
  rawIndex: string,
  headers: MemoryHeader[],
  staleThresholdDays = 30
): string {
  if (!rawIndex) return rawIndex
  const mtimeByFile = new Map<string, number>()
  for (const h of headers) mtimeByFile.set(h.filename, h.mtimeMs)

  const linkRe = /\(([^)]+\.md)\)/
  const lines = rawIndex.split('\n').map((line) => {
    const m = line.match(linkRe)
    if (!m) return line
    const mtime = mtimeByFile.get(m[1])
    if (mtime === undefined) return line
    const days = memoryAgeDays(mtime)
    if (days < staleThresholdDays) return line
    return `${line}  ⚠ ${memoryAgeText(mtime)}更新`
  })
  return lines.join('\n')
}

/**
 * 格式化记忆清单（用于注入提取提示）
 */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  if (headers.length === 0) return ''
  return headers
    .map((h) => {
      const typeTag = h.type ? `[${h.type}]` : ''
      const desc = h.description || '(no description)'
      const date = new Date(h.mtimeMs).toISOString().slice(0, 10)
      return `- ${typeTag} ${h.filename} (${date}): ${desc}`
    })
    .join('\n')
}

// ---- Write ----

/**
 * 写入记忆文件到指定目录。返回写入的文件路径。
 */
export function writeMemoryFile(
  dir: string,
  memory: ExtractionMemory,
  conversationId?: string
): string {
  ensureMemoryDir(dir)
  const now = new Date().toISOString()

  let filePath: string
  let content: string

  if (memory.action === 'update' && memory.updateFile) {
    // 更新已有文件
    filePath = join(dir, memory.updateFile)
    const existing = readMemoryFile(filePath)
    content =
      buildFrontmatter({
        name: memory.name,
        description: memory.description,
        type: memory.type,
        created: existing?.created || now,
        updated: now
      }) + memory.content
  } else {
    // 创建新文件
    const filename = generateFilename(memory.type, memory.name, dir)
    filePath = join(dir, filename)
    content =
      buildFrontmatter({
        name: memory.name,
        description: memory.description,
        type: memory.type,
        created: now,
        updated: now
      }) + memory.content
  }

  writeFileSync(filePath, content, 'utf-8')
  console.log(`[Memory] 已保存: ${basename(filePath)} (${memory.type}/${memory.scope})`)

  // 更新索引
  updateMemoryIndex(dir)
  return filePath
}

/**
 * 修复记忆文件 frontmatter 的 created/updated 字段为真实时间戳。
 *
 * evolver agent（extract-memory / dream）用通用 read/write/edit 工具直接改记忆文件，
 * 不经过上面的 writeMemoryFile()——frontmatter 里的 created/updated 完全由模型自由生成，
 * 曾出现幻觉未来日期（如 2026-08-13，晚于系统当前时间）。这里在 agent 跑完之后用代码
 * 强制覆盖，不依赖模型自律（机制优于纪律）：
 * - 新文件：created = updated = 现在
 * - 已有文件被编辑：updated = 现在，created 保留调用方传入的旧值（防止"编辑一次就重置创建时间"）
 * 只做正则替换 created:/updated: 这两行，不重排其余 frontmatter 字段或正文格式。
 */
export function fixMemoryFrontmatterDate(filePath: string, prevCreated?: string): void {
  if (!existsSync(filePath)) return
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const match = raw.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n)([\s\S]*)$/)
    if (!match) return // 无 frontmatter，不是记忆文件格式，跳过
    const [, open, rawMeta, close, rest] = match
    const now = new Date().toISOString()
    const created = prevCreated || now

    let meta = rawMeta
    meta = /^created:.*$/m.test(meta)
      ? meta.replace(/^created:.*$/m, `created: ${created}`)
      : `${meta}\ncreated: ${created}`
    meta = /^updated:.*$/m.test(meta)
      ? meta.replace(/^updated:.*$/m, `updated: ${now}`)
      : `${meta}\nupdated: ${now}`

    const rebuilt = open + meta + close + rest
    if (rebuilt !== raw) writeFileSync(filePath, rebuilt, 'utf-8')
  } catch {
    // best-effort：修复失败不阻塞提取流程
  }
}

/**
 * 从目录中的文件重建 MEMORY.md 索引
 */
export function updateMemoryIndex(dir: string): void {
  const headers = scanMemoryFiles(dir)
  const lines = headers.map((h) => {
    const desc = h.description ? ` — ${h.description}` : ''
    // 截断到 ~150 字符
    const line = `- [${h.name || h.filename}](${h.filename})${desc}`
    return line.length > 150 ? line.slice(0, 147) + '...' : line
  })

  const indexPath = join(dir, MEMORY_INDEX)
  writeFileSync(indexPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8')
}

/**
 * 删除记忆文件并更新索引
 */
export function deleteMemoryFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const dir = join(filePath, '..')
    unlinkSync(filePath)
    updateMemoryIndex(dir)
    console.log(`[Memory] 已删除: ${basename(filePath)}`)
    return true
  } catch {
    return false
  }
}

// ---- Archive (自适应遗忘 / Adaptive Forgetting) ----
//
// 归档 ≠ 删除。把"长期未更新 + 非核心类型"的记忆 renameSync 到 dir/archive/ 子目录。
// 因为 scanMemoryFiles 不递归子目录，archive/ 里的文件天然不再进索引 / 不再进上下文，
// 但文件完整保留、保留原 mtime、可一键找回。由 dream（整理）流程调用——"整理时激进"。
//
// 灵感：睡眠的"突触降级/下调"(Tononi & Cirelli, Neuron 2014)——睡眠并非把记忆全部留下，
// 而是按比例削弱不重要的连接、保护常用且整合良好的，以提升信噪比、防止饱和。
// 我们映射为:整理时把过期的 project/reference/对话级记忆降级归档,身份(user)/工作方式(feedback)永久保留。

const ARCHIVE_DIR_NAME = 'archive'
const ARCHIVE_LOG = '_archive-log.jsonl'

export interface ArchiveRecord {
  filename: string
  name: string | null
  type: MemoryType | undefined
  scope: MemoryScope
  archivedAt: string
  ageDays: number
  reason: string
  originalDir: string
}

/**
 * 自适应遗忘策略（最激进档，但永远只归档不删除——可逆）。
 * 用户已确认:整理时激进,删除的归档就行。
 */
export const ARCHIVE_POLICY = {
  /** project / reference / 无类型 的全局记忆:超过这么多天未更新即归档 */
  globalStaleDays: 21,
  /** 对话级记忆更易过期,阈值更短 */
  conversationStaleDays: 14,
  /** 身份与工作方式是稳定且高价值的(数量本就 1-2 个),永不按年龄归档(与 dream/SKILL.md 的承诺保持同步) */
  protectedTypes: ['user', 'feedback'] as MemoryType[]
}

export function getArchiveDir(dir: string): string {
  return join(dir, ARCHIVE_DIR_NAME)
}

function appendArchiveLog(archiveDir: string, record: ArchiveRecord): void {
  try {
    appendFileSync(join(archiveDir, ARCHIVE_LOG), JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // best effort — 审计日志失败不应阻塞归档
  }
}

/**
 * 把目录下"过期 + 非保护类型"的记忆降级归档到 dir/archive/。
 * 返回被归档的记录(供 UI 通知 / 设置页"已归档"区使用)。
 *
 * @param dir   记忆目录(global 目录 或 conversations/{id} 目录)
 * @param scope 决定阈值,以及全局是否启用类型保护
 */
export function archiveStaleMemories(dir: string, scope: MemoryScope): ArchiveRecord[] {
  if (!existsSync(dir)) return []
  const headers = scanMemoryFiles(dir) // 已天然排除 archive/ 子目录与 MEMORY.md
  if (headers.length === 0) return []

  const staleDays =
    scope === 'global' ? ARCHIVE_POLICY.globalStaleDays : ARCHIVE_POLICY.conversationStaleDays

  const archived: ArchiveRecord[] = []
  const archiveDir = getArchiveDir(dir)
  let archiveDirReady = false

  for (const h of headers) {
    const age = memoryAgeDays(h.mtimeMs)
    if (age < staleDays) continue
    // 全局:身份/工作方式记忆永不按年龄归档
    if (scope === 'global' && h.type && ARCHIVE_POLICY.protectedTypes.includes(h.type)) continue

    try {
      if (!archiveDirReady) {
        ensureMemoryDir(archiveDir) // 仅在首次实际归档时创建,无过期记忆时不留空目录
        archiveDirReady = true
      }
      const targetName = resolveNameCollision(archiveDir, h.filename)
      renameSync(h.filePath, join(archiveDir, targetName)) // 原子移动,保留 mtime
      const record: ArchiveRecord = {
        filename: targetName,
        name: h.name,
        type: h.type,
        scope,
        archivedAt: new Date().toISOString(),
        ageDays: age,
        reason: 'stale',
        originalDir: dir
      }
      appendArchiveLog(archiveDir, record)
      archived.push(record)
      console.log(`[Memory] 归档: ${h.filename} (${age} 天未更新, ${h.type || '无类型'})`)
    } catch (err: any) {
      console.warn(`[Memory] 归档失败 ${h.filename}: ${err.message}`)
    }
  }

  if (archived.length > 0) updateMemoryIndex(dir)
  return archived
}

/** 列出某目录下已归档的记忆(用于设置页"已归档"区 + 找回) */
export function listArchivedMemories(dir: string): MemoryHeader[] {
  return scanMemoryFiles(getArchiveDir(dir))
}

/**
 * 找回一条归档记忆:从 archive/ 移回原目录并刷新索引。
 * @param archiveFilePath 归档文件的完整路径(dir/archive/xxx.md)
 */
export function restoreArchivedMemory(archiveFilePath: string): boolean {
  if (!existsSync(archiveFilePath)) return false
  try {
    const originalDir = join(archiveFilePath, '..', '..')
    const targetName = resolveNameCollision(originalDir, basename(archiveFilePath))
    renameSync(archiveFilePath, join(originalDir, targetName))
    updateMemoryIndex(originalDir)
    console.log(`[Memory] 找回: ${basename(archiveFilePath)} → ${targetName}`)
    return true
  } catch (err: any) {
    console.warn(`[Memory] 找回失败: ${err.message}`)
    return false
  }
}

// ---- Migration ----

/**
 * 将旧的 JSONL 记忆迁移到 Markdown 格式（一次性）
 */
export function migrateJsonlToMarkdown(role: string): { migrated: number; skipped: boolean } {
  const oldFile = join(OPENPIPAL_DIR, 'memory', role, 'memories.jsonl')
  if (!existsSync(oldFile)) return { migrated: 0, skipped: true }

  // 检查是否已迁移过（全局目录已有文件）
  const globalHeaders = scanMemoryFiles(GLOBAL_DIR)
  if (globalHeaders.length > 0) return { migrated: 0, skipped: true }

  let migrated = 0
  try {
    const lines = readFileSync(oldFile, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          ts: number
          topic: string
          summary: string
          questions?: string[]
          tags: string[]
        }

        const created = new Date(entry.ts).toISOString()
        const questions = entry.questions?.length
          ? `\n\n**待解决：** ${entry.questions.join('、')}`
          : ''

        writeMemoryFile(GLOBAL_DIR, {
          name: entry.topic,
          description: entry.summary.slice(0, 80),
          type: 'project', // 旧记忆默认归为 project
          scope: 'global',
          content: entry.summary + questions,
          action: 'create'
        })
        migrated++
      } catch {
        // 跳过损坏的行
      }
    }
    console.log(`[Memory] 迁移完成: ${migrated} 条从 JSONL → Markdown`)
  } catch {
    console.warn('[Memory] 迁移失败: 无法读取旧 JSONL 文件')
  }

  return { migrated, skipped: false }
}

// ---- Prompt Integration ----

/**
 * 构建系统提示中的记忆上下文段落。
 *
 * 注入两层 MEMORY.md 索引（轻量，每条一行：[标题](文件名) — 描述）。
 * 把实际的文件路径告诉 agent，让它用 read 工具按需读取相关记忆全文。
 * 不依赖专用工具——遵循 OpenPipal 通用工具优先原则（read/write/edit 已在 COMMON_TOOLS）。
 *
 * 选择性是天然的：agent 看到索引的 description 行 + 当前任务，自己判断要读哪几个。
 * 例如设计 agent 看到"小学语文教师身份"那条会跳过；学习 agent 看到"产品落地页"那条会跳过。
 */
export function buildMemoryContext(conversationId?: string): string {
  ensureMemoryDir(GLOBAL_DIR)

  const globalHeaders = scanMemoryFiles(GLOBAL_DIR)
  const rawGlobalIndex = readMemoryIndex(GLOBAL_DIR)
  const globalIndex = annotateIndexWithFreshness(rawGlobalIndex, globalHeaders)

  let context = ''

  if (globalIndex) {
    context += `\n\n## 你的记忆（全局，跨对话有效）\n`
    context += `存储路径：\`${GLOBAL_DIR}/\`（Markdown 文件，frontmatter: name/description/type）\n\n`
    context += globalIndex
  }

  if (conversationId) {
    const convDir = getConversationMemoryDir(conversationId)
    if (existsSync(convDir)) {
      const rawConvIndex = readMemoryIndex(convDir)
      if (rawConvIndex) {
        const convHeaders = scanMemoryFiles(convDir)
        const convIndex = annotateIndexWithFreshness(rawConvIndex, convHeaders)
        context += `\n\n## 本次对话的记忆\n`
        context += `存储路径：\`${convDir}/\`\n\n`
        context += convIndex
      }
    }
  }

  if (context) {
    context += `

**记忆使用规则**：
- **按需读取**：扫描上面的索引，**只读和当前任务相关的几条**（用 \`read <路径>\` 读全文）。不要把所有记忆一次性加载——每个角色任务不同，记忆选择应当贴合任务。
- **trust-but-verify**：记忆里提到的**具体工具名 / 文件名 / 标识符 / 用户当前状态**，行动前**先用现实手段验证**（grep / 实际调工具 / 看屏幕 / 问用户）。"记忆说 X 存在"≠"X 现在存在"——重命名、删除、用户已经换工具，都可能发生。
- **新鲜度信号**：带 \`⚠\` 标记的条目是 30 天以上未更新的旧记忆，**当前状态类信息（project_*, 学习焦点等）尤其要警惕**——先验证用户还在做这件事，再据此回应。和当前观察冲突时，**信任当前观察，更新记忆**而不是按旧记忆行事。
- **存新记忆前先去重**：发现值得保留的新信息（用户身份/偏好/项目背景/反馈），先 \`read\` 同主题的已有文件。能合并就 \`edit\`，否则才 \`write\` 新文件。
- **新文件必须带 frontmatter**：\`---\\nname: 简短标题\\ndescription: 一句话描述（用于未来相关性判断）\\ntype: user|feedback|project|reference\\n---\\n\`
- **类型边界**：user=身份与持续偏好（应当 1-2 个文件，章节化）；feedback=工作方式纠正/确认；project=具体项目上下文；reference=外部资源指针。
- **去重铁律**：同一用户的身份是一体的——别建第二个 user_*.md。`
  }

  return context
}

// ---- Memory Age & Freshness ----

/**
 * 计算记忆年龄（天数）
 */
export function memoryAgeDays(mtimeMs: number): number {
  const days = Math.floor((Date.now() - mtimeMs) / 86_400_000)
  return Math.max(0, days)
}

/**
 * 人类可读的记忆年龄
 */
export function memoryAgeText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  return `${Math.floor(days / 30)} 个月前`
}

/**
 * 记忆新鲜度警告文本。新鲜记忆返回空字符串。
 * 超过 3 天的记忆附带 stale 提示。
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 3) return ''
  return `⚠ 此记忆已 ${memoryAgeText(mtimeMs)}更新。内容可能已过时，请结合当前情况判断。`
}

// ---- Semantic Recall ----

/**
 * LLM 语义召回：从记忆列表中选择与查询最相关的 top-N。
 * 使用轻量 LLM 调用，替代纯关键词匹配。
 *
 * 返回选中记忆的完整内容（附带 freshness 警告）。
 */
export async function findRelevantMemories(
  query: string,
  allHeaders: MemoryHeader[],
  limit = 5
): Promise<{ memory: MemoryFile; freshnessNote: string }[]> {
  if (allHeaders.length === 0) return []

  // 少量记忆时不需要 LLM 筛选，全部返回
  if (allHeaders.length <= limit) {
    return allHeaders
      .map((h) => {
        const memory = readMemoryFile(h.filePath)
        if (!memory) return null
        return { memory, freshnessNote: memoryFreshnessNote(h.mtimeMs) }
      })
      .filter(Boolean) as { memory: MemoryFile; freshnessNote: string }[]
  }

  // 构建记忆清单给 LLM 打分
  const manifest = allHeaders.map((h, i) => {
    const typeTag = h.type ? `[${h.type}]` : ''
    return `${i}. ${typeTag} ${h.name || h.filename}: ${h.description || '(无描述)'}`
  }).join('\n')

  try {
    const { getPiModel, ensurePiApiKey, getEffectiveModelConfig, createModelPayloadAdapter, auxCompletionTuning } = require('./config-manager')
    const model = getPiModel()
    ensurePiApiKey(model.provider)
    const tune = auxCompletionTuning(getEffectiveModelConfig(), model, 128)

    const completion = await completeSimple(model, {
      systemPrompt: `你正在为 AI 助手选择与用户查询最相关的记忆。返回一个 JSON 数组，包含最相关记忆的索引号（0-based），最多 ${limit} 个。只选择明确相关的，不确定就不选。只输出 JSON，不要任何其他文字或代码栅栏。格式：{"selected": [0, 3, 7]}`,
      messages: [
        { role: 'user' as const, content: `查询: ${query}\n\n可用记忆:\n${manifest}`, timestamp: Date.now() }
      ]
    }, {
      maxTokens: tune.maxTokens,
      reasoning: tune.reasoning,
      apiKey: getEffectiveModelConfig().apiKey || undefined, // 显式 key 防并发 env 互踩
      temperature: 0,
      timeoutMs: 60_000,
      maxRetries: 2,
      onPayload: createModelPayloadAdapter()
    })

    if (completion.stopReason === 'error') {
      throw new Error(completion.errorMessage || 'LLM 调用失败')
    }

    const text = stripJsonFence(
      (completion.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    ).trim()
    if (!text) return []

    const parsed = JSON.parse(text) as { selected: number[] }
    if (!Array.isArray(parsed.selected)) return []

    return parsed.selected
      .filter((idx) => idx >= 0 && idx < allHeaders.length)
      .slice(0, limit)
      .map((idx) => {
        const h = allHeaders[idx]
        const memory = readMemoryFile(h.filePath)
        if (!memory) return null
        return { memory, freshnessNote: memoryFreshnessNote(h.mtimeMs) }
      })
      .filter(Boolean) as { memory: MemoryFile; freshnessNote: string }[]
  } catch (err: any) {
    console.warn('[Memory] 语义召回失败，回退到关键词匹配:', err.message)
    // 回退：关键词匹配
    return keywordRecall(query, allHeaders, limit)
  }
}

/**
 * 关键词匹配回退（当 LLM 语义召回不可用时）
 */
function keywordRecall(
  query: string,
  headers: MemoryHeader[],
  limit: number
): { memory: MemoryFile; freshnessNote: string }[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) {
    // 无关键词，返回最近的
    return headers.slice(0, limit).map((h) => {
      const memory = readMemoryFile(h.filePath)
      if (!memory) return null
      return { memory, freshnessNote: memoryFreshnessNote(h.mtimeMs) }
    }).filter(Boolean) as { memory: MemoryFile; freshnessNote: string }[]
  }

  const scored = headers.map((h) => {
    const text = `${h.name || ''} ${h.description || ''} ${h.type || ''}`.toLowerCase()
    let score = 0
    for (const kw of keywords) {
      if (text.includes(kw)) score++
    }
    return { header: h, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => {
      const memory = readMemoryFile(s.header.filePath)
      if (!memory) return null
      return { memory, freshnessNote: memoryFreshnessNote(s.header.mtimeMs) }
    })
    .filter(Boolean) as { memory: MemoryFile; freshnessNote: string }[]
}
