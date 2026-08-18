/**
 * DC 渲染管道 E2E — dc 路线 P1 验收
 *
 * 覆盖:
 *   T1 原版 Clio.dc.html（黄金样例）作为 html artifact 推入 → workspace 自动展开 ArtifactTab
 *      → HtmlPreview 检测 <x-dc> → 内联 support.js → iframe 内 React 渲染出完整界面
 *   T2 Directions 画板稿（canvas 模式、template-only、无逻辑类）同样渲染成功
 *
 * Mock 策略:使用精简 window.api mock，仅提供 DC 渲染所需接口。
 * artifact 事件 cid 传空串——chatStore 守卫是 `if (cid && cid !== activeConversationId) return`,
 * 无活跃会话时空 cid 直接放行。
 * 注意:iframe 内渲染需要网络(unpkg React 18.3.1 + Google Fonts),断网环境本测试会超时。
 */

import { test, expect, Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/dc-render'
const CLIO = readFileSync(join(__dirname, '../fixtures/dc/Clio.dc.html'), 'utf8')
const DIRECTIONS = readFileSync(join(__dirname, '../fixtures/dc/Clio Directions.dc.html'), 'utf8')

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
const DESIGN_ROLE = { name: 'design', displayName: '设计助手', icon: '🎨' };
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {},
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onArtifact: (cb) => window.__mockBus.on('artifact', cb),
  onArtifactDelta: (cb) => window.__mockBus.on('artifact-delta', cb),
  onArtifactUpdate: (cb) => window.__mockBus.on('artifact-update', cb),
  onVisualizer: (cb) => window.__mockBus.on('visualizer', cb),
  onVisualizerDelta: (cb) => window.__mockBus.on('visualizer-delta', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({ hasRole: true, role: DESIGN_ROLE }),
  getAllRoles: async () => [DESIGN_ROLE],
  getCurrentRole: async () => DESIGN_ROLE,
  switchRole: async () => DESIGN_ROLE,
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'mock-conv', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},
  listAssetsTree: async () => ({ brand: [], refs: [], docs: [], kits: [] }),
  saveArtifact: async (cid, art) => {
    (window.__mockCalls ||= []).push({ method: 'saveArtifact', id: art.id, content: art.content });
    return { ok: true, ref: { id: art.id } };
  },
  getExportDir: async () => ({ dir: '/Users/mock/Downloads' }),
  chooseExportDir: async () => ({ dir: '/Users/mock/Downloads' }),
  exportArtifact: async (req) => {
    (window.__mockCalls ||= []).push({ method: 'exportArtifact', req });
    return { ok: true, path: '/Users/mock/Downloads/' + (req.projectName || req.title || 'out') + '.zip' };
  },
  exportDcArtifacts: async (projectName, artifacts) => {
    (window.__mockCalls ||= []).push({ method: 'exportDcArtifacts', projectName, count: artifacts.length });
    return { ok: true, dir: '/Users/x/.openpipal/outputs/' + projectName, files: ['support.js', 'vendor/react.production.min.js', 'vendor/react-dom.production.min.js', 'Clio.dc.html'] };
  },
  loadCompiledArtifact: async () => null,
  readArtifactSidecar: async (cid, name) => {
    (window.__mockCalls ||= []).push({ method: 'readArtifactSidecar', name });
    if (name === '.image-slots.state.json') return JSON.stringify({ 'hydrate-slot': { u: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', s: 1, x: 0, y: 0 } });
    return null;
  },
  writeArtifactSidecar: async (cid, name, content) => {
    (window.__mockCalls ||= []).push({ method: 'writeArtifactSidecar', name, content });
    return true;
  },
};
`

// P8/P9 用：deck 舞台与动画引擎的最小 fixture（兄弟预制件由宿主预载全局）
const MINI_DECK = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}
@keyframes riseIn{from{opacity:0}to{opacity:1}}
[data-deck-active] .rise{animation:riseIn 3s linear both}
</style></helmet>
<x-import component-from-global-scope="deck-stage" from="./deck-stage.js" width="1920" height="1080" hint-size="100%,100%">
<section data-label="One" data-speaker-notes="开场三十秒" style="background:#f5f0e6;display:flex;align-items:center;justify-content:center;"><h1 class="rise" style="font-size:72px;">Slide One</h1></section>
<section data-label="Two" style="background:#2a2620;color:#fff;display:flex;align-items:center;justify-content:center;"><h1 style="font-size:72px;">Slide Two</h1></section>
</x-import>
</x-dc>
</body>
</html>`

const MINI_ANIM = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="Stage" from="./animations.jsx" width="1280" height="720" duration="4" hint-size="100%,100%">
<div style="font-size:64px;color:#2a2620;padding:80px;">Hello Motion</div>
</x-import>
</x-dc>
</body>
</html>`

// T10 用：ios-frame 设备外框（JSX 预制件走 compiled 版预载，与 animations 同管路）
const MINI_IOS = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="IOSDevice" from="./ios-frame.jsx" title="Demo" hint-size="402px,874px">
<div style="padding:40px;font-size:24px;">IOS_BODY_MARKER</div>
</x-import>
</x-dc>
</body>
</html>`

// T12/T13 用：android 外框（compiled 预载）与 image-slot 图片位（helmet script 自注册）
const MINI_ANDROID = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="AndroidDevice" from="./android-frame.jsx" title="Demo" hint-size="412px,892px">
<div style="padding:40px;font-size:24px;">ANDROID_BODY_MARKER</div>
</x-import>
</x-dc>
</body>
</html>`

const MINI_IMAGE_SLOT = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>doc-page:not(:defined){visibility:hidden} body{margin:0}</style>
<script src="./doc-page.js"></script>
<script src="./image-slot.js"></script>
</helmet>
<doc-page size="a4">
<section class="page" id="poster" style="position:relative;container-type:size;overflow:hidden;background:#fff;">
  <div style="position:absolute;top:10cqh;left:10cqw;width:40cqw;height:30cqh;">
    <image-slot id="hero" shape="rounded" placeholder="SLOT_PLACEHOLDER_MARKER"></image-slot>
  </div>
</section>
</doc-page>
</x-dc>
</body>
</html>`

// W3 用：doc-page 文档路线 —— x-import 挂载零依赖自注册 Web Component，正文写连续 flow
const MINI_DOC = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>doc-page:not(:defined){visibility:hidden}</style></helmet>
<x-import component-from-global-scope="doc-page" from="./doc-page.js" size="letter" margin="0.75in">
<h1>Doc Title</h1>
<p>DOC_BODY_MARKER — continuous flow paginated by the component.</p>
</x-import>
</x-dc>
</body>
</html>`

// T16 用：3D 物体（非 dc 裸 HTML，官方 <three-d-stage> 舞台元素）——用户 module 脚本留空，
// 只验证自定义元素注册 + shadow DOM 挂载（离线确定性），不依赖联网加载 three.js CDN
const MINI_3D = `<!-- non-dc: 3d-object -->
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>three-d-stage:not(:defined) { visibility: hidden; } three-d-stage { display: block; width: 100vw; height: 100vh; }</style>
</head><body>
<three-d-stage name="model" background="#f0eee6" autorotate></three-d-stage>
<script src="./three-d-stage.js"></script>
<script type="module">
</script>
</body></html>`

// P2 用：极小 dc fixture —— label prop 经 renderVals 绑定，运行时改 props 可见文本变化
const MINI_DC = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<div style="padding:20px;font-size:24px">{{ label }}</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props="{&quot;label&quot;:{&quot;editor&quot;:&quot;text&quot;,&quot;default&quot;:&quot;DEFAULT&quot;,&quot;tsType&quot;:&quot;string&quot;}}">
class Component extends DCLogic {
  renderVals() { return { label: this.props.label ?? 'DEFAULT' }; }
}
</script>
</body>
</html>`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // handleTweakEdit（持久化路径）要求有活跃会话
  await page.evaluate(() => {
    ;(window as any).__chatStore?.setState?.({ activeConversationId: 'mock-conv' })
  })
}

async function emitArtifact(
  page: Page,
  artifact: { id: string; type: string; title: string; content: string }
): Promise<void> {
  // cid 空串：无活跃会话时绕过 chatStore 的会话匹配守卫
  await page.evaluate(
    ({ artifact }) => (window as any).__mockBus.emit('artifact', '', artifact),
    { artifact }
  )
  await page.waitForTimeout(300)
}

// HtmlPreview 的渲染 iframe（sandbox 属性精确匹配）
const DC_IFRAME = 'iframe[sandbox="allow-scripts allow-modals allow-downloads"]'

test.describe('DC 渲染管道 P1', () => {
  test('T1 原版 Clio.dc.html 在侧栏完整渲染', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-clio', type: 'html', title: 'Clio.dc.html', content: CLIO })

    // artifact bridge 自动展开 workspace → HtmlPreview iframe 出现
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 5000 })

    // iframe 内部：support.js 编译模板 + unpkg React 加载后渲染出真实界面
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=Hierarchy of use')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=Software development').first()).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-clio-in-app.png`, fullPage: true })
  })

  test('T2 Directions 画板稿（canvas 模式 template-only）渲染', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-directions', type: 'html', title: 'Clio Directions.dc.html', content: DIRECTIONS })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=Warm Editorial').first()).toBeVisible({ timeout: 20000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-directions-in-app.png`, fullPage: true })
  })

  test('T2b canvas 画板宿主接管缩放：自动 fit + 重置 100% + 手动 −', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-directions', type: 'html', title: 'Clio Directions.dc.html', content: DIRECTIONS })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })

    // support.js 上报 __dc_design_mode(canvas) 后：宿主缩放控件出现 + 自动 fit
    // （画板固定像素 frame 并排，总宽远超视口 → zoom 必然 < 1）
    await expect(page.locator('[data-testid="canvas-fit"]')).toBeVisible({ timeout: 20000 })
    await expect(async () => {
      const zoom = await frame.locator('html').evaluate((el) => parseFloat((el as HTMLElement).style.zoom))
      // Directions 板宽（三方向并排 ~4000px+）触发单帧适配分支（W2 智能适配）：zoom 落在 [0.25, 1)
      expect(zoom).toBeGreaterThanOrEqual(0.25)
      expect(zoom).toBeLessThan(1)
    }).toPass({ timeout: 10000 })

    // 百分比按钮显示 fit 值；点击重置 100%（转 manual，容器变化不再自动重 fit）
    const pct = page.locator('[data-testid="canvas-zoom-pct"]')
    await expect(pct).not.toHaveText('100%')
    await pct.click()
    await expect(pct).toHaveText('100%')

    // 手动缩小一档 → 80%（曾有 bug：RO debounce 期间转 manual，延迟 fit 把手动值覆盖回 fit 值）
    await page.locator('[data-testid="canvas-zoom-out"]').click()
    await expect(pct).toHaveText('80%')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2b-canvas-zoom.png`, fullPage: true })
  })

  test('T3 Clio propsMeta → Tweaks 面板出现，改动写入运行时并持久化', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-clio', type: 'html', title: 'Clio.dc.html', content: CLIO })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('text=Hierarchy of use')).toBeVisible({ timeout: 20000 })

    // __dc_booted 后 Tweaks 按钮激活；有可调参数 → 停靠条默认自动展开（2026-08 新契约）
    const tweaksBtn = page.getByRole('button', { name: '微调' })
    await expect(tweaksBtn).toBeEnabled({ timeout: 5000 })
    await expect(page.getByTestId('dc-tweaks-panel')).toBeVisible({ timeout: 5000 })

    // 停靠条可收起/再展开（点 Tweaks 切换）
    await tweaksBtn.click()
    await expect(page.getByTestId('dc-tweaks-panel')).toBeHidden()
    await tweaksBtn.click()
    await expect(page.getByTestId('dc-tweaks-panel')).toBeVisible()

    // Clio 声明的三个 prop 控件都在
    await expect(page.getByTestId('dc-tweak-defaultView')).toBeVisible()
    await expect(page.getByTestId('dc-tweak-defaultColorBy')).toBeVisible()
    await expect(page.getByTestId('dc-tweak-startInScatter')).toBeVisible()

    // 改 enum → 运行时 propOverrides 收到（经桥 postMessage → __dcSetProps）
    await page.getByTestId('dc-tweak-defaultView').selectOption('tree')
    const iframeEl = page.frames().find((f) => f !== page.mainFrame())
    await expect
      .poll(async () =>
        iframeEl!.evaluate(() => {
          const w = window as any
          return w.__dcRegistry?.[w.__dcRootName()]?.propOverrides
        })
      )
      .toEqual({ defaultView: 'tree' })

    // debounce 800ms 后持久化：saveArtifact 收到含 data-prop-overrides 的新 content
    await page.waitForTimeout(1200)
    const saved = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'saveArtifact').pop()
    )
    expect(saved?.content).toContain('data-prop-overrides')
    expect(saved?.content).toContain('defaultView')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-tweaks-panel.png`, fullPage: true })
  })

  test('T4 改 props 实时生效且 iframe 不重载（画布语义）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-mini', type: 'html', title: 'Mini.dc.html', content: MINI_DC })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('text=DEFAULT')).toBeVisible({ timeout: 20000 })

    // 在 iframe 里打标记——若后续 iframe 重载，标记会丢失
    const iframeEl = page.frames().find((f) => f !== page.mainFrame())
    await iframeEl!.evaluate(() => ((window as any).__reloadCanary = 'alive'))

    // 有可调参数 → 停靠条已默认自动展开（2026-08 新契约），无需点 Tweaks
    const input = page.getByTestId('dc-tweak-label')
    await expect(input).toBeVisible({ timeout: 5000 })
    await input.fill('CHANGED')

    // 文本实时更新（React 重渲染，非整页重载）
    await expect(frame.locator('text=CHANGED')).toBeVisible({ timeout: 5000 })

    // 等过持久化 debounce（触发 onContentEdit 回写 → content 回声），iframe 不应重载
    await page.waitForTimeout(1500)
    const canary = await page
      .frames()
      .find((f) => f !== page.mainFrame())!
      .evaluate(() => (window as any).__reloadCanary)
    expect(canary).toBe('alive')
    await expect(frame.locator('text=CHANGED')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4-live-props.png`, fullPage: true })
  })

  test('T5 持久化的 overrides 在重新挂载后自动重放（重开会话保持）', async ({ page }) => {
    await setup(page)
    // 模拟"上次会话调过参数"的 content：data-prop-overrides 已写入
    const persisted = MINI_DC.replace(
      'data-dc-script data-props=',
      'data-dc-script data-prop-overrides="{&quot;label&quot;:&quot;RESTORED&quot;}" data-props='
    )
    await emitArtifact(page, { id: 'dc-mini-2', type: 'html', title: 'Mini2.dc.html', content: persisted })

    // boot → __dc_booted → 父侧读出 overrides → dc:set-props 重放 → 显示 RESTORED 而非 DEFAULT
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('text=RESTORED')).toBeVisible({ timeout: 20000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t5-overrides-restored.png`, fullPage: true })
  })

  test('T6 dc artifact 分享弹窗：格式卡 + 保存目录 + 下载走 artifact:export', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-clio', type: 'html', title: 'Clio.dc.html', content: CLIO })

    const btn = page.getByTestId('share-btn')
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click()

    // 弹窗：dc 交付物三种格式 + 目录行（默认 ~/Downloads mock）
    const pop = page.getByTestId('export-popover')
    await expect(pop).toBeVisible()
    await expect(page.getByTestId('export-fmt-project-zip')).toBeVisible()
    await expect(page.getByTestId('export-fmt-standalone-html')).toBeVisible()
    await expect(page.getByTestId('export-fmt-pdf')).toBeVisible()
    await expect(pop).toContainText('Downloads')

    await page.getByTestId('export-fmt-project-zip').click()
    await page.getByTestId('export-download-btn').click()
    await expect(page.getByTestId('dc-export-msg')).toContainText('已导出', { timeout: 5000 })

    const calls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'exportArtifact')
    )
    expect(calls.length).toBe(1)
    expect(calls[0].req.format).toBe('project-zip')
    expect(calls[0].req.projectName).toBe('Clio')
    expect(calls[0].req.artifacts.length).toBe(1)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t6-export-btn.png`, fullPage: true })
  })

  test('T7 deck-stage 预制件预载渲染（幻灯片管线）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-deck', type: 'html', title: 'Deck.dc.html', content: MINI_DECK })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root deck-stage')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=Slide One')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t7-deck.png`, fullPage: true })
  })

  // 备注的外发通道：组件的 notes getter 是导出器取备注的唯一入口（规格 Q2 于 2026-08-17 改判 (c)）。
  // OOXML 那一头有 dc-pptx-notes 单测守着，这条守的是组件这一头——两来源合并与按 rawIndex 寻址。
  test('T7c deck.notes 按 rawIndex 给出逐页备注（PPTX 导出的取数入口）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-deck-notes', type: 'html', title: 'DeckNotes.dc.html', content: MINI_DECK })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root deck-stage')).toBeVisible({ timeout: 20000 })

    const notes = await frame.locator('deck-stage').first().evaluate((d: any) => d.notes)
    expect(notes).toEqual(['开场三十秒', '']) // 第 2 页没写属性也没有 JSON 兜底 → 空串占位，下标不塌陷
    // getter 返回副本：外部改不动内部表
    const tampered = await frame.locator('deck-stage').first().evaluate((d: any) => {
      d.notes[0] = 'HACKED'
      return d.notes[0]
    })
    expect(tampered).toBe('开场三十秒')
  })

  // 逐页截图通道（PPTX / 交接包）不进 print 媒体，入场动画会被拍在刚起步处——一页 opacity:0
  // 起手的动效导出后就是一张空白。运行时按 noscale 定格兜住它；这条守的是"定格真的生效"。
  test('T7b noscale 导出通道定格入场动画（PPTX/交接包截图不会拍到半截）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-deck-freeze', type: 'html', title: 'DeckFreeze.dc.html', content: MINI_DECK })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root deck-stage')).toBeVisible({ timeout: 20000 })

    const el = frame.locator('.rise').first()
    // 未设 noscale：动画照常按作者写的 3s 跑
    expect(await el.evaluate((n) => getComputedStyle(n).animationDuration)).toBe('3s')

    // 导出器就是这么做的：setAttribute('noscale', '') 后只等双 rAF 就开始截图
    await frame.locator('deck-stage').first().evaluate((d) => d.setAttribute('noscale', ''))
    await expect
      .poll(async () => el.evaluate((n) => getComputedStyle(n).animationDuration), { timeout: 5000 })
      .toBe('0s')
    // 定格 = 直接落在终态，而不是停在起始的 opacity:0
    expect(await el.evaluate((n) => getComputedStyle(n).opacity)).toBe('1')

    // 摘掉 noscale 要还原，否则预览里的动画会被导出通道的副作用永久按住
    await frame.locator('deck-stage').first().evaluate((d) => d.removeAttribute('noscale'))
    await expect
      .poll(async () => el.evaluate((n) => getComputedStyle(n).animationDuration), { timeout: 5000 })
      .toBe('3s')
  })

  test('T8 animations 引擎预载渲染（动画管线）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-anim', type: 'html', title: 'Anim.dc.html', content: MINI_ANIM })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=Hello Motion')).toBeVisible({ timeout: 20000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t8-anim.png`, fullPage: true })
  })

  test('T10 ios-frame 设备外框预载渲染（手机原型管线，compiled 版内联）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-ios', type: 'html', title: 'Ios.dc.html', content: MINI_IOS })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    // 根标记在场 = IOSDevice 真渲染而非裸透传（外框没挂上时 x-import 只透传 children，
    // 屏幕内容照样可见，所以光断言 BODY_MARKER 不足以证明外框渲染了）
    await expect(frame.locator('[data-openpipal-frame="ios"]')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=IOS_BODY_MARKER')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=9:41')).toBeVisible({ timeout: 20000 }) // 状态栏默认时间

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t10-ios-frame.png`, fullPage: true })
  })

  test('T12 android-frame 设备外框预载渲染（compiled 版内联）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-android', type: 'html', title: 'Android.dc.html', content: MINI_ANDROID })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('[data-openpipal-frame="android"]')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=ANDROID_BODY_MARKER')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=9:30')).toBeVisible({ timeout: 20000 }) // M3 状态栏默认时间
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t12-android-frame.png`, fullPage: true })
  })

  test('T13 image-slot 图片位（helmet script 自注册，doc-page 页内占位渲染）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-imgslot', type: 'html', title: 'Poster.dc.html', content: MINI_IMAGE_SLOT })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=SLOT_PLACEHOLDER_MARKER')).toBeVisible({ timeout: 20000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t13-image-slot.png`, fullPage: true })
  })

  test('T14 image-slot sidecar 水合：宿主注入 state → fetch 垫片供给 → 槽位渲染已存图片', async ({ page }) => {
    await setup(page)
    const withSlot = MINI_IMAGE_SLOT.replace('id="hero"', 'id="hydrate-slot"')
    await emitArtifact(page, { id: 'dc-imgslot-hydrate', type: 'html', title: 'PosterH.dc.html', content: withSlot })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    // 槽位水合出 data: 图片（穿 shadow DOM），占位文案让位
    await expect(frame.locator('image-slot img[src^="data:image"]').first()).toBeVisible({ timeout: 20000 })
  })

  test('T15 image-slot 拖图写回：window.openpipal.writeFile → 宿主落盘 + 真实回执', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-imgslot-write', type: 'html', title: 'PosterW.dc.html', content: MINI_IMAGE_SLOT })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    const childFrame = page.frames().find((f) => f !== page.mainFrame())
    const ok = await childFrame!.evaluate(() =>
      (window as any).openpipal.writeFile('.image-slots.state.json', '{"hero":{"u":"data:,x","s":1,"x":0,"y":0}}'))
    expect(ok).toBe(true) // Promise resolve = 宿主真实回执，非提前放行
    const call = await page.evaluate(() =>
      (window as any).__mockCalls?.find((c: any) => c.method === 'writeArtifactSidecar'))
    expect(call?.name).toBe('.image-slots.state.json')
    expect(call?.content).toContain('"hero"')
  })

  test('T11 通用宽度适配：固定宽裸 HTML 在窄面板 ≤100% 等比缩宽（响应式内容 zoom 恒 1）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'wide-html', type: 'html', title: 'Wide.html', content:
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0"><div style="width:1600px;background:#eee;font-size:24px;">WIDE_MARKER</div></body></html>' })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('text=WIDE_MARKER')).toBeVisible({ timeout: 20000 })
    const childFrame = page.frames().find((f) => f !== page.mainFrame())
    await expect
      .poll(async () => childFrame!.evaluate(() => parseFloat(document.documentElement.style.zoom || '1') || 1), { timeout: 10000 })
      .toBeLessThan(1)
  })

  test('T9 doc-page 预制件预载渲染（文档管线，穿 shadowRoot 取 .sheet）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-doc', type: 'html', title: 'Doc.dc.html', content: MINI_DOC })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })

    // 常规 locator 穿不透 shadowRoot：用 evaluate 进 iframe，取 doc-page 的 shadow .sheet
    const childFrame = page.frames().find((f) => f !== page.mainFrame())
    await expect
      .poll(
        async () =>
          childFrame!.evaluate(() => {
            const dp = document.querySelector('#dc-root doc-page') as any
            if (!dp) return null
            return {
              defined: !!customElements.get('doc-page'),
              hasSheet: !!dp.shadowRoot?.querySelector('.sheet'),
              bodyText: (dp.textContent || '').trim(),
              visible: dp.getClientRects().length > 0,
            }
          }),
        { timeout: 20000 }
      )
      .toEqual({
        defined: true,
        hasSheet: true,
        bodyText: expect.stringContaining('DOC_BODY_MARKER'),
        visible: true,
      })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t9-doc-page.png`, fullPage: true })
  })

  test('T16 3D 物体（非 dc，官方 <three-d-stage> 舞台）——自定义元素注册 + shadow DOM 挂载', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'dc-3d', type: 'html', title: 'Model.html', content: MINI_3D })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('three-d-stage')).toBeAttached({ timeout: 20000 })

    // 常规 locator 穿不透 shadowRoot：用 evaluate 进 iframe，确认离线确定性的两件事——
    // 自定义元素已注册、shadowRoot 已挂载。不断言 canvas/three.js 加载成功（依赖外网 CDN，会抖）。
    const childFrame = page.frames().find((f) => f !== page.mainFrame())
    await expect
      .poll(
        async () =>
          childFrame!.evaluate(() => {
            const stage = document.querySelector('three-d-stage') as any
            return {
              defined: !!customElements.get('three-d-stage'),
              hasShadowRoot: !!stage?.shadowRoot,
            }
          }),
        { timeout: 20000 }
      )
      .toEqual({ defined: true, hasShadowRoot: true })
  })
})
