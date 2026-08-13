/**
 * DesignSystemGallery —— ArtifactType='design-system' 的 Workspace 侧栏渲染器
 *
 * 挂载时向 main 拉取 manifest（getDesignSystemManifest），把设计系统渲染成：
 *  - 头部：title + description + 绝对路径（弱色 mono）
 *  - 分组卡墙：每组一节，组内每张卡用 iframe 隔离渲染真实 html（127.0.0.1:3031 静态伺服）
 *  - UI Kits：整套 kit 全宽 iframe（仅 kits 非空时渲染）
 *  - 规范文档：README.md 通过受控 window.api 读取并走项目 Markdown
 *
 * 形状与 main 侧接口契约一致，此处本地声明避免跨 bundle import。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ThumbsUp, ThumbsDown, Send } from 'lucide-react'
import { Markdown } from '../shared/Markdown'
import { useChatStore } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import { designSystemResourceUrl, getDesignSystemResourceBaseUrl } from '../../utils/designSystemResourceUrl'

interface DsCardMeta { rel: string; name: string; subtitle?: string; group: string; w: number; h: number }
interface DsKitMeta { rel: string; label: string }
interface DesignSystemManifest {
  name: string
  title: string
  description?: string
  path: string
  groups: { group: string; cards: DsCardMeta[] }[]
  kits: DsKitMeta[]
  readme?: string
}

// 与 main 侧 role-manager 的 DsReview 同形状（本地声明，不跨 bundle import）
interface DsCardReview { verdict: 'up' | 'down'; comment?: string; at: number }

/** 赞/踩按钮对（贴在卡名右侧）；已赞 = 定稿，折叠成 ✓ 徽标（点徽标撤销），只有踩才保留输入 */
function ReviewButtons({
  rel,
  entry,
  t,
  onVerdict
}: {
  rel: string
  entry: DsCardReview | undefined
  t: TFunction
  onVerdict: (rel: string, verdict: 'up' | 'down') => void
}): JSX.Element {
  if (entry?.verdict === 'up') {
    return (
      <button
        data-testid="ds-review-approved"
        title={t('designSystemBrowser.gallery.review.approvedAction')}
        aria-label={t('designSystemBrowser.gallery.review.approvedAction')}
        aria-pressed="true"
        onClick={() => onVerdict(rel, 'up')}
        className="inline-flex items-center gap-1 shrink-0 text-[11px] font-medium text-brand-600 bg-brand-50 dark:text-brand-300 dark:bg-brand-500/15 px-1.5 py-0.5 rounded-full hover:bg-brand-100 dark:hover:bg-brand-500/25 transition-colors"
      >
        ✓ {t('designSystemBrowser.gallery.review.approved')}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        data-testid="ds-review-up"
        title={t('designSystemBrowser.gallery.review.approveAction')}
        aria-label={t('designSystemBrowser.gallery.review.approveAction')}
        aria-pressed="false"
        onClick={() => onVerdict(rel, 'up')}
        // 已赞的情况在上面折叠成 ✓ 徽标提前 return 了，走到这里必定未赞
        className="p-1 rounded transition-colors text-surface-400 hover:text-surface-600 hover:bg-surface-100"
      >
        <ThumbsUp size={13} />
      </button>
      <button
        data-testid="ds-review-down"
        title={t('designSystemBrowser.gallery.review.reviseAction')}
        aria-label={t('designSystemBrowser.gallery.review.reviseAction')}
        aria-pressed={entry?.verdict === 'down'}
        onClick={() => onVerdict(rel, 'down')}
        className={`p-1 rounded transition-colors ${
          entry?.verdict === 'down'
            ? 'text-red-500 bg-red-50 dark:text-red-400 dark:bg-red-500/15'
            : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
        }`}
      >
        <ThumbsDown size={13} />
      </button>
    </div>
  )
}

/** 踩时的意见输入（全宽，失焦保存） */
function ReviewCommentBox({
  rel,
  entry,
  t,
  onComment
}: {
  rel: string
  entry: DsCardReview | undefined
  t: TFunction
  onComment: (rel: string, comment: string) => void
}): JSX.Element | null {
  if (entry?.verdict !== 'down') return null
  return (
    <textarea
      data-testid="ds-review-comment"
      defaultValue={entry.comment || ''}
      placeholder={t('designSystemBrowser.gallery.review.commentPlaceholder')}
      rows={2}
      onBlur={(e) => onComment(rel, e.target.value)}
      className="mt-1 w-full text-xs px-2 py-1.5 rounded border border-red-200 dark:border-red-500/30 bg-white dark:bg-surface-0 text-surface-700 placeholder:text-surface-400 resize-none focus:outline-none focus:border-red-300"
    />
  )
}

export function DesignSystemGallery({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [manifest, setManifest] = useState<DesignSystemManifest | null>(null)
  const [readmeText, setReadmeText] = useState<string | null>(null)
  const [resourceBase, setResourceBase] = useState<string | null>(null)
  // 已编译新格式组件数（官方 _ds_manifest.json 的 components.length）；legacy/未编译 → null（不显示标记）
  const [compiledCount, setCompiledCount] = useState<number | null>(null)
  // 逐卡评审（rel → 赞/踩+评语）；持久化在系统目录 _review.json，跨会话/重开面板保留
  const [review, setReview] = useState<Record<string, DsCardReview>>({})
  const [feedbackSent, setFeedbackSent] = useState(false)
  const reviewRef = useRef(review)
  reviewRef.current = review

  useEffect(() => {
    let cancelled = false
    const loadCapability = (): void => {
      getDesignSystemResourceBaseUrl(name)
        .then(base => { if (!cancelled) setResourceBase(base) })
        .catch(() => { if (!cancelled) setResourceBase(null) })
    }
    loadCapability()
    window.addEventListener('openpipal-browser-session-rotated', loadCapability)
    return () => {
      cancelled = true
      window.removeEventListener('openpipal-browser-session-rotated', loadCapability)
    }
  }, [name])

  const persistReview = useCallback((next: Record<string, DsCardReview>) => {
    const fn = (window.api as any)?.saveDsReview
    if (typeof fn === 'function') {
      Promise.resolve(fn(name, { updatedAt: Date.now(), cards: next })).catch(() => { /* 静默：本地状态仍在 */ })
    }
  }, [name])

  const setVerdict = useCallback((rel: string, verdict: 'up' | 'down') => {
    setFeedbackSent(false)
    setReview(prev => {
      const cur = prev[rel]
      // 再点同一票 = 取消评审
      const next = { ...prev }
      if (cur?.verdict === verdict) delete next[rel]
      else next[rel] = { verdict, comment: cur?.comment, at: Date.now() }
      persistReview(next)
      return next
    })
  }, [persistReview])

  const setComment = useCallback((rel: string, comment: string) => {
    setReview(prev => {
      const cur = prev[rel]
      if (!cur) return prev
      const next = { ...prev, [rel]: { ...cur, comment: comment.trim() || undefined } }
      persistReview(next)
      return next
    })
  }, [persistReview])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setManifest(null)
    setReadmeText(null)
    setCompiledCount(null)
    setReview({})
    setFeedbackSent(false)
    // 评审记录独立拉取；失败/无记录静默（从空白开始）
    const reviewFn = (window.api as any)?.getDsReview
    if (typeof reviewFn === 'function') {
      Promise.resolve(reviewFn(name))
        .then((r: { cards?: Record<string, DsCardReview> } | null) => {
          if (!cancelled && r?.cards && typeof r.cards === 'object') setReview(r.cards)
        })
        .catch(() => { /* 静默 */ })
    }
    // 可选增强：读官方 _ds_manifest.json 的 components 数量（存在即显示"已编译"标记）。
    // 独立于主 manifest 拉取——失败/未编译/无该 IPC（旧 shim）一律静默，画廊照常渲染。
    const compiledFn = (window.api as any)?.getCompiledDsManifest
    if (typeof compiledFn === 'function') {
      Promise.resolve(compiledFn(name))
        .then((cm: { components?: unknown[] } | null) => {
          if (cancelled) return
          const n = cm && Array.isArray(cm.components) ? cm.components.length : 0
          setCompiledCount(n > 0 ? n : null)
        })
        .catch(() => { /* 静默：不显示标记 */ })
    }
    const fn = (window.api as any)?.getDesignSystemManifest
    if (typeof fn !== 'function') { setStatus('error'); return }
    Promise.resolve(fn(name))
      .then((m: DesignSystemManifest | null) => {
        if (cancelled) return
        if (m && typeof m === 'object') { setManifest(m); setStatus('ready') }
        else setStatus('error')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [name])

  // README 单独通过受控资源 API 读取；失败/旧 preload 静默，不渲染文档节。
  useEffect(() => {
    const rel = manifest?.readme
    if (!rel) return
    const readResource = window.api?.readDesignSystemResource
    if (typeof readResource !== 'function') return
    let cancelled = false
    Promise.resolve(readResource(name, rel))
      .then((result: { ok?: boolean; kind?: string; data?: string }) => {
        if (!cancelled && result?.ok && result.kind === 'text' && typeof result.data === 'string') {
          setReadmeText(result.data)
        }
      })
      .catch(() => { /* 静默：文档节不渲染 */ })
    return () => { cancelled = true }
  }, [manifest, name])

  // 全部可评审项（分组卡 + UI kits），rel → 显示名
  const reviewables = useMemo(() => {
    if (!manifest) return [] as Array<{ rel: string; label: string }>
    return [
      ...manifest.groups.flatMap(g => g.cards.map(c => ({ rel: c.rel, label: c.name }))),
      ...manifest.kits.map(k => ({ rel: k.rel, label: `UI Kit · ${k.label}` }))
    ]
  }, [manifest])

  const counts = useMemo(() => {
    let up = 0
    let down = 0
    for (const item of reviewables) {
      const v = review[item.rel]?.verdict
      if (v === 'up') up++
      else if (v === 'down') down++
    }
    return { up, down, pending: reviewables.length - up - down }
  }, [reviewables, review])

  const sendFeedback = useCallback(() => {
    if (!manifest) return
    const cur = reviewRef.current
    const ups = reviewables.filter(i => cur[i.rel]?.verdict === 'up')
    const downs = reviewables.filter(i => cur[i.rel]?.verdict === 'down')
    const pendings = reviewables.filter(i => !cur[i.rel])
    const lines: string[] = [`【设计系统评审反馈 · ${manifest.name}】`]
    if (ups.length) lines.push(`✅ 已确认 (${ups.length})：${ups.map(i => i.label).join('、')}`)
    if (downs.length) {
      lines.push(`❌ 待修改 (${downs.length})：`)
      downs.forEach((i, idx) => {
        const c = cur[i.rel]?.comment
        lines.push(`${idx + 1}. ${i.label}（${i.rel}）：${c || '未写具体意见，请自查这张卡的问题'}`)
      })
    }
    if (pendings.length) lines.push(`⏸ 尚未评审 (${pendings.length})：${pendings.map(i => i.label).join('、')}`)
    lines.push('')
    lines.push(
      downs.length
        ? '请只修改被踩项对应的源文件（已确认项不要动），改完重新自检，并用原 id 重调 create_artifact 刷新画廊，然后请我再次评审。'
        : '以上评审已完成，被确认的卡片视为定稿，不要再改动；若发布收尾尚未完成请继续完成。'
    )
    const text = lines.join('\n')
    const chat = useChatStore.getState()
    const roleName = useAppStore.getState().currentRole?.name || 'design'
    if (chat.isStreaming) chat.enqueuePending(text)
    else void chat.sendMessage(text, roleName)
    setFeedbackSent(true)
  }, [manifest, reviewables])

  if (status !== 'ready' || !manifest) {
    return (
      <div
        data-testid="ds-gallery"
        className="flex-1 flex items-center justify-center text-xs text-surface-400"
      >
        {status === 'loading'
          ? t('designSystemBrowser.gallery.loading')
          : t('designSystemBrowser.gallery.missing')}
      </div>
    )
  }

  return (
    <div
      data-testid="ds-gallery"
      className="flex-1 overflow-y-auto bg-surface-50"
    >
      {/* 头部 */}
      <div className="px-5 pt-5 pb-4 border-b border-surface-100">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold text-surface-900 break-words">
            {manifest.title || manifest.name}
          </h1>
          {compiledCount !== null && (
            <span
              data-testid="ds-compiled-badge"
              className="inline-flex items-center gap-1 shrink-0 rounded-full bg-brand-50 dark:bg-brand-500/15 px-2 py-0.5 text-[11px] font-medium text-brand-600 dark:text-brand-300"
              title={t('designSystemBrowser.gallery.compiledTitle')}
            >
              {t('designSystemBrowser.gallery.compiled', { count: compiledCount })}
            </span>
          )}
        </div>
        {manifest.description && (
          <p className="mt-1.5 text-sm text-surface-600 leading-relaxed break-words">
            {manifest.description}
          </p>
        )}
        <div className="mt-2 text-[11px] font-mono text-surface-400 break-all">
          {manifest.path}
        </div>
      </div>

      {/* 分组卡墙 */}
      {manifest.groups.map(section => (
        <section key={section.group} className="px-5 py-4 border-b border-surface-100">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-surface-500">
            {section.group}
          </div>
          <div className="flex flex-wrap gap-4">
            {section.cards.map(card => (
              <div
                key={card.rel}
                data-testid="ds-gallery-card"
                className="flex flex-col"
                style={{ width: card.w, maxWidth: '100%' }}
              >
                {resourceBase ? (
                  <iframe
                    src={designSystemResourceUrl(resourceBase, name, card.rel)}
                    title={card.name}
                    loading="lazy"
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    style={{ height: card.h }}
                    className="w-full bg-white rounded-lg border border-surface-200"
                  />
                ) : (
                  <div style={{ height: card.h }} className="w-full rounded-lg border border-surface-200 bg-surface-50" />
                )}
                <div className="mt-1.5 px-0.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-surface-700 truncate">
                        {card.name}
                      </div>
                      {card.subtitle && (
                        <div className="text-[11px] text-surface-400 truncate">{card.subtitle}</div>
                      )}
                    </div>
                    <ReviewButtons rel={card.rel} entry={review[card.rel]} t={t} onVerdict={setVerdict} />
                  </div>
                  <ReviewCommentBox rel={card.rel} entry={review[card.rel]} t={t} onComment={setComment} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* UI Kits */}
      {manifest.kits.length > 0 && (
        <section className="px-5 py-4 border-b border-surface-100">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-surface-500">
            {t('designSystemBrowser.gallery.uiKits')}
          </div>
          <div className="space-y-5">
            {manifest.kits.map(kit => (
              <div key={kit.rel} data-testid="ds-gallery-kit" className="flex flex-col">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-surface-700">
                    {kit.label}
                  </div>
                  <ReviewButtons rel={kit.rel} entry={review[kit.rel]} t={t} onVerdict={setVerdict} />
                </div>
                <ReviewCommentBox rel={kit.rel} entry={review[kit.rel]} t={t} onComment={setComment} />
                {resourceBase ? (
                  <iframe
                    src={designSystemResourceUrl(resourceBase, name, kit.rel)}
                    title={kit.label}
                    loading="lazy"
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    style={{ height: 640 }}
                    className="w-full bg-white rounded-lg border border-surface-200"
                  />
                ) : (
                  <div style={{ height: 640 }} className="w-full rounded-lg border border-surface-200 bg-surface-50" />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 规范文档 */}
      {readmeText && (
        <section className="px-5 py-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-surface-500">
            {t('designSystemBrowser.gallery.guidelines')}
          </div>
          <div className="prose-light max-w-none">
            <Markdown content={readmeText} />
          </div>
        </section>
      )}

      {/* 评审汇总栏：赞/踩计数 + 批量发送反馈（吸附底部） */}
      {reviewables.length > 0 && (
        <div
          data-testid="ds-review-bar"
          className="sticky bottom-0 border-t border-surface-200 bg-white/95 dark:bg-surface-0/95 backdrop-blur px-5 py-2.5 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-surface-500">
            <span className="font-medium text-brand-600 dark:text-brand-300">
              {t('designSystemBrowser.gallery.review.confirmed', { count: counts.up })}
            </span>
            <span className="font-medium text-red-500">
              {t('designSystemBrowser.gallery.review.needsChanges', { count: counts.down })}
            </span>
            <span className="font-medium">
              {t('designSystemBrowser.gallery.review.pending', { count: counts.pending })}
            </span>
          </div>
          <button
            data-testid="ds-review-send"
            disabled={counts.up + counts.down === 0 || feedbackSent}
            onClick={sendFeedback}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={12} />
            {feedbackSent
              ? t('designSystemBrowser.gallery.review.sent')
              : t('designSystemBrowser.gallery.review.send')}
          </button>
        </div>
      )}
    </div>
  )
}
