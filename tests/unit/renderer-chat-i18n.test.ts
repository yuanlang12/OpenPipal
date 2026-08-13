import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import {
  TOOL_PHRASES,
  formatUnknownToolName,
  toolLabel,
  toolLabelKey,
  toolOngoing,
} from '../../src/renderer/src/chat/toolPhrases'
import { formatMessageTime } from '../../src/renderer/src/components/MessageBubble'
import { formatToolResultForDisplay } from '../../src/renderer/src/chat/toolResultDisplay'
import { piMessagesToChatMessages } from '../../src/renderer/src/components/messages/SubagentCard'

const CHAT_FILES = [
  'src/renderer/src/components/InputBar.tsx',
  'src/renderer/src/components/ChatPanel.tsx',
  'src/renderer/src/components/MemoryNotice.tsx',
  'src/renderer/src/components/MessageBubble.tsx',
  'src/renderer/src/components/StreamingInlinePreview.tsx',
  'src/renderer/src/components/MermaidBlock.tsx',
  'src/renderer/src/components/RoleArchiveViewer.tsx',
  'src/renderer/src/components/PermissionModal.tsx',
  'src/renderer/src/components/QuestionsV2Panel.tsx',
  'src/renderer/src/components/PendingMessageStack.tsx',
  'src/renderer/src/components/messages/AskUserForm.tsx',
  'src/renderer/src/components/messages/BashOutputCard.tsx',
  'src/renderer/src/components/messages/CodeExecutionCard.tsx',
  'src/renderer/src/components/messages/DocumentCard.tsx',
  'src/renderer/src/components/messages/FileResultCard.tsx',
  'src/renderer/src/components/messages/SearchResultCard.tsx',
  'src/renderer/src/components/messages/ScreenshotCard.tsx',
  'src/renderer/src/components/messages/SubagentCard.tsx',
  'src/renderer/src/components/messages/shared/CopyButton.tsx',
  'src/renderer/src/components/messages/shared/PasteButton.tsx',
  'src/renderer/src/components/messages/shared/VoiceReplayButton.tsx',
  'src/renderer/src/components/messages/ToolCallCard.tsx',
  'src/renderer/src/components/messages/UserMessage.tsx',
  'src/renderer/src/components/shared/markdown-shared.tsx',
]

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer chat i18n', () => {
  it('serves English Chat shell strings and stable tool phrases', async () => {
    const i18n = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(i18n.t('chat.input.placeholder')).toContain('Ask a question')
    expect(i18n.t('chat.errors.modelNotConfigured')).toContain('Settings → Models')
    expect(i18n.t('chat.permission.allow')).toBe('Allow')
    expect(i18n.t('chat.questions.submit')).toBe('Submit and continue')
    expect(i18n.t('chat.pending.images', { count: 2 })).toBe('[2 images]')
    expect(i18n.t('common.actions.copy')).toBe('Copy')
    expect(i18n.t('common.actions.copied')).toBe('Copied')
    expect(i18n.t('chat.bashOutput.terminal')).toBe('Terminal')
    expect(i18n.t('chat.codeExecution.codeLines', { count: 1 })).toBe('Code (1 line)')
    expect(i18n.t('chat.codeExecution.codeLines', { count: 3 })).toBe('Code (3 lines)')
    expect(i18n.t('chat.memoryNotice.rememberedOne', {
      name: '用户命名',
      scope: i18n.t('chat.memoryNotice.scopes.global'),
    })).toBe('Remembered: 用户命名 (Global)')
    expect(i18n.t('chat.memoryNotice.globalCount', { count: 1 })).toBe('1 global memory')
    expect(i18n.t('chat.memoryNotice.globalCount', { count: 2 })).toBe('2 global memories')
    expect(i18n.t('chat.memoryNotice.organizedWithSummary', {
      count: 2,
      summary: '原始摘要',
    })).toBe('Memory organization complete (2 actions: 原始摘要)')
    expect(i18n.t('chat.streamingPreview.phases.layout')).toBe('Aligning the layout…')
    expect(i18n.t('chat.streamingPreview.frameTitle')).toBe('Live visualization preview')
    expect(i18n.t('chat.mermaid.errorTitle')).toBe('Mermaid render error')
    expect(i18n.t('chat.searchResult.title')).toBe('Search results')
    expect(i18n.t('chat.screenshot.loading')).toBe('Loading screenshot…')
    expect(i18n.t('chat.paste.toApp', { appName: '用户应用' })).toBe('Paste into 用户应用')
    expect(i18n.t('chat.voiceReplay.title')).toBe('Replay this voice message')
    expect(i18n.t('chat.markdown.linkTitle')).toContain('preview in Workspace')
    expect(i18n.t('chat.fileResult.badges.teachingStyle')).toBe('Teaching style')
    expect(i18n.t('chat.fileResult.skillNames.frontendDesign')).toBe('Interface design')
    expect(i18n.t('chat.fileDisplay.aliases.styleOverview')).toBe('Style overview')
    expect(i18n.t('chat.document.previewInWorkspace')).toBe('Preview in Workspace')
    expect(i18n.t('chat.subagent.turns', { count: 1 })).toBe('1 turn')
    expect(i18n.t('chat.subagent.turns', { count: 3 })).toBe('3 turns')
    expect(i18n.t('chat.subagent.label')).toBe('Subagent')
    expect(i18n.t('chat.roleArchive.unsupported')).toBe('Preview is not available for this file yet.')
    expect(chinese.t('chat.memoryNotice.organized', { count: 2 })).toBe('记忆整理完成（2 项操作）')
    expect(chinese.t('chat.screenshot.title')).toBe('屏幕截图')
    expect(chinese.t('chat.fileDisplay.aliases.archiveOverview')).toBe('档案总览')
    expect(chinese.t('chat.errors.modelNotConfigured')).toContain('设置 → 模型')
    expect(toolLabel('save_memory', i18n.t)).toBe('Save memory')
    expect(toolOngoing('read_page_content', i18n.t)).toBe('Reading the page...')
  })

  it('maps protocol tool names to translation keys without renaming the protocol', () => {
    expect(toolLabelKey('save_memory')).toBe('chat.tools.saveMemory.label')
    expect(Object.keys(TOOL_PHRASES)).toContain('questions_v2')
    expect(Object.keys(TOOL_PHRASES)).toContain('execute_command')
    expect(formatUnknownToolName('classin_get_courses')).toBe('ClassIn Get Courses')
    expect(formatUnknownToolName('custom-mcp_tool')).toBe('Custom Mcp Tool')
  })

  it('requires renderer callers to provide the active translator explicitly', () => {
    const phrases = read('src/renderer/src/chat/toolPhrases.ts')
    const production = CHAT_FILES
      .concat([
        'src/renderer/src/components/ProcessGroup.tsx',
        'src/renderer/src/components/StreamingArea.tsx',
      ])
      .map(read)
      .join('\n')

    expect(phrases).not.toContain('rendererI18n')
    expect(phrases).toContain('toolLabel(name: string, t: TFunction)')
    expect(phrases).toContain('toolOngoing(name: string, t: TFunction)')
    expect(production).not.toMatch(/tool(?:Label|Ongoing)\([^,\n)]+\)/)
  })

  it('formats message times with the active i18n locale', () => {
    const timestamp = new Date('2026-08-09T13:05:00Z').getTime()
    const english = formatMessageTime(timestamp, 'en-US')
    const chinese = formatMessageTime(timestamp, 'zh-CN')

    expect(english).toBe(new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp))
    expect(chinese).toBe(new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp))
    expect(english).not.toBe(chinese)
  })

  it('localizes only the OpenPipal artifact receipt prefix at display time', async () => {
    const i18n = await createRendererI18n('en')
    const receipt = '预览: 用户标题 (id: artifact-原始-id)'

    expect(formatToolResultForDisplay('create_artifact', receipt, i18n.t)).toBe(
      'Preview: 用户标题 (id: artifact-原始-id)'
    )
    expect(formatToolResultForDisplay('create_artifact', `已更新${receipt}`, i18n.t)).toBe(
      'Preview updated: 用户标题 (id: artifact-原始-id)'
    )
    expect(formatToolResultForDisplay('read', receipt, i18n.t)).toBe(receipt)
  })

  it('removes migrated Chinese shell literals while preserving content payloads', () => {
    const source = stripComments(CHAT_FILES.map(read).join('\n'))
    const migratedUiLiterals = [
      '松开上传文件...',
      '输入问题...（@ 唤起技能）',
      '选择工作目录',
      '需要确认：高风险操作',
      '本次会话允许此类操作',
      '请在下方表单中回答',
      '重新生成',
      '提交并继续',
      '立即插入对话(不等当前回复完成)',
      '在工作空间打开',
      '已复制',
      '复制',
      '终端',
      '(无输出)',
      '代码 ({exec.code.split',
      '记忆已更新',
      '已记住：',
      '记忆整理完成',
      '勾勒轮廓…',
      '填充色彩…',
      '对齐排版…',
      'Mermaid 渲染错误',
      '图表渲染失败',
      '搜索结果',
      '屏幕截图',
      '加载截图…',
      '已粘贴',
      '粘贴失败',
      '粘贴到 ${appName}',
      '回听这段语音',
      '点击在工作空间预览 · ⌘+点击外部打开',
      '设计稿规范',
      '加载设计系统',
      '写入文件',
      '编辑文件',
      '读取文件',
      '点击在工作空间预览',
      '在工作空间中预览这个文档',
      '在工作空间预览',
      '外部应用',
      '(unknown)',
      '(no output)',
      '(无对话历史)',
      '无用量数据',
      '收起 child agent 对话历史',
      '展开 child agent 完整对话历史',
      '这个档案还是空的',
      '个人教学参考 · 不是硬性要求 · 备课时按任务参考',
      '旧版档案总览 · 建议整理为个人教学风格',
      '这个文件暂不支持预览。',
    ]

    for (const literal of migratedUiLiterals) expect(source).not.toContain(literal)

    const input = read('src/renderer/src/components/InputBar.tsx')
    const questions = read('src/renderer/src/components/QuestionsV2Panel.tsx')
    const askUser = read('src/renderer/src/components/messages/AskUserForm.tsx')
    expect(input).toContain("'请分析这些文件'")
    expect(input).toContain('随消息附图为该圈选区域截图')
    expect(questions).toContain("final[q.id] = t('chat.questions.aiDecisionAnswer')")
    expect(questions).toContain("const note = t('chat.questions.attachedMaterials'")
    expect(askUser).toContain("values[f.label] || t('chat.askUser.notFilled')")
  })

  it('keeps user, Agent, thinking, tool, and dynamic question content outside translation calls', () => {
    const bubble = read('src/renderer/src/components/MessageBubble.tsx')
    const toolCard = read('src/renderer/src/components/messages/ToolCallCard.tsx')
    const questions = read('src/renderer/src/components/QuestionsV2Panel.tsx')
    const permission = read('src/renderer/src/components/PermissionModal.tsx')
    const bash = read('src/renderer/src/components/messages/BashOutputCard.tsx')
    const codeExecution = read('src/renderer/src/components/messages/CodeExecutionCard.tsx')
    const memoryNotice = read('src/renderer/src/components/MemoryNotice.tsx')
    const mermaid = read('src/renderer/src/components/MermaidBlock.tsx')
    const searchResult = read('src/renderer/src/components/messages/SearchResultCard.tsx')
    const screenshot = read('src/renderer/src/components/messages/ScreenshotCard.tsx')
    const paste = read('src/renderer/src/components/messages/shared/PasteButton.tsx')
    const voiceReplay = read('src/renderer/src/components/messages/shared/VoiceReplayButton.tsx')
    const markdown = read('src/renderer/src/components/shared/markdown-shared.tsx')
    const fileResult = read('src/renderer/src/components/messages/FileResultCard.tsx')
    const document = read('src/renderer/src/components/messages/DocumentCard.tsx')
    const subagent = read('src/renderer/src/components/messages/SubagentCard.tsx')
    const roleArchive = read('src/renderer/src/components/RoleArchiveViewer.tsx')
    const fileDisplay = read('src/renderer/src/chat/fileDisplay.ts')

    expect(bubble).toContain('<Markdown content={displayContent} />')
    expect(bubble).toContain('{content}')
    expect(toolCard).toContain('formatToolResultForDisplay(name, message.content, t)')
    expect(toolCard).toContain('{displayContent}')
    expect(toolCard).toContain('{artifactDisplayTitle}')
    expect(toolCard).not.toContain("replace('预览: '")
    expect(toolCard).toContain('{value}')
    expect(permission).toContain('{request.reason}')
    expect(permission).toContain('{value}')
    expect(questions).toContain('{q.title}')
    expect(questions).toContain('{q.subtitle}')
    expect(questions).toContain('>{optStr}</button>')
    expect(questions).toContain('placeholder={q.placeholder}')
    expect(bash).toContain('navigator.clipboard.writeText(output)')
    expect(bash).toContain('{output || t(')
    expect(codeExecution).toContain('{exec.description}')
    expect(codeExecution).toContain('{exec.stdout}')
    expect(codeExecution).toContain('{exec.stderr}')
    expect(codeExecution).toContain("typeof value.code !== 'string'")
    expect(memoryNotice).toContain('{ name: m.name, scope }')
    expect(memoryNotice).toContain("{ count, summary }")
    expect(searchResult).toContain('{message.searchResults}')
    expect(screenshot).toContain('`data:image/jpeg;base64,${screenshot}`')
    expect(mermaid).toContain('detail: e instanceof Error ? e.message : null')
    expect(mermaid).toContain("{error.detail || t('chat.mermaid.renderFailed')}")
    expect(mermaid).toContain('<code>{code}</code>')
    expect(mermaid).not.toMatch(/setError\([^)]*t\(/)
    expect(paste).toContain('pasteToTarget(text)')
    expect(paste).toContain("t('chat.paste.toApp', { appName })")
    expect(voiceReplay).toContain('readVoiceAudio?.(audioPath)')
    expect(markdown).toContain("title={title || t('chat.markdown.linkTitle')}")
    expect(markdown).toContain('{children}')
    expect(fileResult).toContain("const content = message.content || ''")
    expect(fileResult).toContain(': skillNameKey ? t(skillNameKey) : skillSlug')
    expect(fileResult).toContain('resolveFileDisplayLabel(archive.docName, t)')
    expect(fileResult).toContain('{filePath}')
    expect(fileResult).toContain('{content || t(')
    expect(document).toContain('{a.title || name}')
    expect(document).toContain('{a.docType}')
    expect(document).toContain('<Markdown content={docContent} />')
    expect(subagent).toContain('toolName: block.name')
    expect(subagent).toContain('{data.profile || t(')
    expect(subagent).toContain('{data.modelId}')
    expect(subagent).toContain('{localizeSubagentError(t, data.errorMessage)}')
    // 非哨兵（模型/网关原文）必须原样返回，不许过 t()
    expect(subagent).toContain('return maxTurns === null ? message :')
    expect(subagent).toContain('{data.stopReason}')
    expect(subagent).toContain('<MessageBubble key={m.id} message={m} />')
    expect(roleArchive).toContain('{error.detail || t(')
    expect(roleArchive).toContain('<Markdown content={docText} />')
    expect(roleArchive).toContain('alt={selected}')
    expect(roleArchive).toContain('>{e.name}</span>')
    expect(roleArchive).not.toMatch(/setError\([^)]*t\(/)
    expect(fileDisplay).toContain('translationKey?: string')
    expect(fileDisplay).toContain('label.translationKey ? t(label.translationKey) : label.raw')

    const source = CHAT_FILES.map(read).join('\n')
    expect(source).not.toMatch(/\bt\(\s*(?:message\.content|content|request\.reason|q\.title|q\.subtitle|optStr|data\.profile|data\.modelId|data\.errorMessage|data\.stopReason|docContent|docText)/)
  })

  it('resolves the missing-model alert at call time without translating generated user content', () => {
    const store = read('src/renderer/src/stores/chatStore.ts')

    expect(store).toContain("window.alert(rendererI18n.t('chat.errors.modelNotConfigured'))")
    expect(store).toContain("? 'chat.message.analyzeFiles'")
    expect(store).toContain(": 'chat.message.analyzeFile'")
    expect(store).not.toContain("fileAttachments.length > 1 ? '请分析这些文件' : '请分析这个文件'")
  })

  it('keeps migrated English text actions fluid or content-sized', () => {
    const bubble = read('src/renderer/src/components/MessageBubble.tsx')
    const paste = read('src/renderer/src/components/messages/shared/PasteButton.tsx')
    const permission = read('src/renderer/src/components/PermissionModal.tsx')
    const questions = read('src/renderer/src/components/QuestionsV2Panel.tsx')
    const toolCard = read('src/renderer/src/components/messages/ToolCallCard.tsx')
    const userMessage = read('src/renderer/src/components/messages/UserMessage.tsx')
    const document = read('src/renderer/src/components/messages/DocumentCard.tsx')
    const subagent = read('src/renderer/src/components/messages/SubagentCard.tsx')

    expect(permission).toContain('className="flex-1 text-[12px] py-2')
    expect(questions).toContain('className="w-full px-5 py-2 text-sm font-medium')
    expect(toolCard).toContain('className="mt-1 w-full flex items-center gap-2')
    expect(userMessage).toContain('text-[11px] text-white/60 px-2')
    expect(bubble).toContain('min-w-0 flex-1 flex flex-wrap items-center')
    expect(bubble).toContain('shrink-0 self-end text-chat-small')
    expect(paste).toContain('min-w-0 max-w-full flex items-center')
    expect(paste).toContain('title={label}')
    expect(paste).toContain('className="min-w-0 truncate"')
    expect(document).toContain('className="flex flex-wrap items-center gap-1 py-1.5 border-t border-border"')
    expect(subagent).toContain('min-w-0 max-w-[45%] truncate')
    expect(subagent).toContain('min-w-0 truncate text-chat-label')
  })

  it('keeps projected subagent ids and timestamps stable across locale changes', () => {
    const messages = [
      { role: 'user', content: '原始任务', timestamp: 100 },
      {
        role: 'assistant',
        timestamp: 200,
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/原始/路径.md' } }],
      },
      { role: 'toolResult', toolCallId: 'call-1', content: [], timestamp: 300 },
    ]
    const english = piMessagesToChatMessages(messages, '(No output)', 'parent-1', 50)
    const chinese = piMessagesToChatMessages(messages, '（无输出）', 'parent-1', 50)

    expect(english.map(message => message.id)).toEqual(chinese.map(message => message.id))
    expect(english.map(message => message.timestamp)).toEqual([100, 200])
    expect(chinese.map(message => message.timestamp)).toEqual([100, 200])
    expect(english[1].content).toBe('(No output)')
    expect(chinese[1].content).toBe('（无输出）')
  })
})
