import { describe, expect, it, vi } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { formatMessageContentForDisplay, injectNoticeContentForDisplay } from '../../src/renderer/src/chat/messageDisplay'
import { formatToolResultForDisplay } from '../../src/renderer/src/chat/toolResultDisplay'
import { buildInterpretTranscriptArchive } from '../../src/renderer/src/chat/voiceArchiveDisplay'
import { fatalStartupText } from '../../src/renderer/src/i18n/fatalStartup'
import { renderBrowserNotificationHtml } from '../../src/main/browser-notification-html'
import { createLatestLocaleApplier } from '../../src/main/locale-apply-queue'
import { artifactTabTitleDescriptor, workspaceTabTitle } from '../../src/renderer/src/components/workspace/workspaceLabels'
import { mergeSyntheticStreamError } from '../../src/renderer/src/chat/syntheticStreamError'

describe('i18n P1 dynamic-content boundaries', () => {
  it('projects exact OpenPipal sentinels while preserving stored and dynamic content', async () => {
    const en = await createRendererI18n('en')
    const rawQuestions = '[Questions answered] 问题卡「Provider Ω / 用户标题」\n自定义：原样'
    const questionsMessage = { role: 'user' as const, content: rawQuestions }
    expect(formatMessageContentForDisplay(questionsMessage, en.t)).toBe(
      'Questions answered: “Provider Ω / 用户标题”\n自定义：原样'
    )
    expect(questionsMessage.content).toBe(rawQuestions)
    const nestedTitle = '[Questions answered] 问题卡「关于「品牌」的问题」\n答案'
    expect(formatMessageContentForDisplay({ role: 'user', content: nestedTitle }, en.t))
      .toBe('Questions answered: “关于「品牌」的问题”\n答案')

    for (const raw of ['[Questions answered]foo', '[Questions answered] 这是普通说明']) {
      expect(formatMessageContentForDisplay({ role: 'user', content: raw }, en.t)).toBe(raw)
    }
    expect(formatMessageContentForDisplay({ role: 'user', content: '[Error] user text' }, en.t))
      .toBe('[Error] user text')
    expect(formatMessageContentForDisplay({ role: 'assistant', content: '[Error] model text' }, en.t))
      .toBe('[Error] model text')

    const zh = await createRendererI18n('zh-CN')
    const partial = 'model line\n[Error] quoted by model'
    const rawError = `${partial}\n\n[Error] provider-动态`
    const errorMessage = {
      role: 'assistant' as const,
      content: rawError,
      messageKind: 'incomplete' as const,
      messageSubtype: 'stream-error',
      syntheticErrorOffset: partial.length + 2
    }
    expect(formatMessageContentForDisplay(errorMessage, zh.t)).toBe(
      `${partial}\n\n[错误] provider-动态`
    )
    expect(errorMessage.content).toBe(rawError)
    for (const syntheticErrorOffset of [Number.NaN, -1, rawError.length + 1]) {
      expect(formatMessageContentForDisplay({ ...errorMessage, syntheticErrorOffset }, zh.t)).toBe(rawError)
    }
  })

  it('deduplicates the repeated error chunk and tags only the OpenPipal suffix', () => {
    const partial = 'model text\n[Error] model quotation'
    const once = mergeSyntheticStreamError(`${partial}\n\n[Error] provider down`, 'provider down')
    expect(once.content).toBe(`${partial}\n\n[Error] provider down`)
    expect(once.offset).toBe(partial.length + 2)
    expect(once.content.match(/provider down/g)).toHaveLength(1)
    expect(mergeSyntheticStreamError('\n\n[Error] only error', 'only error'))
      .toEqual({ content: '[Error] only error', offset: 0 })
  })

  it('projects only exact legacy inject notices without changing stored content', async () => {
    const en = await createRendererI18n('en')
    const legacy = { content: '↳ 已引导对话' }
    expect(injectNoticeContentForDisplay(legacy, en.t)).toBe('↳ Conversation steered')
    expect(legacy.content).toBe('↳ 已引导对话')
    expect(injectNoticeContentForDisplay({ content: '↳ 已引导对话!' }, en.t)).toBe('↳ 已引导对话!')
  })

  it('localizes only exact known tool chrome and leaves dynamic payloads untouched', async () => {
    const en = await createRendererI18n('en')
    const title = 'Provider / 用户标题 🧪'
    expect(formatToolResultForDisplay('create_visualizer', `可视化: ${title}`, en.t))
      .toBe(`Visualization: ${title}`)
    expect(formatToolResultForDisplay('create_visualizer', `x可视化: ${title}`, en.t))
      .toBe(`x可视化: ${title}`)
    expect(formatToolResultForDisplay('update_todos', '任务清单已更新（1/2 完成）：\n☑ 保留动态内容', en.t))
      .toBe('Task list updated (1/2 completed):\n☑ 保留动态内容')
    expect(formatToolResultForDisplay('questions_v2', '问答页', en.t)).toBe('Question page')
    expect(formatToolResultForDisplay('questions_v2', `问答页: ${title}`, en.t))
      .toBe(`Question page: ${title}`)
  })

  it('uses stable metadata rather than default-looking dynamic question titles', async () => {
    const en = await createRendererI18n('en')
    const dynamic = artifactTabTitleDescriptor({ type: 'questions', title: 'A few questions' })
    expect(workspaceTabTitle(dynamic as any, en.t)).toBe('A few questions')
    const productDefault = artifactTabTitleDescriptor({
      type: 'questions',
      title: 'A few questions',
      titleKey: 'chat.questions.defaultTitle'
    })
    expect(workspaceTabTitle(productDefault as any, en.t)).toBe('A few questions')
    await en.changeLanguage('zh-CN')
    expect(workspaceTabTitle(dynamic as any, en.t)).toBe('A few questions')
    expect(workspaceTabTitle(productDefault as any, en.t)).toBe('几个问题')
  })

  it('archives interpretation labels in the locale active at archive time', async () => {
    const en = await createRendererI18n('en')
    const messages = [
      { role: 'user', content: 'dynamic source' },
      { role: 'assistant', content: '动态译文' }
    ]
    const english = buildInterpretTranscriptArchive(messages, en.t)
    expect(english.title).toBe('Interpretation')
    expect(english.content).toContain('**Source** dynamic source')
    expect(english.content).toContain('**Translation** 动态译文')
    await en.changeLanguage('zh-CN')
    const chinese = buildInterpretTranscriptArchive(messages, en.t)
    expect(chinese.title).toBe('同传')
    expect(chinese.content).toContain('**源** dynamic source')
    expect(chinese.content).toContain('**译** 动态译文')
  })
})

