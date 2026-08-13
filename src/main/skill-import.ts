/**
 * 技能导入 —— main 进程内核
 *
 * 两种来源：本地文件夹 / GitHub 仓库链接。扫描产出候选列表供 UI 勾选，
 * 用户确认后再落盘到 ~/.openpipal/skills/，随后触发 reloadSkills() 让新技能立即可见。
 *
 * 不加任何 npm 依赖：GitHub 下载走 Node 全局 fetch，解压走系统 /usr/bin/tar
 * （与 dc-export.ts 用 /usr/bin/zip 打包同一哲学——用 macOS 自带工具）。
 */

import { existsSync, statSync, readdirSync, mkdirSync, rmSync, cpSync, createWriteStream, unlinkSync } from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { app } from 'electron'
import { getUserSkillsDir, listSkillsMeta, scanSkillsInPaths, reloadSkills } from './skill-manager'
import { mainError, tMain, type MainErrorPayload } from './main-i18n'

const execFileAsync = promisify(execFile)

// ---- 契约类型（与 renderer 冻结） ----

export type ImportSource =
  | { type: 'folder'; path: string }
  | { type: 'github'; url: string }

export interface ImportCandidate {
  name: string
  description: string
  conflict: 'none' | 'user' | 'builtin' | 'plugin' | 'mcp'
}

export type ImportScanResult =
  | { ok: true; scanId: string; candidates: ImportCandidate[] }
  | ({ ok: false } & MainErrorPayload)

export interface ImportApplyPayload {
  scanId: string
  names: string[]
  overwrite: boolean
}

export type ImportApplyResult =
  | { ok: true; installed: string[]; skipped: string[] }
  | ({ ok: false } & MainErrorPayload)

// ---- 内部扫描结果缓存 ----

interface InternalCandidate {
  name: string
  description: string
  skillDir: string
}

interface ScanCacheEntry {
  candidates: InternalCandidate[]
  tempDir?: string  // 仅 GitHub 来源有临时目录需要清理
}

const scanCache = new Map<string, ScanCacheEntry>()

// ---- 临时目录管理 ----

function importTempRoot(): string {
  return path.join(app.getPath('temp'), 'openpipal-skill-import')
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** 每次新 scan 前清理历史残留（上次未 apply、或跨 app 重启后 Map 已丢失但磁盘还在的目录） */
function cleanupStaleImportTempDirs(): void {
  const root = importTempRoot()
  if (!existsSync(root)) return
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (scanCache.has(entry.name)) continue
      cleanupDir(path.join(root, entry.name))
    }
  } catch { /* ignore */ }
}

// ---- 冲突标注 ----

function buildConflictMap(): Map<string, 'user' | 'builtin' | 'plugin' | 'mcp'> {
  const meta = listSkillsMeta()
  return new Map(meta.map(m => [m.name, m.source]))
}

// scanId 必须与磁盘临时目录同名——cleanupStaleImportTempDirs 用目录名反查 scanCache,
// 两者不一致会把"已扫描待应用"的临时目录当残留清掉
function finalizeScanResult(candidates: InternalCandidate[], tempDir?: string, scanId = randomUUID()): ImportScanResult {
  scanCache.set(scanId, { candidates, tempDir })
  const bySource = buildConflictMap()
  return {
    ok: true,
    scanId,
    candidates: candidates.map(c => ({
      name: c.name,
      description: c.description,
      conflict: bySource.get(c.name) ?? 'none'
    }))
  }
}

// ---- 文件夹来源 ----

async function scanFolderSource(dirPath: string): Promise<ImportScanResult> {
  if (!dirPath || typeof dirPath !== 'string') return { ok: false, ...mainError('toolsHub.skills.errors.pickFolder') }
  const resolved = path.resolve(dirPath)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { ok: false, ...mainError('toolsHub.skills.errors.notAFolder') }
  }
  // loadSkills 对"目录自身直接含 SKILL.md"已按预期处理——识别为单个技能根，不再递归其子目录
  // （见 pi-coding-agent/dist/core/skills.js: loadSkillsFromDirInternal 命中 SKILL.md 后立即 return），
  // 因此这里无需额外判一层。
  const candidates = await scanSkillsInPaths([resolved])
  if (candidates.length === 0) {
    return { ok: false, ...mainError('toolsHub.skills.errors.noSkillsInFolder') }
  }
  return finalizeScanResult(candidates)
}

// ---- GitHub 来源 ----

interface GithubRef {
  owner: string
  repo: string
  ref?: string
  subpath?: string
}

const ALLOWED_GITHUB_HOSTS = new Set(['github.com'])
const ALLOWED_DOWNLOAD_HOSTS = new Set(['codeload.github.com'])
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

