import { useEffect, useId, useRef } from 'react'
import { ACCESSORY_BY_ID, hueVar, type AccessoryId, type MarkHue } from './accessories'
import { sample, staticFrame, type MarkClock, type MarkFrame, type MarkState } from './engine'
import { eyePath, eyeTransform } from './geometry'
import type { ExpressionId } from './expressions'
import { RINGS, ringPaths } from './rings'
import { now, prefersReducedMotion, subscribe } from './driver'

/**
 * Agent Mark —— 全代码标识，没有一张位图。
 *
 * 渲染策略：DOM 只建一次，每帧只写属性（`d` / `transform` / `opacity`）。
 * 实测 innerHTML 重建是 0.30ms/帧、写属性 + 身体路径缓存是 0.052ms/帧，差 6 倍；
 * 所以这里绝不在 render 里拼 SVG 字符串。
 *
 * `animated=false` 时不订阅 rAF，直接画一帧 —— 列表里的后台 Agent 走这条路。
 */

export interface AgentMarkProps {
  state?: MarkState
  /** 显式指定表情（捏头像预览）；不给就按 state 映射 */
  expression?: ExpressionId | null
  accessory?: AccessoryId
  hue?: MarkHue
  size?: number
  /** 只有当前可见且活跃的 Agent 才开动画；列表里的静态实例零 rAF */
  animated?: boolean
  className?: string
  ariaLabel?: string
}

const r2 = (n: number): number => Math.round(n * 100) / 100