describe('native locale lifecycle helpers', () => {
  it('renders one locale per browser prompt with lang and browser name preserved', async () => {
    const en = await createRendererI18n('en')
    const english = renderBrowserNotificationHtml('Browser Ω', 'en', en.t)
    expect(english).toContain('<html lang="en">')
    expect(english).toContain('Browser Ω')
    expect(english).toContain('Not now')
    // Deliberately keep the translator in English: the helper must pin copy to
    // the requested locale during the brief system-locale transition window.
    const chinese = renderBrowserNotificationHtml('Browser Ω', 'zh-CN', en.t)
    expect(chinese).toContain('<html lang="zh-CN">')
    expect(chinese).toContain('Browser Ω')
    expect(chinese).toContain('忽略')
    await en.changeLanguage('zh-CN')
    const englishWhileGlobalIsChinese = renderBrowserNotificationHtml('Browser Ω', 'en', en.t)
    expect(englishWhileGlobalIsChinese).toContain('Not now')
    expect(englishWhileGlobalIsChinese).not.toContain('忽略')
  })

  it('publishes only the latest queued locale', async () => {
    const applied: string[] = []
    const published: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const schedule = createLatestLocaleApplier<string>({
      apply: async (locale) => {
        applied.push(locale)
        if (locale === 'en') await firstGate
      },
      publish: (locale) => { published.push(locale) }
    })
    const first = schedule('en')
    await vi.waitFor(() => expect(applied).toEqual(['en']))
    const second = schedule('zh-CN')
    releaseFirst?.()
    await Promise.all([first, second])
    expect(applied).toEqual(['en', 'zh-CN'])
    expect(published).toEqual(['zh-CN'])
  })

  it('uses a single-language fatal page even when i18n is unavailable', () => {
    expect(fatalStartupText('en')).toBe('OpenPipal failed to start. Please restart the app.')
    expect(fatalStartupText('en')).not.toMatch(/[一-鿿]/)
    expect(fatalStartupText('zh-CN')).toBe('OpenPipal 启动失败，请重启应用。')
    expect(fatalStartupText('zh-CN')).not.toContain('failed to start')
  })
})
