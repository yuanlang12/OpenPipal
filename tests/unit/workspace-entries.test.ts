import { describe, expect, it } from 'vitest'
import type { Artifact } from '../../src/renderer/src/stores/artifactStore'
import type { ChatMessage } from '../../src/renderer/src/types'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import {
  collectConversationOutputs,
  collectConversationSources,
  resolveWorkspaceEntryLabel,
} from '../../src/renderer/src/components/workspace/workspaceEntries'

function userMessage(patch: Partial<ChatMessage>): ChatMessage {
  return {
    id: `user-${Math.random()}`,
    role: 'user',
    content: '',
    timestamp: 100,
    ...patch
  }
}

describe('workspace conversation entries', () => {
  it('来源只收集用户上传文件和粘贴图，不混入 Agent 截图或工具轨迹', async () => {
    const sources = collectConversationSources([
      userMessage({
        fileAttachments: [{ fileName: '作业.pdf', fileType: 'pdf', sizeBytes: 12, path: '/tmp/uploads/作业.pdf' }],
        imagePaths: ['uploads/pasted-homework.png'],
        images: ['image-data']
      }),
      {
        id: 'tool-shot', role: 'tool', content: '', toolName: 'capture_screenshot',
        screenshot: 'agent-screenshot', timestamp: 101
      },
      userMessage({
        imagePaths: ['uploads/pasted-homework.png'],
        images: ['image-data'],
        timestamp: 102
      }),
      userMessage({ messageKind: 'task-trigger', fileAttachments: [{ fileName: 'hidden.csv', fileType: 'csv', sizeBytes: 1, path: '/tmp/hidden.csv' }] })
    ])

    expect(sources).toEqual([
      expect.objectContaining({ kind: 'file', name: '作业.pdf', path: '/tmp/uploads/作业.pdf' }),
      expect.objectContaining({ kind: 'image', name: '', labelKey: 'shell.workspace.fallback.image', imagePath: 'uploads/pasted-homework.png', imageData: 'image-data' })
    ])

    const zh = await createRendererI18n('zh-CN')
    const en = await createRendererI18n('en')
    expect(resolveWorkspaceEntryLabel(sources[0], zh.getFixedT('zh-CN'))).toBe('作业.pdf')
    expect(resolveWorkspaceEntryLabel(sources[0], en.getFixedT('en'))).toBe('作业.pdf')
    expect(resolveWorkspaceEntryLabel(sources[1], zh.getFixedT('zh-CN'))).toBe('图片 1')
    expect(resolveWorkspaceEntryLabel(sources[1], en.getFixedT('en'))).toBe('Image 1')
  })

  it('未命名来源的身份不随语言变化', async () => {
    const messages = [userMessage({ id: 'stable-message', fileAttachments: [{} as any] })]
    const first = collectConversationSources(messages)[0]
    const second = collectConversationSources(messages)[0]
    const zh = await createRendererI18n('zh-CN')
    const en = await createRendererI18n('en')

    expect(first.id).toBe('attachment:stable-message:0')
    expect(second.id).toBe(first.id)
    expect(resolveWorkspaceEntryLabel(first, zh.getFixedT('zh-CN'))).toBe('未命名文件')
    expect(resolveWorkspaceEntryLabel(first, en.getFixedT('en'))).toBe('Untitled file')
  })

  it('输出合并 artifact 与显式交付文件，并过滤问卷等过程物', () => {
    const artifacts: Artifact[] = [
      { id: 'artifact-report', type: 'markdown', title: '学习报告', content: '# report', messageId: 'm1', createdAt: 200 },
      { id: 'questions-1', type: 'questions', title: '几个问题', content: '{}', messageId: 'm2', createdAt: 300 }
    ]
    const messages: ChatMessage[] = [
      {
        id: 'doc-tool', role: 'tool', content: '', toolName: 'generate_document', timestamp: 400,
        toolArgs: JSON.stringify({ title: '学习报告', filePath: '/tmp/2026-08-02_学习报告.md', fileName: '2026-08-02_学习报告.md', fileType: 'md' })
      },
      {
        id: 'export-tool', role: 'tool', content: '', toolName: 'export_artifact', timestamp: 500,
        toolArgs: JSON.stringify({ title: '学习报告', filePath: '/tmp/学习报告.pdf', fileName: '学习报告.pdf', fileType: 'pdf' })
      }
    ]

    expect(collectConversationOutputs(artifacts, messages)).toEqual([
      expect.objectContaining({ kind: 'file', title: '学习报告.pdf', filePath: '/tmp/学习报告.pdf', type: 'pdf' }),
      expect.objectContaining({ kind: 'artifact', title: '学习报告', artifactId: 'artifact-report' })
    ])
  })
})
