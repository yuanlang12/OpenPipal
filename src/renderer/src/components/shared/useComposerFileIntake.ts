import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useSourcesStore } from '../../stores/sourcesStore'
import type { SourceType } from '../../types'

/** Cave 模式可吃的 source-worthy 扩展名 —— 跟 SourcesPanel.inferSourceType 一致 */
const SOURCE_WORTHY_EXTS = new Set(['pdf', 'md', 'markdown', 'html', 'htm', 'txt', 'text'])

function getFileExt(filePath: string): string {
  const m = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function inferSourceTypeForInput(filePath: string): SourceType {
  switch (getFileExt(filePath)) {
    case 'pdf': return 'pdf'
    case 'md':
    case 'markdown': return 'md'
    case 'html':
    case 'htm': return 'html'
    case 'txt':
    case 'text': return 'txt'
    default: return 'other'
  }
}

function fileNameStem(filePath: string): string {
  const m = filePath.match(/([^/\\]+)$/)
  if (!m) return filePath
  const name = m[1]
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
}

export interface ComposerFileIntake {
  /** 处理单个本地文件路径（拖拽/粘贴/选择器都走这里） */
  handleFile: (filePath: string) => Promise<void>
  /** 打开系统文件选择器（支持多选） */
  handleFileUpload: () => Promise<void>
}

/**
 * 输入框的文件进料口 —— 欢迎页和对话页共用一份分流规则。
 *
 * 按文件类型自动分流：图片内联进 images；learner 的 study 布局 + source-worthy
 * 后缀进知识库 sources；其余上传到 workspace 挂成待发附件。两个输入框各写一份
 * 的话，分流规则一改就会两边不一致——用户看到的是"同一个上传在两页表现不同"。
 */
export function useComposerFileIntake(onImage: (base64: string) => void): ComposerFileIntake {
  const currentRole = useAppStore(s => s.currentRole)
  const addPendingFileAttachment = useChatStore(s => s.addPendingFileAttachment)

  // 图片文件 → base64 交回调用方（各自的 images state）
  const addImageFromPath = async (filePath: string): Promise<void> => {
    try {
      const resp = await fetch(`file://${filePath}`)
      const blob = await resp.blob()
      const reader = new FileReader()
      reader.onload = () => onImage((reader.result as string).split(',')[1])
      reader.readAsDataURL(blob)
    } catch {
      // fallback: 用 Electron 读文件
      const result = await (window.api as any).readFileBase64?.(filePath)
      if (result) onImage(result)
    }
  }

  // 非图片文件 → upload 到 workspace
  const addFileAttachment = async (filePath: string): Promise<void> => {
    if (!(window.api as any)?.uploadFile) return
    try {
      const uploaded = await (window.api as any).uploadFile(filePath)
      addPendingFileAttachment({
        fileName: uploaded.fileName,
        fileType: uploaded.fileName.split('.').pop() || '',
        sizeBytes: uploaded.sizeBytes,
        path: uploaded.path
      })
    } catch (err: any) {
      console.error('[FileUpload] 上传失败:', err.message)
    }
  }

  const handleFile = async (filePath: string): Promise<void> => {
    if (isImageFile(filePath)) {
      await addImageFromPath(filePath)
      return
    }
    // Cave 模式自动归类(C 路径)：知识库 source 而非单次 chat attachment
    const isStudy = currentRole?.layoutManifest?.preferredLayout === 'study'
    if (isStudy && SOURCE_WORTHY_EXTS.has(getFileExt(filePath))) {
      await useSourcesStore.getState().addOptimistic({
        title: fileNameStem(filePath),
        type: inferSourceTypeForInput(filePath),
        filePath
      })
      return
    }
    await addFileAttachment(filePath)
  }

  const handleFileUpload = async (): Promise<void> => {
    if (!window.api?.openFileDialog) return
    const filePaths = await window.api.openFileDialog()
    if (!filePaths) return
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths]
    for (const fp of paths) await handleFile(fp)
  }

  return { handleFile, handleFileUpload }
}
