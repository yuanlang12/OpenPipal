import { Wand2 } from 'lucide-react'

/**
 * 捏头像的轻量入口 —— 悬停才出现的小圆钮，贴在头像右上角。
 *
 * 刻意做成绝对定位的独立 <button>：宿主那个"选角色/开对话"本身就是按钮，
 * 按钮不能套按钮，套了会让整块变成一个不可预测的点击区。
 * 父级需要带 `group relative`。
 */
export function MarkStudioAffordance({
  label, onClick, size = 20,
}: {
  label: string
  onClick: () => void
  size?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ width: size, height: size }}
      className="absolute -right-1 -top-1 grid place-items-center rounded-full border border-surface-100
        bg-surface-0 text-surface-400 opacity-0 shadow-sm transition-opacity
        group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      <Wand2 size={Math.round(size * 0.55)} />
    </button>
  )
}
