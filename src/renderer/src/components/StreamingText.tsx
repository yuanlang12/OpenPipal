import { Markdown } from './shared/Markdown'

interface StreamingTextProps {
  content: string
}

export function StreamingText({ content }: StreamingTextProps) {
  return (
    <div className="prose-light sw-chat-prose">
      <Markdown content={content} />
      <span className="inline-block w-[3px] h-[1em] bg-brand-500 animate-pulse-soft ml-0.5 rounded-[1px] align-text-bottom" />
    </div>
  )
}
