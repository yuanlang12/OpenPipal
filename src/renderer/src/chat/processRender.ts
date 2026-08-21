/**
 * ProcessGroup 展开态的渲染项构建——连续的同文件 edit/write 折叠成一个"文件 ×N"组
 * （对标官方 Claude Design 的文件芯片聚合）。纯函数，单测锁行为。
 */
import { ChatMessage } from '../types'
import { getMessageKind, toolArgsFilePath } from './messages'
import { describeFilePath, FileDisplayInfo } from './fileDisplay'

export type ProcessRenderItem =
  | { kind: 'single'; m: ChatMessage }
  | { kind: 'think-group'; items: ChatMessage[] }
  | { kind: 'file-group'; path: string; items: ChatMessage[] }
  | { kind: 'archive-group'; info: FileDisplayInfo; items: ChatMessage[] }
  | { kind: 'explore-group'; files: number; searches: number; items: ChatMessage[] }

/**
 * 「探索」类步骤——翻文件、找文件、搜网页。它们是**过程里最碎的一类**:一轮里读七八个
 * 文件是常态,逐条铺开会把过程栏撑成流水账,而用户真正关心的只是"它翻了几个文件、搜了几次"。
 * 连续的探索步骤因此并成一行(对标官方的「探索 · 1 搜索, 2 文件」),点开才看逐条。
 * 只并**相邻**的:中间插了编辑/执行就该断开,否则时间线会被抹平成假象。
 */
export function exploreKind(m: ChatMessage): 'file' | 'search' | null {
  if (getMessageKind(m) !== 'tool') return null
  switch (m.toolName) {
    case 'read': case 'ls': case 'find': case 'grep': return 'file'
    case 'web_search': case 'read_page_content': return 'search'
    default: return null
  }
}

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

    // 相邻的探索步骤并成一组（archive 读取在上面已经先被截走，不会进这里）。
    // last 一路用到本轮末尾:这里曾经有 prev / last 两个名字装同一个 items[items.length - 1],
    // 中间再插一个会 push 的分支就会有一个变陈旧,而两处读的都是"上一组"——很难看出来。
    const last = items[items.length - 1]
    const explore = exploreKind(m)
    if (explore) {
      if (last?.kind === 'explore-group') {
        last.items.push(m)
        if (explore === 'file') last.files += 1
        else last.searches += 1
        continue
      }
      items.push({
        kind: 'explore-group',
        files: explore === 'file' ? 1 : 0,
        searches: explore === 'search' ? 1 : 0,
        items: [m]
      })
      continue
    }

    const p = fileEditPath(m)
    if (p && last?.kind === 'file-group' && last.path === p) {
      last.items.push(m)
      continue
    }
    // 连续 thinking 合并成一组——思考内容默认折叠成一行,多段也不逐条占位
    if (getMessageKind(m) === 'thinking') {
      if (last?.kind === 'think-group') { last.items.push(m); continue }
      items.push({ kind: 'think-group', items: [m] })
      continue
    }
    items.push(p ? { kind: 'file-group', path: p, items: [m] } : { kind: 'single', m })
  }
  return items
}
