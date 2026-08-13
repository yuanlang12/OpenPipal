/**
 * Workspace Store — 右侧两个独立面板的状态
 *
 * 两个面板完全独立开关：
 *   - Preview Panel（`open`）：摘要（pinned tab）+ 浏览器预览 tabs。内容入口。
 *   - Files Panel（`filesPanelOpen`）：Agent 的文件夹浏览器。纯文件树。
 *
 * tab 只存在于 Preview Panel 中；摘要作为一个特殊 id 的 pinned tab，不可关闭。
 */

import { create } from 'zustand'

/** 摘要 pinned tab 的 id — 不在 tabs[] 里，而是渲染层特殊处理 */
export const SUMMARY_TAB_ID = '__summary__'

/**
 * Sources pinned tab 的 id —— Cave 模式资料区。同样是渲染层特殊处理,不在 tabs[] 里
 * 只在 learner + study layout 下,由 WorkspacePanel 决定是否在 header 渲染入口
 */
export const SOURCES_TAB_ID = '__sources__'

export type WorkspaceTabKind =
  | 'artifact'   // 引用 artifactStore 里的 Artifact（含 questions 型，走统一管道）
  | 'file'       // 本地文件路径（per-agent outputs/ 或任意 allowed path）
  | 'preview'    // 任意 URL / srcdoc iframe 预览
  | 'visualizer' // 已完成的 visualizer（复用 visualizerStore）
  | 'task'       // 任务详情（单任务面板）

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  title: string
  /** OpenPipal-owned fallback label. Dynamic/user titles always stay in title. */
  titleKey?: string
  titleParams?: Record<string, string | number>
  /** 按 kind 对应不同字段 */
  artifactId?: string
  filePath?: string
  url?: string
  srcdoc?: string
  visualizerId?: string
  taskId?: string
  /** 图标名（lucide），为空用默认 */
  icon?: string
}

export type SidebarSectionId = 'outputs' | 'tasks' | 'sources'

/** 会话产物 tab 记忆的条目——只记 artifact 类 tab（file/preview 等本就跨会话保留，不在记忆范围）。 */
export interface ArtifactTabMemoryEntry {
  artifactId: string
  title: string
  titleKey?: string
  titleParams?: Record<string, string | number>
}

export interface ArtifactTabRestoreEntry {
  id: string
  title: string
  titleKey?: string
  titleParams?: Record<string, string | number>
}

/**
 * 一个会话的产物 tab 记忆。open 只能表达"现在开着哪些"，区分不了"用户关掉的"和"上次来时还
 * 不存在的"——后者（如切走期间后台流式新产出的产物）应该照常自动打开。known 记录记忆已经
 * "处置过"的产物 id：恢复时 open∩重灌 保持用户的开集，重灌∖known 视为新产物追加打开。
 */
export interface ArtifactTabsMemoryRecord {
  open: ArtifactTabMemoryEntry[]
  known: string[]
}

interface WorkspaceState {
  /** Preview Panel（摘要 + 浏览器 tabs）是否可见 */
  open: boolean
  /** Files Panel（Agent 文件夹浏览器）是否可见，独立开关 */
  filesPanelOpen: boolean
  /** Preview Panel 宽度（px） */
  width: number
  /** Files Panel 宽度（px） */
  filesWidth: number
  /** 摘要 tab 内各区块折叠状态 */
  sectionCollapsed: Record<SidebarSectionId, boolean>
  /** 当前打开的 tab 列表（不含摘要；摘要在渲染层特殊处理） */
  tabs: WorkspaceTab[]
  /**
   * 当前激活的 tab id。可能值：
   *   - SUMMARY_TAB_ID（摘要）
   *   - tabs[].id（某个浏览器/文件/artifact tab）
   */
  activeTabId: string
  /**
   * 是否处于"会话切换重灌历史产物"窗口——由 chatStore 在 switchConversation /
   * newConversation* 的重置+重灌区间置位。期间 openTab 不强制展开面板、setOpen 整体
   * 忽略（不改 open、不写 visibilityMemory），避免重灌路径覆盖用户的手动关闭记忆。
   * 窗口结束后由 restoreOpenForConversation 一次性给出该会话的最终显隐状态。
   */
  rehydrating: boolean
  /**
   * 每会话内容区显隐记忆：conversationId -> 最后已知的 open 值。
   * 手动开关（setOpen/togglePanel）与"新产物自动弹出"（非重灌期间的 setOpen(true)）都会写入；
   * 重灌历史产物不写入（见 rehydrating）。进程内存，不落盘。
   */
  visibilityMemory: Record<string, boolean>
  /**
   * 每会话产物 tab 集合记忆：conversationId -> { open: 打开的 tab 列表（含顺序）, known: 已处置过的 id }。
   * 与 visibilityMemory 同款语义的 tab 层版本：会话内任何 tab 变动（用户手动开/关、Agent 新产物
   * 自动开）都写透式记录；重灌窗口不写。切回会话时按记忆精确恢复——用户关掉的不再弹回来
   * （含"全关"这种空 open 记忆），上次访问后新出现的产物照常打开（见 ArtifactTabsMemoryRecord）；
   * 无记忆（本次启动首次进入）才走全量打开的旧默认。进程内存，不落盘。
   */
  artifactTabsMemory: Record<string, ArtifactTabsMemoryRecord>
  /** 当前会话 id —— 由 chatStore 在会话切换时同步，用于给 visibilityMemory 定位 key */
  currentConversationId: string | null
  /**
   * "本轮别再弹"抑制：用户显式关面板（setOpen/togglePanel → false）时记下会话 id，
   * 该会话内后续产物完成的自动弹开（bridge 的 openTab auto 分支）被压制——
   * tab 照常登记，只是不抢开面板。任何显式打开（setOpen(true)/focusTab/用户点 openTab）
   * 或该会话新一轮用户消息（rearmAutoOpen）解除。进程内存，不落盘。
   */
  autoOpenSuppressedConvId: string | null
}

