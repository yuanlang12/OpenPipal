import { test, expect } from '@playwright/test'
import path from 'path'

const ARTIFACTS_DIR = 'tests/artifacts/extension-offline'

// sidepanel.html 的绝对路径
const SIDEPANEL_PATH = path.resolve(__dirname, '../../../openpipal-extension/sidepanel.html')

// Mock chrome APIs + fetch 失败（模拟桌面端离线）
const MOCK_OFFLINE = `
  // Mock chrome extension APIs
  window.chrome = {
    tabs: {
      query: async () => [],
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      sendMessage: async () => null
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0-test' }),
      onMessage: { addListener: () => {} }
    }
  };
  // Mock fetch to simulate offline
  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('localhost:3031')) {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    }
    return _origFetch(url, opts);
  };
`

// Mock chrome APIs + fetch 成功（模拟桌面端在线）
const MOCK_ONLINE = `
  window.chrome = {
    tabs: {
      query: async () => [],
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      sendMessage: async () => null
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0-test' }),
      onMessage: { addListener: () => {} }
    }
  };
  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('/health')) {
      return new Response(JSON.stringify({ status: 'ok', app: 'openpipal', processNonce: 'n'.repeat(43) }), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/extension/session')) {
      return new Response(JSON.stringify({ token: 't'.repeat(43) }), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('localhost:3031')) {
      return new Response('{}', { status: 200 });
    }
    return _origFetch(url, opts);
  };
`

test.describe('浏览器插件离线提示', () => {
  test('TC-EXT.1 桌面端离线时显示错误页面', async ({ page }) => {
    await page.addInitScript({ content: MOCK_OFFLINE })
    await page.goto(`file://${SIDEPANEL_PATH}`)
    await page.waitForTimeout(1000)

    // 错误区域可见
    const error = page.locator('#error')
    await expect(error).toBeVisible({ timeout: 5000 })

    // iframe 隐藏
    const iframe = page.locator('#app')
    await expect(iframe).toBeHidden()

    // 标题
    await expect(page.locator('.error-title')).toContainText('未连接到 OpenPipal')

    // 说明文字
    await expect(page.locator('.error-desc')).toContainText('配合 OpenPipal 桌面端使用')

    // 操作步骤
    const steps = page.locator('.error-steps div')
    await expect(steps).toHaveCount(2)
    await expect(steps.nth(0)).toContainText('打开 OpenPipal 桌面应用')
    await expect(steps.nth(1)).toContainText('等待连接自动恢复')

    // 重新连接按钮
    await expect(page.locator('button', { hasText: '重新连接' })).toBeVisible()

    // 状态提示
    await expect(page.locator('#error-status')).toContainText('正在尝试连接')

    // 版本号
    await expect(page.locator('#ver')).toContainText('v1.0.0-test')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-ext.1-offline.png` })
    console.log('[TC-EXT.1] 离线错误页面 - 通过')
  })

  test('TC-EXT.2 桌面端在线时隐藏错误页面', async ({ page }) => {
    await page.addInitScript({ content: MOCK_ONLINE })
    await page.goto(`file://${SIDEPANEL_PATH}`)
    await page.waitForTimeout(1000)

    // 错误区域隐藏
    const error = page.locator('#error')
    await expect(error).not.toBeVisible({ timeout: 5000 })

    // iframe 可见
    const iframe = page.locator('#app')
    await expect(iframe).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-ext.2-online.png` })
    console.log('[TC-EXT.2] 在线正常显示 - 通过')
  })

  test('TC-EXT.3 多次失败后状态提示更新', async ({ page }) => {
    // 注入 mock 并手动控制 checkDesktop 调用
    await page.addInitScript({ content: `
      window.chrome = {
        tabs: {
          query: async () => [],
          onActivated: { addListener: () => {} },
          onUpdated: { addListener: () => {} },
          sendMessage: async () => null
        },
        runtime: {
          getManifest: () => ({ version: '1.0.0-test' }),
          onMessage: { addListener: () => {} }
        }
      };
      window.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('localhost:3031')) {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        }
        throw new Error('not found');
      };
    `})
    await page.goto(`file://${SIDEPANEL_PATH}`)

    // 等待几次 checkDesktop 轮询（5 秒间隔，等 12 秒大约 3 次）
    await page.waitForTimeout(12000)

    // 状态文字应该更新为包含尝试次数
    const status = page.locator('#error-status')
    const text = await status.textContent()
    expect(text).toContain('已尝试')
    expect(text).toContain('自动重试')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-ext.3-retry-status.png` })
    console.log('[TC-EXT.3] 多次失败状态更新 - 通过')
  })
})
