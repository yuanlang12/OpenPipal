import type { TFunction } from 'i18next'

const CREATE_ARTIFACT_RECEIPTS = [
  { prefix: '预览: ', key: 'chat.toolReceipts.preview' },
  { prefix: '已创建预览: ', key: 'chat.toolReceipts.createdPreview' },
  { prefix: '已更新预览: ', key: 'chat.toolReceipts.updatedPreview' },
  { prefix: '已创建: ', key: 'chat.toolReceipts.createdArtifact' },
] as const

const TODOS_UPDATED = /^任务清单已更新（(\d+)\/(\d+) 完成）：(?=\n|$)/
const TODOS_CLEARED = '任务清单已清空。'
const VISUALIZER_PREFIX = '已创建可视化: '
const VISUALIZER_ADAPTER_PREFIX = '可视化: '
const VISUALIZER_ORB_PREFIX = `\n\n⚠️ 当前在 orb 模式，用户**看不到**内联可视化。立即调用 present_to_user({ content: <本次的 content 字段原文>, kind: 'interactive', title: '`
const VISUALIZER_ORB_SUFFIX = `' }) 把它推到 Presenter 窗口。`
const QUESTION_PAGE_PREFIX = '问答页: '
const QUESTION_PAGE_DEFAULT = '问答页'

/**
 * Localize only OpenPipal-owned receipt chrome at render time. The persisted
 * tool result remains byte-for-byte unchanged for replay and model context;
 * user titles, artifact ids, and every non-artifact result stay untouched.
 */
export function formatToolResultForDisplay(
  toolName: string,
  content: string,
  t: TFunction,
): string {
  if (toolName === 'create_artifact') {
    const receipt = CREATE_ARTIFACT_RECEIPTS.find(({ prefix }) => content.startsWith(prefix))
    if (!receipt) return content
    return `${t(receipt.key)}: ${content.slice(receipt.prefix.length)}`
  }

  if (toolName === 'update_todos') {
    if (content === TODOS_CLEARED) return t('chat.toolReceipts.todosCleared')
    const match = TODOS_UPDATED.exec(content)
    if (match) {
      return `${t('chat.toolReceipts.todosUpdated', { done: match[1], total: match[2] })}${content.slice(match[0].length)}`
    }
  }

  if (toolName === 'create_visualizer' && content.startsWith(VISUALIZER_PREFIX)) {
    const rest = content.slice(VISUALIZER_PREFIX.length)
    const hintStart = rest.indexOf(VISUALIZER_ORB_PREFIX)
    if (hintStart < 0) return `${t('chat.toolReceipts.createdVisualization')}: ${rest}`
    const hintTitleStart = hintStart + VISUALIZER_ORB_PREFIX.length
    if (!rest.endsWith(VISUALIZER_ORB_SUFFIX) || hintTitleStart > rest.length - VISUALIZER_ORB_SUFFIX.length) {
      return `${t('chat.toolReceipts.createdVisualization')}: ${rest}`
    }
    const hintTitle = rest.slice(hintTitleStart, rest.length - VISUALIZER_ORB_SUFFIX.length)
    return `${t('chat.toolReceipts.createdVisualization')}: ${rest.slice(0, hintStart)}${t(
      'chat.toolReceipts.visualizerOrbHint',
      { title: hintTitle }
    )}`
  }

  if (toolName === 'create_visualizer' && content.startsWith(VISUALIZER_ADAPTER_PREFIX)) {
    return `${t('chat.toolReceipts.visualization')}: ${content.slice(VISUALIZER_ADAPTER_PREFIX.length)}`
  }

  if (toolName === 'questions_v2' && content.startsWith(QUESTION_PAGE_PREFIX)) {
    return `${t('chat.toolReceipts.questionPage')}: ${content.slice(QUESTION_PAGE_PREFIX.length)}`
  }
  if (toolName === 'questions_v2' && content === QUESTION_PAGE_DEFAULT) {
    return t('chat.toolReceipts.questionPage')
  }

  return content
}
