/**
 * 通用角色前置页 — 文件式架构驱动（Claude Design 风首页版式）
 *
 * 数据来源：~/.openpipal/system-agents/<role>/preflow.json
 * 角色没有这个文件 = 前置页不渲染（默认跳过）
 * design 是第一个消费者；其他角色自己落文件即可启用
 *
 * 版式（自上而下）：
 *   角色标识（左上）→ 衬线大标题 → 输入卡（textarea + 底行：+菜单 / 设计系统▾ / 模板▾ / 模型▾ / 发送）
 *   → "从模板开始…" 扇形类型卡组（hover 联动模板下拉）→ "…或直接开一个空白会话"（=跳过）
 *   → 库区：产物 / 设计系统 双 tab + 搜索 + 列表
 */

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { extractPastedImages } from '../utils/pasteImages'
import {
  X, Plus, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Check, Search, Image as ImageIcon, FolderGit2, FileCode, Link2,
  Layers, FileText, Presentation, Clapperboard, LayoutTemplate, Frame, Bot, ArrowRight, Mail, GitBranch, Palette, Folder
} from 'lucide-react'
import type { InitialAsset } from '../types'
import { RoleAvatar, type RoleAvatarRole } from './shared/RoleAvatar'
import { ModelControl } from './shared/ModelControl'
import { RoleArchiveViewer } from './RoleArchiveViewer'
import { stripDcSuffix } from '../utils/format'
import { DesignSystemView } from './artifacts/DesignSystemView'
import { formatLocaleDate } from '../i18n/formatters'
import {
  getPreflowOptionChoices,
  localizePreflowFieldValue,
  resolvePreflowManifest,
  type PreflowField,
  type PreflowManifest,
} from '../i18n/preflowManifest'

export type { PreflowField, PreflowManifest, PreflowTplOption } from '../i18n/preflowManifest'

export interface PreflowSubmitData {
  projectName?: string
  roleBrief: Record<string, any>
  initialAssets: InitialAsset[]
  /** 用户直接在前置页输入框写的首条消息；有值则提交后直接开聊 */
  initialMessage?: string
  /** 前置页输入框粘贴的剪贴板图片（base64，无 data: 前缀）——随首条消息一起发出 */
  initialImages?: string[]
  /** 前置页选中的模型预设 id（会话专属，不碰全局）——未选则缺省，会话跟随全局默认 */
  modelPresetId?: string
}

interface ArtifactHistoryItem {
  id: string
  type: string
  title: string
  conversationId: string
  conversationTitle: string
  updatedAt: number
  thumbnail?: string
}

interface Props {
  roleName: string
  roleDisplayName: string
  roleIcon: string
  /** 有则用 RoleAvatar 渲染角色标识（含用户上传的 avatar.png），无则回落 emoji icon */
  role?: RoleAvatarRole
  manifest: PreflowManifest
  onSubmit: (data: PreflowSubmitData) => void
  onSkip: () => void
  /** 点击历史产物 → 打开原会话 */
  onOpenConversation?: (conversationId: string) => void
}

const CONTEXT_BUTTON_META: Record<string, { icon: any; category: InitialAsset['category'] }> = {
  brand:      { icon: FolderGit2, category: 'brand' },
  screenshot: { icon: ImageIcon,  category: 'refs'  },
  codebase:   { icon: FileCode,   category: 'kits'  },
  figma:      { icon: Link2,      category: 'refs' }
}

/** 模板卡迷你示意图 — 按选项文案启发式匹配 */
type TypeVisual = 'proto' | 'deck' | 'doc' | 'wireframe' | 'motion' | 'email' | 'diagram' | 'pairing' | 'object3d' | 'generic'
function visualFor(option: string): TypeVisual {
  if (/线框|wireframe|lofi/i.test(option)) return 'wireframe'
  if (/邮件|email|mail/i.test(option)) return 'email'
  if (/3d|三维|物体|object3d/i.test(option)) return 'object3d'
  if (/图表|示意图|diagram|流程|flow/i.test(option)) return 'diagram'
  if (/配色|pairing|palette|type pairing/i.test(option)) return 'pairing'
  if (/三折页|折页|brochure|trifold/i.test(option)) return 'doc'
  if (/原型|prototype|landing|界面|proto|mockup/i.test(option)) return 'proto'
  if (/幻灯|deck|slide|演示/i.test(option)) return 'deck'
  if (/文档|doc\b|打印|pdf|规范|简历|résumé|resume|研究|research|传单|flier|flyer/i.test(option)) return 'doc'
  if (/动画|motion|视频|anim/i.test(option)) return 'motion'
  return 'generic'
}

const TYPE_FALLBACK_ICON: Record<TypeVisual, any> = {
  proto: LayoutTemplate, deck: Presentation, doc: FileText, wireframe: Frame, motion: Clapperboard,
  email: Mail, diagram: GitBranch, pairing: Palette, object3d: Layers, generic: Layers
}