export function AgentMark({
  state = 'idle', expression = null, accessory = 'none', hue = 'ink',
  size = 20, animated = false, className = '', ariaLabel,
}: AgentMarkProps): React.JSX.Element {
  const maskId = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const nodes = useRef<Record<string, SVGElement | null>>({})
  const clock = useRef<MarkClock>({
    state, prevState: state, expression, prevExpression: expression, since: 0,
  })
  const lastBody = useRef<string | null>(null)
  const color = hueVar(hue)

  // 切状态 = 记一次 since，morph 由 sample 按时间算，组件不持有中间态
  useEffect(() => {
    const c = clock.current
    if (c.state === state && c.expression === expression) return
    c.prevState = c.state
    c.prevExpression = c.expression ?? null
    c.state = state
    c.expression = expression
    c.since = now()
  }, [state, expression])

  useEffect(() => {
    const draw = (f: MarkFrame): void => {
      const n = nodes.current
      if (lastBody.current !== f.body) {
        n.maskBody?.setAttribute('d', f.body)
        n.bg?.setAttribute('d', f.body)
        n.fg?.setAttribute('d', f.body)
        lastBody.current = f.body
      }
      for (const [el, e] of [[n.eyeL, f.l], [n.eyeR, f.r]] as const) {
        if (!el) continue
        el.setAttribute('d', eyePath(e))
        el.setAttribute('stroke-width', String(r2(e.w)))
        el.setAttribute('transform', eyeTransform(e, f.eyeSquash, f.eyeShift))
        el.setAttribute('opacity', String(r2(f.eyeAlpha)))
      }
      n.squash?.setAttribute('transform', `scale(${r2(f.scaleX)} ${r2(f.scaleY)})`)
      n.rot?.setAttribute('transform', `rotate(${r2(f.rotate)})`)
      n.all?.setAttribute('transform', `scale(${r2(f.scale)})`)
      n.propBehind?.setAttribute('opacity', String(r2(f.propAlpha)))
      n.propFront?.setAttribute('opacity', String(r2(f.propAlpha)))
      for (const [key, dot] of [['dot0', f.dots[0]], ['dot1', f.dots[1]]] as const) {
        const el = nodes.current[key]
        if (!el) continue
        if (!dot) { el.setAttribute('r', '0'); continue }
        el.setAttribute('cx', String(r2(dot.x)))
        el.setAttribute('r', String(r2(dot.radius)))
        el.setAttribute('opacity', String(r2(dot.alpha)))
        el.setAttribute('fill', dot.hot > 0.5 ? color : 'var(--sw-mark-ink)')
      }
      for (let i = 0; i < RINGS.length; i++) {
        const front = nodes.current[`ringF${i}`]
        const back = nodes.current[`ringB${i}`]
        if (!front || !back) continue
        if (f.ringAlpha <= 0) {
          if (front.getAttribute('opacity') !== '0') {
            front.setAttribute('opacity', '0'); back.setAttribute('opacity', '0')
          }
          continue
        }
        const [fd, bd] = ringPaths(RINGS[i], f.t * RINGS[i].speed)
        front.setAttribute('d', fd); back.setAttribute('d', bd)
        front.setAttribute('opacity', String(r2(f.ringAlpha)))
        back.setAttribute('opacity', String(r2(f.ringAlpha * 0.55)))
      }
    }

    if (!animated || prefersReducedMotion()) {
      draw(staticFrame(expression ?? undefined))
      return
    }

    let unsubscribe: (() => void) | null = null
    const tick = (t: number): void => draw(sample(t, clock.current))
    const attach = (): void => { if (!unsubscribe) unsubscribe = subscribe(tick) }
    const detach = (): void => { unsubscribe?.(); unsubscribe = null }

    // 滚出视口就退订：长会话列表里这是最省的一刀
    const el = svgRef.current
    let observer: IntersectionObserver | null = null
    if (el && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(([entry]) => (entry.isIntersecting ? attach() : detach()))
      observer.observe(el)
    } else attach()

    return () => { observer?.disconnect(); detach() }
  }, [animated, expression, color])

  const ref = (key: string) => (el: SVGElement | null): void => { nodes.current[key] = el }
  const acc = ACCESSORY_BY_ID.get(accessory) ?? ACCESSORY_BY_ID.get('none')!

  return (
    <svg
      ref={svgRef}
      viewBox="-32 -32 64 64"
      width={size}
      height={size}
      className={`sw-agent-mark ${className}`}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        {/* 眼睛是 mask 挖的洞，不是盖上去的白形 —— 洞才会随身体轮廓自动裁切 */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-70" y="-70" width="140" height="140">
          <path ref={ref('maskBody')} fill="#fff" />
          <path ref={ref('eyeL')} fill="none" stroke="#000" strokeLinecap="round" />
          <path ref={ref('eyeR')} fill="none" stroke="#000" strokeLinecap="round" />
        </mask>
      </defs>
      <g ref={ref('all')}>
        <g ref={ref('rot')}>
          {RINGS.map((ring, i) => (
            <path key={`b${i}`} ref={ref(`ringB${i}`)} fill="none" stroke={ring.color}
              strokeWidth={ring.width} strokeLinecap="round" strokeLinejoin="round" opacity={0} />
          ))}
          {acc.behind && (
            <g ref={ref('propBehind')} style={{ color }} dangerouslySetInnerHTML={{ __html: acc.behind }} />
          )}
          {/* 纸色底：没有它，绕到背后的彩环会从眼睛的洞里冒出来 */}
          <g ref={ref('squash')}>
            <path ref={ref('bg')} fill="var(--sw-mark-paper)" />
            <path ref={ref('fg')} fill="var(--sw-mark-ink)" mask={`url(#${maskId})`} />
          </g>
          <circle ref={ref('dot0')} cy={0} r={0} />
          <circle ref={ref('dot1')} cy={0} r={0} />
          {acc.front && (
            <g ref={ref('propFront')} style={{ color }} dangerouslySetInnerHTML={{ __html: acc.front }} />
          )}
          {RINGS.map((ring, i) => (
            <path key={`f${i}`} ref={ref(`ringF${i}`)} fill="none" stroke={ring.color}
              strokeWidth={ring.width} strokeLinecap="round" strokeLinejoin="round" opacity={0} />
          ))}
        </g>
      </g>
    </svg>
  )
}
