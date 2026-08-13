import { useEffect, useRef, useState } from 'react'
import { RefreshCw, ExternalLink, ArrowLeft, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface PreviewTabProps {
  url?: string
  srcdoc?: string
  title?: string
}

/**
 * 通用预览 tab。
 *
 * 双轨渲染：
 *   - url（外部网页）→ Electron <webview>。独立 Chromium 进程，绕开 iframe 受
 *     X-Frame-Options 限制，支持 YouTube/B站/X 等反内嵌站点。
 *   - srcdoc（直接喂 HTML 字符串）→ 仍用 iframe + srcDoc。AI 自家产生的轻量
 *     内容用 iframe 沙盒更合适，不需要 webview 的重武器。sandbox 绝不能加
 *     allow-same-origin：srcdoc 帧加了它就与宿主同源，帧内脚本可经 parent
 *     摸到 preload 暴露的 window.api。
 *
 * webview 共享 partition='persist:openpipal-browser' → 多个 tab 共用 cookie/登录态。
 * 多 tab 并存时，每个实例独立挂载，display 切换不卸载保留状态。
 */
export function PreviewTab({ url, srcdoc, title }: PreviewTabProps) {
  const { t } = useTranslation()
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [currentUrl, setCurrentUrl] = useState(url)
  const webviewRef = useRef<any>(null)

  const isWebView = !!url && !srcdoc

  useEffect(() => {
    if (!isWebView) return
    const wv = webviewRef.current
    if (!wv) return

    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      try {
        setCanBack(wv.canGoBack?.() ?? false)
        setCanForward(wv.canGoForward?.() ?? false)
        setCurrentUrl(wv.getURL?.() || url)
      } catch { /* ignore */ }
    }
    const onFail = (e: any): void => {
      setLoading(false)
      // -3 = ABORTED（用户取消导航），不算真错误
      if (e?.errorCode !== -3) console.warn('[PreviewTab] webview 加载失败:', e?.errorCode, e?.errorDescription)
    }

    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [isWebView, reloadKey, url])

  const handleReload = (): void => {
    if (isWebView && webviewRef.current?.reload) webviewRef.current.reload()
    else setReloadKey(k => k + 1)
  }
  const handleBack = (): void => { if (canBack) webviewRef.current?.goBack?.() }
  const handleForward = (): void => { if (canForward) webviewRef.current?.goForward?.() }
  const handleOpen = (): void => {
    const target = currentUrl || url
    if (target) (window as any).api?.openFile?.(target)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-surface-100 bg-surface-0 dark:bg-surface-50">
        {isWebView && (
          <>
            <button onClick={handleBack} disabled={!canBack} className="h-6 w-6 flex items-center justify-center rounded text-surface-500 hover:bg-surface-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent" title={t('shell.workspace.preview.back')}>
              <ArrowLeft size={12} />
            </button>
            <button onClick={handleForward} disabled={!canForward} className="h-6 w-6 flex items-center justify-center rounded text-surface-500 hover:bg-surface-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent" title={t('shell.workspace.preview.forward')}>
              <ArrowRight size={12} />
            </button>
          </>
        )}
        <span className="text-xs text-surface-600 truncate flex-1 px-1" title={currentUrl || title}>
          {loading ? t('shell.workspace.preview.loading') : (title || currentUrl || `(${t('shell.workspace.preview.fallback')})`)}
        </span>
        <button onClick={handleReload} className="h-6 px-1.5 rounded flex items-center gap-1 text-[11px] text-surface-500 hover:bg-surface-100" title={t('shell.workspace.preview.reload')}>
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
        {(currentUrl || url) && (
          <button onClick={handleOpen} className="h-6 px-1.5 rounded flex items-center gap-1 text-[11px] text-surface-500 hover:bg-surface-100" title={t('shell.workspace.preview.openExternal')}>
            <ExternalLink size={11} />
          </button>
        )}
      </div>
      {isWebView ? (
        <webview
          ref={webviewRef}
          key={reloadKey}
          src={url}
          partition="persist:openpipal-browser"
          className="flex-1 w-full bg-surface-0"
          style={{ display: 'flex' }}
          {...({ allowpopups: 'true' } as any)}
        />
      ) : (
        <iframe
          key={reloadKey}
          src={url}
          srcDoc={srcdoc}
          className="flex-1 w-full border-0 bg-surface-0"
          title={title || t('shell.workspace.preview.fallback')}
          sandbox="allow-scripts allow-forms"
        />
      )}
    </div>
  )
}
