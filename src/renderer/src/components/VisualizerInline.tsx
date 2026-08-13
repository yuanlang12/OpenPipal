import { useEffect, useRef, useState } from 'react'
import { useVisualizerStore, Visualizer } from '../stores/visualizerStore'

interface VisualizerInlineProps {
  messageId: string
  fallbackContent?: string  // 从消息持久化字段读取，store 无数据时（重载）使用
}

function sanitizeHtml(content: string): string {
  // 使用 DOMParser 进行安全的 HTML 过滤
  const parser = new DOMParser()
  const doc = parser.parseFromString(content, 'text/html')

  // 移除 script 标签
  const scripts = doc.querySelectorAll('script')
  scripts.forEach(el => el.remove())

  // 移除事件处理器 (on* 属性)
  const allElements = doc.querySelectorAll('*')
  allElements.forEach(el => {
    const attrs = Array.from(el.attributes)
    attrs.forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name)
      }
    })
  })

  // 移除危险标签
  const dangerousTags = ['iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select']
  dangerousTags.forEach(tag => {
    const elements = doc.querySelectorAll(tag)
    elements.forEach(el => {
      // 用 div 替换危险标签，保留内容
      const div = doc.createElement('div')
      div.innerHTML = el.innerHTML
      el.replaceWith(div)
    })
  })

  return doc.body.innerHTML
}

function injectThemeStyles(shadow: ShadowRoot, isDark: boolean) {
  // 注入基础样式和 CSS 变量
  const style = document.createElement('style')
  style.textContent = `
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    /* CSS Variables for theming */
    :host {
      --bg-primary: ${isDark ? '#1a1a1a' : '#ffffff'};
      --bg-secondary: ${isDark ? '#252525' : '#f5f5f5'};
      --text-primary: ${isDark ? '#e0e0e0' : '#1a1a1a'};
      --text-secondary: ${isDark ? '#888888' : '#666666'};
      --border-color: ${isDark ? '#333333' : '#e0e0e0'};
      --accent-color: #4a90e2;
    }
  `
  shadow.appendChild(style)
}

function VisualizerContent({ content, isDark }: { content: string; isDark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || !content) return

    const container = containerRef.current

    // 清理旧的 shadow root
    if (container.shadowRoot) {
      container.innerHTML = ''
    }

    // 创建新的 shadow root
    const shadow = container.attachShadow({ mode: 'open' })

    // 注入主题样式
    injectThemeStyles(shadow, isDark)

    // 创建内容容器
    const contentDiv = document.createElement('div')
    contentDiv.style.cssText = `
      width: 100%;
      background: var(--bg-primary);
      color: var(--text-primary);
    `

    // 注入 sanitized 内容
    const sanitized = sanitizeHtml(content)
    contentDiv.innerHTML = sanitized

    shadow.appendChild(contentDiv)

    return () => {
      container.innerHTML = ''
    }
  }, [content, isDark])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%' }}
    />
  )
}

export function VisualizerInline({ messageId, fallbackContent }: VisualizerInlineProps) {
  const visualizer = useVisualizerStore((s) => s.getVisualizer(messageId))
  const isDark = document.documentElement.classList.contains('dark')
  const content = visualizer?.content || fallbackContent

  if (!content) return null

  return (
    <div className="my-3 rounded-lg overflow-hidden">
      <VisualizerContent content={content} isDark={isDark} />
    </div>
  )
}

/**
 * Shimmer loading 效果组件 - 独立的扫光层实现
 * 使用一个绝对定位的扫光层从左到右移动，效果更明显可靠
 */
function ShimmerLoader({ height = 300, isDark }: { height?: number; isDark: boolean }) {
  // 骨架背景色 - 增加对比度
  const baseBg = isDark
    ? 'bg-surface-700'
    : 'bg-surface-200'

  // 占位线条颜色 - 加深对比度
  const placeholderColor = isDark
    ? 'bg-surface-600'
    : 'bg-surface-300'

  // 扫光层背景 - 更大对比度，更明显
  const shimmerBg = isDark
    ? 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 30%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0.15) 70%, transparent 100%)'
    : 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.6) 30%, rgba(255,255,255,1) 50%, rgba(255,255,255,0.6) 70%, transparent 100%)'

  return (
    <div
      className={`w-full relative overflow-hidden rounded ${baseBg}`}
      style={{ height: `${height}px` }}
    >
      {/* 扫光层 - 独立的动画层，宽度更大 */}
      <div
        className="absolute top-0 bottom-0 w-1/2"
        style={{
          background: shimmerBg,
          animation: 'shimmer-slide 1.8s ease-in-out infinite',
          left: '-50%',
        }}
      />

      {/* 占位线条 - 模拟内容结构，让骨架更真实 */}
      <div className="absolute inset-0 p-4 space-y-3">
        <div className={`h-4 ${placeholderColor} rounded w-3/4`} />
        <div className={`h-4 ${placeholderColor} rounded w-1/2`} />
        <div className={`h-4 ${placeholderColor} rounded w-5/6`} />
        <div className={`h-20 ${placeholderColor} rounded w-full mt-4`} />
      </div>
    </div>
  )
}

