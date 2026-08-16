/**
 * Questions v2 全屏问答面板
 *
 * 由 agent 调用 questions_v2 工具时触发。比 ask_user 表达力强：
 * - text-options：按钮式文字选项（支持 multi）
 * - svg-options：可视化选项（色板/图标块）
 * - slider：数值滑块
 * - freeform：自由文本
 * - multi-chip：紧凑多选 chip
 *
 * 选择题自动附加“其他”。**不再逐题摆“交给 AI 判断”按钮**——那让代选看起来像第 N 个选项，
 * 用户每题都要处理一次。改成一条面板级规则：**没选的题就是交给 AI 判断**（提交时统一填
 * aiDecisionAnswer）。allowAiDecision:false 的题是例外：它必须由本人裁决，标「必答」且拦提交。
 */

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from 'react'
import { Paperclip, X, FileText } from 'lucide-react'
import { extractPastedImages } from '../utils/pasteImages'
import { shouldOfferAiDecision } from '../chat/questionChoices'
import type { FileAttachmentData } from '../types'
import { useTranslation } from 'react-i18next'
import { questionsPreviewImageUrl } from '../../../shared/safe-svg'

interface QuestionBase {
  id: string
  title: string
  subtitle?: string
  /** false = 必须由用户本人裁决，不出现“交给 AI 判断” */
  allowAiDecision?: boolean
  /** 这道题下方放文件上传位（模型声明"这道题的最准答案是一份原件"）；attachHint 是引导语 */
  attach?: boolean
  attachHint?: string
}
interface TextOptionsQuestion extends QuestionBase { kind: 'text-options'; options: string[]; multi?: boolean; default?: string }
interface SvgOption { value: string; label?: string; svg?: string }
interface SvgOptionsQuestion extends QuestionBase { kind: 'svg-options'; options: SvgOption[]; default?: string }
interface SliderQuestion extends QuestionBase { kind: 'slider'; min: number; max: number; step?: number; default?: number }
interface FreeformQuestion extends QuestionBase { kind: 'freeform'; placeholder?: string }
interface MultiChipQuestion extends QuestionBase { kind: 'multi-chip'; options: string[] }
type Question = TextOptionsQuestion | SvgOptionsQuestion | SliderQuestion | FreeformQuestion | MultiChipQuestion

interface Props {
  title: string
  questions: any[]  // 来自 agent，运行时类型检查
  onSubmit: (answers: Record<string, any>, images?: string[], files?: FileAttachmentData[]) => void
  onCancel?: () => void
  /** 流式生成中:问题仍在逐个到达,提交禁用,底部显示「生成中」而非提交按钮 */
  streaming?: boolean
}

const OTHER = '__other__'

/**
 * 预览图一律以 <img> 呈现（img 里的 SVG 不执行脚本、不发请求），绝不把模型给的标记插进
 * 宿主 DOM。主进程已经把预览收敛成静态白名单 SVG 或合法 data:image/* URI；这里再过一遍
 * 同一支 questionsPreviewImageUrl，是针对解析器差异的独立防线。
 */

/** 图片扩展名判定 —— 与 InputBar.isImageFile 同一组扩展 */
const isImageFile = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)

