import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import mermaid from 'mermaid'

let counter = 0
let initialized = false

function ensureMermaidInit() {
  if (initialized) return
  const isDark = document.documentElement.classList.contains('dark')
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    fontFamily: '"SF Pro Text", "PingFang SC", -apple-system, sans-serif',
    securityLevel: 'strict'
  })
  initialized = true
}

interface MermaidBlockProps {
  code: string
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<{ detail: string | null } | null>(null)
  const idRef = useRef(`mermaid-${counter++}`)
  const isFirstRenderRef = useRef(true)

  useEffect(() => {
    ensureMermaidInit()
    let cancelled = false

    async function render() {
      try {
        const { svg } = await mermaid.render(idRef.current, code)
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError({ detail: e instanceof Error ? e.message : null })
          const errNode = document.getElementById('d' + idRef.current)
          errNode?.remove()
        }
      }
    }

    // 挂载时立即渲染一次(历史消息零延迟);此后每次 code 变化(流式 token 到达)防抖 300ms 再渲染，
    // 避免代码围栏未闭合期间每个 token 都触发一次必然失败的 mermaid.render()
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      render()
      return () => { cancelled = true }
    }

    const timer = setTimeout(render, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code])

  if (error) {
    return (
      <div className="my-2 rounded-lg border border-red-200 dark:border-red-800 overflow-hidden">
        <div className="px-3 py-1.5 bg-red-50 dark:bg-red-900/30 text-[11px] text-red-600 dark:text-red-400">
          {t('chat.mermaid.errorTitle')}: {error.detail || t('chat.mermaid.renderFailed')}
        </div>
        <pre className="px-3 py-2 text-[12px] bg-surface-50 text-surface-600 overflow-x-auto">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="my-2 rounded-lg border border-surface-200 p-3 overflow-x-auto bg-white dark:bg-surface-0 [&>svg]:mx-auto"
    />
  )
}
