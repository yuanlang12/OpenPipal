import { beforeEach, expect, test, vi } from 'vitest'

const { sendBrowserCommand } = vi.hoisted(() => ({ sendBrowserCommand: vi.fn() }))

vi.mock('../../src/main/browser-control', () => ({
  sendBrowserCommand,
  isBrowserControlReady: () => true
}))

import { createBrowserControlTools } from '../../src/main/browser-tools.ts'
import {
  decideForCommand,
  replaceBrowserTabUrls,
  setBrowserTabUrl
} from '../../src/main/browser-policy-store.ts'

function tool(name: string) {
  const found = createBrowserControlTools().find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing browser tool: ${name}`)
  return found
}

beforeEach(() => {
  sendBrowserCommand.mockReset()
  replaceBrowserTabUrls([])
})

test('list_tabs 记录每个标签 URL，定向 click 把该标签 host 绑定到扩展命令', async () => {
  sendBrowserCommand.mockImplementation(async (action: string) => {
    if (action === 'list_tabs') {
      return {
        tabs: [
          { id: 11, title: 'Trusted', url: 'https://trusted-tab.example/inbox', active: true },
          { id: 22, title: 'Target', url: 'https://target-tab.example/checkout', active: false }
        ]
      }
    }
    if (action === 'click') return { clicked: '#buy' }
    if (action === 'screenshot') {
      return { tabId: 22, url: 'https://target-tab.example/checkout', dataUrl: 'data:image/jpeg;base64,AA==' }
    }
    throw new Error(`unexpected action: ${action}`)
  })

  await tool('browser_list_tabs').execute('list', {}, undefined)
  await tool('browser_click').execute('click', { selector: '#buy', tabId: 22 }, undefined)

  expect(sendBrowserCommand).toHaveBeenNthCalledWith(
    2,
    'click',
    { selector: '#buy', tabId: 22, expectedHost: 'target-tab.example' },
    15_000,
    undefined
  )
  expect(sendBrowserCommand).toHaveBeenNthCalledWith(
    3,
    'screenshot',
    { tabId: 22, expectedHost: 'target-tab.example' },
    15_000,
    undefined
  )
})

test('navigate 跨站重定向后不自动截图，最终 host 必须单独重新授权', async () => {
  sendBrowserCommand.mockImplementation(async (action: string) => {
    if (action === 'navigate') {
      return { tabId: 31, title: 'Done', url: 'https://redirected.example/done', ready: 'complete' }
    }
    throw new Error(`unexpected action: ${action}`)
  })

  const result = await tool('browser_navigate').execute(
    'navigate',
    { url: 'https://destination.example/start', tabId: 31 },
    undefined
  )

  expect(sendBrowserCommand).toHaveBeenNthCalledWith(
    1,
    'navigate',
    { url: 'https://destination.example/start', tabId: 31, expectedHost: 'destination.example' },
    20_000,
    undefined
  )
  expect(sendBrowserCommand).toHaveBeenCalledTimes(1)
  expect(result.content[0]).toMatchObject({ type: 'text' })
  expect((result.content[0] as { text: string }).text).toContain('未读取页面标题或截图')
  expect(result.details).toMatchObject({
    browser: { tabId: 31, host: 'redirected.example', redirected: true }
  })
})

test('navigate 同站完成时仍以原授权 host 自动截图', async () => {
  sendBrowserCommand.mockImplementation(async (action: string) => {
    if (action === 'navigate') {
      return { tabId: 32, title: 'Done', url: 'https://destination.example/done', ready: 'complete' }
    }
    if (action === 'screenshot') {
      return { tabId: 32, url: 'https://destination.example/done', dataUrl: 'data:image/jpeg;base64,AA==' }
    }
    throw new Error(`unexpected action: ${action}`)
  })

  await tool('browser_navigate').execute(
    'navigate-same-host',
    { url: 'https://destination.example/start', tabId: 32 },
    undefined
  )

  expect(sendBrowserCommand).toHaveBeenNthCalledWith(
    2,
    'screenshot',
    { tabId: 32, expectedHost: 'destination.example' },
    15_000,
    undefined
  )
})

test('确认等待期间标签切站，命令仍携带原授权 host 供扩展 fail closed', async () => {
  const args = { selector: '#buy', tabId: 44 }
  replaceBrowserTabUrls([{ id: 44, url: 'https://approved-target.example/checkout' }])
  expect(decideForCommand('browser_click', args).host).toBe('approved-target.example')
  setBrowserTabUrl(44, 'https://changed-after-approval.example/account')

  sendBrowserCommand.mockImplementation(async (action: string) => {
    if (action === 'click') return { clicked: '#buy' }
    if (action === 'screenshot') throw new Error('target host mismatch')
    throw new Error(`unexpected action: ${action}`)
  })

  await tool('browser_click').execute('click', args, undefined)

  expect(sendBrowserCommand).toHaveBeenNthCalledWith(
    1,
    'click',
    { selector: '#buy', tabId: 44, expectedHost: 'approved-target.example' },
    15_000,
    undefined
  )
})

test('主进程不采信扩展返回的跨站正文 URL', async () => {
  replaceBrowserTabUrls([{ id: 55, url: 'https://approved.example/inbox' }])
  sendBrowserCommand.mockResolvedValue({
    tabId: 55,
    title: 'Private',
    url: 'https://private.example/secrets',
    text: 'DO_NOT_RETURN_THIS_SECRET'
  })

  await expect(tool('browser_read_page').execute('read', { tabId: 55 }, undefined))
    .rejects.toThrow('已丢弃结果')
  expect(sendBrowserCommand).toHaveBeenCalledWith(
    'read_page',
    { tabId: 55, maxChars: undefined, expectedHost: 'approved.example' },
    15_000,
    undefined
  )
})

test('主进程不采信扩展返回的跨站截图', async () => {
  replaceBrowserTabUrls([{ id: 56, url: 'https://approved.example/dashboard' }])
  sendBrowserCommand.mockResolvedValue({
    tabId: 56,
    url: 'https://private.example/account',
    dataUrl: 'data:image/jpeg;base64,DO_NOT_RETURN_THESE_PIXELS'
  })

  await expect(tool('browser_screenshot').execute('shot', { tabId: 56 }, undefined))
    .rejects.toThrow('已丢弃结果')
})

test('写操作后的扩展跨站截图被静默丢弃', async () => {
  replaceBrowserTabUrls([{ id: 57, url: 'https://approved.example/form' }])
  sendBrowserCommand.mockImplementation(async (action: string) => {
    if (action === 'fill') return { filled: '#name' }
    if (action === 'screenshot') {
      return {
        tabId: 57,
        url: 'https://private.example/account',
        dataUrl: 'data:image/jpeg;base64,DO_NOT_RETURN_THESE_PIXELS'
      }
    }
    throw new Error(`unexpected action: ${action}`)
  })

  const result = await tool('browser_fill').execute(
    'fill',
    { tabId: 57, selector: '#name', value: 'Alice' },
    undefined
  )

  expect((result.details as { screenshot?: string }).screenshot).toBeUndefined()
})
