/**
 * DC 场景 sibling（会话内编译产物）解析渲染 E2E — W2 契约条款 1/3/4 验收
 *
 * 覆盖:
 *   A 链式 from="./animations.jsx ./artifact-<id>.jsx" —— dc.html 薄壳经
 *     inlineDcArtifactSiblings 解析：animations（已知运行时）+ 会话内 artifact-test1
 *     （经 IPC artifact:load-compiled mock 返回一段已编译 IIFE）→ 删 from + 链序预载全局。
 *     求值顺序硬要求：animations 先、场景 render 时 window.Stage 已在场。
 *   B from="./nope-9999.jsx" 未知引用 —— 非 artifact sibling 原样保留，交回 support.js，
 *     走 placeholder 路径：iframe 不白屏、其余静态内容照常渲染。
 *
 * Mock 策略同 dc-render.spec.ts：精简 window.api，额外提供 loadCompiledArtifact。
 * conversationId 由 chatStore.activeConversationId 供给（setup 里置为 'mock-conv'），
 * HtmlPreview 的 assembleDoc 以此调 loadCompiledArtifact 解析 ./artifact-<id>.jsx。
 * 注意:iframe 内渲染需要网络（unpkg React 18.3.1），断网环境本测试会超时。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/dc-scene-sibling'

// 已编译 IIFE：复刻契约条款3 的 poll 包装器 —— 场景文件的 poll 条件为
// window.React && window.ReactDOM && window.Stage（链中含 animations 时），三者齐备
// 才把 SceneMarker 注册到全局。support.js 的 waitForGlobal 随后拾取并渲染。
// 这既保证「场景求值时 Stage 已在场」（顺序硬要求），也让下方 __sceneStageSeen 断言确定性成立。
// render 时再快照 window.Stage 进 __sceneStageSeen，渲出 id=scene-ok / 文本 SCENE_RENDERED。
const COMPILED_SCENE =
  "(function(){function reg(){window.SceneMarker=function(){" +
  "window.__sceneStageSeen=!!window.Stage;" +
  "return React.createElement('div',{id:'scene-ok'},'SCENE_RENDERED');};}" +
  "function poll(){if(window.React&&window.ReactDOM&&window.Stage){reg();}else{setTimeout(poll,30);}}" +
  "poll();})();"

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
const DESIGN_ROLE = { name: 'design', displayName: '设计助手', icon: '🎨' };
window.api = {
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
  saveArtifact: async (cid, art) => ({ ok: true, ref: { id: art.id } }),
  // W2 会话内编译产物解析：artifact-test1 命中 → 已编译 IIFE；未知 id → null（走 placeholder）
  loadCompiledArtifact: async (cid, artifactId) => {
    if (artifactId === 'artifact-test1') return ${JSON.stringify(COMPILED_SCENE)};
    return null;
  },
};
`

// 薄壳 A：链式 from —— animations 先、场景后
const SCENE_SHELL = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="SceneMarker" from="./animations.jsx ./artifact-test1.jsx" width="1280" height="720" duration="4" hint-size="100%,100%">
</x-import>
</x-dc>
</body>
</html>`

// 薄壳 B：未知引用 —— from 保留、走 support.js placeholder，静态内容照渲
const UNKNOWN_SHELL = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<div id="static-ok" style="font-size:40px;color:#2a2620;padding:40px;">STATIC_VISIBLE</div>
<x-import component-from-global-scope="SceneMarker" from="./nope-9999.jsx" width="600" height="300" hint-size="100%,100%">
</x-import>
</x-dc>
</body>
</html>`

const DC_IFRAME = 'iframe[sandbox="allow-scripts allow-modals allow-downloads"]'

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).__chatStore?.setState?.({ activeConversationId: 'mock-conv' })
  })
}

async function emitArtifact(
  page: Page,
  artifact: { id: string; type: string; title: string; content: string }
): Promise<void> {
  await page.evaluate(
    ({ artifact }) => (window as any).__mockBus.emit('artifact', '', artifact),
    { artifact }
  )
  await page.waitForTimeout(300)
}

test.describe('DC 场景 sibling 解析', () => {
  test('A 链式 from 解析会话内编译产物：场景渲染且求值顺序 animations 先（Stage 在场）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'dc-scene',
      type: 'html',
      title: 'Scene.dc.html',
      content: SCENE_SHELL,
    })

    // support.js 内联 + animations/artifact-test1 链序预载 → SceneMarker 全局到位 → 渲出 #scene-ok
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('#scene-ok')).toHaveText('SCENE_RENDERED', { timeout: 20000 })

    // 求值顺序硬断言：场景 render 时 window.Stage 已在场（animations 链先求值）
    const childFrame = page.frames().find((f) => f !== page.mainFrame())
    await expect
      .poll(async () => childFrame!.evaluate(() => (window as any).__sceneStageSeen === true), {
        timeout: 20000,
      })
      .toBe(true)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/a-scene-rendered.png`, fullPage: true })
  })

  test('B 未知引用 ./nope-9999.jsx：iframe 不白屏，其余静态内容仍渲染（placeholder 路径）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'dc-unknown',
      type: 'html',
      title: 'Unknown.dc.html',
      content: UNKNOWN_SHELL,
    })

    const frame = page.frameLocator(DC_IFRAME)
    // 根挂载 + 静态内容可见 = 未白屏
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('#static-ok')).toHaveText('STATIC_VISIBLE', { timeout: 20000 })
    // 未知引用的场景组件解析失败 → 不出现 #scene-ok（走 placeholder，不整页崩）
    await expect(frame.locator('#scene-ok')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/b-unknown-placeholder.png`, fullPage: true })
  })
})
