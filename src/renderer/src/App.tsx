import { useEffect, useCallback, useState, useMemo, useRef } from 'react'
import { PanelLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from './stores/appStore'
import { useChatStore } from './stores/chatStore'
import { useArtifactStore } from './stores/artifactStore'
import { useWorkspaceStore, SUMMARY_TAB_ID, SOURCES_TAB_ID } from './stores/workspaceStore'
import { useSourcesStore } from './stores/sourcesStore'
import { useTargetStatus } from './hooks/useTargetStatus'
import { useRealtimeVoice } from './hooks/useRealtimeVoice'
import { useArtifactWorkspaceBridge } from './hooks/useArtifactWorkspaceBridge'
import { useThemeStore } from './stores/themeStore'
import { resolveVariant } from './lib/theme'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { BrowserTopBar } from './components/BrowserTopBar'
import { ChatPanel } from './components/ChatPanel'
import { InputBar } from './components/InputBar'
import { SelfCheckPreview } from './components/SelfCheckPreview'
// 语音 UI 已改为输入框内联控件（VoiceCallInline）。
// 旧的 VoiceCallOverlay（全屏）/ VoiceCallStrip（顶部长条）方案已停用，文件暂留做 fallback。
import { Skeleton } from './components/Skeleton'
import { PermissionModal } from './components/PermissionModal'
import { ToolsHub } from './components/ToolsHub'
import { SettingsPanel } from './components/SettingsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { TasksPanel } from './components/TasksPanel'
import { OutputCenterPanel } from './components/OutputCenterPanel'
import { WelcomePage } from './components/WelcomePage'
import { AgentWorkspaceInspector } from './components/AgentWorkspaceInspector'
import { AskUserForm } from './components/messages/AskUserForm'
import { WorkspacePanel } from './components/workspace/WorkspacePanel'
import { FilesPanel } from './components/workspace/FilesPanel'
import { OnboardingOverlay } from './components/OnboardingOverlay'

export default function App() {
  const { t } = useTranslation()
  const status = useTargetStatus()
  const { initialized, currentRole, activeView, workspacePanelOpen } = useAppStore()
  const { convLoading, isStreaming, setupListeners, clearMessages, pendingPermission, respondPermission, messages, activeWorkspaceId, sendMessage } = useChatStore()
  const { switchRole, setActiveView } = useAppStore()
  const { newConversation } = useChatStore()

  // 查找最后一条 assistant 消息的 askFields（如果它还没被用户回答）
  // 逻辑：从后向前扫描，若碰到 user 消息说明已回答，返回 null
  const pendingAskFields = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user') return null
      if (m.role === 'assistant' && m.askFields && m.askFields.length > 0) {
        return { question: m.askQuestion || m.content || '', fields: m.askFields }
      }
    }
    return null
  }, [messages])
  const voice = useRealtimeVoice()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [dreamStatus, setDreamStatus] = useState<{ detail?: string } | null>(null)
  // 输入框那一坨(自检预览 + 输入框 + dream 状态)的实测高度。消息列表要留出
  // 同样的底部内边距,才能「滚到玻璃底下」而不是被挡住最后一条。
  const chatDockRef = useRef<HTMLDivElement>(null)
  // 窗口窄到 420px 以下时**默认**收起侧栏(用户随时可再展开):那时 240px 侧栏会把
  // 内容列压到 ~160px,输入框工具栏塞不下就会被裁。48px 收起态刚好还回可用宽度。
  // 注意适用范围:挂靠态根本不渲染侧栏(见下面 !status.connected 的门),所以这条
  // 只管「用户手动把独立窗口拖窄」。420 是这个场景的实测拐点,不是挂靠宽度常量 ——
  // 别把它和 window-tracker 的 AI_WINDOW_WIDTH=400 当成同一个数。
  const [narrowViewport, setNarrowViewport] = useState(false)
  // 浏览器模式（插件 iframe）走精简布局：顶栏切换智能体 + 历史浮层，隐藏桌面侧栏
  const isBrowser = (window as any).__OPENPIPAL_ENV__ === 'browser'

  // Preflow 已移入 WelcomePage — 因为 WelcomePage 里的角色图标才是用户真正的"角色选择"动作

  const theme = useAppStore(s => s.theme)
  useEffect(() => {
    // appStore.theme ('system'|'light'|'dark') → themeStore.variant ('light'|'dark')
    // themeStore.setVariant 内部会调 applyTheme,自动管理 .dark class + CSS variables
    useThemeStore.getState().setVariant(resolveVariant(theme))
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => {
        useThemeStore.getState().setVariant(e.matches ? 'dark' : 'light')
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])

  useEffect(() => { useAppStore.getState().init() }, [])
  useEffect(() => {
    // 窄到挂靠宽度以下时**默认**收起,但只是把开关拨过去 —— 用户随时能再展开。
    // 之前是直接 disabled + 强制 collapsed,等于在 410px 手动宽度下把历史记录、
    // 搜索、会话列表全部锁死且无法覆盖;自动行为该是便利,不该是锁。
    const sync = (): void => setNarrowViewport(prev => {
      const next = window.innerWidth < 420
      if (next !== prev && next) setSidebarCollapsed(true)
      return next
    })
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  // 只在「输入区这一坨挂载/卸载」时重挂 observer,不跟着每条消息重建 —— 尺寸变化
  // 本来就由 ResizeObserver 自己报,把 messages.length 放进 deps 只会白拆白建。
  const chatViewMounted = activeView === 'chat' && !(messages.length === 0 && !isStreaming && !activeWorkspaceId)
  useEffect(() => {
    const node = chatDockRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    // 直接写 CSS 变量,不走 React state:它唯一的消费者就是这个变量(ChatPanel 的
    // 滚动内边距和保护渐变都从 CSS 读)。走 state 会让输入框每次换行、自检预览
    // 挂载/卸载都触发整棵树重渲染 —— 包括把整条消息列表重新 map 一遍。
    const host = node.closest('.op-chat-view') as HTMLElement | null
    if (!host) return
    const sync = (entry?: ResizeObserverEntry): void => {
      const next = Math.ceil(entry?.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height)
      if (next > 0) host.style.setProperty('--op-dock-h', `${next}px`)
    }
    sync()
    const observer = new ResizeObserver(entries => sync(entries[0]))
    observer.observe(node)
    return () => observer.disconnect()
  }, [chatViewMounted])
  useEffect(() => {
    if (currentRole) useChatStore.getState().initConversations(currentRole.name)
  }, [currentRole?.name])
  useEffect(() => setupListeners(), [setupListeners])
  useArtifactWorkspaceBridge()
  useEffect(() => {
    const cleanup = (window.api as any).onDreamStatus?.((data: { status: string; detail?: string }) => {
      if (data.status === 'started') setDreamStatus({ detail: data.detail })
      else setDreamStatus(null)
    })
    return cleanup
  }, [])

  const handleSwitchRole = useCallback(async (name: string) => {
    await switchRole(name)
    clearMessages()
  }, [switchRole, clearMessages])

  const roleName = currentRole?.name || 'learner'
  const handleNew = useCallback(async () => {
    // 所见即所得：与 Sidebar 新建入口一致，固定 general（欢迎页可切换角色）
    await newConversation('general')
    setActiveView('chat')
  }, [newConversation, setActiveView])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'l')) {
        e.preventDefault()
        handleNew()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarCollapsed(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNew])

  useEffect(() => {
    const handler = (e: Event) => {
      const { action, text } = (e as CustomEvent).detail
      if (!text) return
      const prompt = action === 'translate'
        ? `请翻译以下内容：\n\n${text}`
        : `请解释以下内容：\n\n${text}`
      useChatStore.getState().sendMessage(prompt, roleName)
    }
    window.addEventListener('openpipal-context-action', handler)
    return () => window.removeEventListener('openpipal-context-action', handler)
  }, [roleName])

  const handleHangup = useCallback(() => {
    // P3a 起，voice transcripts 已实时进入 chat 消息流（chatStore.upsertVoiceMessage）
    // 这里只需停掉 session；不再需要 insertVoiceMessages 批量写入
    voice.stopSession()
  }, [voice.stopSession])

  const artifactCount = useArtifactStore(s => s.artifacts.length)
  const streamingArtifact = useArtifactStore(s => s.streamingArtifact)
  const previewOpen = useWorkspaceStore(s => s.open)
  const filesPanelOpen = useWorkspaceStore(s => s.filesPanelOpen)

  // Cave 模式 / 沉浸式学习布局 —— 由角色的 layout.json 驱动
  // - triggerOn === 'always': 切到该角色立即生效
  // - triggerOn === 'hasSources': 资料区有 source 才切
  const layoutManifest = currentRole?.layoutManifest
  const sourcesCount = useSourcesStore(s => s.sources.length)
  const studyModeActive = activeView === 'chat'
    && layoutManifest?.preferredLayout === 'study'
    && (layoutManifest?.triggerOn === 'always'
        || (layoutManifest?.triggerOn === 'hasSources' && sourcesCount > 0))
  const chatSidebarWidth = layoutManifest?.chatSidebarWidth ?? 380
  const layoutTransitionMs = layoutManifest?.transitionMs ?? 500

  // 进入 Cave 模式时自动聚焦 Sources tab(只在 transition,不抢用户手动切的 tab)
  useEffect(() => {
    if (studyModeActive) {
      const current = useWorkspaceStore.getState().activeTabId
      if (current === SUMMARY_TAB_ID) {
        useWorkspaceStore.getState().focusTab(SOURCES_TAB_ID)
      }
    }
  }, [studyModeActive])

  // learner 角色挂载时拉一次 sources(让 layout 触发 / SourcesPanel 渲染都有数据)
  useEffect(() => {
    if (currentRole?.name === 'learner') {
      useSourcesStore.getState().refresh()
    }
  }, [currentRole?.name])

  // questions_v2 作为 artifact 走 useArtifactWorkspaceBridge，这里不需要单独处理

  if (!initialized || convLoading) return <Skeleton />

  return (
    <div className="op-app-shell relative h-screen flex flex-col">
      {/* 顶部标题栏：macOS 拖拽区 + 角色切换 + 状态。
          ⚠️ 必须留在文档流里(relative,不能 absolute/fixed):Chromium 只从**常规流**
          元素上收集 -webkit-app-region: drag,脱流元素一律不计入窗口拖拽区。
          写成 absolute 会让整条标题栏拖不动窗口(实测 static 能拖、absolute/fixed 都不能)。
          标题栏方向没有 pass-behind(探出会被外层 overflow:hidden 裁掉,已移除);
          可执行的不变量在 tests/e2e/liquid-glass-shell.spec.ts。 */}
      <div className="op-titlebar op-glass-chrome relative z-30 h-10 shrink-0 flex items-center" style={{ WebkitAppRegion: 'drag' } as any}>
        {isBrowser ? (
          <BrowserTopBar />
        ) : (
          <>
            {/* 左上角这 76px 原本是给 macOS 红绿灯留的位。窗口是 frame:false,
                红绿灯根本不存在,这块一直空着 —— 现在让它装侧栏开关,
                和右侧那几个面板开关左右对称。 */}
            <div className="w-[76px] shrink-0 flex items-center pl-3">
              {!status.connected && (
                <button
                  onClick={() => setSidebarCollapsed(v => !v)}
                  data-testid="sidebar-toggle"
                  className={[
                    'shrink-0 p-1.5 rounded-md transition-colors',
                    sidebarCollapsed || narrowViewport
                      ? 'text-surface-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20'
                      : 'bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400'
                  ].join(' ')}
                  style={{ WebkitAppRegion: 'no-drag' } as any}
                  title={t(sidebarCollapsed || narrowViewport
                    ? 'shell.navigation.expandSidebar'
                    : 'shell.navigation.collapseSidebar')}
                >
                  <PanelLeft className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <StatusBar
              status={status}
              onClear={handleNew}
              onSwitchRole={handleSwitchRole}
            />
          </>
        )}
      </div>

      {/* 语音通话改为输入框内联控件（VoiceCallInline），不再用顶部长条 */}

      {/* 主体：Sidebar + [Agent Workspace Inspector] + 内容区 + 右侧 WorkspacePanel
          挂靠模式（status.connected === true，窗口宽 400px 跟随前台应用）下隐藏 Sidebar，
          只显示当前最近一次会话；脱离挂靠后 Sidebar 自动恢复 */}
      {/* 标题栏回到文档流后,这里不再需要 pt-10 补位 —— 它本来就是给脱流标题栏让位的 */}
      <div className="op-app-body flex-1 flex overflow-hidden">
        {!status.connected && !isBrowser && (
          <Sidebar collapsed={sidebarCollapsed} />
        )}

        {/* Agent Workspace 信息检视器 — 仅 chat view + activeWorkspaceId + 用户开启时显示 */}
        {activeView === 'chat' && activeWorkspaceId && workspacePanelOpen && (
          <div className="w-[260px] shrink-0 flex flex-col">
            <AgentWorkspaceInspector
              workspaceId={activeWorkspaceId}
              onClose={() => useAppStore.getState().setWorkspacePanelOpen(false)}
            />
          </div>
        )}

        {/* Cave 模式：Visualizer 升主舞台（在中列之前渲染，让 chat 缩成右栏） */}
        {studyModeActive && <WorkspacePanel layoutMode="study" />}

        {/* 中列：主内容（chat / welcome / agents / tools / tasks / settings）
            study 模式下变成固定宽度右栏，chat 缩成阅读伴侣 */}
        <div
          className={[
            'op-content-column flex flex-col min-w-0 min-h-0',
            studyModeActive ? 'shrink-0' : 'flex-1'
          ].join(' ')}
          style={{
            width: studyModeActive ? chatSidebarWidth : undefined,
            transition: `width ${layoutTransitionMs}ms ease-out`
          }}
        >
          {activeView === 'chat' && (
            messages.length === 0 && !isStreaming && !activeWorkspaceId ? (
              <WelcomePage
                onStartVoice={voice.sessionState === 'idle' && !isStreaming ? voice.startSession : undefined}
                voiceAvailable={voice.voiceAvailable}
                voiceSessionState={voice.sessionState}
                voiceDuration={voice.duration}
                voiceIsAISpeaking={voice.isAISpeaking}
                voiceInputLevel={voice.inputLevel}
                onHangupVoice={handleHangup}
              />
            ) : (
              <div
                className="op-chat-view relative flex-1 flex flex-col min-w-0 min-h-0"
              >
                <ChatPanel appName={status.connected ? status.appName : undefined} />
                {/* 保护渐变：画布在输入框底下化开,文字溶进玻璃而不是被一条硬边裁断 */}
                <div aria-hidden className="op-glass-veil" />
                {/* 输入区悬浮在消息列表之上；列表的底部内边距由 --op-dock-h 反向撑开 */}
                <div ref={chatDockRef} className="op-chat-dock absolute inset-x-0 bottom-0 z-20">
                  {/* 自检实时画面：钉在输入框上方的固定槽（对标官方 Claude Design），自管显隐 */}
                  <SelfCheckPreview />
                  {pendingAskFields && (
                    <div className="border-t border-surface-100 bg-surface-primary">
                      <AskUserForm
                        variant="popup"
                        question={pendingAskFields.question}
                        fields={pendingAskFields.fields}
                        onSubmit={(answers) => {
                          sendMessage(answers, currentRole?.name || 'learner')
                        }}
                      />
                    </div>
                  )}
                  {!pendingAskFields && (
                    <InputBar
                      onStartVoice={voice.sessionState === 'idle' && !isStreaming ? voice.startSession : undefined}
                      voiceAvailable={voice.voiceAvailable}
                      voiceSessionState={voice.sessionState}
                      voiceDuration={voice.duration}
                      voiceIsAISpeaking={voice.isAISpeaking}
                      voiceInputLevel={voice.inputLevel}
                      onHangupVoice={handleHangup}
                    />
                  )}
                  {dreamStatus && (
                    <div className="px-4 pb-1.5 text-[11px] text-surface-400 flex items-center gap-2 animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
                      {dreamStatus.detail || t('shell.app.organizingMemory')}
                    </div>
                  )}
                </div>
              </div>
            )
          )}
          {activeView === 'agents' && <AgentsPanel />}
          {activeView === 'tools' && <ToolsHub />}
          {activeView === 'tasks' && <TasksPanel />}
          {activeView === 'artifacts' && <OutputCenterPanel />}
          {activeView === 'settings' && <SettingsPanel />}
        </div>

        {/* Questions v2 现在作为 WorkspacePanel 的 tab 渲染（useEffect 同步 open/close）*/}

        {/* 右列 A：PreviewPanel —— 摘要 pinned + 浏览器预览 tabs
            study 模式下不再渲染右侧 sidebar 版（主舞台已在中列左侧渲染） */}
        {activeView === 'chat' && !studyModeActive && previewOpen && <WorkspacePanel layoutMode="sidebar" />}
        {/* 右列 B：FilesPanel —— Agent 文件夹浏览器，独立开关 */}
        {filesPanelOpen && <FilesPanel />}
      </div>

      {/* 浮层 */}
      {/* P3b: 旧 VoiceCallOverlay 全屏方案已停用，改为顶部 VoiceCallStrip 细条。
          组件文件保留几天做 fallback，确认稳定后删除。 */}
      {pendingPermission && (
        <PermissionModal
          request={pendingPermission}
          onRespond={respondPermission}
        />
      )}
      <OnboardingOverlay />
    </div>
  )
}
