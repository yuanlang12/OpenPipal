import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ACCESSORIES, ACCESSORY_BY_ID, MARK_HUES, hueVar, type AccessoryId, type MarkHue } from './accessories'
import { AgentMark } from './AgentMark'
import type { MarkState } from './engine'

/**
 * 捏头像 —— 弹窗。
 *
 * 一条产品规则写进 UI 里：**眼睛不出现在选项里**。它是所有 Agent 共用的符号，
 * 用户能改的只有配饰和它自带的那点颜色。所以配饰格子里画的是**配饰本身**，
 * 不再画一遍 logo —— 选的是配饰，就该看清配饰。
 *
 * 落盘走 system-agents/<role>/mark.json（文件式 opt-in，同 layout.json），
 * 不给 agent.md 加任何 schema 字段。
 */

const PREVIEW_STATES: MarkState[] = ['idle', 'thinking', 'generating', 'done', 'error']

/** 只画配饰本身：挂到隐藏 <g> 上量一次 bbox，再据此定 viewBox，格子里就自动居中撑满。 */
function AccessoryGlyph({ id, hue, size }: { id: AccessoryId; hue: MarkHue; size: number }): React.JSX.Element {
  const acc = ACCESSORY_BY_ID.get(id)
  const groupRef = useRef<SVGGElement>(null)
  const [box, setBox] = useState('-32 -32 64 64')

  useLayoutEffect(() => {
    const g = groupRef.current
    if (!g) return
    try {
      const b = g.getBBox()
      if (!b.width || !b.height) return
      const span = Math.max(b.width, b.height) * 1.18
      setBox(`${b.x + b.width / 2 - span / 2} ${b.y + b.height / 2 - span / 2} ${span} ${span}`)
    } catch { /* 未挂载或不可见时 getBBox 会抛，保持默认框 */ }
  }, [id])

  if (!acc?.front && !acc?.behind) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 19 L19 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".45" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox={box} aria-hidden="true" style={{ color: hueVar(hue), overflow: 'visible' }}>
      <g ref={groupRef} dangerouslySetInnerHTML={{ __html: `${acc.behind ?? ''}${acc.front ?? ''}` }} />
    </svg>
  )
}

export interface AgentMarkStudioProps {
  /** 'role' = 内置六角色（id 是角色名）；'agent' = 用户自建 Agent（id 是 workspace uuid） */
  scope?: 'role' | 'agent'
  roleName: string
  displayName?: string
  initial?: { accessory?: AccessoryId; hue?: MarkHue }
  onClose: () => void
  onSaved?: (config: { accessory: AccessoryId; hue: MarkHue }) => void
}

