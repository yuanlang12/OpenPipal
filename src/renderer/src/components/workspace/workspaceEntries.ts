import type { Artifact } from '../../stores/artifactStore'
import type { ChatMessage } from '../../types'
import type { TFunction } from 'i18next'

type LocalizedWorkspaceLabel = {
  labelKey?: string
  labelParams?: Record<string, string | number>
}

export type ConversationSourceEntry = LocalizedWorkspaceLabel & {
  id: string
  kind: 'file' | 'image' | 'url'
  name: string
  timestamp: number
  path?: string
  url?: string
  /** 会话 artifacts 目录下的相对上传路径（如 uploads/pasted-*.png） */
  imagePath?: string
  /** 旧消息/落盘失败时的内联兜底；常规路径优先按 imagePath 懒读取 */
  imageData?: string
}

export type ConversationOutputEntry =
  | (LocalizedWorkspaceLabel & {
      id: string
      kind: 'artifact'
      title: string
      type: string
      timestamp: number
      artifactId: string
    })
  | (LocalizedWorkspaceLabel & {
      id: string
      kind: 'file'
      title: string
      type: string
      timestamp: number
      filePath: string
    })

const EPHEMERAL_ARTIFACT_TYPES = new Set(['todos', 'questions', 'goal', 'mcp-app'])

type AttachmentLike = {
  path?: unknown
  url?: unknown
  fileName?: unknown
  name?: unknown
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value
}

function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function outputKey(title: string): string {
  return basename(title)
    .replace(/^\d{4}-\d{2}-\d{2}[_-]/, '')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

/**
 * 会话来源只认用户明确提供的材料：上传文件、拖放/粘贴图片，以及旧版消息里的链接附件。
 * Agent 截图、工具读写、技能和历史产物不算输入来源，避免把过程痕迹误当成用户材料。
 */
export function collectConversationSources(messages: ChatMessage[]): ConversationSourceEntry[] {
  const seen = new Set<string>()
  const entries: ConversationSourceEntry[] = []
  let imageIndex = 0

  for (const message of messages) {
    if (message.role !== 'user' || message.messageKind === 'task-trigger') continue
    const timestamp = message.timestamp || 0
    const legacyMessage = message as ChatMessage & { attachments?: AttachmentLike[] }
    const attachments: AttachmentLike[] | undefined = message.fileAttachments || legacyMessage.attachments

    if (Array.isArray(attachments)) {
      for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
        const attachment = attachments[attachmentIndex]
        const path = typeof attachment?.path === 'string' ? attachment.path : undefined
        const url = typeof attachment?.url === 'string' ? attachment.url : undefined
        const name = String(attachment?.fileName || attachment?.name || basename(path || url || ''))
        const key = `attachment:${path || url || `${message.id}:${attachmentIndex}`}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({
          id: key,
          kind: url && !path ? 'url' : 'file',
          name,
          ...(!name ? { labelKey: 'shell.workspace.fallback.untitledFile' } : {}),
          timestamp,
          path,
          url
        })
      }
    }

    const paths = Array.isArray(message.imagePaths) ? message.imagePaths : []
    const images = Array.isArray(message.images) ? message.images : []
    const imageCount = Math.max(paths.length, images.length)
    for (let i = 0; i < imageCount; i++) {
      const imagePath = paths[i]
      const imageData = images[i]
      if (!imagePath && !imageData) continue
      imageIndex += 1
      const key = `image:${imagePath || imageData}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        id: key,
        kind: 'image',
        name: '',
        labelKey: 'shell.workspace.fallback.image',
        labelParams: { count: imageIndex },
        timestamp,
        imagePath,
        imageData
      })
    }
  }

  return entries
}

/**
 * 会话输出统一入口：
 * - 优先展示可回看/迭代的持久 artifact；
 * - 补上 generate_document / export_artifact 记录的交付文件；
 * - 过程型 artifact（问卷、待办等）不进入输出。
 */
export function collectConversationOutputs(
  artifacts: Artifact[],
  messages: ChatMessage[]
): ConversationOutputEntry[] {
  const entries: ConversationOutputEntry[] = []
  const representedTitles = new Set<string>()
  const representedPaths = new Set<string>()

  for (const artifact of artifacts) {
    if (EPHEMERAL_ARTIFACT_TYPES.has(artifact.type)) continue
    const title = artifact.title || ''
    representedTitles.add(outputKey(title))
    entries.push({
      id: `artifact:${artifact.id}`,
      kind: 'artifact',
      title,
      ...(!title ? { labelKey: 'shell.workspace.fallback.untitledArtifact' } : {}),
      type: artifact.type,
      timestamp: artifact.createdAt || 0,
      artifactId: artifact.id
    })
  }

  for (const message of messages) {
    if (message.role !== 'tool') continue
    if (message.toolName !== 'generate_document' && message.toolName !== 'export_artifact') continue
    const args = parseArgs(message.toolArgs)
    const filePath = typeof args?.filePath === 'string' ? args.filePath : undefined
    if (!filePath || representedPaths.has(filePath)) continue
    const title = typeof args?.fileName === 'string'
      ? args.fileName
      : typeof args?.title === 'string'
        ? args.title
        : basename(filePath)
    // generate_document 的 markdown 文件已经有同名 artifact 时，只保留可编辑的 artifact。
    // 导出的 PDF/PPTX/zip 即使源 artifact 同名，也是另一份用户可带走的交付物，必须保留。
    if (message.toolName === 'generate_document' && representedTitles.has(outputKey(title))) continue
    representedPaths.add(filePath)
    entries.push({
      id: `file:${filePath}`,
      kind: 'file',
      title,
      type: typeof args?.fileType === 'string'
        ? args.fileType
        : (filePath.split('.').pop() || 'file'),
      timestamp: message.timestamp || 0,
      filePath
    })
  }

  return entries.sort((a, b) => b.timestamp - a.timestamp)
}

/** Resolve only OpenPipal-owned fallbacks; user, Agent, file, and artifact titles remain byte-for-byte unchanged. */
export function resolveWorkspaceEntryLabel(
  entry: Pick<LocalizedWorkspaceLabel, 'labelKey' | 'labelParams'> & { name?: string; title?: string },
  t: TFunction
): string {
  const raw = entry.name ?? entry.title ?? ''
  return raw || (entry.labelKey ? t(entry.labelKey, entry.labelParams) : '')
}