export function QuestionsV2Panel({ title, questions, onSubmit, onCancel, streaming }: Props) {
  const { t } = useTranslation()
  // 初始化默认值
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {}
    for (const q of questions) {
      if (q?.default !== undefined) init[q.id] = q.default
    }
    return init
  })
  // "Other" 自由输入的字符串（per question id）
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  // 预览图加载失败的选项（key = `${questionId}::${optionValue}`）→ 改渲染中性占位卡
  const [brokenPreviews, setBrokenPreviews] = useState<Record<string, boolean>>({})

  // 附件仅按 Agent 明确声明的题内上传位分桶。没有 attach:true 就不出现上传入口，
  // 也不接管用户的粘贴行为；用户要主动补充无关材料时仍可用聊天输入框正常发送。
  const [zoneImages, setZoneImages] = useState<Record<string, string[]>>({})
  const [zoneFiles, setZoneFiles] = useState<Record<string, FileAttachmentData[]>>({})
  const [uploading, setUploading] = useState(false)
  const [attachNoticeKey, setAttachNoticeKey] = useState('')
  const [dragZone, setDragZone] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInputZone = useRef<string | null>(null)
  // 提交被必答题拦下后才亮红：进来就一片红是在指责还没开始答的人
  const [showMissing, setShowMissing] = useState(false)
  const questionRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const attachQuestions = questions.filter((q: any) => q?.attach === true && typeof q?.id === 'string' && q.id)
  const attachQuestionIds = new Set(attachQuestions.map((q: any) => q.id))
  const hasAiDelegation = questions.some((q: any) =>
    (q?.kind === 'text-options' || q?.kind === 'svg-options') && shouldOfferAiDecision(q)
  )
  // ⌘V 只有唯一且明确的 Agent 请求目标时才接管。多个上传位时不猜归属，用户应在具体题下
  // 点击“传文件”，避免把同一份材料误绑到错误答案。
  const pasteZoneRef = useRef<string | null>(null)
  pasteZoneRef.current = attachQuestions.length === 1 ? attachQuestions[0].id : null

  const pushZoneImage = (zone: string, b64: string): void =>
    setZoneImages(prev => ({ ...prev, [zone]: [...(prev[zone] || []), b64] }))

  // 非图片文件 → 走现成的 file:upload IPC 落到 workspace/uploads/，返回路径供 AI 工具读取
  // （与 InputBar.addFileAttachment 同一条管道，不新增后端）
  const uploadAsFileAttachment = async (filePath: string, zone: string): Promise<void> => {
    if (!(window.api as any)?.uploadFile) return
    try {
      setUploading(true)
      const uploaded = await (window.api as any).uploadFile(filePath)
      setZoneFiles(prev => ({ ...prev, [zone]: [...(prev[zone] || []), {
        fileName: uploaded.fileName,
        fileType: (uploaded.fileName.split('.').pop() || ''),
        sizeBytes: uploaded.sizeBytes,
        path: uploaded.path
      }] }))
    } catch (err) {
      console.error('[QuestionsV2Panel] 文件上传失败:', err)
    } finally {
      setUploading(false)
    }
  }

  const handleFiles = (fileList: FileList | File[], zone: string): void => {
    for (const file of Array.from(fileList)) {
      if (file.type.startsWith('image/') || isImageFile(file.name)) {
        const reader = new FileReader()
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1]
          pushZoneImage(zone, base64)
        }
        reader.readAsDataURL(file)
        continue
      }
      // Electron 32+ 移除了 File.path——真实路径走 preload 的 webUtils；旧字段兜底 legacy。
      const filePath = ((window.api as any)?.getPathForFile?.(file) ?? (file as any).path) as string | undefined
      if (!filePath) {
        // 浏览器插件模式无 path，桌面优先——不为插件新造上传通道，轻提示即可
        setAttachNoticeKey('chat.questions.browserFileUnsupported')
        continue
      }
      void uploadAsFileAttachment(filePath, zone)
    }
  }

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files && fileInputZone.current) handleFiles(e.target.files, fileInputZone.current)
    e.target.value = ''
  }

  const handleAttachDragOver = (zone: string) => (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault(); e.stopPropagation()
    if (dragZone !== zone) setDragZone(zone)
  }
  const handleAttachDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault(); e.stopPropagation()
    setDragZone(null)
  }
  const handleAttachDrop = (zone: string) => (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault(); e.stopPropagation()
    setDragZone(null)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) handleFiles(files, zone)
  }

  // 面板级 ⌘V 粘贴图片/文件——只在 Agent 请求了唯一附件位时接管；跳过正落焦在输入框
  // （如 "Other" 自由输入）里的粘贴，不抢那里的文本粘贴行为。
  useEffect(() => {
    const handler = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const zone = pasteZoneRef.current
      if (!zone) return
      extractPastedImages(e, (b64) => pushZoneImage(zone, b64), {
        onFilePath: (p) => { void uploadAsFileAttachment(p, zone) }
      })
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [])

  const removePendingImage = (zone: string, i: number): void =>
    setZoneImages(prev => ({ ...prev, [zone]: (prev[zone] || []).filter((_, idx) => idx !== i) }))
  const removePendingFile = (zone: string, i: number): void =>
    setZoneFiles(prev => ({ ...prev, [zone]: (prev[zone] || []).filter((_, idx) => idx !== i) }))

  const set = (id: string, v: any): void => setValues(prev => ({ ...prev, [id]: v }))

  /** 作答判定：空数组 / 空串 / 未定义都算没答 */
  const isAnswered = (q: any): boolean => {
    const raw = values[q.id]
    if (Array.isArray(raw)) return raw.length > 0
    return raw !== undefined && raw !== null && raw !== ''
  }
  // 必答 = Agent 声明「本人裁决」（allowAiDecision:false，如写入/删除个人档案）。
  // 其余题不答就是交给 AI —— 但这条豁免绝不能覆盖必答题，否则等于把确认权悄悄让渡出去。
  const isRequired = (q: any): boolean => !shouldOfferAiDecision(q)
  const missingRequired = questions.filter((q: any) => q?.id && isRequired(q) && !isAnswered(q))

  const handleSubmit = (): void => {
    if (missingRequired.length > 0) {
      setShowMissing(true)
      questionRefs.current[missingRequired[0].id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    // 把 "Other" 文本 merge 进最终答案；没答的题统一落成「交给 AI 判断」，
    // 于是模型收到的答案表永远是全的（缺 key 与"用户跳过"分不清，会逼它反问）
    const final: Record<string, any> = {}
    const delegated = new Set<string>() // 落成「交给 AI」的题：下面挂材料时不该再跟一句"你判断"
    for (const q of questions) {
      const raw = values[q.id]
      const otherVal = otherText[q.id]
      if (raw === OTHER && otherVal) {
        final[q.id] = otherVal
      } else if (Array.isArray(raw)) {
        const mapped = raw.map((x: string) => x === OTHER ? otherVal : x).filter(Boolean)
        if (mapped.length > 0) final[q.id] = mapped
        else { final[q.id] = t('chat.questions.aiDecisionAnswer'); delegated.add(q.id) }
      } else if (raw !== undefined && raw !== '') {
        final[q.id] = raw
      } else {
        final[q.id] = t('chat.questions.aiDecisionAnswer')
        delegated.add(q.id)
      }
    }
    // 附件平铺走 sendMessage 现有管线；归属关系写进对应题目的答案文本——模型收到的是
    // "班级学情: xxx（本题附材料：作业1.jpg、图片 2 张）"，不用再猜哪份材料回答哪道题
    const allImages: string[] = []
    const allFiles: FileAttachmentData[] = []
    for (const q of questions) {
      const imgs = zoneImages[q.id] || []
      const files = zoneFiles[q.id] || []
      if (imgs.length === 0 && files.length === 0) continue
      const parts: string[] = []
      if (files.length > 0) parts.push(files.map(f => f.fileName).join(t('chat.questions.fileSeparator')))
      if (imgs.length > 0) parts.push(t('chat.questions.imageCount', { count: imgs.length }))
      const note = t('chat.questions.attachedMaterials', {
        parts: parts.join(t('chat.questions.attachmentSeparator'))
      })
      // 传了材料就是答了——别再让"交给 AI 判断"跟在材料后面自相矛盾
      const cur = delegated.has(q.id) ? undefined : final[q.id]
      final[q.id] = Array.isArray(cur) ? [...cur, note] : cur ? `${cur} ${note}` : note
      allImages.push(...imgs)
      allFiles.push(...files)
    }
    onSubmit(final, allImages.length > 0 ? allImages : undefined, allFiles.length > 0 ? allFiles : undefined)
  }

  // 上传位：传文件按钮 + 已选 chips + 拖放。仅在 Agent 对当前题声明 attach:true 时渲染。
  const renderAttachZone = (zone: string, opts: { hint: string; compact?: boolean; testid: string }) => (
    <div
      data-testid={opts.testid}
      onDragOver={handleAttachDragOver(zone)}
      onDragLeave={handleAttachDragLeave}
      onDrop={handleAttachDrop(zone)}
      className={`rounded-lg border border-dashed transition-colors ${opts.compact ? 'p-2.5' : 'p-3'} ${
        dragZone === zone
          ? 'border-brand-400 bg-brand-50/40 dark:bg-brand-900/10'
          : 'border-surface-200'
      }`}
    >
      <p className={`text-[11px] text-surface-400 leading-relaxed ${opts.compact ? 'mb-1.5' : 'mb-2'}`}>{opts.hint}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid={`${opts.testid}-btn`}
          onClick={() => { fileInputZone.current = zone; fileInputRef.current?.click() }}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-surface-200 text-surface-600 hover:border-brand-300 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
        >
          <Paperclip className="w-3 h-3" />
          {t('chat.questions.uploadFile')}
        </button>
        {uploading && fileInputZone.current === zone && <span className="text-[11px] text-surface-400">{t('chat.questions.uploading')}</span>}
        {(zoneFiles[zone] || []).map((f, i) => (
          <span key={`qf${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-100 text-[11px] text-surface-500">
            <FileText className="w-3 h-3" />
            {f.fileName}
            <button type="button" onClick={() => removePendingFile(zone, i)} className="ml-0.5 text-surface-300 hover:text-surface-500"><X className="w-2.5 h-2.5" /></button>
          </span>
        ))}
        {(zoneImages[zone] || []).map((img, i) => (
          <div key={`qi${i}`} className="relative group">
            <img src={`data:image/jpeg;base64,${img}`} alt="" className="w-8 h-8 object-cover rounded border border-surface-200" />
            <button type="button" onClick={() => removePendingImage(zone, i)} className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-surface-600 text-white rounded-full flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-2 h-2" /></button>
          </div>
        ))}
      </div>
      {attachNoticeKey && <p className="text-[11px] text-amber-500 mt-1.5">{t(attachNoticeKey)}</p>}
    </div>
  )

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-0 dark:bg-surface-50">
      {/* 顶栏 —— 只是身份标识：大标题在内容区，这里不必再喊一遍，收到 h-9 把空间还给问题 */}
      <div className="h-9 shrink-0 flex items-center justify-between px-4 border-b border-surface-100">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] text-surface-400">✓</span>
          <span className="text-xs text-surface-500 truncate">{t('chat.questions.confirmTitle')}</span>
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-xs text-surface-400 hover:text-surface-600"
          >{t('chat.questions.close')}</button>
        )}
      </div>

      {/* 内容列限宽：面板拉宽时正文不该跟着拉到一行上千像素——读一行要转头 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-5">
        <div className="mx-auto w-full max-w-[680px]">
        {/* 标题 */}
        <div className="mb-1">
          <h1 className="text-lg font-semibold text-surface-800 mb-1.5">{title}</h1>
          {/* 流式且一道题都还没到时不写这句：此刻两条文案哪条成立都还不知道，
              先写「AI 不会替你决定」再被换掉，等于承诺打了个折 */}
          {!(streaming && questions.length === 0) && (
            <p className="text-xs text-surface-500 leading-relaxed">
              {hasAiDelegation
                ? t('chat.questions.delegationDescription')
                : t('chat.questions.personalDecisionDescription')}
            </p>
          )}
        </div>

        {/* 流式空档：标题已到、第一道题还没闭合时不留一片白 */}
        {streaming && questions.length === 0 && (
          <div data-testid="questions-skeleton" className="mt-6 space-y-6" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="space-y-2.5 animate-pulse">
                <div className="h-3 rounded bg-surface-100" style={{ width: `${42 - i * 6}%` }} />
                <div className="flex gap-2">
                  <div className="h-8 w-20 rounded-lg bg-surface-100" />
                  <div className="h-8 w-24 rounded-lg bg-surface-100" />
                  <div className="h-8 w-16 rounded-lg bg-surface-100" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Questions —— 细分隔线分组：只靠间距的话题一多就糊成一片 */}
        <div className="divide-y divide-surface-100">
        {questions.map((q: Question, idx: number) => {
          const required = isRequired(q)
          const missing = showMissing && required && !isAnswered(q)
          return (
          <div
            key={q.id || idx}
            ref={el => { if (q.id) questionRefs.current[q.id] = el }}
            data-testid={missing ? 'question-missing' : undefined}
            className={`py-5 first:pt-6 space-y-2.5 ${missing ? 'border-l-2 border-l-amber-400 -ml-3 pl-3' : ''}`}
          >
            <div>
              <div className="text-sm font-medium text-surface-700 flex items-baseline gap-2">
                <span className="text-[11px] tabular-nums text-surface-300 shrink-0">{idx + 1}</span>
                <span className="min-w-0">{q.title}</span>
                {required && (
                  <span className="shrink-0 text-[10px] px-1.5 py-px rounded text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20">
                    {t('chat.questions.requiredBadge')}
                  </span>
                )}
              </div>
              {q.subtitle && <div className="text-xs text-surface-400 mt-1 pl-[22px]">{q.subtitle}</div>}
            </div>

            {q.kind === 'text-options' && (
              <div className="flex flex-wrap gap-2">
                {[...q.options, OTHER].map((opt: unknown) => {
                  // 双保险：normalizeQuestionsV2Items 应该已经把 options 元素收敛成字符串，
                  // 但弱模型/旧缓存数据仍可能穿透对象元素——渲染前再强转一次，防 React #31 崩溃。
                  const optStr = typeof opt === 'string' ? opt : String((opt as any)?.label ?? (opt as any)?.value ?? '')
                  if (!optStr) return null
                  const multi = q.multi
                  const selected = multi
                    ? Array.isArray(values[q.id]) && values[q.id].includes(optStr)
                    : values[q.id] === optStr
                  const label = optStr === OTHER ? t('chat.questions.other') : optStr
                  return (
                    <button
                      key={optStr}
                      onClick={() => {
                        if (multi) {
                          const cur: string[] = Array.isArray(values[q.id]) ? values[q.id] : []
                          set(q.id, selected ? cur.filter((x: string) => x !== optStr) : [...cur, optStr])
                        } else {
                          set(q.id, optStr)
                        }
                      }}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition-all ${
                        selected
                          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                          : 'border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-600 hover:border-surface-300'
                      }`}
                    >{label}</button>
                  )
                })}
                {(values[q.id] === OTHER || (Array.isArray(values[q.id]) && values[q.id].includes(OTHER))) && (
                  <input
                    type="text"
                    value={otherText[q.id] || ''}
                    onChange={e => setOtherText(p => ({ ...p, [q.id]: e.target.value }))}
                    placeholder={t('chat.questions.otherPlaceholder')}
                    className="flex-1 min-w-[200px] px-3 py-1.5 text-sm rounded-lg border border-surface-200 bg-surface-0 dark:bg-surface-50 focus:outline-none focus:ring-2 focus:ring-brand-200"
                  />
                )}
              </div>
            )}

            {q.kind === 'svg-options' && (
              <div className="grid grid-cols-2 gap-2.5">
                {q.options.map((opt: SvgOption) => {
                  // 双保险：normalize 理应已经丢弃无 value 的元素，这里再兜一次防坏数据崩渲染
                  if (!opt?.value) return null
                  const selected = values[q.id] === opt.value
                  const previewKey = `${q.id}::${opt.value}`
                  // 规范化漏网的预览（解析器差异、超大图解码失败）在 onError 里降级，
                  // 用户永远不该看到浏览器裂图图标。
                  const imageUrl = brokenPreviews[previewKey] ? null : questionsPreviewImageUrl(opt.svg)
                  return (
                    <button
                      key={opt.value}
                      onClick={() => set(q.id, opt.value)}
                      className={`rounded-lg border-2 p-2 transition-all text-left ${
                        selected
                          ? 'border-brand-500 ring-2 ring-brand-200'
                          : 'border-surface-200 hover:border-brand-300'
                      }`}
                      title={opt.label || opt.value}
                    >
                      <div className="w-full aspect-[80/56] rounded overflow-hidden">
                        {imageUrl
                          ? <img
                              src={imageUrl}
                              alt=""
                              draggable={false}
                              className="w-full h-full object-contain"
                              onError={() => setBrokenPreviews(prev => ({ ...prev, [previewKey]: true }))}
                            />
                          : (
                            <div className="w-full h-full bg-surface-100 dark:bg-surface-50 flex items-center justify-center px-2">
                              <span className="text-[11px] leading-tight text-surface-400 text-center line-clamp-3 break-words">
                                {opt.label || opt.value}
                              </span>
                            </div>
                          )}
                      </div>
                      {/* 无预览时选项名已经在占位卡里，不再重复一行 */}
                      {imageUrl && opt.label && <div className="text-[11px] text-surface-500 mt-1.5 truncate">{opt.label}</div>}
                    </button>
                  )
                })}
              </div>
            )}

            {q.kind === 'slider' && (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={q.min}
                  max={q.max}
                  step={q.step || 1}
                  value={values[q.id] ?? q.default ?? q.min}
                  onChange={e => set(q.id, Number(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-mono text-surface-500 w-16 text-right">
                  {values[q.id] ?? q.default ?? q.min}
                </span>
              </div>
            )}

            {q.kind === 'freeform' && (
              <textarea
                value={values[q.id] || ''}
                onChange={e => set(q.id, e.target.value)}
                placeholder={q.placeholder}
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-lg border border-surface-200 bg-surface-0 dark:bg-surface-50 resize-none focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            )}

            {q.kind === 'multi-chip' && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt: unknown) => {
                  // 双保险：见 text-options 分支同款强转注释
                  const optStr = typeof opt === 'string' ? opt : String((opt as any)?.label ?? (opt as any)?.value ?? '')
                  if (!optStr) return null
                  const cur: string[] = Array.isArray(values[q.id]) ? values[q.id] : []
                  const selected = cur.includes(optStr)
                  return (
                    <button
                      key={optStr}
                      onClick={() => set(q.id, selected ? cur.filter((x: string) => x !== optStr) : [...cur, optStr])}
                      className={`px-2.5 py-1 text-xs rounded-full border transition-all ${
                        selected
                          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                          : 'border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-500 hover:border-surface-300'
                      }`}
                    >{optStr}</button>
                  )
                })}
              </div>
            )}

            {/* 题内上传位——模型声明"这道题的最准答案是一份原件"时长在题下，材料随答案标注归属 */}
            {attachQuestionIds.has(q.id) && renderAttachZone(q.id, {
              hint: (q as any).attachHint || t('chat.questions.defaultAttachHint'),
              compact: true,
              testid: 'question-attach-zone'
            })}
          </div>
          )
        })}
        </div>

        {attachQuestions.length > 0 && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            data-testid="questions-file-input"
            className="hidden"
            onChange={handleFileInputChange}
          />
        )}
        </div>
      </div>

      {/* 底部操作栏（位于 scroll 区之外，始终可见） */}
      <div className="shrink-0 bg-surface-0 dark:bg-surface-50 border-t border-surface-100 px-5 py-3">
        <div className="mx-auto w-full max-w-[680px] flex flex-col gap-2">
        {showMissing && missingRequired.length > 0 && (
          <p data-testid="questions-required-notice" className="text-[11px] text-amber-600 dark:text-amber-400">
            {t('chat.questions.requiredNotice', { count: missingRequired.length })}
          </p>
        )}
        {streaming ? (
          <div
            data-testid="questions-streaming"
            className="w-full px-5 py-2 text-sm font-medium rounded-lg bg-surface-100 text-surface-400 flex items-center justify-center gap-2 cursor-default"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
            {t('chat.questions.generating')}
          </div>
        ) : (
          <button
            onClick={handleSubmit}
            className="w-full px-5 py-2 text-sm font-medium rounded-lg bg-brand-500 hover:bg-brand-600 text-ink-on-accent"
          >{t('chat.questions.submit')}</button>
        )}
        </div>
      </div>
    </div>
  )
}
