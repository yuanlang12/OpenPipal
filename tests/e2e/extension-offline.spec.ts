import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'

const ARTIFACTS_DIR = 'tests/artifacts/extension-offline'

// sidepanel.html 的绝对路径
// 插件在**仓库内**(openpipal-extension/),不是仓库的兄弟目录。
// 早先它确实是同级仓库,搬进来之后这里的 ../../../ 没跟着改,三条用例一直 ERR_FILE_NOT_FOUND。
const SIDEPANEL_PATH = path.resolve(__dirname, '../../openpipal-extension/sidepanel.html')


// sidepanel.js 一开头就调 chrome.i18n.getUILanguage() / getMessage() 给 [data-i18n] 填字。
// file:// 里没有 chrome.i18n,脚本直接抛异常 —— 后面的健康检查、.visible 切换全都不跑,
// 于是页面永远是"错误区隐藏 + 所有文案为空"。三条用例一直红就是这个原因(插件做 i18n 迁移时
// 测试没跟着补桩),而 TC-EXT.2 甚至因此**假绿**:它断言错误区隐藏,而脚本死了本来就隐藏。
// 桩里的文案直接读插件真实的 _locales,断言钉的就是用户会看到的字。
const MESSAGES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../openpipal-extension/_locales/zh_CN/messages.json'), 'utf8')
) as Record<string, { message: string; placeholders?: Record<string, { content: string }> }>

const CHROME_I18N_STUB = `
  window.__MESSAGES = ${JSON.stringify(MESSAGES)};
  window.__i18nStub = {
    getUILanguage: () => 'zh-CN',
    getMessage: (name, subs) => {
      const entry = window.__MESSAGES[name];
      if (!entry) return '';
      const list = subs === undefined ? [] : (Array.isArray(subs) ? subs : [subs]);
      let msg = entry.message;
      Object.entries(entry.placeholders || {}).forEach(([ph, def]) => {
        const idx = parseInt(String(def.content).replace('$', ''), 10) - 1;
        msg = msg.replace(new RegExp('\\$' + ph + '\\$', 'gi'), list[idx] == null ? '' : String(list[idx]));
      });
      return msg;
    }
  };
`

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
    },
    i18n: window.__i18nStub
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
    },
    i18n: window.__i18nStub
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
    await page.addInitScript({ content: CHROME_I18N_STUB })
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
    // 文案以 _locales 里的 disconnectedDescription 为准("桌面端"早已改成"桌面应用")
    await expect(page.locator('.error-desc')).toContainText('配合 OpenPipal 桌面应用使用')

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
    await page.addInitScript({ content: CHROME_I18N_STUB })
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
    await page.addInitScript({ content: CHROME_I18N_STUB })
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
        },
        i18n: window.__i18nStub
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
