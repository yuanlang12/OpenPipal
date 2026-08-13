/**
 * code 产物"生成卡" + jsx 场景合成预览 E2E — workspace 预览优化验收
 *
 * 覆盖:
 *   T1 流式 code 产物 —— ArtifactTab 渲染 CodeStreamingCard（进度卡），不出现 CodePreview
 *      的全屏源码视图（复制按钮等标志性元素不可见）
 *   T2 完成态场景 jsx（纯 JS、无需 Babel 编译的最小场景）—— 合成动画薄壳直接渲染预览，
 *      frameLocator 里看到场景渲出的文案
 *   T3 完成态普通 code（python）—— 行为不变，仍走 CodePreview
 *
 * Mock 策略同 dc-render.spec.ts / dc-scene-sibling.spec.ts：精简 window.api，
 * 额外提供 onArtifactDelta（驱动流式）与 loadCompiledArtifact（驱动场景 sidecar 解析）。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/code-scene-preview'

// 纯 JS 无需编译的最小场景 —— 不含 JSX 语法，可直接当 <script> 执行；
// Object.assign(window, { Demo }) 是 SceneSynthPreview 的导出识别锚点
const SCENE_SRC = `const { Stage } = window;
function Demo() {
  return React.createElement('div', { style: { fontSize: '48px' } }, 'SCENE OK');
}
Object.assign(window, { Demo });
`

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
  saveArtifact: async (cid, art) => ({ ok: true, ref: { id: art.id } }),
  // 场景 sidecar：artifact-scene1 命中返回纯 JS 源码（无需 Babel，直接当已编译产物执行）
  loadCompiledArtifact: async (cid, artifactId) => {
    if (artifactId === 'artifact-scene1') return ${JSON.stringify(SCENE_SRC)};
    return null;
  },
};
`

const DC_IFRAME = 'iframe[sandbox="allow-scripts allow-modals allow-downloads"]'

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).__chatStore?.setState?.({ activeConversationId: 'mock-conv' })
  })
}

async function emitArtifactDelta(
  page: Page,
  data: { id: string; title?: string; artifactType?: string; content: string }
): Promise<void> {
  await page.evaluate(({ data }) => (window as any).__mockBus.emit('artifact-delta', '', data), { data })
  await page.waitForTimeout(300)
}

async function emitArtifact(
  page: Page,
  artifact: { id: string; type: string; title: string; content: string; language?: string }
): Promise<void> {
  await page.evaluate(({ artifact }) => (window as any).__mockBus.emit('artifact', '', artifact), { artifact })
  await page.waitForTimeout(300)
}

test.describe('code 产物预览优化', () => {
  test('T1 流式 code 产物 → 生成卡可见，不出现全屏源码视图', async ({ page }) => {
    await setup(page)
    const partial = Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`).join('\n')
    // 首个 delta 只建壳（chatStore onArtifactDelta：streamingArtifact 为空时走 startStreaming，
    // 不带 content）；第二个 delta 才真正走 updateStreaming 把内容写进去
    await emitArtifactDelta(page, { id: 'code-streaming-1', title: 'Demo场景.jsx', artifactType: 'code', content: partial })
    await emitArtifactDelta(page, { id: 'code-streaming-1', title: 'Demo场景.jsx', artifactType: 'code', content: partial })

    await expect(page.getByTestId('code-streaming-card')).toBeVisible({ timeout: 5000 })
    // 进度文案 + 尾部代码片段都在卡片里
    await expect(page.getByTestId('code-streaming-card')).toContainText('已生成')
    await expect(page.getByTestId('code-streaming-card')).toContainText('line11')
    // CodePreview 的标志性"复制"按钮不应出现——证明没有走全屏原始代码视图
    await expect(page.getByText('复制', { exact: true })).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-streaming-card.png`, fullPage: true })
  })

  test('T2 完成态场景 jsx → 合成薄壳渲染出场景内容', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'artifact-scene1',
      type: 'code',
      title: 'Demo场景.jsx',
      language: 'jsx',
      content: SCENE_SRC
    })

    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('text=SCENE OK')).toBeVisible({ timeout: 20000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-scene-synth.png`, fullPage: true })
  })

  test('T3 完成态普通 code（python）→ 行为不变，仍走 CodePreview', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'code-py-1',
      type: 'code',
      title: 'script.py',
      language: 'python',
      content: 'def hello():\n    return "hi there"\n'
    })

    // CodePreview：语言徽章 + 复制按钮 + markdown 渲染的代码块
    await expect(page.getByText('PYTHON', { exact: true })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('复制', { exact: true })).toBeVisible()
    await expect(page.getByText('hello', { exact: false }).first()).toBeVisible()
    await expect(page.getByTestId('code-streaming-card')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-plain-code.png`, fullPage: true })
  })
})
