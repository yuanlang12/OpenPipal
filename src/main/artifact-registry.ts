/**
 * Artifact 注册表 —— artifact「身份」的单一权威（create 同步落盘、render/edit 同步解析）。
 *
 * 为什么存在：历史上 create_artifact 拿到 id 却不落盘（异步经渲染器往返才写），而 render/edit
 * 按磁盘扫描解析 id → 文件还没写就"找不到 id"→ 模型反复重试/猜 id。注册表把"create 写、
 * render/edit 读"收敛到同一个权威，写在返回 id 之前同步完成，竞态消失。
 *
 * ports-and-adapters（为上云留接口缝）：工具只依赖 `ArtifactStore` 接口，本地 `LocalArtifactStore`
 * = 内存 Map（元数据）+ 委托 artifact-store 落盘（磁盘 sidecar 是 render 隐藏窗口/导出的依赖，必须保留）。
 * 将来上云写 `CloudArtifactStore`（DB 元数据 + 对象存储内容）替换 getArtifactStore()。
 * ⚠️ 尚未完全"零改"的一处：edit 的正文写盘目前仍在 pi-tools 里 `fs.writeFileSync(record.path)`（走本地路径）。
 * 真上云时这步要挪进 store 由它自己持久化（store 拥有写、不外泄 path），届时该 seam 才彻底可换。
 */
import fs from 'fs'
import { structuredPatch } from 'diff'
import {
  ArtifactData,
  ArtifactRef,
  saveArtifact,
  listConversationArtifacts,
  findArtifactFileById,
  normalizeArtifactTitle,
  coarseTypeFromFile,
  titlesSimilar,
} from './artifact-store'

export interface ArtifactRecord {
  id: string
  type: string
  title: string
  language?: string
  path: string // 绝对 sidecar 路径
  /** Agent 最后一次读到或写出该文件时的磁盘 mtime（ms）。写入对账门闩的基线——undefined 表示
   *  尚无基线（legacy 记录 / 应用重启后首个回合），此时门闩不设防，见 evaluateArtifactWriteGuard。 */
  lastKnownMtimeMs?: number
  /** Agent 最后一次**写出**的内容快照（create/edit 后刷新，read 不动它）。diff 证据链的基线：
   *  模型上下文里未必有它自己上一版的原文，没有这份快照就无从告诉它「用户改了哪几行」——
   *  这是信息缺口不是能力问题，属永久架构。undefined = 本进程内 Agent 没写过（legacy/重启后）。 */
  lastAgentContent?: string
}

export type ResolveResult = { record: ArtifactRecord; corrected: boolean } | { error: string }

/** artifact 身份存储的接口（端口）。工具只依赖它，实现可换（本地 Map+磁盘 / 云端 DB+对象存储）。 */
export interface ArtifactStore {
  /** create 持久化：同步落盘 + 记录，返回 record。关竞态的关键——返回前内容已在权威里。 */
  upsert(convId: string, a: ArtifactData): ArtifactRecord
  /** render/edit 解析 handle（id 或标题）→ record 或带真实 id 清单的错误。 */
  resolve(idOrTitle: string, convId?: string): ResolveResult
  /** 按 id 取元信息（替代旧 artifactMetaCache）。legacy 未入表 → undefined。 */
  getRecord(id: string): ArtifactRecord | undefined
  /** 幂等回补用：注册表已拥有该 id 时返回其 ref（渲染器 onArtifact 的往返 save 变 no-op）。 */
  getRef(convId: string, id: string): ArtifactRef | undefined
  /** 删除记录（会话删除时清理，避免内存表无界增长）。未知 id 是 no-op。 */
  delete(id: string): void
  /** 写入对账门闩的基线刷新——read_artifact/edit_artifact 成功后调用，"看过/改过即解锁"。
   *  record 缺字段时（legacy 未入表）以调用方拼出的最小信息为准，顺带把该 id 补进注册表。
   *  writtenContent：仅**写出**事件（edit）传入，同步刷新 diff 证据基线；read 不传、快照不动。 */
  touch(record: ArtifactRecord, mtimeMs: number, writtenContent?: string): void
}

/** 对账容忍窗口——文件系统 mtime 精度/落盘时序抖动的余量，避免刚写完的正常回合被自己的写入误判为"外部修改"。 */
export const WRITE_GUARD_TOLERANCE_MS = 1500

export interface WriteGuardResult {
  blocked: boolean
  message?: string
}

