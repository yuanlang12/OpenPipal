import { _electron as electron, expect, test } from '@playwright/test'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedElectron } from './helpers'

const mainEntry = join(process.cwd(), 'out', 'main', 'index.js')
const electronExecutable = join(
  process.cwd(),
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'MacOS',
  'Electron'
)

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  await visit(root)
  return found
}

test('真机：新会话写入 JSONL，重启后列表和消息完整恢复', async () => {
  test.setTimeout(120_000)

  const isolated = await launchIsolatedElectron({
    entry: mainEntry,
    env: { OPENPIPAL_HTTP_PORT: '31391' },
  })
  let reopened: Awaited<ReturnType<typeof electron.launch>> | undefined

  try {
    const page = await isolated.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const created = await page.evaluate(async () => {
      const conversation = await window.api.createConversation('general', '重启恢复验收')
      const now = Date.now()
      await window.api.appendMessages(conversation.id, [
        { id: 'live-user-1', role: 'user', content: '请保存这句话', timestamp: now },
        { id: 'live-assistant-1', role: 'assistant', content: '已经保存', timestamp: now + 1 },
      ])
      return {
        id: conversation.id,
        summaries: await window.api.listConversations(),
        messages: await window.api.getConversationMessages(conversation.id),
      }
    })

    expect(created.summaries.some((item: { id: string }) => item.id === created.id)).toBe(true)
    expect(created.messages.map((message: { id: string }) => message.id)).toEqual([
      'live-user-1',
      'live-assistant-1',
    ])

    const sessionsRoot = join(isolated.home, '.openpipal', 'sessions-v4')
    const logs = await findJsonlFiles(sessionsRoot)
    expect(logs).toHaveLength(1)
    const durableLog = await readFile(logs[0], 'utf8')
    expect(durableLog).toContain('live-user-1')
    expect(durableLog).toContain('live-assistant-1')
    expect(
      await exists(join(isolated.home, '.openpipal', 'conversations', `${created.id}.json`))
    ).toBe(false)

    await isolated.app.close()

    reopened = await electron.launch({
      executablePath: electronExecutable,
      args: [mainEntry],
      env: {
        ...process.env,
        HOME: isolated.home,
        OPENPIPAL_ISOLATED_HOME: isolated.home,
        OPENPIPAL_DISABLE_APP_TRACKING: '1',
        OPENPIPAL_HTTP_PORT: '31392',
      },
    })
    const reopenedPage = await reopened.firstWindow()
    await reopenedPage.waitForLoadState('domcontentloaded')

    const restored = await reopenedPage.evaluate(async (conversationId) => ({
      summaries: await window.api.listConversations(),
      messages: await window.api.getConversationMessages(conversationId),
    }), created.id)

    expect(restored.summaries.some((item: { id: string }) => item.id === created.id)).toBe(true)
    expect(restored.messages.map((message: { id: string }) => message.id)).toEqual([
      'live-user-1',
      'live-assistant-1',
    ])
    expect(restored.messages.map((message: { content: string }) => message.content)).toEqual([
      '请保存这句话',
      '已经保存',
    ])
  } finally {
    await reopened?.close().catch(() => undefined)
    await isolated.dispose()
  }
})
