/**
 * SelfCheckPreview —— Agent 自检（render_artifact）时钉在输入框上方的实时画面卡
 *
 * 对标官方 Claude Design：「Checking the design for issues…」+ 设备外框里的当前作品。
 * 位置是 App 中列 ChatPanel 与 InputBar 之间的固定槽（和 ask_user 表单同一层），不在对话流里
 * ——流里的东西会滚走、流式一结束就消失，而自检恰恰是用户最该看见的一步（真渲染发生在
 * 主进程 show:false 的隐藏窗口里，此前用户只看得到一行转圈）。
 *
 * 生命周期：自检开始 → 出现；自检结束 → **不自动关闭**，收结论继续挂着（用户要看得见这一步）。
 * 关闭有三条路，都走同一个 close()：用户点 ✕；切会话（别把上一个会话的稿子挂在这儿）；
 * **用户在本会话又发了一条消息**（2026-08-14 所有者裁决：人一开口提修改，旧画面就没有留存
 * 价值了；合盖收起态同样关）。
 *
 * 渲染走 dcRuntime 的同一组装配函数（isDcHtml/inlineDcRuntime/inlineDcArtifactSiblings），
 * 与 HtmlPreview 同源；这里刻意不带 bridge/tweak/sidecar——它是缩略画面，不是可交互预览。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { Loader2, CheckCircle2, AlertTriangle, Circle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLiveStreamStore } from '../stores/liveStreamStore'
import { useChatStore } from '../stores/chatStore'
import { useArtifactStore } from '../stores/artifactStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { isDcHtml, inlineDcRuntime, inlineDcArtifactSiblings, inlineKnownScriptSiblings } from './artifacts/dcRuntime'
import { stripDcSuffix } from '../utils/format'
import {
  SELF_CHECK_TOOL, FRAME_SPEC, FrameKind,
  pickFrame, parseSelfCheckVerdict, resolveSelfCheckTarget, latestSelfCheckResult, isVisualArtifactType,
  renderInputsFingerprint,
  type SelfCheckVerdict,
} from '../chat/selfCheck'

// ---- 卡片状态（模块级 store：切视图/重挂载不丢，"不自动关闭"才站得住）----

interface SelfCheckState {
  open: boolean
  collapsed: boolean
  artifactId: string | null
  phase: 'running' | 'done'
  verdict: SelfCheckVerdict | null
  /** 结论对应的那一版内容指纹——当前内容与之不符 = 结论说的是旧版本，徽标降级为"已过时" */
  verdictFp: string | null
  begin: (artifactId: string) => void
  finish: (verdict: SelfCheckVerdict | null, fp: string | null) => void
  close: () => void
  toggleCollapsed: () => void
}

export const useSelfCheckStore = create<SelfCheckState>((set) => ({
  open: false,
  collapsed: false,
  artifactId: null,
  phase: 'running',
  verdict: null,
  verdictFp: null,
  begin: (artifactId) => set({ open: true, collapsed: false, artifactId, phase: 'running', verdict: null, verdictFp: null }),
  finish: (verdict, fp) => set(s => (s.open ? { phase: 'done', verdict, verdictFp: fp } : s)),
  close: () => set({ open: false, artifactId: null, verdict: null, verdictFp: null }),
  toggleCollapsed: () => set(s => ({ collapsed: !s.collapsed }))
}))

// ---- 设备外框 ----