function parseGithubUrl(input: string): GithubRef | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // 裸 owner/repo 形式（无协议、恰好一段 owner/repo）
  if (!/^https?:\/\//i.test(trimmed) && /^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.split('/')
    return { owner, repo: repo.replace(/\.git$/, '') }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!ALLOWED_GITHUB_HOSTS.has(url.hostname)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length === 2) {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') }
  }
  if (parts.length >= 4 && parts[2] === 'tree') {
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '')
    const ref = decodeURIComponent(parts[3])
    const subpath = parts.length > 4 ? parts.slice(4).map(decodeURIComponent).join('/') : undefined
    return { owner, repo, ref, subpath }
  }
  return null
}

/** 流式下载并强制 50MB 上限（Content-Length 缺失/伪造时靠边下边计数兜底） */
async function downloadWithLimit(res: Response, destPath: string): Promise<{ ok: true } | ({ ok: false } & MainErrorPayload)> {
  const declaredLen = Number(res.headers.get('content-length') || 0)
  if (declaredLen > MAX_DOWNLOAD_BYTES) {
    return { ok: false, ...mainError('toolsHub.skills.errors.repoTooLarge') }
  }
  if (!res.body) return { ok: false, ...mainError('toolsHub.skills.errors.emptyResponse') }

  let received = 0
  const writeStream = createWriteStream(destPath)
  const nodeStream = Readable.fromWeb(res.body as any)
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > MAX_DOWNLOAD_BYTES) {
      nodeStream.destroy(new Error('SIZE_LIMIT_EXCEEDED'))
    }
  })

  try {
    await pipeline(nodeStream, writeStream)
  } catch (err: any) {
    try { unlinkSync(destPath) } catch { /* ignore */ }
    if (err?.message === 'SIZE_LIMIT_EXCEEDED') return { ok: false, ...mainError('toolsHub.skills.errors.repoTooLarge') }
    return { ok: false, ...mainError('toolsHub.skills.errors.downloadFailed', { detail: err?.message || String(err) }) }
  }
  return { ok: true }
}

/**
 * 下载 GitHub 仓库到临时目录并解压,返回仓库内容根(已应用 /tree/<ref>/<subpath>)。
 * 供技能导入与插件导入(plugin-import.ts)共用。调用方负责用完后清理 tempDir。
 */