/**
 * 写入对账门闩的纯判定：磁盘 mtime 是否领先于 Agent 最后一次读写基线超过容差。
 * 无基线（undefined）= 放行——注册表是内存态，重启后首个回合本就没有基线可对账（可接受，见机制台账）。
 */
export function evaluateArtifactWriteGuard(diskMtimeMs: number, lastKnownMtimeMs: number | undefined): WriteGuardResult {
  if (lastKnownMtimeMs === undefined) return { blocked: false }
  if (diskMtimeMs <= lastKnownMtimeMs + WRITE_GUARD_TOLERANCE_MS) return { blocked: false }
  const minutesAgo = Math.max(1, Math.round((Date.now() - diskMtimeMs) / 60000))
  return {
    blocked: true,
    message: `该产物在你上次读写之后已被用户直接修改（${minutesAgo} 分钟前）。先用 read_artifact 读取当前内容（结果会标出用户修改的 diff），把用户的修改整合进你的新版本再重发。`
  }
}

/** diff 证据块的字符预算——差异是证据不是正文，超预算截断并声明，完整现状以 read 正文为准。 */
const EDIT_EVIDENCE_MAX_CHARS = 4000

/**
 * 外部修改的 diff 证据（确定性归代码，判断力归模型）：mtime 对账只能告诉模型「被改过」，
 * 这里把「改了什么」算出来一并给它——保不保留、怎么整合进新版本由模型判断。
 * 内容相同或无快照可比 → null（调用方不附证据块）。
 */
export function buildExternalEditEvidence(lastAgentContent: string, currentContent: string): string | null {
  if (lastAgentContent === currentContent) return null
  let hunks: { newStart: number; lines: string[] }[]
  try {
    hunks = structuredPatch('agent', 'user', lastAgentContent, currentContent, undefined, undefined, { context: 2 }).hunks
  } catch {
    return null // diff 失败不阻塞读取——证据链是增强，不是读取的前置条件
  }
  if (!hunks.length) return null
  const parts: string[] = []
  for (const h of hunks) {
    parts.push(`@@ 第 ${h.newStart} 行附近 @@`)
    parts.push(...h.lines)
  }
  let body = parts.join('\n')
  let truncNote = ''
  if (body.length > EDIT_EVIDENCE_MAX_CHARS) {
    body = body.slice(0, EDIT_EVIDENCE_MAX_CHARS)
    truncNote = `\n…（差异过长已截断，共 ${hunks.length} 处修改；完整现状以下方正文为准）`
  }
  return (
    `⚠️ 外部修改对账：用户在你上次写出之后**直接修改过**此产物，差异如下（- 你上次写出的版本 / + 用户改后的当前版本）：\n` +
    '```diff\n' + body + truncNote + '\n```\n' +
    `重做或整合时**保留用户的这些修改**，除非与用户本次的要求直接冲突。`
  )
}

function jsxLang(file: string): string | undefined {
  return file.toLowerCase().endsWith('.jsx') ? 'jsx' : undefined
}

/** best-effort 取文件当前 mtime；ephemeral（空 path）或竞态删除时返回 undefined，调用方按"无基线"处理。 */
function statMtimeMs(filePath: string): number | undefined {
  if (!filePath) return undefined
  try { return fs.statSync(filePath).mtimeMs } catch { return undefined }
}

/** best-effort 读文件全文；ephemeral（空 path）或竞态删除时返回 undefined。 */
function readFileUtf8(filePath: string): string | undefined {
  if (!filePath) return undefined
  try { return fs.readFileSync(filePath, 'utf8') } catch { return undefined }
}

class LocalArtifactStore implements ArtifactStore {
  private map = new Map<string, ArtifactRecord>()

  upsert(convId: string, a: ArtifactData): ArtifactRecord {
    // 同步落盘（saveArtifact 内含 jsx sidecar 编译）—— 返回前文件已在盘上，render/edit 立即可解析。
    const ref = saveArtifact(convId, a)
    const rec: ArtifactRecord = {
      id: ref.id,
      type: ref.type,
      title: ref.title,
      language: ref.language,
      path: ref.path,
      lastKnownMtimeMs: statMtimeMs(ref.path),
      // diff 证据基线：以磁盘读回为准（与 read_artifact 看到的表示严格一致），读不到才退回入参。
      lastAgentContent: readFileUtf8(ref.path) ?? a.content
    }
    this.map.set(a.id, rec)
    return rec
  }