interface WorkspaceActions {
  setOpen: (open: boolean) => void
  togglePanel: () => void
  setFilesPanelOpen: (open: boolean) => void
  toggleFilesPanel: () => void
  setWidth: (w: number) => void
  setFilesWidth: (w: number) => void
  toggleSection: (id: SidebarSectionId) => void
  /** 直接设置某区块折叠态（区分 toggleSection 的取反语义，用于按上下文重置默认态） */
  setSectionCollapsed: (id: SidebarSectionId, collapsed: boolean) => void
  /**
   * 打开或复用 tab。
   * 去重规则：按 kind + 唯一字段（artifactId/filePath/url/visualizerId/taskId）匹配，
   * 已存在则直接激活，避免同文件多 tab。
   * openTab 会激活对应 tab 并确保 Preview Panel 展开（open: true，同时写入当前会话的显隐记忆）；
   * 但在 rehydrating 窗口内（会话切换重灌历史产物）只加 tab，不强开面板、不写记忆。
   */
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }, opts?: { auto?: boolean }) => string
  closeTab: (id: string) => void
  focusTab: (id: string) => void
  /** 切回摘要 pinned tab */
  focusSummary: () => void
  reorderTabs: (fromIdx: number, toIdx: number) => void
  clearAllTabs: () => void
  /** 进入/退出"重灌历史产物"窗口（见 rehydrating 字段注释） */
  setRehydrating: (v: boolean) => void
  /** 同步当前会话 id（不改 open，不写记忆——纯定位 key） */
  setCurrentConversationId: (id: string | null) => void
  /**
   * 会话切换/新建收官时调用：按该会话的显隐记忆决定最终 open 值——
   * 有记忆用记忆，无记忆按 hasArtifacts 走默认规则（有产物开/无产物关）。
   * 同时把 currentConversationId 切到该会话，并把决定结果写回记忆（建立基线）。
   */
  restoreOpenForConversation: (id: string, hasArtifacts: boolean) => void
  /**
   * 会话切换重灌收官时调用（仍在 rehydrating 窗口内）：按该会话的 tab 记忆重建产物 tab 集合。
   * 有记忆（含空数组=用户全关过）→ 精确恢复 记忆∩本次重灌产物（已删产物剔除，标题以现值为准）；
   * 无记忆 → 全量打开重灌产物（维持旧默认）。恢复结果写回记忆建立基线；非产物 tab 不动。
   * 恢复决策全在这里而不在桥接层——桥接 effect 的 flush 时序不可依赖（确定性归代码）。
   */
  restoreArtifactTabsForConversation: (convId: string, rehydrated: ArtifactTabRestoreEntry[]) => void
  /** 当前会话新一轮用户消息 → 解除"本轮别再弹"（只清匹配当前会话的抑制） */
  rearmAutoOpen: () => void
}

/** "本轮别再弹"是否对当前会话生效 */
function autoSuppressed(s: WorkspaceState): boolean {
  return s.currentConversationId !== null && s.autoOpenSuppressedConvId === s.currentConversationId
}