export async function downloadGithubRepo(
  rawUrl: string,
  tempDirName = randomUUID()
): Promise<{ ok: true; repoDir: string; tempDir: string } | ({ ok: false } & MainErrorPayload)> {
  const parsed = parseGithubUrl(rawUrl)
  if (!parsed) return { ok: false, ...mainError('toolsHub.skills.errors.githubOnly') }
  const { owner, repo, ref, subpath } = parsed

  const scanTempDir = path.join(importTempRoot(), tempDirName)
  const extractDir = path.join(scanTempDir, 'extracted')
  const tarPath = path.join(scanTempDir, 'repo.tar.gz')

  try {
    mkdirSync(extractDir, { recursive: true })
  } catch (err: any) {
    return { ok: false, ...mainError('toolsHub.skills.errors.tempDirFailed', { detail: err?.message || String(err) }) }
  }

  const downloadUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(ref || 'HEAD')}`
  const downloadUrlObj = new URL(downloadUrl)
  if (!ALLOWED_DOWNLOAD_HOSTS.has(downloadUrlObj.hostname)) {
    cleanupDir(scanTempDir)
    return { ok: false, ...mainError('toolsHub.skills.errors.unsupportedDownloadSource') }
  }

  let res: Response
  try {
    res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) })
  } catch (err: any) {
    cleanupDir(scanTempDir)
    return { ok: false, ...mainError('toolsHub.skills.errors.githubUnreachable', { detail: err?.message || tMain('toolsHub.skills.errors.networkTimeout') }) }
  }
  if (!res.ok) {
    cleanupDir(scanTempDir)
    if (res.status === 404) return { ok: false, ...mainError('toolsHub.skills.errors.repoNotFound') }
    return { ok: false, ...mainError('toolsHub.skills.errors.githubStatus', { status: res.status }) }
  }

  const dl = await downloadWithLimit(res, tarPath)
  if (!dl.ok) {
    cleanupDir(scanTempDir)
    return dl
  }

  try {
    await execFileAsync('/usr/bin/tar', ['-xzf', tarPath, '-C', extractDir])
  } catch (err: any) {
    cleanupDir(scanTempDir)
    return { ok: false, ...mainError('toolsHub.skills.errors.extractFailed', { detail: err?.message || String(err) }) }
  }

  let topEntries: string[]
  try {
    topEntries = readdirSync(extractDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    topEntries = []
  }
  if (topEntries.length === 0) {
    cleanupDir(scanTempDir)
    return { ok: false, ...mainError('toolsHub.skills.errors.emptyArchive') }
  }

  let repoDir = path.join(extractDir, topEntries[0])
  if (subpath) {
    const withSub = path.join(repoDir, subpath)
    if (!existsSync(withSub) || !statSync(withSub).isDirectory()) {
      cleanupDir(scanTempDir)
      return { ok: false, ...mainError('toolsHub.skills.errors.subpathNotFound', { subpath }) }
    }
    repoDir = withSub
  }
  return { ok: true, repoDir, tempDir: scanTempDir }
}

async function scanGithubSource(rawUrl: string): Promise<ImportScanResult> {
  if (!rawUrl || typeof rawUrl !== 'string') return { ok: false, ...mainError('toolsHub.skills.errors.enterGithubUrl') }
  const scanId = randomUUID()
  const dl = await downloadGithubRepo(rawUrl, scanId)
  if (!dl.ok) return dl

  const candidates = await scanSkillsInPaths([dl.repoDir])
  if (candidates.length === 0) {
    cleanupDir(dl.tempDir)
    return { ok: false, ...mainError('toolsHub.skills.errors.noSkillsInRepo') }
  }
  return finalizeScanResult(candidates, dl.tempDir, scanId)
}

// ---- 公开 API ----

export async function importScan(source: ImportSource): Promise<ImportScanResult> {
  cleanupStaleImportTempDirs()
  if (!source || typeof source !== 'object') return { ok: false, ...mainError('toolsHub.skills.errors.missingSource') }
  if (source.type === 'folder') return scanFolderSource(source.path)
  if (source.type === 'github') return scanGithubSource(source.url)
  return { ok: false, ...mainError('toolsHub.skills.errors.unsupportedSource') }
}

/** 目标目录名 sanitize：非 [a-z0-9-] 字符转 '-'，避免 frontmatter name 里的非法字符落到文件系统 */
function sanitizeSkillDirName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || 'skill'
}

export function importApply(payload: ImportApplyPayload): ImportApplyResult {
  const entry = scanCache.get(payload.scanId)
  if (!entry) return { ok: false, ...mainError('toolsHub.skills.errors.scanExpired') }

  const bySource = buildConflictMap()
  const installed: string[] = []
  const skipped: string[] = []

  for (const name of payload.names) {
    const candidate = entry.candidates.find(c => c.name === name)
    if (!candidate) { skipped.push(name); continue }

    const conflict = bySource.get(name) ?? 'none'
    if (conflict === 'builtin') { skipped.push(name); continue }

    const destDir = path.join(getUserSkillsDir(), sanitizeSkillDirName(candidate.name))
    if (conflict === 'user') {
      if (!payload.overwrite) { skipped.push(name); continue }
      cleanupDir(destDir)
    }
    // conflict === 'mcp' | 'none'：user 目录下没有同名实体，直接装；
    // 'mcp' 情形下按扫描路径优先级（built-in > user > MCP），装入 user 目录会自然覆盖 MCP 建议版本。

    try {
      mkdirSync(path.dirname(destDir), { recursive: true })
      cpSync(candidate.skillDir, destDir, { recursive: true })
      installed.push(name)
    } catch {
      skipped.push(name)
    }
  }

  if (entry.tempDir) cleanupDir(entry.tempDir)
  scanCache.delete(payload.scanId)

  reloadSkills()
  return { ok: true, installed, skipped }
}

export function deleteUserSkill(name: string): { ok: true } | ({ ok: false } & MainErrorPayload) {
  const meta = listSkillsMeta().find(s => s.name === name)
  if (!meta) return { ok: false, ...mainError('toolsHub.skills.errors.skillNotFound', { name }) }
  if (meta.source !== 'user') {
    return { ok: false, ...mainError('toolsHub.skills.errors.deleteUserOnly') }
  }

  const userRoot = path.resolve(getUserSkillsDir())
  const target = path.resolve(meta.dir)
  if (target !== userRoot && !target.startsWith(userRoot + path.sep)) {
    return { ok: false, ...mainError('toolsHub.skills.errors.deleteUserOnly') }
  }

  try {
    rmSync(target, { recursive: true, force: true })
  } catch (err: any) {
    return { ok: false, ...mainError('toolsHub.skills.errors.deleteFailed', { detail: err?.message || String(err) }) }
  }
  reloadSkills()
  return { ok: true }
}
