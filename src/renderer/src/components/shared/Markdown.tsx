import { lazy, Suspense, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { COMPONENTS, BASE_REMARK_PLUGINS, BASE_REHYPE_PLUGINS } from './markdown-shared'

// KaTeX 按需加载:大多数消息不含数学公式，无需为它们承担 remark-math/rehype-katex 的解析成本
const MathMarkdown = lazy(() =>
  import('./MathMarkdown').then((m) => ({ default: m.MathMarkdown }))
)

// 宽松检测数学语法:宁可误判为有数学(多加载一次 KaTeX)也不能漏判(数学显示为原始 $...$)
const MATH_PATTERN = /\$[^$\s]|\\\(|\\\[|\$\$/

interface MarkdownProps {
  content: string
}

export function Markdown({ content }: MarkdownProps) {
  const hasMath = useMemo(() => MATH_PATTERN.test(content), [content])

  // fallback 用无数学插件的普通渲染，避免 KaTeX chunk 加载期间内容空白
  const fallback = (
    <ReactMarkdown
      remarkPlugins={BASE_REMARK_PLUGINS}
      rehypePlugins={BASE_REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )

  if (hasMath) {
    return (
      <Suspense fallback={fallback}>
        <MathMarkdown content={content} />
      </Suspense>
    )
  }

  return fallback
}
