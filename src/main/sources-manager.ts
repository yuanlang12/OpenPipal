/**
 * Sources Manager — Cave 模式的资料区数据层
 *
 * 存储位置：~/.openpipal/workspace/sources/<id>/
 *   - meta.json       : Source metadata（title / type / status / addedAt / summary…）
 *   - original.<ext>  : 原文件（PDF / MD / HTML / TXT / 图片）
 *   - extracted.txt   : 可选 — AI 友好的纯文本（异步 ingest 任务生成）
 *   - thumbnail.png   : 可选 — 缩略图
 *
 * 设计原则（来自 CLAUDE.md "文件式 opt-in" 约定）：
 *   - 每个 source 是一个独立子目录，用户/Agent 可以手动 mkdir / rm 管理
 *   - 子目录存在 + meta.json 解析成功 = source 存在
 *   - 没有索引文件 / 注册表 —— 文件系统就是数据库
 *
 * Status 状态机（乐观 UI 的基础）：
 *   pending  → 用户刚拖入，未开始 ingest（UI 显示骨架屏）
 *   ingesting → 提取文本 / 生成 summary 中（UI 显示进度）
 *   ready    → 可被 AI 引用
 *   failed   → ingest 失败（UI 显示错误 + retry 按钮）
 */

import * as fs from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { dataPath } from './data-root'

export type SourceType = 'pdf' | 'md' | 'html' | 'txt' | 'image' | 'url' | 'other'
export type SourceStatus = 'pending' | 'ingesting' | 'ready' | 'failed'

export interface Source {
  /** Unique id，格式 <unix-ms-base36>-<random4>，对应子目录名 */
  id: string
  /** 显示用标题（默认取自原文件名，可由用户/AI 改写） */
  title: string
  type: SourceType
  status: SourceStatus
  /** 原文件相对路径（相对于 source 目录） */
  originalFile?: string
  /** AI 友好纯文本相对路径（ingest 后生成） */
  extractedFile?: string
  /** 缩略图相对路径 */
  thumbnailFile?: string
  /** AI 生成的摘要（ready 后写入） */
  summary?: string
  /** 来自 web 时的源 URL */
  sourceUrl?: string
  /** 加入资料区时间（unix ms） */
  addedAt: number
  /** ingest 完成时间 */
  ingestedAt?: number
  /** 原文件大小 bytes */
  byteSize?: number
  /**
   * 学习会话内的引用编号（[1]、[2]……）
   * 由 cave 模式 UI 在 list 时根据 addedAt 顺序赋值，不持久化
   */
  citationIndex?: number
  /** ingest 失败时的错误信息 */
  errorMessage?: string
}

/** 创建 source 时传入的参数 */
export interface AddSourceParams {
  title: string
  type: SourceType
  /** 从本地文件系统复制原文件（绝对路径） */
  filePath?: string
  /** 直接传入文本内容（type='txt' 常用） */
  content?: string
  /** type='url' 时记录源 URL */
  sourceUrl?: string
}

/** update-status 时可附带的部分 patch */
export interface SourceStatusPatch {
  extractedFile?: string
  thumbnailFile?: string
  summary?: string
  errorMessage?: string
}

// ---- 路径 helpers ----

function getSourcesRoot(): string {
  return dataPath('workspace', 'sources')
}

function getSourceDir(id: string): string {
  return join(getSourcesRoot(), id)
}

function getMetaPath(id: string): string {
  return join(getSourceDir(id), 'meta.json')
}

// ---- ID 生成 ----