function TypeCardVisual({ kind }: { kind: TypeVisual }) {
  // 纯 CSS 迷你示意——不是装饰，是让几类产物一眼可辨
  if (kind === 'proto') {
    return (
      <div className="w-full h-14 rounded-md bg-white dark:bg-surface-100 border border-border dark:border-surface-200 overflow-hidden">
        <div className="h-3 bg-surface-200 flex items-center gap-0.5 px-1.5">
          <span className="w-1 h-1 rounded-full bg-surface-400" />
          <span className="w-1 h-1 rounded-full bg-surface-400" />
        </div>
        <div className="p-1.5 flex gap-1.5">
          <div className="w-1/3 space-y-1">
            <div className="h-1.5 rounded-sm bg-[#A8BB87] dark:bg-brand-700" />
            <div className="h-1.5 rounded-sm bg-surface-300 dark:bg-surface-200" />
            <div className="h-1.5 rounded-sm bg-surface-300 dark:bg-surface-200" />
          </div>
          <div className="flex-1 rounded-sm bg-surface-200" />
        </div>
      </div>
    )
  }
  if (kind === 'deck') {
    return (
      <div className="w-full h-14 flex flex-col gap-1">
        <div className="flex-1 rounded-md bg-surface-700 flex flex-col justify-center px-2 gap-1">
          <div className="h-1.5 w-2/3 rounded-sm bg-white/80" />
          <div className="h-1 w-1/3 rounded-sm bg-[#A8BB87]" />
        </div>
        <div className="flex gap-1">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className={`h-2 flex-1 rounded-sm ${i === 0 ? 'bg-[#A8BB87]' : 'bg-surface-300 dark:bg-surface-200'}`} />
          ))}
        </div>
      </div>
    )
  }
  if (kind === 'doc') {
    return (
      <div className="w-full h-14 flex justify-center">
        <div className="h-full aspect-[3/4] rounded-sm bg-white dark:bg-surface-100 border border-border dark:border-surface-200 shadow-sm p-1.5 space-y-1">
          <div className="h-1.5 w-2/3 rounded-sm bg-surface-700 dark:bg-surface-200" />
          <div className="h-1 rounded-sm bg-surface-300" />
          <div className="h-1 rounded-sm bg-surface-300" />
          <div className="h-1 w-3/4 rounded-sm bg-surface-300" />
          <div className="h-2.5 rounded-sm bg-[#DCE5CB] dark:bg-brand-800" />
        </div>
      </div>
    )
  }
  if (kind === 'wireframe') {
    return (
      <div className="w-full h-14 rounded-md bg-white dark:bg-surface-100 border border-dashed border-surface-400 dark:border-surface-300 p-1.5 space-y-1">
        <div className="h-3 rounded-sm border border-dashed border-surface-400 dark:border-surface-300 relative overflow-hidden">
          <svg className="absolute inset-0 w-full h-full text-surface-300" preserveAspectRatio="none" viewBox="0 0 40 10"><path d="M0 0 L40 10 M40 0 L0 10" stroke="currentColor" strokeWidth="0.6" /></svg>
        </div>
        <div className="flex gap-1">
          <div className="h-4 flex-1 rounded-sm border border-dashed border-surface-400 dark:border-surface-300" />
          <div className="h-4 flex-1 rounded-sm border border-dashed border-surface-400 dark:border-surface-300" />
        </div>
      </div>
    )
  }
  if (kind === 'motion') {
    return (
      <div className="w-full h-14 rounded-md bg-surface-700 relative overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center">
            <div className="w-0 h-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-white/90 ml-0.5" />
          </div>
        </div>
        <div className="absolute bottom-1.5 left-2 right-2 h-1 rounded-full bg-white/20">
          <div className="h-full w-1/3 rounded-full bg-[#A8BB87]" />
        </div>
      </div>
    )
  }
  if (kind === 'email') {
    return (
      <div className="w-full h-14 rounded-md bg-white dark:bg-surface-100 border border-border dark:border-surface-200 p-1.5 flex flex-col gap-1">
        <div className="h-2 rounded-sm bg-surface-700 dark:bg-surface-300" />
        <div className="h-1 w-3/4 rounded-sm bg-surface-300 dark:bg-surface-200" />
        <div className="h-1 w-2/3 rounded-sm bg-surface-300 dark:bg-surface-200" />
        <div className="h-2.5 w-1/2 mx-auto rounded-full bg-[#A8BB87]" />
      </div>
    )
  }
  if (kind === 'diagram') {
    return (
      <div className="w-full h-14 rounded-md bg-white dark:bg-surface-100 border border-border dark:border-surface-200 relative overflow-hidden">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 56 32">
          <path d="M12 8 H24 M28 12 V20 M32 24 H44" className="stroke-surface-400" strokeWidth="1" fill="none" />
          <rect x="4" y="4" width="12" height="8" rx="2" fill="#DCE5CB" />
          <rect x="22" y="8" width="12" height="8" rx="2" className="fill-surface-200 stroke-surface-400" strokeWidth="0.8" />
          <rect x="40" y="20" width="12" height="8" rx="2" fill="#A8BB87" />
        </svg>
      </div>
    )
  }
  if (kind === 'object3d') {
    // 等距小立方体：顶面/左面/右面三色
    return (
      <div className="w-full h-14 rounded-md bg-surface-700 flex items-center justify-center">
        <div className="relative w-8 h-8">
          <div className="absolute left-1/2 top-0 w-5 h-5 -translate-x-1/2 rotate-45 scale-y-[0.58] bg-[#DCE5CB]" />
          <div className="absolute left-1/2 top-[9px] w-[10px] h-[14px] -translate-x-full skew-y-[26deg] bg-[#A8BB87]" />
          <div className="absolute left-1/2 top-[9px] w-[10px] h-[14px] -skew-y-[26deg] bg-[#6F864F]" />
        </div>
      </div>
    )
  }
  if (kind === 'pairing') {
    return (
      <div className="w-full h-14 rounded-md bg-white dark:bg-surface-100 border border-border dark:border-surface-200 p-1.5 flex gap-1.5 items-stretch">
        <div className="flex-1 flex flex-col justify-center">
          <div className="text-[13px] leading-none font-serif text-ink-primary dark:text-surface-600">Aa</div>
          <div className="text-[9px] leading-tight text-ink-tertiary">Aa</div>
        </div>
        <div className="flex flex-col gap-0.5 w-1/2">
          <div className="flex-1 rounded-sm bg-surface-700" />
          <div className="flex-1 rounded-sm bg-[#A8BB87]" />
          <div className="flex-1 rounded-sm bg-surface-300 dark:bg-surface-200" />
          <div className="flex-1 rounded-sm bg-surface-200 dark:bg-surface-300" />
        </div>
      </div>
    )
  }
  const Icon = TYPE_FALLBACK_ICON.generic
  return (
    <div className="w-full h-14 rounded-md bg-surface-200 dark:bg-surface-100 flex items-center justify-center">
      <Icon className="w-5 h-5 text-surface-400" strokeWidth={1.75} />
    </div>
  )
}

type OpenMenu = 'plus' | 'ds' | 'tpl' | 'model' | null
type BuiltInInputPrompt =
  | { kind: 'design-system' }
  | { kind: 'role-system-create' }
  | { kind: 'role-system-manage'; name: string }

const dropdownBtnCls = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border dark:border-surface-400 bg-white dark:bg-surface-50 hover:border-surface-400 dark:hover:border-surface-300 transition-colors text-left'
const menuCls = 'absolute bottom-full left-0 mb-1.5 min-w-[220px] op-menu py-1 z-50 animate-fade-in'
const fanArrowCls = 'absolute top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-white dark:bg-surface-50 border border-border dark:border-surface-200 shadow-sm flex items-center justify-center text-ink-tertiary hover:text-[#586B3F] hover:border-[#A8BB87] active:scale-95 transition-all'
const menuItemCls = 'w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-surface-100 transition-colors text-ink-primary dark:text-surface-600'

/** 输入卡底行的下拉：小标签 + ChevronDown + 当前值 触发上弹菜单。设计系统/模板/模型三处共用同一版式 */
function PreflowDropdown({
  open, onToggle, triggerTestId, menuTestId, label, value, valueClassName, triggerExtra, menuClassName, children
}: {
  open: boolean
  onToggle: () => void
  triggerTestId: string
  menuTestId: string
  label: React.ReactNode
  value: React.ReactNode
  valueClassName: string
  triggerExtra?: Record<string, string>
  menuClassName?: string
  children: React.ReactNode
}) {
  return (
    <div className="relative">
      <button onClick={onToggle} data-testid={triggerTestId} className={dropdownBtnCls} {...triggerExtra}>
        <span className="text-left">
          <span className="flex items-center gap-1 text-[10px] text-ink-tertiary">{label} <ChevronDown className="w-3 h-3" /></span>
          <span className={valueClassName}>{value}</span>
        </span>
      </button>
      {open && <div className={menuClassName || menuCls} data-testid={menuTestId}>{children}</div>}
    </div>
  )
}

