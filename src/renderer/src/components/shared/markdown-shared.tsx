import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import remarkGfm from 'remark-gfm'
import { handleLinkClick } from '../../utils/openInWorkspace'

// MermaidBlock 懒加载:React.lazy 要求 default export,MermaidBlock 是具名导出,这里做一层适配
const LazyMermaidBlock = lazy(() =>
  import('../MermaidBlock').then((m) => ({ default: m.MermaidBlock }))
)

// 懒加载骨架:与 MermaidBlock 渲染完成后的容器视觉一致,避免懒加载瞬间的布局跳动
function MermaidSkeleton() {
  return (
    <div className="my-2 rounded-lg border border-surface-200 p-3 bg-white dark:bg-surface-0 h-20 animate-pulse" />
  )
}

function MarkdownLink({ href, children, title, ...props }: any) {
  const { t } = useTranslation()
  // Markdown 作者显式提供的 title 属于内容；仅在缺省时补 OpenPipal 的操作提示。
  return (
    <a
      href={href}
      onClick={(e) => href && handleLinkClick(e, href)}
      className="text-brand-600 dark:text-brand-400 hover:underline cursor-pointer"
      title={title || t('chat.markdown.linkTitle')}
      {...props}
    >
      {children}
    </a>
  )
}

// 模块级常量:Markdown 与 MathMarkdown 共用的 components 映射,避免两处维护同一份 code/a 渲染逻辑而漂移
export const COMPONENTS = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    if (match?.[1] === 'mermaid') {
      return (
        <Suspense fallback={<MermaidSkeleton />}>
          <LazyMermaidBlock code={String(children).replace(/\n$/, '')} />
        </Suspense>
      )
    }
    return <code className={className} {...props}>{children}</code>
  },
  // 所有 link 默认在 workspace 预览，⌘/Ctrl+点击走系统浏览器
  a: MarkdownLink
}

// 模块级常量数组,刻意保持引用稳定(避免 ReactMarkdown 重挂载)——无数学语法场景的基础插件集
export const BASE_REMARK_PLUGINS = [remarkGfm]
export const BASE_REHYPE_PLUGINS: never[] = []