function generateSourceId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ts}-${rand}`
}

// ---- 文件名 helper ----

function extForType(type: SourceType, filePath?: string): string {
  if (filePath) {
    const m = filePath.match(/\.([a-zA-Z0-9]+)$/)
    if (m) return m[1].toLowerCase()
  }
  switch (type) {
    case 'pdf': return 'pdf'
    case 'md': return 'md'
    case 'html': return 'html'
    case 'txt': return 'txt'
    case 'image': return 'png'
    default: return 'bin'
  }
}

// ---- meta.json 读写 ----

function readMeta(id: string): Source | null {
  const p = getMetaPath(id)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const data = JSON.parse(raw) as Source
    // 防御：id 不一致以目录名为准（用户可能手动改文件名）
    if (data.id !== id) data.id = id
    return data
  } catch (err: any) {
    console.warn(`[Sources] 读取 ${id}/meta.json 失败:`, err?.message)
    return null
  }
}

function writeMeta(source: Source): void {
  const dir = getSourceDir(source.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getMetaPath(source.id), JSON.stringify(source, null, 2), 'utf8')
}

// ---- 公开 API ----

/**
 * 列出所有 source —— 扫描 sources 目录，按 addedAt 降序，附加 citationIndex
 * citationIndex 按 *升序*（最早加入的是 [1]）赋值——符合学术引用习惯
 */
export function listSources(): Source[] {
  const root = getSourcesRoot()
  if (!fs.existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = fs.readdirSync(root)
  } catch (err: any) {
    console.warn('[Sources] 读取 sources 根目录失败:', err?.message)
    return []
  }

  const sources: Source[] = []
  for (const id of entries) {
    const fullPath = join(root, id)
    try {
      if (!fs.statSync(fullPath).isDirectory()) continue
    } catch { continue }
    const meta = readMeta(id)
    if (meta) sources.push(meta)
  }

  // 按 addedAt 升序赋 citationIndex（[1] 是最早的），但返回时按降序（最新在前）
  const ascByTime = [...sources].sort((a, b) => a.addedAt - b.addedAt)
  ascByTime.forEach((s, i) => { s.citationIndex = i + 1 })
  return sources.sort((a, b) => b.addedAt - a.addedAt)
}

export function getSource(id: string): Source | null {
  return readMeta(id)
}

/**
 * 创建一个新 source —— 立即返回（status='pending'），不做 ingest
 * Ingest（提取文本 / 生成 summary / 生成缩略图）由后续异步任务完成
 *
 * 关键性质：这个调用必须**快**（< 100ms 完成磁盘写入），UI 才能立即乐观渲染
 */
export function addSource(params: AddSourceParams): Source {
  const id = generateSourceId()
  const dir = getSourceDir(id)
  fs.mkdirSync(dir, { recursive: true })

  const ext = extForType(params.type, params.filePath)
  const originalFileName = `original.${ext}`
  const targetPath = join(dir, originalFileName)

  let byteSize: number | undefined
  if (params.filePath) {
    fs.copyFileSync(params.filePath, targetPath)
    try { byteSize = fs.statSync(targetPath).size } catch {}
  } else if (typeof params.content === 'string') {
    fs.writeFileSync(targetPath, params.content, 'utf8')
    try { byteSize = fs.statSync(targetPath).size } catch {}
  }
  // 注意：type='url' 且无 content / filePath 时 originalFile 不写入
  // ingest 任务会异步 fetch URL 内容到 extracted.txt

  const source: Source = {
    id,
    title: params.title,
    type: params.type,
    status: 'pending',
    originalFile: (params.filePath || params.content) ? originalFileName : undefined,
    sourceUrl: params.sourceUrl,
    addedAt: Date.now(),
    byteSize
  }
  writeMeta(source)
  return source
}

/**
 * 删除 source —— 递归删整个子目录
 */
export function removeSource(id: string): { ok: boolean; error?: string } {
  const dir = getSourceDir(id)
  if (!fs.existsSync(dir)) return { ok: false, error: 'source 不存在' }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || '删除失败' }
  }
}

/**
 * 更新 source 状态 —— 用于 ingest 任务汇报进度
 * 可一并 patch summary / extractedFile / thumbnailFile / errorMessage
 */
export function updateSourceStatus(
  id: string,
  status: SourceStatus,
  patch?: SourceStatusPatch
): Source | null {
  const current = readMeta(id)
  if (!current) return null
  const next: Source = {
    ...current,
    status,
    ...patch
  }
  if (status === 'ready' && !next.ingestedAt) {
    next.ingestedAt = Date.now()
  }
  writeMeta(next)
  return next
}