export function AgentMarkStudio({
  scope = 'role', roleName, displayName, initial, onClose, onSaved,
}: AgentMarkStudioProps): React.JSX.Element {
  const { t } = useTranslation()
  const [accessory, setAccessory] = useState<AccessoryId>(initial?.accessory ?? 'none')
  const [hue, setHue] = useState<MarkHue>(initial?.hue ?? 'ink')
  const [state, setState] = useState<MarkState>('idle')
  const [saving, setSaving] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api?.saveMark?.(scope, roleName, { accessory, hue })
      onSaved?.({ accessory, hue })
      onClose()
    } finally { setSaving(false) }
  }

  /** 导出前把 CSS 变量解析成字面色 —— 导出的文件要能脱离 App 打开 */
  const serialized = (): string | null => {
    const svg = previewRef.current?.querySelector('svg')
    if (!svg) return null
    const cs = getComputedStyle(document.body)
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('width', '512')
    clone.setAttribute('height', '512')
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.querySelectorAll('*').forEach((el) => {
      for (const attr of ['fill', 'stroke']) {
        const v = el.getAttribute(attr)
        if (v?.includes('var(')) {
          el.setAttribute(attr, v.replace(/var\((--[\w-]+)\)/g, (_, n) => cs.getPropertyValue(n).trim() || '#000'))
        }
      }
      const color = (el as SVGElement).style?.color
      if (color?.includes('var(')) {
        ;(el as SVGElement).style.color = color.replace(/var\((--[\w-]+)\)/g, (_, n) => cs.getPropertyValue(n).trim() || '#000')
      }
    })
    return new XMLSerializer().serializeToString(clone)
  }

  const download = (href: string, name: string): void => {
    const a = document.createElement('a')
    a.href = href
    a.download = name
    a.click()
  }

  const exportSvg = (): void => {
    const svg = serialized()
    if (svg) download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, `${roleName}-mark.svg`)
  }

  const exportPng = (): void => {
    const svg = serialized()
    if (!svg) return
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 1024
      canvas.getContext('2d')?.drawImage(img, 0, 0, 1024, 1024)
      download(canvas.toDataURL('image/png'), `${roleName}-mark.png`)
    }
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-[720px] max-w-[94vw] max-h-[88vh] overflow-hidden rounded-2xl border border-surface-100 bg-surface-0 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('agentMark.title')}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-100">
          <div>
            <div className="text-[14px] font-semibold text-ink-primary">{t('agentMark.title')}</div>
            {displayName && <div className="text-[11.5px] text-surface-400">{displayName}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label={t('agentMark.actions.cancel')}
            className="p-1.5 rounded-md text-surface-400 hover:text-ink-primary hover:bg-surface-50">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex gap-6">
          {/* 主视图 —— 选完在这儿看效果 */}
          <div className="shrink-0 w-[210px] flex flex-col items-center gap-4">
            {/* 盒子留足余量：配饰和执行态彩环都画在瓷砖外沿，mark 本体只占盒子的六成 */}
            <div ref={previewRef} className="w-[200px] h-[190px] grid place-items-center">
              <AgentMark state={state} accessory={accessory} hue={hue} size={118} animated
                ariaLabel={`${displayName ?? roleName} · ${t(`agentMark.state.${state}`)}`} />
            </div>
            <div className="grid grid-cols-3 gap-1.5 w-full">
              {PREVIEW_STATES.map((s) => (
                <button key={s} type="button" onClick={() => setState(s)}
                  className={`px-1.5 py-1 rounded-md text-[11px] border transition-colors ${
                    state === s ? 'bg-ink-primary text-surface-0 border-ink-primary'
                      : 'border-surface-100 text-surface-400 hover:text-ink-primary'}`}>
                  {t(`agentMark.state.${s}`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-surface-400 text-center">{t('agentMark.hint')}</p>
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-surface-400 mb-2.5">
              {t('agentMark.sections.accessory')}
            </h3>
            <div className="grid grid-cols-6 gap-1.5 mb-6">
              {ACCESSORIES.map((a) => (
                <button key={a.id} type="button" onClick={() => setAccessory(a.id)} title={t(`agentMark.accessory.${a.id}`)}
                  className={`aspect-square grid place-items-center rounded-lg border transition-colors ${
                    accessory === a.id ? 'border-ink-primary bg-surface-50'
                      : 'border-transparent hover:border-surface-100 hover:bg-surface-50'}`}>
                  <AccessoryGlyph id={a.id} hue={hue} size={34} />
                </button>
              ))}
            </div>

            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-surface-400 mb-2.5">
              {t('agentMark.sections.color')}
            </h3>
            <div className="flex flex-wrap gap-2.5">
              {MARK_HUES.map((h) => (
                <button key={h} type="button" onClick={() => setHue(h)} title={t(`agentMark.hue.${h}`)}
                  aria-label={t(`agentMark.hue.${h}`)}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    hue === h ? 'border-ink-primary scale-110' : 'border-surface-100'}`}
                  style={{ background: hueVar(h) }} />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-surface-100">
          <button type="button" onClick={exportSvg}
            className="px-3 py-1.5 rounded-lg text-[12.5px] border border-surface-100 text-ink-primary hover:border-surface-300">
            {t('agentMark.actions.exportSvg')}
          </button>
          <button type="button" onClick={exportPng}
            className="px-3 py-1.5 rounded-lg text-[12.5px] border border-surface-100 text-ink-primary hover:border-surface-300">
            {t('agentMark.actions.exportPng')}
          </button>
          <div className="flex-1" />
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-[12.5px] text-surface-400 hover:text-ink-primary">
            {t('agentMark.actions.cancel')}
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="px-4 py-1.5 rounded-lg text-[12.5px] font-medium bg-ink-primary text-surface-0 disabled:opacity-60">
            {t('agentMark.actions.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
