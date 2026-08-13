/**
 * Phase 2/3/4 端到端验收启动器 —— 不需要用户手动重载扩展。
 *
 * 用 Playwright 起一个一次性 Chrome,把项目内的 0.3.8 扩展用 --load-extension 加载进去。
 * 该 Chrome 的 service worker 会连上正在运行的桌面端 :3031 WS server(顶替用户旧扩展)。
 * 随后用 curl 打 /debug/bc?action=... 驱动真实 CDP 命令,逐条验证。
 *
 * 这验证的是"扩展 CDP 代码 + 通道 + 桌面工具"的功能正确性(用一次性 profile),
 * 用户的登录态 profile 只在操作其私有站点时才需要 —— 代码对不对在这就能钉死。
 *
 * 用法:node scripts/diagnostics/browser-control-e2e.mjs   (前台保持,Ctrl-C 退出)
 */
import { chromium } from '@playwright/test'

const EXT = join(process.cwd(), 'openpipal-extension')
const userDataDir = '/tmp/sw-e2e-profile'

const TEST_HTML = `<!doctype html><html><head><title>E2E Test Page</title></head><body>
<h1>OpenPipal E2E</h1>
<p>hello world body text for read_page</p>
<input id="t" />
<button id="b" onclick="document.getElementById('out').textContent='VAL:'+document.getElementById('t').value">go</button>
<div id="out">ready</div>
</body></html>`
const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(TEST_HTML)

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]
})

const page = context.pages()[0] || (await context.newPage())
await page.goto(dataUrl)
await new Promise((r) => setTimeout(r, 2500))
console.log('[e2e] launched; service workers:', context.serviceWorkers().map((w) => w.url()))
console.log('[e2e] active page title:', await page.title())
console.log('[e2e] 扩展应已连上 :3031;现在可以打 /debug/bc 验收了。保持运行中…')

// 保持存活,让扩展 SW 维持 WS 连接
await new Promise(() => {})