function DeviceFrame({ kind, children }: { kind: FrameKind; children: React.ReactNode }): JSX.Element {
  const { w, vw, vh } = FRAME_SPEC[kind]
  const h = Math.round((w * vh) / vw)
  const screen = (
    <div className="relative overflow-hidden bg-white" style={{ width: w, height: h }}>
      {children}
    </div>
  )
  if (kind === 'phone') {
    return (
      <div className="relative rounded-[20px] border-[5px] border-surface-800 dark:border-surface-700 overflow-hidden shadow-sm">
        {screen}
        <div className="absolute top-[3px] left-1/2 -translate-x-1/2 w-8 h-[5px] rounded-full bg-surface-800 dark:bg-surface-700" />
      </div>
    )
  }
  if (kind === 'wide') {
    return (
      <div className="rounded-md border border-surface-300 overflow-hidden shadow-sm">
        {screen}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center">
      <div className="rounded-t-md rounded-b-sm border-[5px] border-b-[6px] border-surface-800 dark:border-surface-700 overflow-hidden">
        {screen}
      </div>
      {/* 笔记本底座：比屏幕略宽的一条，够读出"这是台电脑"就行，不做拟物投影 */}
      <div className="h-[5px] rounded-b-md bg-surface-700" style={{ width: w + 34 }} />
    </div>
  )
}

/** 盖上的样子：只剩一条合起的机身。收起态必须留个可点的实体，否则盖上了就再也打不开 */
function ClosedLid({ kind }: { kind: FrameKind }): JSX.Element {
  const { t } = useTranslation()
  const { w } = FRAME_SPEC[kind]
  return (
    <div className="flex flex-col items-center gap-1.5 py-1">
      <div
        className="h-2.5 rounded-md bg-surface-800 dark:bg-surface-700 shadow-sm"
        style={{ width: w + 34 }}
      />
      <span className="text-[10px] text-surface-400">{t('artifacts.selfCheck.closedHint')}</span>
    </div>
  )
}

// ---- 卡片本体 ----

export function SelfCheckPreview(): JSX.Element | null {
  const { t } = useTranslation()
  const toolStatus = useLiveStreamStore(s => s.toolStatus)
  const conversationId = useChatStore(s => s.activeConversationId)
  const artifacts = useArtifactStore(s => s.artifacts)
  const { open, collapsed, artifactId, phase, verdict, verdictFp } = useSelfCheckStore()
  const [doc, setDoc] = useState<string | null>(null)
  const runningRef = useRef(false)

  // 自检开始/结束。toolStatus 存的就是工具名（liveStreamStore.setToolStatus(name)）
  useEffect(() => {
    const store = useSelfCheckStore.getState()
    if (toolStatus === SELF_CHECK_TOOL) {
      if (runningRef.current) return
      runningRef.current = true
      const list = useArtifactStore.getState().artifacts
      const id = resolveSelfCheckTarget(useChatStore.getState().messages, list)
      // path 模式自检（设计系统 specimen/ui_kit）本轮没产出会话产物 → 这一版不弹卡
      if (id) store.begin(id)
      return
    }
    if (runningRef.current) {
      runningRef.current = false
      const text = latestSelfCheckResult(useChatStore.getState().messages)
      // 指纹取"结论落下这一刻"的整套渲染输入（薄壳 + 它引用的场景 jsx）——之后 AI 再改任一份，
      // 组件里比对不一致即降级"已过时"
      const targetId = useSelfCheckStore.getState().artifactId
      const list = useArtifactStore.getState().artifacts
      const target = targetId ? list.find(a => a.id === targetId) : null
      store.finish(
        text ? parseSelfCheckVerdict(text) : null,
        renderInputsFingerprint(target, list)
      )
    }
  }, [toolStatus])

  // 切会话 = 上一份稿子的自检结果失效，直接收起
  useEffect(() => {
    useSelfCheckStore.getState().close()
  }, [conversationId])

  // 用户在本会话又发了一条消息 = 他已经开口提修改，旧自检画面没有留存价值了 → 自动关闭。
  // 走与 ✕ 完全相同的销毁路径（合盖收起态同样关，close 不看 collapsed）。
  // 判据取"最后一条 user 消息的 id 变了"：所有发送入口（回车/点击/语音/重发）都必然经过它，
  // 比在某个具体按钮上挂钩子更不容易漏。选择器返回标量，流式每个 chunk 都不会触发重渲染。
  // 首次观测只记不关——挂载与会话水合那一刻的"从无到有"不是用户发言。
  const lastUserMsgId = useChatStore(s => {
    for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i].role === 'user') return s.messages[i].id
    return null
  })
  const seenUserMsgRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (seenUserMsgRef.current !== undefined && seenUserMsgRef.current !== lastUserMsgId) {
      useSelfCheckStore.getState().close()
    }
    seenUserMsgRef.current = lastUserMsgId
  }, [lastUserMsgId])

  const artifact = useMemo(
    () => (artifactId ? artifacts.find(a => a.id === artifactId) || null : null),
    [artifactId, artifacts]
  )

  // 当前渲染输入指纹：与 finish 时记录的不一致 = 结论描述的是旧版本（AI 修完没复检的常见形态）
  const currentFp = useMemo(
    () => renderInputsFingerprint(artifact, artifacts),
    [artifact, artifacts]
  )

  // 装配：与 HtmlPreview 同一组 dcRuntime 函数（缩略画面不带 bridge/sidecar/tweak）
  useEffect(() => {
    if (!open || !artifact) { setDoc(null); return }
    const src = artifact.content || ''
    let cancelled = false
    // 两段式，抄 HtmlPreview 的 assembleDocSync → assembleDoc：先同步内联 runtime 保底
    // （dc 产物少了 support.js 就是一片空白），再用异步的兄弟预制件解析升级；异步那步失败保留保底稿
    const build = async (): Promise<void> => {
      let out = isDcHtml(src) ? inlineDcRuntime(src) : inlineKnownScriptSiblings(src)
      if (!cancelled) setDoc(out)
      if (!isDcHtml(src)) return
      try {
        out = inlineDcRuntime(await inlineDcArtifactSiblings(src, conversationId))
        if (!cancelled) setDoc(out)
      } catch { /* 保底稿已经在画了 */ }
    }
    void build()
    return () => { cancelled = true }
    // 依赖挂 currentFp 而不是 artifact.content：场景 jsx 被改时薄壳内容一个字节没变，
    // 只盯 content 的话这张缩略图会一直画着旧画面（与"已过时"徽标是同一个坑）
  }, [open, artifact?.id, currentFp, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 第二道闸：解析阶段已经挑过可视类型，这里再挡一次（id 复用/类型后改都不至于把 JSON 塞进屏幕）
  if (!open || !artifact || !isVisualArtifactType(artifact.type)) return null

  const kind = pickFrame(artifact.content || '')
  const { vw, vh, w } = FRAME_SPEC[kind]
  const scale = w / vw

  const focusInWorkspace = (): void => {
    useWorkspaceStore.getState().openTab({
      kind: 'artifact',
      title: stripDcSuffix(artifact.title) || t('artifacts.common.untitledArtifact'),
      artifactId: artifact.id
    })
  }

  return (
    <div
      data-testid="self-check-preview"
      className="shrink-0 border-t border-surface-100 bg-surface-0 dark:bg-surface-50 px-4 py-2"
    >
      <div className="max-w-[880px] mx-auto">
        <div className="flex items-center gap-2 text-[12px]">
          {phase === 'running' ? (
            <>
              <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
              <span className="text-surface-600">{t('artifacts.selfCheck.checking')}</span>
            </>
          ) : verdict && verdictFp && currentFp && currentFp !== verdictFp ? (
            <>
              {/* 结论已过时：只声称"变了"，不猜"修好了"——证据式呈现，绿黄都不装 */}
              <Circle data-testid="self-check-stale-icon" size={13} className="text-surface-400 shrink-0" />
              <span className="text-surface-600">{t('artifacts.selfCheck.stale')}</span>
            </>
          ) : verdict?.ok === false ? (
            <>
              <AlertTriangle data-testid="self-check-issues-icon" size={13} className="text-amber-500 shrink-0" />
              <span className="text-surface-600">
                {t('artifacts.selfCheck.issues', { count: verdict.count })}
              </span>
            </>
          ) : !verdict || verdict.ok === null ? (
            <>
              <Circle data-testid="self-check-neutral-icon" size={13} className="text-surface-400 shrink-0" />
              <span className="text-surface-600">
                {verdict?.kind === 'raw' ? verdict.label : t('artifacts.selfCheck.complete')}
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 data-testid="self-check-success-icon" size={13} className="text-brand-500 shrink-0" />
              <span className="text-surface-600">
                {t('artifacts.selfCheck.clean')}
              </span>
            </>
          )}
          <button
            data-testid="self-check-open"
            onClick={focusInWorkspace}
            title={t('artifacts.selfCheck.openArtifact')}
            className="text-[11px] text-surface-400 hover:text-brand-600 dark:hover:text-brand-300 truncate max-w-[220px]"
          >
            {stripDcSuffix(artifact.title) || t('artifacts.common.untitled')}
          </button>
          <div className="flex-1" />
          {/* 收起没有按钮——直接点电脑本身"盖上"（见下方 self-check-lid），这里只留关闭 */}
          <button
            data-testid="self-check-close"
            onClick={() => useSelfCheckStore.getState().close()}
            title={t('common.actions.close')}
            className="p-1 rounded text-surface-400 hover:bg-surface-50 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* 整台电脑就是收起开关：点一下盖上、再点一下打开。iframe 是 pointerEvents:none，
            点击必然落在这个按钮上，不会被里面的页面吃掉 */}
        <div className="mt-2 flex justify-center">
          <button
            data-testid="self-check-lid"
            onClick={() => useSelfCheckStore.getState().toggleCollapsed()}
            title={collapsed ? t('artifacts.selfCheck.openLid') : t('artifacts.selfCheck.closeLid')}
            className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            {collapsed ? (
              <ClosedLid kind={kind} />
            ) : (
              <DeviceFrame kind={kind}>
                {/* 逻辑视口按真机尺寸渲染再整体缩放——直接给 iframe 小尺寸会触发响应式断点，
                    显示的就不是用户最终看到的那一版了 */}
                <iframe
                  data-testid="self-check-frame"
                  srcDoc={doc ?? undefined}
                  sandbox="allow-scripts"
                  title={t('artifacts.selfCheck.frameTitle')}
                  className="border-0 bg-white"
                  style={{
                    width: vw,
                    height: vh,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    pointerEvents: 'none'
                  }}
                />
              </DeviceFrame>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