  resolve(given: string, conversationId?: string): ResolveResult {
    if (conversationId) {
      // 磁盘清单是本会话事实来源（create 已同步落盘 → 无竞态、跨重启有效、天然按会话隔离）。
      const scoped = listConversationArtifacts(conversationId)
      const exact = scoped.find((e) => e.id === given)
      if (exact) return { record: this.recordFor(exact.id, exact.file, exact.title), corrected: false }
      // 容错纠正（保留旧 resolveArtifactId 行为）：唯一子串（≥4 位）→ 本会话只有一个 artifact 时直接对上。
      const stripped = String(given || '').replace(/^artifact-?/, '')
      let candidates = stripped.length >= 4 ? scoped.filter((e) => e.id.includes(stripped)) : []
      if (candidates.length !== 1 && scoped.length === 1) candidates = scoped
      if (candidates.length === 1) {
        const c = candidates[0]
        return { record: this.recordFor(c.id, c.file, c.title), corrected: true }
      }
      // 语义 handle：按**标题**解析。跨轮模型看产物靠 system prompt 注入的 <session-artifacts>
      // 清单（id+标题都有）；弱模型复述 id 不稳时用标题引用兜底。相似阈值与 create 门闩共用
      // titlesSimilar（不漂移）。
      const wanted = normalizeArtifactTitle(given)
      if (wanted) {
        const titleHits = scoped.filter((e) =>
          titlesSimilar(normalizeArtifactTitle(e.title || this.map.get(e.id)?.title || ''), wanted)
        )
        if (titleHits.length === 1) {
          const h = titleHits[0]
          return { record: this.recordFor(h.id, h.file, h.title), corrected: true }
        }
        if (titleHits.length > 1) {
          const cands = titleHits.map((e) => `- ${e.id} · ${e.title || ''}`).join('\n')
          return { error: `标题"${given}"在本会话匹配到多个 artifact，用下面的**完整 id** 指定其一：\n${cands}` }
        }
      }
      // 都不行 → 回列真实 id 清单，绝不引导新建。
      const list = scoped
        .slice(-5)
        .map((e) => `- ${e.id} · ${e.title || this.map.get(e.id)?.title || ''}`)
        .join('\n')
      return {
        error:
          `找不到 id 为 ${given} 的 artifact。` +
          (list
            ? `本会话已有这些 artifact，用下面的**完整 id** 重试（不要新建）：\n${list}`
            : `本会话还没有任何 artifact——先用 create_artifact 创建。`),
      }
    }
    // 拿不到 convId 的兜底：全局精确匹配（id 含时间戳全局唯一）。
    const file = findArtifactFileById(given)
    if (file) return { record: this.recordFor(given, file, ''), corrected: false }
    return { error: `找不到 id 为 ${given} 的 artifact。从历史 tool 结果里找 "(id: artifact-...)" 的完整 id 重试。` }
  }

  getRecord(id: string): ArtifactRecord | undefined {
    return this.map.get(id)
  }

  getRef(convId: string, id: string): ArtifactRef | undefined {
    const r = this.map.get(id)
    if (!r) return undefined
    return { id: r.id, type: r.type, title: r.title, path: r.path, language: r.language }
  }

  delete(id: string): void {
    this.map.delete(id)
  }

  touch(record: ArtifactRecord, mtimeMs: number, writtenContent?: string): void {
    // 合并而非整条覆盖：调用方（read/edit_artifact）传入的可能是磁盘重建的最小 record，
    // 已缓存的更全字段（如精确 type/language）不应被冲掉。
    const existing = this.map.get(record.id)
    this.map.set(record.id, {
      ...existing,
      ...record,
      lastKnownMtimeMs: mtimeMs,
      // 写出事件刷新 diff 基线；read 事件（不传）保留原快照——基线语义是「Agent 最后写出的版本」。
      lastAgentContent: writtenContent !== undefined ? writtenContent : existing?.lastAgentContent
    })
  }

  /** Map 命中优先（含精确 type/language）；否则从磁盘条目重建 legacy 记录。 */
  private recordFor(id: string, file: string, title: string): ArtifactRecord {
    const cached = this.map.get(id)
    if (cached) return cached
    return { id, type: coarseTypeFromFile(file), title: title || id, language: jsxLang(file), path: file }
  }
}

let singleton: ArtifactStore | null = null
/** 单例访问器。上云时此处返回 CloudArtifactStore（DB + 对象存储），create/resolve/getRecord/getRef 调用点零改。 */
export function getArtifactStore(): ArtifactStore {
  if (!singleton) singleton = new LocalArtifactStore()
  return singleton
}
