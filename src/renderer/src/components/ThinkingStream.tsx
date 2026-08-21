import { useEffect, useRef } from 'react'

/** 距底多少像素以内仍算「贴着底」。
 *  不写 0:容器底部有 10px 的 mask 渐隐,行高取整也常差个一两像素,
 *  卡死在 0 会让自动贴底在流式中途莫名其妙失效。 */
const STICK_THRESHOLD_PX = 24

/**
 * 思考正文的限高滚动容器 —— 生成中自动贴底,用户一往上滑就停手。
 *
 * 为什么不是无脑 `scrollTop = scrollHeight`:
 *  1. **只在内容变长时贴底**。展开一段**已经想完**的思考时,人是要从头读的,
 *     一挂载就弹到最后一行等于把开头藏起来。所以拿长度增量当"还在生成"的判据 ——
 *     不需要额外传 live 标志,内容自己会说。
 *  2. **用户滑上去就交出控制权**。滚动一停在非底部,后续 chunk 就不再拽回去;
 *     滑回底部又自动接管。判据只有"离底够近"这一条,不记方向,所以拖滚动条、
 *     滚轮、触控板惯性、键盘翻页都是同一套行为。
 *
 * 两个调用点(过程栏的 ThinkGroup / 旧数据里 assistant 自带 thinking 的 MessageBubble)
 * 必须表现一致,所以收在这里而不是各写一遍。
 */
export function ThinkingStream({
  content,
  maxHeightClass = 'max-h-[240px]'
}: {
  content?: string
  maxHeightClass?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevLen = useRef(content?.length ?? 0)

  useEffect(() => {
    const el = ref.current
    const len = content?.length ?? 0
    const grew = len > prevLen.current
    prevLen.current = len
    if (!el || !grew || !stick.current) return
    // 即时跳而不是 smooth:流式每几十毫秒来一次,平滑动画只会永远追在内容后面
    el.scrollTop = el.scrollHeight
  }, [content])

  return (
    <div
      ref={ref}
      onScroll={() => {
        const el = ref.current
        if (!el) return
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
      }}
      data-testid="thinking-stream"
      className={`sw-chat-reasoning text-ink-tertiary whitespace-pre-wrap ${maxHeightClass} overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_10px,black_calc(100%-10px),transparent)]`}
    >
      {content}
    </div>
  )
}