/** setOpen/togglePanel 共用：重灌窗口内忽略；否则套用 open 并写入当前会话的显隐记忆 */
function applyOpen(s: WorkspaceState, open: boolean): Partial<WorkspaceState> {
  if (s.rehydrating) return {}
  const patch: Partial<WorkspaceState> = { open }
  // 显式关 → 记住"本轮别再弹"；任何显式开 → 解除（auto 路径被抑制时根本走不到这里）
  patch.autoOpenSuppressedConvId = open ? null : s.currentConversationId
  if (s.currentConversationId) {
    patch.visibilityMemory = { ...s.visibilityMemory, [s.currentConversationId]: open }
  }
  return patch
}

function uid(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * openTab/closeTab/reorderTabs/clearAllTabs 共用：把变更后的产物 tab 集合写透进当前会话的记忆。
 * 重灌窗口/无当前会话时不写（与 applyOpen 同款守卫）；streaming 临时 tab 不入记忆。
 * known 只增不减：开过 tab 的产物永久算"处置过"，关掉只是从 open 里退场。
 */
function snapshotArtifactTabs(s: WorkspaceState, nextTabs: WorkspaceTab[]): Partial<WorkspaceState> {
  if (s.rehydrating || !s.currentConversationId) return {}
  const open: ArtifactTabMemoryEntry[] = nextTabs
    .filter(t => t.kind === 'artifact' && t.artifactId && t.artifactId !== 'streaming')
    .map(t => ({
      artifactId: t.artifactId!,
      title: t.title,
      titleKey: t.titleKey,
      titleParams: t.titleParams
    }))
  const prev = s.artifactTabsMemory[s.currentConversationId]
  const known = new Set(prev?.known ?? [])
  for (const e of open) known.add(e.artifactId)
  return {
    artifactTabsMemory: {
      ...s.artifactTabsMemory,
      [s.currentConversationId]: { open, known: Array.from(known) }
    }
  }
}

function findDuplicate(tabs: WorkspaceTab[], candidate: Omit<WorkspaceTab, 'id'>): WorkspaceTab | undefined {
  return tabs.find(t => {
    if (t.kind !== candidate.kind) return false
    switch (candidate.kind) {
      case 'artifact':   return t.artifactId === candidate.artifactId
      case 'file':       return t.filePath === candidate.filePath
      case 'preview':    return t.url === candidate.url && t.srcdoc === candidate.srcdoc
      case 'visualizer': return t.visualizerId === candidate.visualizerId
      case 'task':       return t.taskId === candidate.taskId
      default:           return false
    }
  })
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set, get) => ({
  open: false,
  filesPanelOpen: false,
  width: 480,
  filesWidth: 240,
  sectionCollapsed: { outputs: false, tasks: false, sources: true },
  tabs: [],
  activeTabId: SUMMARY_TAB_ID,
  rehydrating: false,
  visibilityMemory: {},
  artifactTabsMemory: {},
  currentConversationId: null,
  autoOpenSuppressedConvId: null,

  setOpen: (open) => set(s => applyOpen(s, open)),
  togglePanel: () => set(s => applyOpen(s, !s.open)),
  setFilesPanelOpen: (open) => set({ filesPanelOpen: open }),
  toggleFilesPanel: () => set(s => ({ filesPanelOpen: !s.filesPanelOpen })),
  setWidth: (w) => set({ width: Math.max(320, Math.min(1200, w)) }),
  setFilesWidth: (w) => set({ filesWidth: Math.max(180, Math.min(480, w)) }),
  toggleSection: (id) => set(s => ({
    sectionCollapsed: { ...s.sectionCollapsed, [id]: !s.sectionCollapsed[id] }
  })),
  setSectionCollapsed: (id, collapsed) => set(s => ({
    sectionCollapsed: { ...s.sectionCollapsed, [id]: collapsed }
  })),

  openTab: (input, opts) => {
    const { tabs, rehydrating } = get()
    // auto = 产物完成的自动打开——"本轮别再弹"生效时只登记 tab，不抢开面板
    const skipOpen = (s: WorkspaceState): boolean => rehydrating || (!!opts?.auto && autoSuppressed(s))
    const existing = findDuplicate(tabs, input)
    if (existing) {
      set(s => ({ activeTabId: existing.id, ...(skipOpen(s) ? {} : applyOpen(s, true)) }))
      return existing.id
    }
    const id = input.id || uid()
    const tab: WorkspaceTab = { ...input, id } as WorkspaceTab
    set(s => {
      const nextTabs = [...s.tabs, tab]
      return { tabs: nextTabs, activeTabId: id, ...(skipOpen(s) ? {} : applyOpen(s, true)), ...snapshotArtifactTabs(s, nextTabs) }
    })
    return id
  },

  closeTab: (id) => set(s => {
    if (id === SUMMARY_TAB_ID) return s // 摘要不可关
    const idx = s.tabs.findIndex(t => t.id === id)
    if (idx < 0) return s
    const nextTabs = s.tabs.filter(t => t.id !== id)
    let nextActive = s.activeTabId
    if (s.activeTabId === id) {
      // 关闭的是当前激活 tab → 激活相邻浏览器 tab；没有则回到摘要
      nextActive = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? SUMMARY_TAB_ID
    }
    return { tabs: nextTabs, activeTabId: nextActive, ...snapshotArtifactTabs(s, nextTabs) }
  }),

  // 抑制位只在"用户显式打开"时解除——重灌窗口内的程序性 focus(切会话 reset 会调 focusSummary,
  // 此刻 currentConversationId 仍指向被离开的会话)不得误清,否则切一次标签就把"刚关别弹"抹掉(评审实锤)
  focusTab: (id) => set(s => ({ activeTabId: id, open: true, ...(s.rehydrating ? {} : { autoOpenSuppressedConvId: null }) })),
  focusSummary: () => set(s => ({ activeTabId: SUMMARY_TAB_ID, open: true, ...(s.rehydrating ? {} : { autoOpenSuppressedConvId: null }) })),

  reorderTabs: (fromIdx, toIdx) => set(s => {
    if (fromIdx === toIdx) return s
    const next = [...s.tabs]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    return { tabs: next, ...snapshotArtifactTabs(s, next) }
  }),

  clearAllTabs: () => set(s => ({ tabs: [], activeTabId: SUMMARY_TAB_ID, ...snapshotArtifactTabs(s, []) })),

  rearmAutoOpen: () => set(s => (autoSuppressed(s) ? { autoOpenSuppressedConvId: null } : {})),

  setRehydrating: (v) => set({ rehydrating: v }),
  setCurrentConversationId: (id) => set({ currentConversationId: id }),
  restoreOpenForConversation: (id, hasArtifacts) => set(s => {
    const remembered = s.visibilityMemory[id]
    const open = remembered !== undefined ? remembered : hasArtifacts
    return {
      open,
      currentConversationId: id,
      visibilityMemory: { ...s.visibilityMemory, [id]: open }
    }
  }),

  restoreArtifactTabsForConversation: (convId, rehydrated) => set(s => {
    const byId = new Map(rehydrated.map(a => [a.id, a]))
    const remembered = s.artifactTabsMemory[convId]
    let wanted: ArtifactTabMemoryEntry[]
    if (remembered !== undefined) {
      // 用户开集 ∩ 本次重灌（已删产物剔除、标题以现值为准）+ 记忆没处置过的新产物（追加打开）
      const kept = remembered.open
        .filter(e => byId.has(e.artifactId))
        .map(e => {
          const current = byId.get(e.artifactId)!
          return {
            artifactId: e.artifactId,
            title: current.title,
            titleKey: current.titleKey,
            titleParams: current.titleParams
          }
        })
      const knownSet = new Set(remembered.known)
      const fresh = rehydrated
        .filter(a => !knownSet.has(a.id))
        .map(a => ({
          artifactId: a.id,
          title: a.title,
          titleKey: a.titleKey,
          titleParams: a.titleParams
        }))
      wanted = [...kept, ...fresh]
    } else {
      wanted = rehydrated.map(a => ({
        artifactId: a.id,
        title: a.title,
        titleKey: a.titleKey,
        titleParams: a.titleParams
      }))
    }
    const nonArtifact = s.tabs.filter(t => t.kind !== 'artifact')
    const artifactTabs: WorkspaceTab[] = wanted.map(w => ({
      id: uid(),
      kind: 'artifact',
      title: w.title,
      titleKey: w.titleKey,
      titleParams: w.titleParams,
      artifactId: w.artifactId
    }))
    // 基线：本次重灌的所有产物都算"处置过"（开或不开都是决定）；known 只增不减
    const known = new Set(remembered?.known ?? [])
    for (const a of rehydrated) known.add(a.id)
    return {
      tabs: [...nonArtifact, ...artifactTabs],
      // 有产物 tab 时落在最后一个上（贴近旧行为：重灌逐个 openTab 后末位激活）；全关记忆 → 摘要
      activeTabId: artifactTabs.length ? artifactTabs[artifactTabs.length - 1].id : SUMMARY_TAB_ID,
      artifactTabsMemory: { ...s.artifactTabsMemory, [convId]: { open: wanted, known: Array.from(known) } }
    }
  })
}))

// dev-only：挂到 window 便于 E2E 直接驱动（prod 构建会在 renderer-dev-only 判断下不挂）
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  ;(window as any).__workspaceStore = useWorkspaceStore
}
