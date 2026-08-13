import { DcPropMeta } from './dcRuntime'

interface DcTweaksPanelProps {
  meta: Record<string, DcPropMeta>
  values: Record<string, any>
  onChange: (key: string, value: any) => void
}

/**
 * dc artifact 的类型化参数条 —— 消费 __dc_booted 上报的 propsMeta，按 editor 类型渲染控件；
 * 改动经父组件 postMessage 写回运行时 + 持久化。
 * 形态：画布工具栏下方的停靠横条（对齐官方 Claude Design），有参数时默认展开、Tweaks 按钮收起。
 */
export function DcTweaksPanel({ meta, values, onChange }: DcTweaksPanelProps) {
  const inputCls =
    'h-6 px-1.5 rounded border border-surface-200 bg-white dark:bg-surface-0 text-[11px] text-surface-700'

  const current = (key: string, m: DcPropMeta): any => (key in values ? values[key] : m.default)

  return (
    <div
      data-testid="dc-tweaks-panel"
      className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5 border-b border-surface-100 bg-surface-50/80 max-h-24 overflow-y-auto"
    >
      {Object.entries(meta).map(([key, m]) => {
        const val = current(key, m)
        return (
          <label key={key} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[10px] font-medium text-surface-500">{key}</span>
            {m.editor === 'enum' && (
              <select
                data-testid={`dc-tweak-${key}`}
                className={inputCls}
                value={val ?? ''}
                onChange={(e) => onChange(key, e.target.value)}
              >
                {(m.options || []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            )}
            {m.editor === 'boolean' && (
              <input
                data-testid={`dc-tweak-${key}`}
                type="checkbox"
                className="sw-checkbox"
                checked={!!val}
                onChange={(e) => onChange(key, e.target.checked)}
              />
            )}
            {m.editor === 'color' && (
              <span className="flex items-center gap-1">
                <input
                  data-testid={`dc-tweak-${key}`}
                  type="color"
                  className="h-6 w-8 p-0 border border-surface-200 rounded cursor-pointer bg-transparent"
                  value={typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val) ? val : '#000000'}
                  onChange={(e) => onChange(key, e.target.value)}
                />
                <span className="text-[10px] text-surface-400 font-mono">{val ?? ''}</span>
              </span>
            )}
            {(m.editor === 'int' || m.editor === 'float') && (
              <input
                data-testid={`dc-tweak-${key}`}
                type="number"
                className={`${inputCls} w-16`}
                value={val ?? ''}
                min={m.min}
                max={m.max}
                step={m.step ?? (m.editor === 'int' ? 1 : 'any')}
                onChange={(e) => {
                  const n = m.editor === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
                  if (!Number.isNaN(n)) onChange(key, n)
                }}
              />
            )}
            {m.editor === 'text' && (
              <input
                data-testid={`dc-tweak-${key}`}
                type="text"
                className={`${inputCls} w-28`}
                value={val ?? ''}
                onChange={(e) => onChange(key, e.target.value)}
              />
            )}
          </label>
        )
      })}
    </div>
  )
}
