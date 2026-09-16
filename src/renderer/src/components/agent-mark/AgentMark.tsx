import { memo, useEffect, useId, useRef } from 'react'
import { ACCESSORY_BY_ID, accentFor, hueVar, type AccessoryId, type MarkHue } from './accessories'
import { sample, staticFrame, type MarkClock, type MarkFrame, type MarkState } from './engine'
import { eyePath, eyeTransform, r2, type MarkShape } from './geometry'
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
  /** 身体色。眼睛是纸色的洞，身体什么色都露得出来 */
  hue?: MarkHue
  /** 配饰色；不给 = 身体色的搭子（搭配表头一个），老 mark.json 只有 hue 也照样两色 */
  accent?: MarkHue
  /** 身体轮廓；不给 = 圆角方。眼睛与配饰不随它变 */
  shape?: MarkShape
  size?: number
  /** 只有当前可见且活跃的 Agent 才开动画；列表里的静态实例零 rAF */
  animated?: boolean
  /**
   * 叠放时给整个剪影（身体 + 配饰 + 状态点）描一圈背景色（--sw-mark-halo，默认纸色）：
   * 前面的头把后面的头"抠"出一道缝，层级才看得出来。用 SVG 滤镜把整张图的 alpha 向外膨胀再填底色、垫在图下面，
   * 所以围脖、公文包这些伸出身体的配饰也一起抠，不是只描身体轮廓（所有者 2026-09-16）。
   */
  halo?: boolean
  className?: string
  ariaLabel?: string
}

export const AgentMark = memo(function AgentMark({
  state = 'idle', expression = null, accessory = 'none', hue = 'ink', accent, shape = 'square',
  size = 20, animated = false, halo = false, className = '', ariaLabel,
}: AgentMarkProps): React.JSX.Element {
  const maskId = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const nodes = useRef<Record<string, SVGElement | null>>({})
  const clock = useRef<MarkClock>({
    state, prevState: state, expression, prevExpression: expression, since: 0, shape,
  })
  const lastBody = useRef<string | null>(null)
  const color = hueVar(accent ?? accentFor(hue))

  // 切状态 = 记一次 since，morph 由 sample 按时间算，组件不持有中间态
  useEffect(() => {
    const c = clock.current
    c.shape = shape
    if (c.state === state && c.expression === expression) return
    c.prevState = c.state
    c.prevExpression = c.expression ?? null
    c.state = state
    c.expression = expression
    c.since = now()
  }, [state, expression, shape])

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
          // 隐藏时连几何一起清：getBBox 不看 opacity，留着的弧线会把导出取景框撑到 ~100 宽（先点过"生成中"再导出就中招）
          if (front.getAttribute('opacity') !== '0') {
            front.setAttribute('opacity', '0'); back.setAttribute('opacity', '0')
            front.removeAttribute('d'); back.removeAttribute('d')
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
      draw(staticFrame(expression ?? undefined, shape))
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
  }, [animated, expression, color, shape])

  // ref 回调按 key 只建一次：每次 render 新建闭包会让 React 先 null 再重挂每个 ref——
  // 侧栏几十个头像跟着流式输出一起重渲染时，这是白做的一大笔
  const refs = useRef<Record<string, (el: SVGElement | null) => void>>({})
  const ref = (key: string): ((el: SVGElement | null) => void) =>
    refs.current[key] || (refs.current[key] = (el) => { nodes.current[key] = el })
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
        {/* 抠缝：整张图的 alpha 向外膨胀 5 单位（64 单位 = size px，16px 下约 1.25px）填底色，垫在原图下面。
            滤镜区域放到 ±70，配饰最远伸到 ±56 也罩得住 */}
        {halo && (
          <filter id={`${maskId}h`} data-halo filterUnits="userSpaceOnUse" x="-70" y="-70" width="140" height="140">
            <feMorphology in="SourceAlpha" operator="dilate" radius="5" result="fat" />
            <feFlood style={{ floodColor: 'var(--sw-mark-halo, var(--sw-mark-paper))' }} result="tint" />
            <feComposite in="tint" in2="fat" operator="in" result="halo" />
            <feMerge><feMergeNode in="halo" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        )}
      </defs>
      <g ref={ref('all')} filter={halo ? `url(#${maskId}h)` : undefined}>
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
            <path ref={ref('fg')} fill={hueVar(hue)} mask={`url(#${maskId})`} />
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
})
