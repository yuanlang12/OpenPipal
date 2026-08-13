import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { COMPONENTS } from './markdown-shared'

// 模块级常量，避免每次渲染创建新数组 —— 仅在检测到数学语法时才会被懒加载并组装
const MATH_REMARK_PLUGINS = [remarkMath, remarkGfm]
const MATH_REHYPE_PLUGINS = [rehypeKatex]

interface MathMarkdownProps {
  content: string
}

export function MathMarkdown({ content }: MathMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={MATH_REMARK_PLUGINS}
      rehypePlugins={MATH_REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )
}
