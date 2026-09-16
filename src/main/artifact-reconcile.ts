/**
 * 产物库直写对账（2026-09-12，替代"bash/write 直写 artifact sidecar 一律硬拒"）。
 *
 * 模型用 write/edit/bash/execute_code 直接改了本会话的产物文件之后，产物面板和 jsx 编译产物
 * 是磁盘的投影，投影跟着磁盘走：把改过的产物同步回面板、jsx 重编译、注册表基线刷新。
 * "产物存储单一写入方"这条不变量改由对账保证，不再靠拦——拦只会把模型逼去更怪的绕路。
 *
 * 只看两件事都成立的文件：① 这条工具调用期间改过（mtime ≥ 开跑时刻）；② 内容异于注册表里
 * Agent 上一次写出的快照。① 让用户在 UI 里的直改（另有 diff 证据链）不被这里抹掉，
 * ② 让渲染端收到产物事件后的回写（同内容再落一次盘）不会被下一条命令误报成"又改了"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getArtifactStore } from './artifact-registry'
import {
  coarseTypeFromFile,
  isCompilableJsx,
  listConversationArtifacts,
  writeCompiledSidecar,
  type ArtifactData
} from './artifact-store'

export interface ReconciledArtifact {
  artifact: ArtifactData
  recompiled: boolean
  compileError?: string
}

/** 走这些通道才可能直写 sidecar；artifact 三工具自己经产物库写，不在此列 */
export const SIDECAR_WRITE_CHANNELS: ReadonlySet<string> = new Set(['write', 'edit', 'bash', 'powershell', 'execute_code'])

/** 1 秒 mtime 分辨率的文件系统（HFS+/exFAT）会把开跑后几百毫秒的写入记成开跑前，留一秒余量 */
const MTIME_SLACK_MS = 1000

export function reconcileArtifactSidecarWrites(conversationId: string | undefined, sinceMs: number): ReconciledArtifact[] {
  if (!conversationId) return []
  const store = getArtifactStore()
  const out: ReconciledArtifact[] = []
  for (const entry of listConversationArtifacts(conversationId)) {
    if (!entry.mtimeMs || entry.mtimeMs < sinceMs - MTIME_SLACK_MS) continue
    let content: string
    try { content = fs.readFileSync(entry.file, 'utf8') } catch { continue }
    const record = store.getRecord(entry.id)
    if (record?.lastAgentContent !== undefined && record.lastAgentContent === content) continue
    const type = record?.type || coarseTypeFromFile(entry.file)
    const language = record?.language || (entry.file.endsWith('.jsx') ? 'jsx' : undefined)
    const artifact: ArtifactData = {
      id: entry.id,
      type,
      title: record?.title || entry.title || entry.id,
      content,
      ...(language ? { language } : {})
    }
    let recompiled = false
    let compileError: string | undefined
    if (isCompilableJsx(type, language)) {
      const err = writeCompiledSidecar(path.dirname(entry.file), entry.id, content)
      recompiled = !err
      compileError = err || undefined
    }
    if (record) store.touch(record, entry.mtimeMs, content)
    out.push({ artifact, recompiled, ...(compileError ? { compileError } : {}) })
  }
  return out
}

/** 回给模型的一句话：事实（同步到哪、编译成没成），不是训诫 */
export function formatReconciledForModel(items: ReconciledArtifact[]): string {
  return items.map(({ artifact, recompiled, compileError }) => {
    const compile = compileError ? `；jsx 重编译失败：${compileError}` : recompiled ? '；jsx 已重编译' : ''
    return `产物 ${artifact.id}（${artifact.title}）已按磁盘内容同步到产物面板${compile}`
  }).join('\n')
}
