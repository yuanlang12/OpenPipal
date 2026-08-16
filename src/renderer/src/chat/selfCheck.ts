/**
 * 自检预览卡的纯逻辑（组件在 components/SelfCheckPreview.tsx）——按仓库惯例把可单测的部分
 * 放在 chat/*.ts，组件只留渲染。
 *
 * 自检 = agent 调 render_artifact（main 侧隐藏窗口真渲染 + console 报错 + 文本重叠 lint）。
 */
import { ChatMessage } from '../types'
import { getMessageKind } from './messages'
import { looksLikeDeckDc, looksLikePhoneDc, collectDcSiblingArtifactIds } from '../components/artifacts/dcRuntime'

export const SELF_CHECK_TOOL = 'render_artifact'

export type FrameKind = 'laptop' | 'phone' | 'wide'

/**
 * 外框内屏的逻辑视口（缩放基准）与展示宽度。
 * 展示宽度刻意压得小：这张卡钉在输入框上方，吃掉的是对话的垂直空间，而窗口默认只有 ~800 高
 * （侧栏模式还更窄）——够认出"这是我那一稿"就行，要细看走右侧产物面板。
 */
export const FRAME_SPEC: Record<FrameKind, { vw: number; vh: number; w: number }> = {
  laptop: { vw: 1280, vh: 800, w: 208 },
  phone: { vw: 402, vh: 874, w: 78 },
  wide: { vw: 1280, vh: 720, w: 232 }
}

/** 设备外框按产物形态挑：手机原型→手机、幻灯舞台→16:9 裸框、其余（网页/文档/画板）→笔记本 */
export function pickFrame(content: string): FrameKind {
  if (looksLikePhoneDc(content)) return 'phone'
  if (looksLikeDeckDc(content)) return 'wide'
  return 'laptop'
}

export type SelfCheckVerdict =
  | { ok: false; kind: 'issues'; count: number }
  | { ok: true; kind: 'clean' }
  | { ok: null; kind: 'complete' }
  | { ok: null; kind: 'raw'; label: string }

/**
 * Parse render_artifact's stable result markers without baking UI language into
 * stored state. Unrecognized model/tool text stays untranslated and preserves
 * the legacy 40-character display bound.
 */
export function parseSelfCheckVerdict(text: string): SelfCheckVerdict {
  const head = (text || '').split('\n')[0] || ''
  const m = head.match(/^\s*渲染发现\s*(\d+)\s*个问题/)
  if (m) return { ok: false, kind: 'issues', count: Number(m[1]) }
  if (/^\s*渲染干净(?:[：:]|$)/.test(head)) return { ok: true, kind: 'clean' }
  if (!head) return { ok: null, kind: 'complete' }
  return { ok: null, kind: 'raw', label: head.slice(0, 40) }
}

/**
 * 轻量内容指纹（长度 + djb2）。自检结论必须与"被检的那一版内容"绑定：结论落下后产物又被
 * AI 改过 → 徽标降级为"已过时"，而不是继续宣称旧结论。不求抗碰撞，只求变更可感知。
 */
export function contentFingerprint(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${text.length}:${h >>> 0}`
}

/**
 * **渲染输入**指纹 = 产物自身 + 它 from 链里引用的会话兄弟产物（场景 jsx 等）。
 *
 * 只盯薄壳自己是不够的：动画产物的画面由「薄壳 + N 份场景 jsx」共同决定，模型改 bug 十有八九
 * 改的是场景 jsx，薄壳一个字节都不动——只比薄壳的话，"自检发现 1 个问题"会永远钉在那里
 * （实测复现）。兄弟不在 store 里（未水合）记为 `-`，它变成有内容时指纹照样会变。
 */
export function renderInputsFingerprint(
  target: { id: string; content?: string } | null | undefined,
  artifacts: Array<{ id: string; content?: string }>
): string | null {
  if (!target) return null
  const own = contentFingerprint(target.content || '')
  const siblingIds = collectDcSiblingArtifactIds(target.content || '')
  if (!siblingIds.length) return own
  const byId = new Map(artifacts.map(a => [a.id, a]))
  const parts = siblingIds.map(id => {
    const sib = byId.get(id)
    return `${id}=${sib ? contentFingerprint(sib.content || '') : '-'}`
  })
  return `${own}|${parts.join(',')}`
}

const ARTIFACT_TOOLS = new Set(['create_artifact', 'edit_artifact'])

/**
 * 能当"画面"看的产物类型。todos/questions/goal 也走 artifact 管线、也带 artifactRef，
 * 但它们的 content 是 JSON，塞进设备外框只会显示一坨裸 JSON（实测：update_todos 之后自检，
 * 卡里显示的是任务清单的 JSON 文本）。design-system 的 content 是 {name}，同理不是画面。
 */
const VISUAL_ARTIFACT_TYPES = new Set(['html', 'svg', 'canvas', 'code', 'markdown', 'document'])

export function isVisualArtifactType(type?: string): boolean {
  return VISUAL_ARTIFACT_TYPES.has(type || 'html') // 流式早期 type 可能还没赋值 → 按 html 处理
}

/** 能直接当页面渲进设备外框的类型；源码类（code/markdown/document）srcdoc 出来只是文本，居次选 */
const RENDERABLE_PAGE_TYPES = new Set(['html', 'svg', 'canvas'])

/**
 * 本轮自检的目标产物 id。倒着扫到本轮的 user 消息为止（跨轮的旧产物不算数——path 模式自检
 * 设计系统 specimen 时，上一轮的稿子挂在这儿是误导）：
 *   · **可渲染页（html/svg/canvas）优先于源码类**——动画轮里模型常常后写场景 jsx，
 *     自检真正渲染的却是薄壳 html；把 jsx 原文塞进电脑屏幕只会是一片白
 *   · 命中 create_artifact / edit_artifact 但没 ref（落盘失败/ref 还没回填）→ 本轮已见的
 *     源码类候选优先，否则退到最近一个可视产物
 *   · todos/questions 这类非画面产物 → 跳过继续往前找，别把 JSON 塞进电脑屏幕
 *   · 都没有 → null，调用方据此不弹卡
 */
export function resolveSelfCheckTarget(
  messages: ChatMessage[],
  artifacts: Array<{ id: string; type?: string }>
): string | null {
  const typeById = new Map(artifacts.map(a => [a.id, a.type]))
  const lastVisual = (): string | null => {
    for (let i = artifacts.length - 1; i >= 0; i--) {
      if (isVisualArtifactType(artifacts[i].type)) return artifacts[i].id
    }
    return null
  }
  let textualHit: string | null = null // 本轮最近的源码类候选：先记住，继续找可渲染页
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') break
    const ref = (m as ChatMessage & { artifactRef?: { id?: string; type?: string } }).artifactRef
    if (ref?.id) {
      // 类型以 store 里的为准，store 没有（未水合）才退回 ref 自带的；流式早期无 type 按 html
      const ty = (typeById.get(ref.id) ?? ref.type) || 'html'
      if (!isVisualArtifactType(ty)) continue
      if (RENDERABLE_PAGE_TYPES.has(ty)) return ref.id
      if (!textualHit) textualHit = ref.id
      continue
    }
    if (getMessageKind(m) === 'tool' && m.toolName && ARTIFACT_TOOLS.has(m.toolName)) {
      return textualHit ?? lastVisual()
    }
  }
  return textualHit
}

/** 最近一条 render_artifact 的工具结果文本（有 content 才算已返回） */
export function latestSelfCheckResult(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (getMessageKind(m) === 'tool' && m.toolName === SELF_CHECK_TOOL && m.content) return m.content
  }
  return null
}
