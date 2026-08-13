import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

export function resolvePresenterDisplayTitle(title: string | undefined, t: TFunction): string {
  return title?.trim() ? title : t('artifacts.presenter.defaultTitle')
}

/**
 * PresenterView — 独立 Presenter 窗口的根视图
 *
 * 加载触发：main.tsx 检测到 URL ?view=presenter 后渲染本组件
 * 内容来源：main 进程 `presenter:set-content` IPC 推送 { html, title }
 * 窗口 chrome：frameless + transparent（main/presenter-window.ts 配置），这里渲染圆角容器 + 标题栏 + 关闭按钮
 * 内容隔离：AI 生成的 HTML 放入 iframe srcdoc，交互完整（JS/CSS/canvas 全部可用）但不污染主 DOM
 */
export function PresenterView() {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string>('')
  const [rawTitle, setRawTitle] = useState<string | undefined>(undefined)
  const displayTitle = resolvePresenterDisplayTitle(rawTitle, t)

  useEffect(() => {
    // 监听 main 推来的内容更新（首次加载 + 后续替换共用同一通道）
    const handler = (_e: any, payload: { html: string; title?: string }) => {
      setHtml(payload.html)
      // 每次都替换原始标题；省略标题时不能沿用上一份内容的动态标题。
      setRawTitle(payload.title)
    }
    const ipc = (window as any).electron?.ipcRenderer
    if (ipc) {
      ipc.on('presenter:set-content', handler)
      // 先注册内容监听器，再通知 main；避免首次 payload 在监听器就绪前丢失。
      ipc.send('presenter:ready')
      return () => ipc.removeListener('presenter:set-content', handler)
    }
    return
  }, [])

  const handleClose = () => {
    const ipc = (window as any).electron?.ipcRenderer
    ipc?.send('presenter:close')
  }

  // Esc 快捷键关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="h-screen w-screen flex flex-col bg-white rounded-xl overflow-hidden
                 shadow-2xl border border-stone-200"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {/* 标题栏（可拖动）+ 关闭按钮 */}
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-stone-100 bg-stone-50">
        <span className="min-w-0 truncate text-[13px] font-medium text-stone-700">{displayTitle}</span>
        <button
          onClick={handleClose}
          className="shrink-0 p-1 rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-200 transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as any}
          title={t('artifacts.presenter.closeWithEscape')}
          aria-label={t('artifacts.presenter.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 内容区 — iframe srcdoc 隔离 AI 生成的 HTML。
          sandbox 绝不能加 allow-same-origin：srcdoc 帧加了它就与宿主同源，
          帧内脚本可经 parent 摸到 preload 暴露的 window.api（与 HtmlPreview 同一纪律）。*/}
      <div className="flex-1 min-h-0 bg-white" style={{ WebkitAppRegion: 'no-drag' } as any}>
        {html ? (
          <iframe
            srcDoc={html}
            className="w-full h-full border-0"
            sandbox="allow-scripts"
            title={displayTitle}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-stone-400 text-sm">
            {t('artifacts.presenter.waiting')}
          </div>
        )}
      </div>
    </div>
  )
}
