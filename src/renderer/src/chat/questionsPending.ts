/**
 * questions_v2 的待答状态既要在当前 renderer 里可用，也要能随会话落盘恢复。
 * 问卷本体是 ephemeral 过程物，不写 artifact sidecar；答题前的完整题目只暂存在
 * conversation.config.pendingQuestion 中，答题后随 pending 状态一起清掉。
 */

export interface PersistedPendingQuestion {
  artifactId: string
  title: string
  questions: any[]
}

export interface PendingQuestion extends PersistedPendingQuestion {
  conversationId: string
}

/**
 * 新版问卷锚点的轻量版本标记。
 *
 * 这个标记不携带题目正文，也不会把问卷变成永久 artifact；它只让历史 UI 能区分
 * "新版的 ephemeral 问卷" 和 "旧版只留下标题、没有任何可恢复正文的问卷"。
 */
export const QUESTIONS_V2_PERSISTENCE_VERSION = 1

type QuestionMessage = {
  id?: unknown
  role?: unknown
  content?: unknown
  toolName?: unknown
  questionsV2Version?: unknown
  artifactRef?: { id?: unknown; type?: unknown; title?: unknown; path?: unknown }
}

type QuestionArtifact = {
  id?: unknown
  type?: unknown
  title?: unknown
  content?: unknown
}

const ANSWER_PREFIX = '[Questions answered]'

type LegacyQuestionContext = {
  /** 当前待答状态命中时，说明该问卷正文仍完整可恢复。 */
  pendingArtifactId?: unknown
  /** 已有对应答案时，不应再对历史工具卡提示“无法恢复”。 */
  messages?: QuestionMessage[]
}

export function toPersistedPendingQuestion(question: PendingQuestion): PersistedPendingQuestion {
  return {
    artifactId: question.artifactId,
    title: question.title,
    questions: question.questions
  }
}

/** 容错读取旧会话配置；坏数据不应让整个对话切换失败。 */
export function restorePendingQuestion(value: unknown, conversationId: string): PendingQuestion | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PersistedPendingQuestion>
  if (typeof candidate.artifactId !== 'string' || !candidate.artifactId) return null
  if (!Array.isArray(candidate.questions)) return null
  return {
    artifactId: candidate.artifactId,
    title: typeof candidate.title === 'string' ? candidate.title : '',
    questions: candidate.questions,
    conversationId
  }
}

/**
 * 修复前的 questions_v2 有一段历史只写下 artifact 标题，既没有 sidecar 路径，
 * 也没有题目 JSON。此时不能把它误当成「已提交」或渲染一张空问卷；原题内容已不在
 * 会话数据中，只能如实提示用户让 Agent 重新展示。
 *
 * 不能把 path 为空直接视为旧版：新版 questions 同样是 ephemeral，path 必然为空。
 * 新锚点带版本标记；部署过渡期的问卷则从 pending 状态或后续答案判定是否仍可恢复。
 */
export function isLegacyQuestionWithoutPayload(message: QuestionMessage, context: LegacyQuestionContext = {}): boolean {
  if (message.toolName !== 'questions_v2') return false
  if (message.questionsV2Version === QUESTIONS_V2_PERSISTENCE_VERSION) return false
  const ref = message.artifactRef
  if (ref?.type !== 'questions' || typeof ref.id !== 'string' || !ref.id) return false
  if (context.pendingArtifactId === ref.id) return false
  if (context.messages && hasAnswerAfterQuestionAnchor(message, context.messages)) return false
  return typeof ref.path !== 'string' || ref.path.length === 0
}

function parseQuestionPayload(content: unknown, fallbackTitle: string): { title: string; questions: any[] } | null {
  if (typeof content !== 'string') return null
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).questions)) return null
    return {
      title: typeof (parsed as any).title === 'string' ? (parsed as any).title : fallbackTitle,
      questions: (parsed as any).questions
    }
  } catch {
    return null
  }
}

function isAnswerForQuestion(message: QuestionMessage, title: string): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  const content = message.content.trim()
  if (!content.startsWith(ANSWER_PREFIX)) return false
  // 一次 agent run 在等待答案时就会停下，因此正常情况下一张问卷对应一条后续答案。
  // 标题可用时再对齐一次，避免历史中另一张问卷的答案误关当前问卷。
  return !title || !content.includes('问题卡「') || content.includes(`问题卡「${title}」`)
}

/**
 * 待答配置与历史消息对账：崩溃发生在“答案已写入、pending 尚未来得及清理”之间时不重开旧问卷。
 *
 * 同一会话可能多次出现同标题（默认标题尤其常见）。已知当前 artifactId 时，答案必须位于
 * 该问卷锚点之后，不能让早先同名问卷的答案误关刚生成的新卡片。
 */
export function hasAnsweredQuestion(messages: QuestionMessage[], title: string, artifactId?: string): boolean {
  const anchorIndex = artifactId
    ? messages.findIndex(message => message.artifactRef?.id === artifactId)
    : -1
  const candidates = anchorIndex >= 0 ? messages.slice(anchorIndex + 1) : messages
  return candidates.some(message => isAnswerForQuestion(message, title))
}

function hasAnswerAfterQuestionAnchor(anchor: QuestionMessage, messages: QuestionMessage[]): boolean {
  const refId = anchor.artifactRef?.id
  if (typeof refId !== 'string' || !refId) return false
  const anchorIndex = messages.findIndex(message =>
    (typeof anchor.id === 'string' && message.id === anchor.id) || message.artifactRef?.id === refId
  )
  if (anchorIndex < 0) return false
  const title = typeof anchor.artifactRef?.title === 'string'
    ? anchor.artifactRef.title
    : typeof anchor.content === 'string' ? anchor.content : ''
  return hasAnsweredQuestion(messages, title, refId)
}

/**
 * 兼容修复前已落盘的问卷：旧版本没有 pendingQuestion 配置，仍可根据
 * “问卷锚点之后是否有对应答案”恢复一张未回答的问卷。新版本优先用持久化状态。
 */
export function recoverPendingQuestionFromHistory(
  messages: QuestionMessage[],
  artifacts: QuestionArtifact[],
  conversationId: string
): PendingQuestion | null {
  for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex--) {
    const artifact = artifacts[artifactIndex]
    if (artifact?.type !== 'questions' || typeof artifact.id !== 'string') continue
    const fallbackTitle = typeof artifact.title === 'string' ? artifact.title : ''
    const payload = parseQuestionPayload(artifact.content, fallbackTitle)
    if (!payload) continue

    const anchorIndex = messages.findIndex(message => message.artifactRef?.id === artifact.id)
    if (anchorIndex < 0) continue
    const answered = hasAnsweredQuestion(messages.slice(anchorIndex + 1), payload.title)
    if (!answered) {
      return {
        artifactId: artifact.id,
        title: payload.title,
        questions: payload.questions,
        conversationId
      }
    }
  }
  return null
}