export function RolePreflowPanel({ roleName, roleIcon, roleDisplayName, role, manifest, onSubmit, onSkip, onOpenConversation }: Props) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' || i18n.language.startsWith('en') ? 'en' : 'zh-CN'
  const displayManifest = useMemo(
    () => resolvePreflowManifest(manifest, locale),
    [manifest, locale]
  )
  const [projectName, setProjectName] = useState('')
  const [input, setInput] = useState('')
  // Built-in prompts track semantic intent so an untouched scaffold follows an
  // immediate locale switch. The first user edit clears this marker and the
  // user's text then remains verbatim.
  const [builtInInputPrompt, setBuiltInInputPrompt] = useState<BuiltInInputPrompt | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {}
    for (const f of manifest.fields || []) {
      if (f.default !== undefined) init[f.id] = f.default
    }
    return init
  })
  const [assets, setAssets] = useState<InitialAsset[]>([])
  const [uploading, setUploading] = useState(false)
  // 模板卡 hover 只是视觉预览（浮起），不改选值——曾经 onMouseEnter 直接 setFieldValue，
  // 鼠标在提交前扫过别的卡会静默覆盖用户点选的模板
  const [hoverType, setHoverType] = useState<string | null>(null)
  // 轮盘起点（可见窗口的第一张卡在全量选项里的下标）；选项 ≤5 时不启用轮盘
  const [fanStart, setFanStart] = useState(0)
  const fanRowRef = useRef<HTMLDivElement>(null)

  // 设计系统：资产库里含 SKILL.md 的子文件夹。有 → 默认选中第一个；无 → 下拉只有"不使用/生成"
  const [dsList, setDsList] = useState<Array<{ name: string; path: string }>>([])
  const [selectedDsPath, setSelectedDsPath] = useState<string | null>(null)

  // 教学风格的会话选用态：'all' = 全部作为个人偏好提供给 Teacher Agent（缺省），
  // 'none' = 本会话不用，具体 path = 只提供那一套。它不是学校规定或强制模板。
  const [roleSystemChoice, setRoleSystemChoice] = useState<'all' | 'none' | string>('all')
  // 角色资产库子文件夹里的长期档案（dsSelector 关闭的角色用，如 teacher 教学风格）
  const [roleSystems, setRoleSystems] = useState<Array<{ name: string; path: string; description?: string; entryFile?: string }>>([])

  // 模型（会话专属：本地记选择，随 onSubmit 带出去落进本会话 config，绝不切全局）
  const [modelName, setModelName] = useState('')
  const [modelIsBuiltin, setModelIsBuiltin] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; model: string; active: boolean; supportsThinking?: boolean; supportsEffortDial?: boolean; providerName?: string; builtin?: boolean }>>([])
  // 前置页选中的预设 id；未选（undefined）则下拉沿用全局当前模型名，提交时不带 modelPresetId
  const [selectedModelPresetId, setSelectedModelPresetId] = useState<string | undefined>(undefined)

  // 库区
  const [history, setHistory] = useState<ArtifactHistoryItem[]>([])
  const [libTab, setLibTab] = useState<'products' | 'systems'>('products')
  const [libQuery, setLibQuery] = useState('')

  // 教学风格内容预览：非空 = overlay 打开；内容只读，修改回到 Teacher Agent 对话完成
  const [previewArchive, setPreviewArchive] = useState<{ name: string; path: string; entryFile?: string } | null>(null)
  // 设计系统全屏画廊预览：非空 = overlay 打开，值为被预览的系统（name 传给 DesignSystemGallery）
  const [previewDs, setPreviewDs] = useState<{ name: string; path: string } | null>(null)

  // 弹出菜单（同时只开一个）/ Figma 内嵌输入
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const menuRootRef = useRef<HTMLDivElement>(null)
  const [figmaUrlOpen, setFigmaUrlOpen] = useState(false)
  const [figmaUrl, setFigmaUrl] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 粘贴的剪贴板图片（base64，无 data: 前缀）——与聊天 InputBar 同一管道，随首条消息发出
  const [images, setImages] = useState<string[]>([])
  const handlePaste = (e: ClipboardEvent) => extractPastedImages(e, (b64) => setImages(prev => [...prev, b64]))

  const allowSkip = manifest.allowSkip !== false
  const showProjectName = manifest.projectName?.enabled === true
  // 设计系统下拉——缺省开（design 现状），显式 false 才关（teacher 等非设计角色）
  const dsSelectorEnabled = manifest.dsSelector?.enabled !== false
  const artifactsTabLabel = displayManifest.libraryTabs?.artifacts || t('chat.preflow.libraryTabs.artifacts')
  const systemsTabLabel = displayManifest.libraryTabs?.systems || t('chat.preflow.libraryTabs.systems')

  const cardsField = (manifest.fields || []).find(f => f.display === 'cards' && f.kind === 'text-options' && !f.multi)
  const displayCardsField = displayManifest.fields?.find(field => field.id === cardsField?.id)
  const otherFields = (manifest.fields || []).filter(f => f !== cardsField)
  const currentType: string | undefined = cardsField ? fieldValues[cardsField.id] : undefined
  const currentTypeLabel = cardsField
    ? localizePreflowFieldValue(cardsField, displayCardsField, currentType) as string | undefined
    : undefined
  const hoverTypeLabel = cardsField
    ? localizePreflowFieldValue(cardsField, displayCardsField, hoverType) as string | null
    : null
  // 选项的 value 永远来自原始 manifest；label/subtitle/placeholder 来自当前语言展示层。
  const cardOptions = getPreflowOptionChoices(cardsField, displayCardsField)
  // 选中模板的官方 placeholder 联动输入框占位文案（抓包原文；未选/无配置回落 manifest 全局占位）
  const tplPlaceholder = currentType
    ? cardOptions.find(option => option.value === currentType)?.placeholder
    : undefined
  // 轮盘派生量（原为 JSX 内 IIFE——普通组件体常量即可，无需立即执行函数包装）
  const FAN_WINDOW = 5
  const fanWheel = cardOptions.length > FAN_WINDOW
  const fanVisible = fanWheel
    ? Array.from({ length: FAN_WINDOW }, (_, i) => cardOptions[((fanStart + i) % cardOptions.length + cardOptions.length) % cardOptions.length])
    : cardOptions
  // 整盘切换：一次翻一屏（5 张），整组以远心低点为轴做轮盘式转入动画
  const fanFlip = (dir: 1 | -1): void => {
    const n = cardOptions.length
    setFanStart(s => ((s + dir * FAN_WINDOW) % n + n) % n)
    requestAnimationFrame(() => {
      fanRowRef.current?.animate(
        [
          { transform: `rotate(${dir * 6}deg) translateX(${dir * 72}px)`, opacity: 0.3 },
          { transform: 'none', opacity: 1 }
        ],
        { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      )
    })
  }
  const selectedDs = dsList.find(d => d.path === selectedDsPath) || null

  useEffect(() => { textareaRef.current?.focus() }, [])

  useEffect(() => {
    if (!builtInInputPrompt) return
    if (builtInInputPrompt.kind === 'design-system') {
      setInput(t('chat.preflow.designSystem.scaffold'))
    } else if (builtInInputPrompt.kind === 'role-system-create') {
      setInput(displayManifest.systemsCreate?.kickoff || t('chat.preflow.roleSystems.createTeachingStyleKickoff'))
    } else {
      setInput(t('chat.preflow.roleSystems.managePrompt', { name: builtInInputPrompt.name }))
    }
  }, [builtInInputPrompt, displayManifest.systemsCreate?.kickoff, locale, t])

  useEffect(() => {
    let cancelled = false
    // dsSelector 关闭的角色跳过设计系统发现——不默认选中，库区"系统" tab 也不展示这份数据
    if (dsSelectorEnabled) {
      (window.api as any).listDesignSystems?.().then((ds: any) => {
        if (cancelled || !Array.isArray(ds)) return
        setDsList(ds)
        setSelectedDsPath(ds.length > 0 ? ds[0].path : null) // 有设计系统 → 默认选中
      }).catch(() => {})
    } else {
      // dsSelector 关闭的角色（如 teacher）改读角色资产库子文件夹（教学风格等）；浏览器 shim 无此端点
      ;(window.api as any)?.listRoleSystems?.().then((list: any) => {
        if (cancelled || !Array.isArray(list)) return
        setRoleSystems(list)
        // 一套都没有 → 库区默认落在"系统" tab：空态本身是最强的引导位，创建入口不该藏在第二个 tab 后面
        if (list.length === 0) setLibTab('systems')
      }).catch(() => {})
    }
    ;(window.api as any).listArtifactHistory?.(roleName, 18).then((items: any) => {
      if (!cancelled && Array.isArray(items)) setHistory(items)
    }).catch(() => {})
    window.api.getModelConfigFull?.().then((mc: any) => {
      if (!cancelled && mc) { setModelName(mc.model || ''); setModelIsBuiltin(!!mc.builtin) }
    }).catch(() => {})
    window.api.getAvailableModels?.().then((ms: any) => { if (!cancelled && Array.isArray(ms)) setAvailableModels(ms) }).catch(() => {})
    return () => { cancelled = true }
  }, [roleName])

  useEffect(() => {
    if (!openMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRootRef.current && !menuRootRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenu])

  useEffect(() => {
    if (!previewDs) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewDs(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewDs])

  const handleFieldChange = (id: string, value: any): void => {
    setFieldValues(v => ({ ...v, [id]: value }))
  }

  const handleContextClick = async (kind: string): Promise<void> => {
    const meta = CONTEXT_BUTTON_META[kind]
    if (!meta) return
    setOpenMenu(null)
    if (kind === 'figma') { setFigmaUrlOpen(true); return }
    try {
      setUploading(true)
      // 代码库 = 选文件夹，只登记路径引用（渐进式披露：agent 用 ls/read 按需读，不拷贝不解压）
      const accept = kind === 'screenshot' ? 'image' : kind === 'codebase' ? 'folder' : 'any'
      const paths = await window.api.openFileDialog?.(accept)
      if (!paths || paths.length === 0) return
      for (const p of paths) {
        if (kind === 'codebase') {
          const folderName = p.replace(/\/+$/, '').split('/').pop() || p
          setAssets(prev => [...prev, { category: meta.category, fileName: folderName, path: p, sourceType: 'codebase' }])
          continue
        }
        const asset = await window.api.uploadAssetToCategory?.(p, meta.category)
        if (asset) setAssets(prev => [...prev, asset as InitialAsset])
      }
    } catch (err: any) {
      console.error('上传失败:', err)
    } finally {
      setUploading(false)
    }
  }

  const handleFigmaSubmit = (): void => {
    const url = figmaUrl.trim()
    if (!url) { setFigmaUrlOpen(false); return }
    if (!/figma\.com\/(file|design|proto)\//i.test(url)) {
      console.warn('Figma URL 格式可能不对:', url)
    }
    let fileName = 'figma-link'
    try {
      const m = url.match(/figma\.com\/(?:file|design|proto)\/[^/]+\/([^?/]+)/i)
      if (m && m[1]) fileName = decodeURIComponent(m[1]).slice(0, 60)
    } catch { /* ignore */ }
    setAssets(prev => [...prev, { category: 'refs', fileName: `${fileName} (Figma)`, path: url, sourceType: 'figma' }])
    setFigmaUrl('')
    setFigmaUrlOpen(false)
  }

  const removeAsset = async (path: string): Promise<void> => {
    try {
      await window.api.deleteAsset?.(path)
      setAssets(prev => prev.filter(a => a.path !== path))
    } catch { /* 删失败就不管了，用户可以刷新 */ }
  }

  const handleSwitchModel = (id: string): void => {
    setOpenMenu(null)
    // 会话专属：只记本地选择 + 更新下拉显示名。绝不调 switchModelPreset——那会改全局 config，
    // 波及其他会话、甚至把运行中的会话翻转到别的模型（本 bug 的根因）。真正落地在 onSubmit → 本会话 config。
    setSelectedModelPresetId(id)
    const target = availableModels.find(m => m.id === id)
    if (target) setModelName(target.model || '')
  }

  /** overrideMessage：系统 tab 的"创建教学风格"按钮等场景，用 kickoff 文案顶替输入框内容提交（其余字段照常收集） */
  const handleStart = (overrideMessage?: string): void => {
    const roleBrief: Record<string, any> = {}
    for (const f of manifest.fields || []) {
      if (fieldValues[f.id] !== undefined) {
        // fieldValues always stores the base manifest value. Keep that stable
        // product/runtime contract in roleBrief even when the visible label is
        // localized (for example 动画 is displayed as Animation). Runtime
        // guards and role instructions intentionally key off the stable value.
        roleBrief[f.id] = fieldValues[f.id]
      }
    }
    const dsAssets: InitialAsset[] = selectedDs
      ? [{ category: 'design-system', fileName: selectedDs.name, path: selectedDs.path, sourceType: 'library' }]
      : []
    // 角色长期档案（如教师个人教学风格）走同一根简报管道。默认提供给角色作为个人偏好参考，
    // 用户也能针对本次会话关闭或只选一套；当前任务、班级与学生的真实情况仍优先。
    const roleSystemAssets: InitialAsset[] = dsSelectorEnabled || roleSystemChoice === 'none'
      ? []
      : roleSystems
          .filter(s => roleSystemChoice === 'all' || s.path === roleSystemChoice)
          .map(s => ({ category: 'role-system' as const, fileName: s.name, path: s.path, sourceType: 'library' as const }))
    onSubmit({
      projectName: projectName.trim() || undefined,
      roleBrief,
      initialAssets: [...dsAssets, ...roleSystemAssets, ...assets],
      initialMessage: (overrideMessage ?? input).trim() || undefined,
      initialImages: images.length ? images : undefined,
      modelPresetId: selectedModelPresetId
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleStart()
    }
  }

  const libProducts = history.filter(h => !libQuery || h.title.toLowerCase().includes(libQuery.toLowerCase()))
  const libSystems = dsList.filter(d => !libQuery || d.name.toLowerCase().includes(libQuery.toLowerCase()))
  const libRoleSystems = roleSystems.filter(s => !libQuery || s.name.toLowerCase().includes(libQuery.toLowerCase()) || (s.description || '').toLowerCase().includes(libQuery.toLowerCase()))
  // 日期 label 只依赖不可变的 history，预算一次，避免每次渲染逐行重跑 toLocaleDateString(Intl)
  const dateLabels = useMemo(() => {
    const m: Record<string, string> = {}
    for (const h of history) {
      m[h.id] = formatLocaleDate(h.updatedAt, locale, { month: 'numeric', day: 'numeric' })
    }
    return m
  }, [history, locale])

  return (
    <div className="flex-1 overflow-y-auto min-h-0 bg-surface-0" data-testid="preflow-composer">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 pb-10">

        {/* 角色标识（左上，wordmark 位） */}
        <div className="flex items-center gap-2 mb-8">
          <div className="w-7 h-7 rounded-full bg-surface-100 dark:bg-surface-50 flex items-center justify-center overflow-hidden">
            {role
              ? <RoleAvatar role={role} size={16} className="text-brand-500 dark:text-brand-300" imgClassName="w-full h-full rounded-full object-cover" />
              : <span className="text-sm">{roleIcon}</span>}
          </div>
          <span className="text-[14px] font-semibold text-ink-primary dark:text-surface-700">{roleDisplayName}</span>
        </div>

        {/* 衬线大标题 */}
        <h1
          data-testid="preflow-headline"
          className="font-serif text-[clamp(1.75rem,4vw,2.125rem)] leading-tight text-center text-ink-primary dark:text-surface-700 mb-7 tracking-tight break-words"
        >
          {displayManifest.title || t('chat.preflow.newTask', { role: roleDisplayName })}
        </h1>

        {/* 输入卡 */}
        <div className="bg-white dark:bg-surface-50 border border-surface-100 rounded-2xl shadow-sm mb-8" ref={menuRootRef}>
          {/* 已传资产 chips */}
          {assets.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {assets.map(a => (
                <span key={a.path} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-surface-50 dark:bg-surface-100 text-ink-secondary dark:text-surface-300">
                  {a.sourceType === 'figma' ? <Link2 className="w-3 h-3" /> : a.sourceType === 'codebase' ? <FolderGit2 className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                  <span className="max-w-[160px] truncate">{a.fileName}</span>
                  <button onClick={() => removeAsset(a.path)} className="ml-0.5 text-surface-300 hover:text-red-500"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}

          {showProjectName && (
            <input
              type="text"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder={displayManifest.projectName?.placeholder || t('chat.preflow.projectNamePlaceholder')}
              data-testid="preflow-project-name"
              className="w-full px-5 pt-3 text-[12px] bg-transparent outline-none text-ink-secondary placeholder:text-surface-300"
            />
          )}

          {images.length > 0 && (
            <div className="flex items-center gap-1.5 px-5 pt-3 flex-wrap">
              {images.map((img, i) => (
                <div key={`i${i}`} className="relative group">
                  <img src={`data:image/jpeg;base64,${img}`} alt="" className="w-10 h-10 object-cover rounded border border-border dark:border-surface-200" />
                  <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))} className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-surface-600 text-white rounded-full flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => {
              setBuiltInInputPrompt(null)
              setInput(e.target.value)
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={tplPlaceholder || displayManifest.inputPlaceholder || t('chat.preflow.inputPlaceholder')}
            rows={2}
            data-testid="preflow-input"
            className="w-full px-5 pt-4 pb-2 text-[15px] text-ink-primary placeholder:text-surface-400 bg-transparent resize-none outline-none"
          />

          <div className="flex items-center gap-2 px-3.5 pb-3.5 pt-1 flex-wrap">
            {/* + 号：4 类资料 */}
            <div className="relative">
              <button
                onClick={() => setOpenMenu(m => m === 'plus' ? null : 'plus')}
                disabled={uploading || !manifest.contextButtons?.length}
                data-testid="preflow-plus-btn"
                title={t('chat.preflow.addResourcesTitle')}
                className="w-9 h-9 rounded-lg border border-border dark:border-surface-200 flex items-center justify-center text-ink-tertiary hover:text-brand-500 hover:border-brand-300 transition-colors disabled:opacity-40 bg-white dark:bg-surface-50"
              >
                <Plus className={`w-4 h-4 ${uploading ? 'animate-pulse' : ''}`} />
              </button>
              {openMenu === 'plus' && (
                <div className={menuCls} data-testid="preflow-plus-menu">
                  {(displayManifest.contextButtons || []).map(entry => {
                    // 字符串 = 内置文案；对象 = 同一上传通道、角色自定义文案（teacher 不说"品牌资产"）
                    const kind = typeof entry === 'string' ? entry : entry.kind
                    const meta = CONTEXT_BUTTON_META[kind]
                    if (!meta) return null
                    const label = (typeof entry === 'object' && entry.label) || t(`chat.preflow.context.${kind}.label`)
                    const subtitle = (typeof entry === 'object' && entry.subtitle) || t(`chat.preflow.context.${kind}.subtitle`)
                    const Icon = meta.icon
                    return (
                      <button key={kind} onClick={() => handleContextClick(kind)} className={`${menuItemCls} py-2`}>
                        <Icon className="w-4 h-4 text-brand-500 shrink-0" strokeWidth={1.75} />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-medium">{label}</span>
                          <span className="block text-[10px] text-ink-tertiary truncate">{subtitle}</span>
                        </span>
                      </button>
                    )
                  })}
                  <div className="px-3 pt-1.5 pb-1 text-[10px] text-surface-400 border-t border-surface-100 mt-1">
                    {t('chat.preflow.uploadedReusableHint')}
                  </div>
                </div>
              )}
            </div>

            {/* 设计系统 ▾（dsSelector 关闭的角色不渲染——"生成新设计系统…"入口随之一起消失） */}
            {dsSelectorEnabled && (
              <PreflowDropdown
                open={openMenu === 'ds'}
                onToggle={() => setOpenMenu(m => m === 'ds' ? null : 'ds')}
                triggerTestId="preflow-ds-select"
                triggerExtra={{ 'data-ds-selected': selectedDs ? 'true' : 'false' }}
                menuTestId="preflow-ds-menu"
                label={t('chat.preflow.designSystem.label')}
                value={selectedDs ? selectedDs.name : t('chat.preflow.designSystem.noUse')}
                valueClassName={`block text-[12px] font-medium ${selectedDs ? 'text-ink-primary dark:text-surface-700' : 'text-surface-400'}`}
              >
                {dsList.map(d => (
                  <button key={d.path} onClick={() => { setSelectedDsPath(d.path); setOpenMenu(null) }} className={menuItemCls}>
                    <Layers className="w-3.5 h-3.5 text-brand-500 shrink-0" strokeWidth={1.75} />
                    <span className="truncate flex-1">{d.name}</span>
                    {selectedDsPath === d.path && <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />}
                  </button>
                ))}
                <button onClick={() => { setSelectedDsPath(null); setOpenMenu(null) }} className={menuItemCls}>
                  <span className="w-3.5" />
                  <span className="flex-1 text-ink-tertiary">{t('chat.preflow.designSystem.noUse')}</span>
                  {!selectedDs && <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />}
                </button>
                <div className="border-t border-surface-100 mt-1 pt-1">
                  <button
                    data-testid="preflow-ds-generate"
                    onClick={() => {
                      setSelectedDsPath(null)
                      setBuiltInInputPrompt({ kind: 'design-system' })
                      setInput(t('chat.preflow.designSystem.scaffold'))
                      setOpenMenu(null)
                      textareaRef.current?.focus()
                    }}
                    className={menuItemCls}
                  >
                    <Plus className="w-3.5 h-3.5 text-brand-500 shrink-0" />
                    <span className="flex-1">{t('chat.preflow.designSystem.generate')}</span>
                  </button>
                </div>
              </PreflowDropdown>
            )}

            {/* 教学风格 ▾（dsSelector 关闭的角色用）。默认作为个人偏好参考，同时保持可见、可关闭。 */}
            {!dsSelectorEnabled && (roleSystems.length > 0 || displayManifest.systemsCreate) && (
              <PreflowDropdown
                open={openMenu === 'ds'}
                onToggle={() => setOpenMenu(m => m === 'ds' ? null : 'ds')}
                triggerTestId="preflow-role-system-select"
                menuTestId="preflow-role-system-menu"
                label={systemsTabLabel}
                value={
                  roleSystemChoice === 'none' ? t('chat.preflow.roleSystems.noUse')
                    : roleSystems.length === 0 ? t('chat.preflow.roleSystems.none')
                    : roleSystemChoice === 'all'
                      ? (roleSystems.length === 1
                          ? t('chat.preflow.roleSystems.singleAuto', { name: roleSystems[0].name })
                          : t('chat.preflow.roleSystems.allAuto', { count: roleSystems.length }))
                      : (roleSystems.find(s => s.path === roleSystemChoice)?.name || t('chat.preflow.roleSystems.auto'))
                }
                valueClassName={`block text-[12px] font-medium ${
                  roleSystemChoice !== 'none' && roleSystems.length > 0 ? 'text-ink-primary dark:text-surface-700' : 'text-surface-400'
                }`}
              >
                {roleSystems.length > 1 && (
                  <button onClick={() => { setRoleSystemChoice('all'); setOpenMenu(null) }} className={menuItemCls}>
                    <Layers className="w-3.5 h-3.5 text-brand-500 shrink-0" strokeWidth={1.75} />
                    <span className="flex-1">{t('chat.preflow.roleSystems.all')}</span>
                    {roleSystemChoice === 'all' && <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />}
                  </button>
                )}
                {roleSystems.map(s => (
                  <button key={s.path} onClick={() => { setRoleSystemChoice(roleSystems.length === 1 ? 'all' : s.path); setOpenMenu(null) }} className={menuItemCls}>
                    <Layers className="w-3.5 h-3.5 text-brand-500 shrink-0" strokeWidth={1.75} />
                    <span className="truncate flex-1">{s.name}</span>
                    {(roleSystemChoice === s.path || (roleSystemChoice === 'all' && roleSystems.length === 1)) &&
                      <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />}
                  </button>
                ))}
                {roleSystems.length > 0 && (
                  <button onClick={() => { setRoleSystemChoice('none'); setOpenMenu(null) }} className={menuItemCls}>
                    <span className="w-3.5" />
                    <span className="flex-1 text-ink-tertiary">{t('chat.preflow.roleSystems.noneForSession')}</span>
                    {roleSystemChoice === 'none' && <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />}
                  </button>
                )}
                {displayManifest.systemsCreate && (
                  <div className={roleSystems.length > 0 ? 'border-t border-surface-100 mt-1 pt-1' : ''}>
                    <button
                      data-testid="preflow-role-system-create"
                      onClick={() => {
                        // 与 design 的"生成新设计系统…"同模式：填入输入框可改可直接发，不直接开聊——
                        // 给用户确认缓冲；基本盘采集在对话里的选项卡完成，这句话只声明意图
                        setBuiltInInputPrompt({ kind: 'role-system-create' })
                        setInput(displayManifest.systemsCreate?.kickoff || t('chat.preflow.roleSystems.createTeachingStyleKickoff'))
                        setOpenMenu(null)
                        textareaRef.current?.focus()
                      }}
                      className={menuItemCls}
                    >
                      <Plus className="w-3.5 h-3.5 text-brand-500 shrink-0" />
                      <span className="flex-1">{displayManifest.systemsCreate.label || t('chat.preflow.roleSystems.createTeachingStyle')}…</span>
                    </button>
                  </div>
                )}
              </PreflowDropdown>
            )}

            {/* 模板 ▾（= cards 字段，与扇形卡组联动） */}
            {cardsField && (
              <PreflowDropdown
                open={openMenu === 'tpl'}
                onToggle={() => setOpenMenu(m => m === 'tpl' ? null : 'tpl')}
                triggerTestId="preflow-tpl-select"
                menuTestId="preflow-tpl-menu"
                label={displayCardsField?.title || cardsField.title}
                value={hoverTypeLabel ?? currentTypeLabel ?? t('chat.preflow.template.none')}
                valueClassName={`block text-[12px] font-medium ${
                  hoverType && hoverType !== currentType
                    ? 'text-ink-tertiary dark:text-surface-400' /* hover 预览态：联动显示但未提交，灰字示意 */
                    : currentType ? 'text-ink-primary dark:text-surface-700' : 'text-surface-400'
                }`}
                menuClassName="absolute top-full left-0 mt-1.5 w-[min(460px,calc(100vw-3rem))] max-h-[50vh] overflow-y-auto op-menu z-50 animate-fade-in"
              >
                {/* 两列排布：模板从 5 涨到 12，单列太长（官方文案 subtitle 一并展示） */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 p-1">
                  {cardOptions.map(meta => {
                    const Icon = TYPE_FALLBACK_ICON[visualFor(meta.label)]
                    return (
                      <button key={meta.value} onClick={() => { handleFieldChange(cardsField.id, meta.value); setOpenMenu(null) }} className={`${menuItemCls} rounded-md !items-start`}>
                        <Icon className="w-3.5 h-3.5 text-brand-500 shrink-0 mt-0.5" strokeWidth={1.75} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">{meta.label}</span>
                          {meta.subtitle && <span className="block text-[10px] text-surface-400 truncate">{meta.subtitle}</span>}
                        </span>
                        {currentType === meta.value && <Check className="w-3.5 h-3.5 text-brand-500 shrink-0 mt-0.5" />}
                      </button>
                    )
                  })}
                  <button onClick={() => { handleFieldChange(cardsField.id, undefined); setOpenMenu(null) }} className={`${menuItemCls} rounded-md col-span-2`}>
                    <span className="w-3.5" />
                    <span className="flex-1 text-ink-tertiary">{t('chat.preflow.template.none')}</span>
                    {!currentType && <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />}
                  </button>
                </div>
              </PreflowDropdown>
            )}

            <div className="flex-1" />

            {/* 模型+思考深度合一控件（与对话页/欢迎页同一组件）。
                preflow 语义：本地暂存选择、onSubmit 时随 modelPresetId 落进本会话 config，
                绝不改全局（历史 bug：改全局会翻转运行中的其他会话）；思考档位走会话配置同管道 */}
            {modelName && (() => {
              const effective = availableModels.find(m => selectedModelPresetId ? m.id === selectedModelPresetId : m.active)
              // effective 来自 getAvailableModels 哨兵列表，modelName 来自 get-model-full 展示口径
              //（两者对 builtin 均已在主进程遮蔽）；列表未加载时回落 modelIsBuiltin 判定
              const displayModel = (effective ? effective.builtin : modelIsBuiltin) ? t('chat.modelControl.builtinModel') : modelName
              return (
                <ModelControl
                  models={availableModels}
                  displayModel={displayModel}
                  supportsThinking={!!effective?.supportsThinking}
                  supportsDial={!!effective?.supportsEffortDial}
                  selectedId={selectedModelPresetId}
                  onSelectModel={(id) => { if (id) handleSwitchModel(id) }}
                  triggerTestId="preflow-model-select"
                  menuTestId="preflow-model-menu"
                />
              )
            })()}

            <button
              onClick={() => handleStart()}
              disabled={uploading}
              data-testid="preflow-start-btn"
              title={input.trim() ? t('chat.preflow.actions.startConversation') : t('chat.preflow.actions.saveBrief')}
              className="w-11 h-11 rounded-xl flex items-center justify-center bg-brand-500 text-ink-on-accent hover:bg-brand-600 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ArrowUp className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Figma URL 内嵌输入 */}
        {figmaUrlOpen && (
          <div className="rounded-lg border border-brand-300 bg-white/60 dark:bg-surface-50 p-3 mb-6 -mt-4">
            <div className="text-xs font-medium text-ink-secondary dark:text-surface-300 mb-2">{t('chat.preflow.figma.pasteLink')}</div>
            <div className="flex gap-2 flex-wrap">
              <input
                type="url"
                autoFocus
                value={figmaUrl}
                onChange={e => setFigmaUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleFigmaSubmit() }
                  if (e.key === 'Escape') { setFigmaUrl(''); setFigmaUrlOpen(false) }
                }}
                placeholder="https://www.figma.com/file/..."
                className="flex-1 min-w-[min(14rem,100%)] px-3 py-2 text-sm rounded-md border border-border dark:border-surface-100 bg-white dark:bg-surface-50 text-ink-primary placeholder:text-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <button onClick={handleFigmaSubmit} className="px-3 py-2 text-sm rounded-md bg-brand-500 hover:bg-brand-600 text-ink-on-accent">{t('chat.preflow.actions.add')}</button>
              <button onClick={() => { setFigmaUrl(''); setFigmaUrlOpen(false) }} className="px-2 py-2 text-sm rounded-md text-ink-tertiary hover:bg-surface-100 dark:hover:bg-surface-50">{t('chat.preflow.actions.cancel')}</button>
            </div>
          </div>
        )}

        {/* 扇形模板轮盘：一次展示 5 张，超过 5 个模板时左右箭头整盘循环切换 */}
        {cardsField && cardOptions.length > 0 && (
          <div className="mb-2">
            <p className="text-center text-[13px] text-ink-tertiary dark:text-surface-400 mb-4">{t('chat.preflow.template.startFrom')}</p>
            <div className="relative max-w-full mx-auto">
              {fanWheel && (
                <button onClick={() => fanFlip(-1)} data-testid="preflow-fan-prev" title={t('chat.preflow.template.previous')} className={`${fanArrowCls} left-1`}>
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              <div className="op-no-scrollbar max-w-full overflow-x-auto px-10 pt-4 pb-12">
                <div ref={fanRowRef} style={{ transformOrigin: '50% 280%' }} className="flex items-start w-max mx-auto" data-testid="preflow-type-cards" onMouseLeave={() => setHoverType(null)}>
                  {fanVisible.map((meta, idx) => {
                    const centered = idx - (fanVisible.length - 1) / 2
                    // 浮起动效跟 hover（预览），选中样式（ring/文字色）只认 click 后的 currentType
                    const active = (hoverType ?? currentType) === meta.value
                    return (
                      <button
                        key={meta.value}
                        onMouseEnter={() => setHoverType(meta.value)}
                        onClick={() => handleFieldChange(cardsField.id, meta.value)}
                        data-testid={`preflow-type-card-${idx}`}
                        style={{
                          transform: `rotate(${active ? 0 : centered * 4}deg) translateY(${active ? -8 : Math.abs(centered) * 14}px)`,
                          zIndex: active ? 10 : 1,
                          transition: 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)'
                        }}
                        className={`shrink-0 w-[140px] -ml-2 first:ml-0 p-2.5 pb-3 rounded-xl border text-center shadow-sm ${
                          currentType === meta.value
                            ? 'border-brand-300 bg-white dark:bg-surface-50 ring-1 ring-brand-500/20'
                            : 'border-surface-100 bg-white dark:bg-surface-50 hover:shadow-md'
                        }`}
                      >
                        <div className="rounded-lg bg-surface-50 dark:bg-surface-100 p-2 mb-2">
                          <TypeCardVisual kind={visualFor(meta.label)} />
                        </div>
                        <div className={`text-[12px] leading-snug font-semibold break-words ${currentType === meta.value ? 'text-brand-600 dark:text-brand-300' : 'text-ink-primary dark:text-surface-600'}`}>
                          {meta.label}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
              {fanWheel && (
                <button onClick={() => fanFlip(1)} data-testid="preflow-fan-next" title={t('chat.preflow.template.next')} className={`${fanArrowCls} right-1`}>
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* …或直接开一个空白会话——依附于"从模板开始"轮盘存在，fields 为空（无模板）时一起消失 */}
        {allowSkip && cardsField && (
          <div className="text-center mb-10 mt-6">
            <button
              onClick={onSkip}
              data-testid="preflow-blank-link"
              className="inline-flex items-center gap-1 text-[13px] text-ink-tertiary hover:text-ink-primary dark:hover:text-surface-700 transition-colors"
            >
              {t('chat.preflow.template.blankConversation')} <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 其余 manifest 字段（向后兼容：text-options pills / freeform） */}
        {otherFields.length > 0 && (
          <div className="space-y-5 mb-8">
            {otherFields.map(field => {
              const displayField = displayManifest.fields?.find(candidate => candidate.id === field.id) || field
              const choices = getPreflowOptionChoices(field, displayField)
              return (
              <div key={field.id}>
                <label className="block text-sm font-medium text-ink-primary dark:text-surface-600 mb-1">{displayField.title}</label>
                {displayField.subtitle && <p className="text-xs text-ink-tertiary mb-2">{displayField.subtitle}</p>}
                {field.kind === 'text-options' && (
                  <div className="flex flex-wrap gap-2">
                    {choices.map(choice => {
                      const opt = choice.value
                      const selected = field.multi
                        ? Array.isArray(fieldValues[field.id]) && fieldValues[field.id].includes(opt)
                        : fieldValues[field.id] === opt
                      return (
                        <button
                          key={opt}
                          onClick={() => {
                            if (field.multi) {
                              const cur: string[] = Array.isArray(fieldValues[field.id]) ? fieldValues[field.id] : []
                              handleFieldChange(field.id, selected ? cur.filter(x => x !== opt) : [...cur, opt])
                            } else {
                              handleFieldChange(field.id, opt)
                            }
                          }}
                          className={`px-3 py-1.5 text-sm rounded-lg border transition-all ${
                            selected
                              ? 'border-brand-300 bg-brand-500/[0.08] text-brand-600'
                              : 'border-border dark:border-surface-100 bg-white dark:bg-surface-50 text-ink-secondary dark:text-surface-300 hover:border-surface-300'
                          }`}
                        >
                          {choice.label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {field.kind === 'freeform' && (
                  <textarea
                    value={fieldValues[field.id] || ''}
                    onChange={e => handleFieldChange(field.id, e.target.value)}
                    placeholder={displayField.placeholder}
                    rows={3}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-border dark:border-surface-100 bg-white dark:bg-surface-50 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  />
                )}
              </div>
              )
            })}
          </div>
        )}

        {/* 库区：产物 / 设计系统（tab 文案可被 manifest 覆盖）。
            dsSelector 关闭的角色（如 teacher）没有 dsList 可数，但"系统" tab 仍要露出空态文案，
            所以库区显隐额外认 !dsSelectorEnabled 这一条 */}
        {(history.length > 0 || dsList.length > 0 || !dsSelectorEnabled) && (
          <div data-testid="preflow-library">
            <div className="flex items-center gap-1 mb-3">
              {([['products', artifactsTabLabel], ['systems', systemsTabLabel]] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setLibTab(key)}
                  data-testid={`preflow-lib-tab-${key}`}
                  className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                    libTab === key ? 'bg-white dark:bg-surface-50 shadow-sm text-ink-primary dark:text-surface-700 border border-surface-100' : 'text-ink-tertiary hover:text-ink-primary dark:hover:text-surface-600'
                  }`}
                >
                  {label}
                </button>
              ))}
              <div className="flex-1" />
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
                <input
                  value={libQuery}
                  onChange={e => setLibQuery(e.target.value)}
                  placeholder={t('chat.preflow.actions.search')}
                  data-testid="preflow-lib-search"
                  className="w-44 max-w-[40vw] pl-8 pr-3 py-1.5 text-[12px] rounded-lg border border-surface-100 bg-white dark:bg-surface-50 outline-none focus:border-brand-300 placeholder:text-surface-400 text-ink-primary"
                />
              </div>
            </div>

            <div className="rounded-xl border border-surface-100 bg-white dark:bg-surface-50 divide-y divide-surface-100 overflow-hidden">
              {libTab === 'products' && libProducts.map(item => {
                const Icon = TYPE_FALLBACK_ICON[visualFor(item.title)]
                return (
                  <button
                    key={item.id}
                    onClick={() => onOpenConversation?.(item.conversationId)}
                    data-testid="preflow-history-item"
                    title={`${item.title} · ${item.conversationTitle}`}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors text-left"
                  >
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className="w-14 h-9 rounded-md object-cover object-top bg-surface-100 shrink-0" draggable={false} />
                    ) : (
                      <div className="w-14 h-9 rounded-md bg-surface-100 flex items-center justify-center shrink-0">
                        <Icon className="w-4 h-4 text-surface-400" strokeWidth={1.75} />
                      </div>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-medium text-ink-primary dark:text-surface-700 truncate">{stripDcSuffix(item.title)}</span>
                      <span className="block text-[11px] text-ink-tertiary truncate">{item.conversationTitle}</span>
                    </span>
                    <span className="text-[11px] text-surface-400 shrink-0">
                      {dateLabels[item.id]}
                    </span>
                  </button>
                )
              })}
              {libTab === 'products' && libProducts.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-surface-400">
                  {t(libQuery ? 'chat.preflow.empty.artifactMatches' : 'chat.preflow.empty.artifacts')}
                </div>
              )}

              {libTab === 'systems' && dsSelectorEnabled && libSystems.map(d => (
                <div
                  key={d.path}
                  data-testid="preflow-ds-row"
                  onClick={() => setPreviewDs(d)}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors"
                >
                  <div className="w-9 h-9 rounded-md bg-brand-500/[0.08] dark:bg-surface-100 flex items-center justify-center shrink-0">
                    <Layers className="w-4 h-4 text-brand-500" strokeWidth={1.75} />
                  </div>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-medium text-ink-primary dark:text-surface-700 truncate">{d.name}</span>
                    <span className="block text-[11px] text-surface-400 truncate">{d.path}</span>
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelectedDsPath(d.path) }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 ${
                      selectedDsPath === d.path
                        ? 'bg-brand-500/[0.08] text-brand-600 cursor-default'
                        : 'border border-border dark:border-surface-200 text-ink-secondary dark:text-surface-300 hover:border-brand-300'
                    }`}
                  >
                    {selectedDsPath === d.path ? t('chat.preflow.actions.selected') : t('chat.preflow.actions.use')}
                  </button>
                </div>
              ))}
              {libTab === 'systems' && dsSelectorEnabled && libSystems.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-surface-400">
                  {t('chat.preflow.designSystem.empty')}
                </div>
              )}
              {/* dsSelector 关闭时"系统" tab 不展示 design-systems 目录内容（挂着教学风格等自定义标签展示设计系统资产是错的）
                  ——改读角色资产库子文件夹（如 teacher 的教学风格）。行点击 → 档案内容预览（只读） */}
              {libTab === 'systems' && !dsSelectorEnabled && libRoleSystems.map(s => (
                <button
                  key={s.path}
                  data-testid="preflow-role-system-row"
                  onClick={() => setPreviewArchive(s)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors text-left"
                >
                  <div className="w-9 h-9 rounded-md bg-brand-500/[0.08] dark:bg-surface-100 flex items-center justify-center shrink-0">
                    <Folder className="w-4 h-4 text-brand-500" strokeWidth={1.75} />
                  </div>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-medium text-ink-primary dark:text-surface-700 truncate">{s.name}</span>
                    <span className="block text-[11px] text-surface-400 truncate">{s.description || s.path}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-surface-300 shrink-0" />
                </button>
              ))}
              {libTab === 'systems' && !dsSelectorEnabled && libRoleSystems.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-surface-400">
                  {displayManifest.systemsEmptyHint || t('chat.preflow.empty.systems')}
                </div>
              )}
              {/* 创建入口——manifest 显式声明才渲染（design 等其他角色 manifest 无此键，零影响）。
                  填输入框不直接开聊（同下拉里的创建项），kickoff 只声明意图、基本盘走对话里的选项卡 */}
              {libTab === 'systems' && !dsSelectorEnabled && displayManifest.systemsCreate && (
                <div className="px-3 py-3">
                  <button
                    onClick={() => {
                      setBuiltInInputPrompt({ kind: 'role-system-create' })
                      setInput(displayManifest.systemsCreate?.kickoff || t('chat.preflow.roleSystems.createTeachingStyleKickoff'))
                      textareaRef.current?.focus()
                    }}
                    data-testid="preflow-create-system"
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-surface-300 dark:border-surface-200 text-[13px] font-medium text-brand-600 dark:text-brand-300 hover:border-brand-300 hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {displayManifest.systemsCreate.label || t('chat.preflow.roleSystems.createTeachingStyle')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 教学风格内容预览 overlay — 内容只读；整理或修改回到 Teacher Agent 对话确认 */}
      {previewArchive && (
        <div
          data-testid="preflow-archive-preview"
          className="fixed inset-0 z-50 flex flex-col bg-surface-0"
        >
          <div className="flex items-center gap-3 px-6 py-4 border-b border-surface-100 shrink-0">
            <div className="w-8 h-8 rounded-md bg-brand-500/[0.08] dark:bg-surface-100 flex items-center justify-center shrink-0">
              <Folder className="w-4 h-4 text-brand-500" strokeWidth={1.75} />
            </div>
            <span className="flex-1 min-w-0 text-[16px] font-semibold text-ink-primary dark:text-surface-700 truncate">
              {systemsTabLabel} · {previewArchive.name}
            </span>
            <button
              data-testid="preflow-archive-preview-manage"
              onClick={() => {
                const name = previewArchive.name
                setPreviewArchive(null)
                setBuiltInInputPrompt({ kind: 'role-system-manage', name })
                setInput(t('chat.preflow.roleSystems.managePrompt', { name }))
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
              className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors shrink-0"
            >
              {t('chat.preflow.roleSystems.manage')}
            </button>
            <button
              data-testid="preflow-archive-preview-close"
              onClick={() => setPreviewArchive(null)}
              title={t('chat.preflow.actions.close')}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-ink-tertiary hover:bg-surface-100 dark:hover:bg-surface-50 transition-colors shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* 两栏各自滚动，外层不滚 */}
          <div className="flex-1 overflow-hidden min-h-0 flex">
            <RoleArchiveViewer rootPath={previewArchive.path} initialFile={previewArchive.entryFile} />
          </div>
        </div>
      )}

      {/* 设计系统全屏画廊 overlay — 行主体点击进入，点「选用这套」= 等价选用逻辑并关闭 */}
      {previewDs && (
        <div
          data-testid="preflow-ds-preview"
          className="fixed inset-0 z-50 flex flex-col bg-surface-0"
        >
          <div className="flex items-center gap-3 px-6 py-4 border-b border-surface-100 shrink-0">
            <div className="w-8 h-8 rounded-md bg-brand-500/[0.08] dark:bg-surface-100 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 text-brand-500" strokeWidth={1.75} />
            </div>
            <span className="flex-1 min-w-0 text-[16px] font-semibold text-ink-primary dark:text-surface-700 truncate">{previewDs.name}</span>
            <button
              data-testid="preflow-ds-preview-use"
              onClick={() => { setSelectedDsPath(previewDs.path); setPreviewDs(null) }}
              className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors shrink-0"
            >
              {t('chat.preflow.actions.useThis')}
            </button>
            <button
              data-testid="preflow-ds-preview-close"
              onClick={() => setPreviewDs(null)}
              title={t('chat.preflow.actions.close')}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-ink-tertiary hover:bg-surface-100 dark:hover:bg-surface-50 transition-colors shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* flex 列而非自身滚动条：内层（画廊/文件视图）各自 flex-1 + 内部滚动，
              文件视图的左右分栏才有确定高度可撑（外层再套一个 overflow-y-auto 会让它塌成 0 高） */}
          <div className="flex-1 min-h-0 flex flex-col">
            <DesignSystemView name={previewDs.name} />
          </div>
        </div>
      )}
    </div>
  )
}
