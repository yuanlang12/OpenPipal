import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchIsolatedElectron } from './helpers'
import type { StoreWindow } from './live-helpers'

/**
 * 输入框观感截图（真 Electron，玻璃材质只有这里看得见）。不调模型、不花钱，但要起真窗口，默认不跑。
 *   OPENPIPAL_COMPOSER_LOOK=1 npx playwright test composer-look
 * 产物在 tests/artifacts/composer-look/<OPENPIPAL_COMPOSER_LOOK_TAG|shot>-*.png
 */
const ON = !!process.env.OPENPIPAL_COMPOSER_LOOK
const TAG = process.env.OPENPIPAL_COMPOSER_LOOK_TAG || 'shot'
const ARTIFACTS = 'tests/artifacts/composer-look'

test.describe('输入框观感截图', () => {
  test.skip(!ON, '要起真窗口，默认不跑。OPENPIPAL_COMPOSER_LOOK=1 npx playwright test composer-look')
  test.setTimeout(3 * 60 * 1000)

  test('欢迎页 / 对话页 / 模型浮层', async () => {
    mkdirSync(ARTIFACTS, { recursive: true })
    const { app, dispose } = await launchIsolatedElectron({
      config: {
        modelConfig: {
          provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-look', apiFormat: 'openai', model: 'look-model',
          supportsThinking: true, supportsEffortDial: true, thinkingLevels: ['low', 'medium', 'high', 'max']
        }
      },
      env: { OPENPIPAL_HTTP_PORT: '3141' }
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60_000 })
      await page.waitForTimeout(800)
      await page.screenshot({ path: join(ARTIFACTS, `${TAG}-01-welcome.png`) })

      await page.evaluate(async () => {
        const store = (window as StoreWindow & { __chatStore?: { setState(s: unknown): void; getState(): { newConversation(role: string): Promise<void> } } }).__chatStore!
        await store.getState().newConversation('general')
        store.setState({ messages: [{ id: 'm1', role: 'user', content: '你好', timestamp: Date.now() }, { id: 'm2', role: 'assistant', content: '你好，有什么想聊的？', timestamp: Date.now() }] })
      })
      await page.locator('[data-testid="inputbar-plus-btn"]').waitFor({ state: 'visible', timeout: 30_000 })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(ARTIFACTS, `${TAG}-02-chat.png`) })
      const heights = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="inputbar-plus-btn"]')?.parentElement
        return Array.from(bar?.querySelectorAll('button') || []).map(b => `${(b.getAttribute('data-testid') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 20)}=${Math.round(b.getBoundingClientRect().height * 10) / 10}`)
      })
      console.log(`[观感] 对话页工具栏按钮高度 ${heights.join('  ')}`)
      // 这一排控件统一 32px：高矮不齐是 2026-09-21 被退货的原因（+ 36 / 模型 25.7 / 发送 32）
      for (const h of heights) expect(h, heights.join('  ')).toMatch(/=32$/)

      await page.locator('[title="模型与思考深度"]').first().click()
      const slider = page.getByTestId('thinking-slider')
      await slider.waitFor({ state: 'visible', timeout: 5000 })
      await slider.press('Home')
      await slider.press('ArrowRight')
      await slider.press('ArrowRight')
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(ARTIFACTS, `${TAG}-03-chat-menu.png`) })
      const dock = page.locator('.op-composer-dock')
      await dock.screenshot({ path: join(ARTIFACTS, `${TAG}-04-composer-closeup.png`) }).catch(() => undefined)

      // 暗色：主题把色板写成 :root 的行内变量，光加 .dark 类翻不全；走系统外观这条真路径
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(ARTIFACTS, `${TAG}-05-chat-menu-dark.png`) })
    } finally {
      await dispose()
    }
  })
})
