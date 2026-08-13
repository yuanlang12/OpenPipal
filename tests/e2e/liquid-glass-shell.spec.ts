/**
 * E2E（真 Electron）：daylight glass 外壳的结构不变量。
 *
 * 这里断言的不是「好不好看」，而是四条一旦破掉玻璃就退化成浅灰矩形的结构条件：
 *   1. 标题栏脱离文档流悬浮 → 消息列表能从它底下滚过去（pass-behind）
 *   2. 输入框真的挂着 backdrop-filter（不是画了个圆角白框冒充）
 *   3. 滚动容器的底部内边距 ≥ 输入区实测高度（最后一条不会被玻璃吃掉）
 *   4. 挂靠 400px 下不出现横向溢出（输入框工具栏曾经在这里被裁掉）
 * 外加两条配色回归：动作色是墨、暗色画布是暗的。
 */
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchIsolatedElectron } from './helpers'

test('daylight glass shell keeps its pass-behind structure in real Electron', async () => {
  test.setTimeout(90_000)

  const importNative = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<{
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

  const modelConfig = {
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: QA_PROVIDER_TOKEN,
    apiFormat: 'openai',
    model: QA_PROVIDER_MODEL
  }
  const { app, dispose } = await launchIsolatedElectron({ config: {
    autoMemoryEnabled: false,
    role: 'general',
    modelConfig,
    modelProviders: [{ id: 'qa-provider', name: 'QA provider', ...modelConfig }],
    modelPresets: [{ id: 'qa-model', name: 'QA model', providerId: 'qa-provider', config: modelConfig }],
    activePresetId: 'qa-model'
  } })

  const setBounds = (width: number, height: number): Promise<void> =>
    app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(
        candidate => !candidate.webContents.getURL().startsWith('devtools://')
      )
      if (!win) throw new Error('OpenPipal BrowserWindow not found')
      win.setBounds({ x: 40, y: 40, width: size.width, height: size.height })
    }, { width, height })

  const sendStatus = (connected: boolean, appName: string): Promise<void> =>
    app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find(
        candidate => !candidate.webContents.getURL().startsWith('devtools://')
      )
      if (!win) throw new Error('OpenPipal BrowserWindow not found')
      win.webContents.send('target:status', payload)
    }, { connected, appName, windowTitle: appName })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.op-app-shell').waitFor()

    // ── 配色：动作色是墨,不是绿 ────────────────────────────────────────
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--sw-accent').trim()
    )
    expect(accent.toUpperCase()).toBe('#1B2429')

    await setBounds(1240, 820)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1200)

    // 先跑一个真回合，让消息列表有东西可以从玻璃底下滚过去
    await page.locator('textarea').last().fill('Glass shell acceptance turn.')
    await page.getByTestId('send-btn').click()
    await expect(page.getByText('OpenPipal QA response: runtime round-trip completed.')).toBeVisible()

    const shell = await page.evaluate(() => {
      const titlebar = document.querySelector('.op-titlebar')
      const scroll = document.querySelector('[data-testid="chat-scroll"]')
      const composer = document.querySelector('.op-composer')
      const dock = document.querySelector('.op-chat-dock')
      if (!titlebar || !scroll || !composer || !dock) throw new Error('glass shell nodes are missing')
      const titlebarStyle = getComputedStyle(titlebar)
      const scrollStyle = getComputedStyle(scroll)
      const composerStyle = getComputedStyle(composer)
      return {
        titlebarPosition: titlebarStyle.position,
        titlebarBackdrop: titlebarStyle.backdropFilter || (titlebarStyle as never as Record<string, string>).webkitBackdropFilter,
        composerBackdrop: composerStyle.backdropFilter || (composerStyle as never as Record<string, string>).webkitBackdropFilter,
        // 滚动容器顶边在标题栏之上 → 内容确实从标题栏底下穿过去
        scrollTopEdge: scroll.getBoundingClientRect().top,
        titlebarBottom: titlebar.getBoundingClientRect().bottom,
        scrollPaddingBottom: parseFloat(scrollStyle.paddingBottom),
        dockHeight: dock.getBoundingClientRect().height
      }
    })

    // 回合结束后不允许还有任何东西在扫光。之前 running 是从 message.content 里
    // 嗅关键词猜的,一条「成功」和「失败」都没命中的工具卡会在历史记录里永远亮着。
    await expect(page.locator('.op-sweep')).toHaveCount(0)
    await expect(page.locator('.op-shimmer-text')).toHaveCount(0)

    // 标题栏必须留在常规流里。Chromium 只从常规流元素收集 -webkit-app-region: drag,
    // 一旦写成 absolute/fixed,整条标题栏就拖不动窗口(2026-08 真机实测:
    // static 能拖、absolute 和 fixed 都不能)。这条断言是那个回归的守门员。
    expect(['absolute', 'fixed']).not.toContain(shell.titlebarPosition)
    // 滚动容器不得再向上探进标题栏:.op-app-body / .op-app-shell 都是 overflow:hidden,
    // 探出去的部分会被裁掉,是个看不见的假效果。曾经有过 -top-10,而当时的断言读
    // getBoundingClientRect() —— 那报的是布局几何、与裁剪无关,所以在坏掉的构建上照样绿。
    // 现在改成断言「内容从标题栏下方开始」这个诚实的结构。
    expect(shell.scrollTopEdge).toBeGreaterThanOrEqual(shell.titlebarBottom - 1)
    // 标题栏刻意不挂 backdrop-filter:页面内没有可采样的背景,它的通透感来自窗口
    // vibrancy;挂上去只会白付一个常驻合成层并掐死所有嵌套浮层的模糊。
    expect(shell.titlebarBackdrop === 'none' || shell.titlebarBackdrop === '').toBe(true)
    expect(shell.composerBackdrop).toContain('blur')
    // 底部留白必须盖住整个输入区，否则最后一条消息会被玻璃吃掉
    expect(shell.scrollPaddingBottom).toBeGreaterThanOrEqual(shell.dockHeight)

    // ── 挂靠 400px：Sidebar 收起 + 不许横向溢出 ──────────────────────
    await setBounds(400, 760)
    await sendStatus(true, 'Electron QA Target')
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(400)
    await expect(page.getByTestId('sidebar')).toHaveCount(0)

    const compact = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      composerRight: document.querySelector('.op-composer')!.getBoundingClientRect().right
    }))
    expect(compact.documentWidth).toBeLessThanOrEqual(compact.viewportWidth)
    expect(compact.composerRight).toBeLessThanOrEqual(compact.viewportWidth)

    // ── 外壳必须让位给原生材质:壳自己一刷不透明底色,NSVisualEffectView 就被盖死 ──
    const shellAlpha = await page.evaluate(() => {
      const bg = getComputedStyle(document.querySelector('.op-app-shell')!).backgroundColor
      const m = bg.match(/rgba?\(([^)]+)\)/)
      const parts = m ? m[1].split(',').map(v => parseFloat(v)) : []
      return parts.length === 4 ? parts[3] : (bg === 'transparent' ? 0 : 1)
    })
    expect(shellAlpha).toBe(0)

    // ── 暗色：画布必须是暗的（surface-800 当背景曾经把它刷成浅灰）──────
    await sendStatus(false, '独立模式')
    await setBounds(1240, 820)
    await page.evaluate(() => (window as never as { __appStore: { getState(): { setTheme(t: string): void } } })
      .__appStore.getState().setTheme('dark'))
    await expect.poll(async () => page.evaluate(() => {
      const bg = getComputedStyle(document.querySelector('.op-content-column')!).backgroundColor
      const [r, g, b] = bg.match(/[\d.]+/g)!.map(Number)
      return (r + g + b) / 3
    })).toBeLessThan(80)

    // ── 单一事实源：DS 静态调色板必须是主题层的视图，而不是第二份手抄本 ──
    // openpipal-ds.css 的 --fg-*/--bg-*/--accent-rgb 曾各自硬编码明暗两套值,
    // 于是改主题时漏掉一处 —— 暗色 accent 一直停在改版前的 sage 绿。
    // 这里钉两件事:别名解析得出来(不是空串),且随 .dark 一起翻。
    const alias = (): Promise<Record<string, string>> => page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      const read = (n: string): string => cs.getPropertyValue(n).trim()
      return {
        fg: read('--fg-primary'), swFg: read('--sw-fg-primary'),
        bg: read('--bg-canvas'), swBg: read('--sw-bg-primary'),
        accentRgb: read('--accent-rgb'), swAccentRgb: read('--sw-accent-rgb')
      }
    })
    const dark = await alias()
    for (const [k, v] of Object.entries(dark)) expect(v, `${k} 解析为空`).not.toBe('')
    expect(dark.fg).toBe(dark.swFg)
    expect(dark.bg).toBe(dark.swBg)
    expect(dark.accentRgb).toBe(dark.swAccentRgb)

    await page.evaluate(() => (window as never as { __appStore: { getState(): { setTheme(t: string): void } } })
      .__appStore.getState().setTheme('light'))
    await expect.poll(async () => (await alias()).fg).not.toBe(dark.fg)
    const light = await alias()
    expect(light.fg).toBe(light.swFg)
    expect(light.bg).toBe(light.swBg)
    expect(light.accentRgb).toBe(light.swAccentRgb)
    expect(light.bg).not.toBe(dark.bg)
  } finally {
    await dispose()
    await new Promise<void>(resolve => provider.close(() => resolve()))
  }
})
