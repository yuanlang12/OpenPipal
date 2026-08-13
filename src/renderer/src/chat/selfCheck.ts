/**
 * 自检预览卡的纯逻辑（组件在 components/SelfCheckPreview.tsx）——按仓库惯例把可单测的部分
 * 放在 chat/*.ts，组件只留渲染。
 *
 * 自检 = agent 调 render_artifact（main 侧隐藏窗口真渲染 + console 报错 + 文本重叠 lint）。
 */
import { ChatMessage } from '../types'
import { getMessageKind } from './messages'
import { looksLikeDeckDc, looksLikePhoneDc } from '../components/artifacts/dcRuntime'

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

/**
 * 本轮自检的目标产物 id。倒着扫到本轮的 user 消息为止（跨轮的旧产物不算数——path 模式自检
 * 设计系统 specimen 时，上一轮的稿子挂在这儿是误导）：
 *   · 命中带 artifactRef 且类型可视的消息 → 用它的 id（精确）
 *   · 命中 create_artifact / edit_artifact 但没 ref（落盘失败/ref 还没回填）→ 退到最近一个可视产物
 *   · 命中的是 todos/questions 这类非画面产物 → 跳过继续往前找，别把 JSON 塞进电脑屏幕
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') break
    const ref = (m as ChatMessage & { artifactRef?: { id?: string; type?: string } }).artifactRef
    if (ref?.id) {
      // 类型以 store 里的为准，store 没有（未水合）才退回 ref 自带的
      if (isVisualArtifactType(typeById.get(ref.id) ?? ref.type)) return ref.id
      continue
    }
    if (getMessageKind(m) === 'tool' && m.toolName && ARTIFACT_TOOLS.has(m.toolName)) return lastVisual()
  }
  return null
}

/** 最近一条 render_artifact 的工具结果文本（有 content 才算已返回） */
export function latestSelfCheckResult(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (getMessageKind(m) === 'tool' && m.toolName === SELF_CHECK_TOOL && m.content) return m.content
  }
  return null
}
