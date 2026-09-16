/**
 * 拖文件进窗口（真 Electron，本地假模型，不花钱）：
 *   - 真 preload 里 getPathForFile 在（Finder 拖真文件走这条拿路径）
 *   - 欢迎页：拖进来输入框亮边，松手图片进输入框
 *   - 对话页：拖到消息列上，对话区盖提示层、输入框亮边；拖出即灭；松手图片进输入框
 * 合成的 File 没有磁盘路径（webUtils 给空串），所以这里只能验图片那一路和提示层；
 * Finder 真拖 PDF 进附件条那一路要人手验（screenshot 在 tests/artifacts/chat-drop-files-live/）。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'

const ARTIFACTS = 'tests/artifacts/chat-drop-files-live'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type DragType = 'dragenter' | 'dragover' | 'dragleave' | 'drop'
function drag(page: Page, type: DragType, target: string): Promise<void> {
  return page.evaluate(({ type, target, png }) => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
    const el = document.querySelector(target) ?? document.body
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, { type, target, png: PNG_B64 })
}

test('真 Electron：整窗认拖拽，对话区亮圈，松手进输入框', async () => {
  test.setTimeout(3 * 60 * 1000)
  await mkdir(ARTIFACTS, { recursive: true })

  const importNative = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{
    QA_PROVIDER_MODEL: string
    QA_PROVIDER_TOKEN: string
    startQaProvider: (options: { port: number }) => Promise<import('node:http').Server>
  }>
  const { QA_PROVIDER_MODEL, QA_PROVIDER_TOKEN, startQaProvider } = await importNative(
    pathToFileURL(join(process.cwd(), 'scripts', 'qa', 'openai-compatible-fixture.mjs')).href
  )
  const provider = await startQaProvider({ port: 0 })
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('QA provider did not expose a TCP port')
  const modelConfig = { provider: 'custom', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: QA_PROVIDER_TOKEN, apiFormat: 'openai', model: QA_PROVIDER_MODEL }

  let app: IsolatedElectron | null = null
  try {
    app = await launchIsolatedElectron({
      config: {
        autoMemoryEnabled: false,
        role: 'general',
        modelConfig,
        modelProviders: [{ id: 'qa-provider', name: 'QA provider', ...modelConfig }],
        modelPresets: [{ id: 'qa-model', name: 'QA model', providerId: 'qa-provider', config: modelConfig }],
        activePresetId: 'qa-model'
      },
      env: { OPENPIPAL_HTTP_PORT: '3137' }
    })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.op-app-shell').waitFor()
    await app.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'))
      win?.setBounds({ x: 40, y: 40, width: 1100, height: 780 })
    })

    // 真 preload：Finder 拖真文件靠它拿路径
    expect(await page.evaluate(() => typeof (window as unknown as { api: Record<string, unknown> }).api.getPathForFile)).toBe('function')

    // 欢迎页
    const welcomeComposer = page.locator('.op-composer-solid')
    await expect(welcomeComposer).toBeVisible({ timeout: 60_000 })
    await drag(page, 'dragenter', 'body')
    await drag(page, 'dragover', 'body')
    await expect(welcomeComposer).toHaveClass(/op-composer--drop/)
    await page.screenshot({ path: `${ARTIFACTS}/01-welcome-dragging.png` })
    await drag(page, 'drop', 'body')
    await expect(welcomeComposer).not.toHaveClass(/op-composer--drop/)
    await expect(welcomeComposer.locator('img')).toHaveCount(1)
    await page.screenshot({ path: `${ARTIFACTS}/02-welcome-dropped.png` })

    // 进对话页（假模型一回合）
    await page.locator('textarea').last().fill('拖放真机验收')
    await page.getByTestId('send-btn').click()
    await expect(page.getByText('OpenPipal QA response: runtime round-trip completed.')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)

    // 拖到消息列上：提示层 + 输入框亮边
    await drag(page, 'dragenter', '[data-testid="chat-scroll"]')
    await drag(page, 'dragover', '[data-testid="chat-scroll"]')
    await expect(page.getByTestId('file-drop-highlight')).toBeVisible()
    await expect(page.locator('.op-composer')).toHaveClass(/op-composer--drop/)
    await page.screenshot({ path: `${ARTIFACTS}/03-chat-dragging.png` })

    // 拖出窗口：灭
    await drag(page, 'dragleave', '[data-testid="chat-scroll"]')
    await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
    await expect(page.locator('.op-composer')).not.toHaveClass(/op-composer--drop/)

    // 松手在消息列上：图片进输入框
    await drag(page, 'dragenter', '[data-testid="chat-scroll"]')
    await drag(page, 'drop', '[data-testid="chat-scroll"]')
    await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
    await expect(page.locator('.op-composer img')).toHaveCount(1)
    await page.screenshot({ path: `${ARTIFACTS}/04-chat-dropped.png` })
  } finally {
    await app?.dispose()
    await new Promise<void>(resolve => provider.close(() => resolve()))
  }
})
