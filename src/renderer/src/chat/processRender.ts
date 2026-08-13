/**
 * ProcessGroup 展开态的渲染项构建——连续的同文件 edit/write 折叠成一个"文件 ×N"组
 * （对标官方 Claude Design 的文件芯片聚合）。纯函数，单测锁行为。
 */
import { ChatMessage } from '../types'
import { getMessageKind, toolArgsFilePath } from './messages'
import { describeFilePath, FileDisplayInfo } from './fileDisplay'

export type ProcessRenderItem =
  | { kind: 'single'; m: ChatMessage }
  | { kind: 'file-group'; path: string; items: ChatMessage[] }
  | { kind: 'archive-group'; info: FileDisplayInfo; items: ChatMessage[] }

/** edit/write 工具消息的目标文件路径（三键兼容收口在 toolArgsFilePath），其余消息 null */
export function fileEditPath(m: ChatMessage): string | null {
  if (getMessageKind(m) !== 'tool') return null
  if (m.toolName !== 'edit' && m.toolName !== 'write') return null
  return toolArgsFilePath(m.toolArgs)
}

/** 长期档案（教学风格/记忆）的读取——返回面向用户的说法，其余 null */
export function archiveReadInfo(m: ChatMessage): FileDisplayInfo | null {
  if (getMessageKind(m) !== 'tool' || m.toolName !== 'read') return null
  return describeFilePath(toolArgsFilePath(m.toolArgs))
}

export function buildProcessRenderItems(messages: ChatMessage[]): ProcessRenderItem[] {
  const items: ProcessRenderItem[] = []
  for (const m of messages) {
    const archive = archiveReadInfo(m)
    if (archive) {
      // 档案读取按文件夹归并，且**不要求相邻**——模型常在两次档案读取之间插一次别的读取，
      // 老师关心的是"它翻了我的教学风格"这一件事，不是它翻的先后次序
      const existing = items.find(
        it => it.kind === 'archive-group' && it.info.groupKey === archive.groupKey
      ) as Extract<ProcessRenderItem, { kind: 'archive-group' }> | undefined
      if (existing) { existing.items.push(m); continue }
      items.push({ kind: 'archive-group', info: archive, items: [m] })
      continue
    }

    const p = fileEditPath(m)
    const last = items[items.length - 1]
    if (p && last?.kind === 'file-group' && last.path === p) {
      last.items.push(m)
      continue
    }
    items.push(p ? { kind: 'file-group', path: p, items: [m] } : { kind: 'single', m })
  }
  return items
}
