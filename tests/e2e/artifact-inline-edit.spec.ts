/**
 * Artifact 元素微调 E2E —— comment 点选气泡 + ⚙ 展开的属性面板（v2：单一入口 + 字段补齐）
 *
 * 覆盖：
 *   T1 comment 模式点选 h1 → 悬浮气泡（⚙ + 「添加评论…」）出现，位置贴元素；不再有独立的
 *      ✎ 改文字按钮（改文字入口已收敛到面板「文本」字段）
 *   T2 ⚙ 展开面板 → 文本字段 → 改文字 → 确认 → 源码字符串直写（面板成为改文字唯一入口，
 *      走宿主侧确定性阶梯 ladderTextReplace 直写 onContentEdit）
 *   T3 ⚙ 展开面板 → 标签名 + 字段初值正确（覆盖颜色/背景/Opacity/字体等基础字段）
 *   T4 改颜色字段 → live 预览即时生效 → 确认 → pendingMentions 收到样式 change-spec
 *   T5 改颜色后取消 → 内联样式已还原
 *   T6 字号/字重/内边距字段 → live 预览即时生效（新增字段组的抽样验证）
 *   T7 宽高联动锁：开锁后改宽 → 高按初始宽高比联动变化
 *   T8 元素 A 改色(预览生效)未确认 → 直接点选元素 B → A 的样式回滚 + 面板显示 B 的初值
 *   T9 A 确认样式 → 面板关闭/comment 模式保持 → 点选 B → B 确认样式 → pendingMentions 各自累积
 *   T10 字号调大改变元素几何 → 气泡与持续选中高亮框的位置/尺寸跟随重定位
 *   T11 麦克风按钮存在于气泡评论输入和面板描述输入，点击进入录音态（真转写人工验）
 *   T12 面板垂直空间自适应：锚定元素贴近预览容器底部时面板整体翻转到锚点上方、且完整落在
 *      容器内，取消/确认按钮始终可见可点；矮容器场景下面板 max-height 收缩，内容区出现
 *      滚动条而底栏依旧可见（P2 面板高度/位置自适应）
 *
 * Mock 手法同 dc-stream-pump.spec.ts / pdf-export-btn.spec.ts：__mockBus + 精简 window.api + addInitScript。
 * 用一个不含 <x-dc> 的纯静态 html（无 support.js/无网络依赖），走 assembleDocSync 的非 dc 分支
 * （只注入 bridge，不解析 dc 运行时），断网环境也能跑。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/inline-edit'
const DC_IFRAME = 'iframe[sandbox="allow-scripts allow-modals allow-downloads"]'

// 静态 html：h1 显式 color，方便断言初值/live 预览的确定性；body 留白让 h1 rect.y 够大，
// 气泡才有空间画在元素上方（而不是被 clamp 到下方）。#para 用 position:absolute 摆在视口
// 右侧远处——面板浮层（~340px 宽，锚定在 h1 附近左上区域）不会盖住它，T8/T9 才能真的
// 把点击事件送进 iframe（而不是被 host 侧浮层截胡）。
const CONTENT = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>body{margin:0;padding:60px 24px;font-family:sans-serif;background:#fff}</style>
</head>
<body>
<h1 id="title" style="color:#1a2b3c;margin:0 0 56px 0">Hello Title</h1>
<p id="para" style="position:absolute;top:100px;left:900px;margin:0">Some paragraph text here for testing edits.</p>
</body>
</html>`

// T12a/b：目标元素贴 iframe 视口底沿(bottom:8px 相对 initial containing block，即 iframe
// 视口本身，与外层 wrapper 实际像素高度无关)——面板默认在下方展开时必然放不下，逼出翻转分支。
const CONTENT_BOTTOM = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>body{margin:0;padding:24px;font-family:sans-serif;background:#fff}</style>
</head>
<body>
<div id="bottom-el" style="position:absolute;bottom:8px;left:24px;background:#eee;padding:8px 12px">Bottom Element</div>
</body>
</html>`

// T12c：矮容器场景——配合极矮 viewport，元素摆在 iframe 视口纵向中段，上下剩余空间都不够
// 面板最小可用高度，只收缩 max-height（不发生有意义的翻转）
const CONTENT_MID = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>body{margin:0;padding:24px;font-family:sans-serif;background:#fff}</style>
</head>
<body>
<div id="mid-el" style="position:absolute;top:45%;left:24px;background:#eee;padding:8px 12px">Mid Element</div>
</body>
</html>`

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.__savedCalls = [];
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
  captureRegion: async () => ({ base64: 'ZmFrZQ==' }),
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
    window.__savedCalls.push({ id: art.id, content: art.content });
    return { ok: true, ref: { id: art.id } };
  },
  exportDcArtifacts: async () => ({ ok: true, dir: '/x', files: [] }),
  transcribeAudio: async () => ({ text: '' }),
};

// 假麦克风：headless Chromium 无真实设备/权限，用 WebAudio 振荡器合成一路音轨，
// 让 useLocalSTT 的 getUserMedia 分支能正常进入 recording 态（T11 只测 UI 态，不测真转写）
navigator.mediaDevices = navigator.mediaDevices || {};
navigator.mediaDevices.getUserMedia = async () => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dst = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.connect(dst);
  osc.start();
  return dst.stream;
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).__chatStore?.setState?.({ activeConversationId: 'mock-conv' })
  })
}

async function emitArtifact(page: Page, id: string, content: string = CONTENT): Promise<void> {
  await page.evaluate(
    ({ id, content }) => (window as any).__mockBus.emit('artifact', '', { id, type: 'html', title: 'Demo.html', content }),
    { id, content }
  )
  await page.waitForTimeout(300)
}

/** 激活 comment 模式并点选 h1 —— T2-T7 共用前缀 */
async function activateAndClickTitle(page: Page, artifactId: string): Promise<void> {
  await setup(page)
  await emitArtifact(page, artifactId)
  await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })
  const frame = page.frameLocator(DC_IFRAME)
  await expect(frame.locator('#title')).toBeVisible({ timeout: 8000 })

  await page.getByRole('button', { name: '评论' }).first().click()
  await frame.locator('#title').click()
  await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
}

/** ⚙ 展开面板 —— T3-T7 共用后缀 */
async function expandPanel(page: Page): Promise<void> {
  await page.getByTestId('comment-bubble-expand').click()
  await expect(page.getByTestId('element-tweak-panel')).toBeVisible({ timeout: 5000 })
}

test.describe('Artifact 元素微调面板(v2)：单一入口 + 样式字段补齐', () => {
  test('T1 comment 点选 h1 → 悬浮气泡出现，位置贴元素；无独立改文字按钮', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, 'inline-t1')
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#title')).toBeVisible({ timeout: 8000 })

    await page.getByRole('button', { name: '评论' }).first().click()
    await frame.locator('#title').click()

    const bubble = page.getByTestId('comment-bubble')
    await expect(bubble).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('comment-bubble-expand')).toBeVisible()
    await expect(page.getByTestId('comment-bubble-input')).toBeVisible()
    // 单一入口：不应再出现独立悬浮的「✎ 改文字」按钮
    await expect(frame.getByText('✎ 改文字')).toHaveCount(0)

    // 位置贴元素：气泡与 h1 的水平位置应接近（同一坐标系，Playwright 自动换算 frame 偏移）
    const bubbleBox = await bubble.boundingBox()
    const titleBox = await frame.locator('#title').boundingBox()
    expect(bubbleBox).not.toBeNull()
    expect(titleBox).not.toBeNull()
    if (bubbleBox && titleBox) {
      expect(Math.abs(bubbleBox.x - titleBox.x)).toBeLessThan(20)
      // 气泡应在元素附近的垂直范围内（上方或下方 clamp），不应飘到页面另一端
      expect(Math.abs(bubbleBox.y - titleBox.y)).toBeLessThan(120)
    }

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-bubble-visible.png`, fullPage: true })
  })

  test('T2 面板文本字段 → 改文字 → 确认 → 源码直写', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t2')
    await expandPanel(page)

    const textField = page.getByTestId('tweak-field-text')
    await textField.click() // 聚焦：单行胶囊 → 展开为多行 textarea
    await textField.fill('Changed Title Text')

    await page.getByTestId('tweak-confirm').click()
    await page.waitForTimeout(200)

    const saved = await page.evaluate(() => (window as any).__savedCalls)
    expect(saved.length).toBeGreaterThan(0)
    const last = saved[saved.length - 1]
    expect(last.content).toContain('Changed Title Text')
    expect(last.content).not.toContain('Hello Title')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-panel-text-saved.png`, fullPage: true })
  })

  test('T3 ⚙ 展开面板 → 标签名 + 字段初值正确', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t3')
    await expandPanel(page)

    await expect(page.getByTestId('tweak-tag-name')).toHaveText('h1')

    await expect(page.getByTestId('tweak-field-text')).toHaveValue('Hello Title')
    await expect(page.getByTestId('tweak-field-color')).toHaveValue('#1a2b3c')
    await expect(page.getByTestId('tweak-field-bg')).toHaveValue('#000000') // 无显式背景 → rgba(0,0,0,0) 归一化
    await expect(page.getByTestId('tweak-field-opacity')).toHaveValue('1')
    const fontSize = await page.getByTestId('tweak-field-font-size').inputValue()
    expect(Number(fontSize)).toBeGreaterThan(0)
    const fontWeight = await page.getByTestId('tweak-field-font-weight').inputValue()
    expect(fontWeight.length).toBeGreaterThan(0)
    const width = await page.getByTestId('tweak-field-width').inputValue()
    expect(Number(width)).toBeGreaterThan(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-panel-fields.png`, fullPage: true })
    // 第二屏：滚动面板内容区到底部，覆盖组4-5（边框/宽高/内外边距）
    await page.getByTestId('element-tweak-panel').evaluate((el) => {
      const scrollArea = el.querySelector('.overflow-y-auto')
      if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight
    })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3b-panel-scrolled-groups4-5.png`, fullPage: true })
  })

  test('T4 改颜色字段 → live 预览即时生效 → 确认 → 样式直写落盘，零 AI mention', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t4')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    await page.getByTestId('tweak-field-color').fill('#ff0000')
    // live 预览：iframe 内 h1 的实际渲染颜色应立即变化，无需确认
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)', { timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4a-live-preview.png`, fullPage: true })

    await page.getByTestId('tweak-confirm').click()
    await page.waitForTimeout(200)

    // #title 有 id → 确定性阶梯 (a) 命中：样式直接合并进源码的 style="..." 并落盘，
    // 不再走 AI change-spec；点选时留下的"元素引用"chip 也随之清掉（零 AI 介入，零留痕）
    const saved = await page.evaluate(() => (window as any).__savedCalls)
    expect(saved.length).toBeGreaterThan(0)
    const last = saved[saved.length - 1]
    expect(last.content).toContain('color: #ff0000')
    expect(last.content).not.toContain('#1a2b3c')

    const mentions = await page.evaluate(() => (window as any).__chatStore.getState().pendingMentions as string[])
    expect(mentions.length).toBe(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4b-confirmed.png`, fullPage: true })
  })

  test('T5 取消 → 内联样式已还原', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t5')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    await page.getByTestId('tweak-field-color').fill('#00ff00')
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(0, 255, 0)', { timeout: 3000 })

    await page.getByTestId('tweak-cancel').click()
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(26, 43, 60)', { timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t5-cancel-reverted.png`, fullPage: true })
  })

  test('T6 字号/字重/内边距 → live 预览即时生效', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t6')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    await page.getByTestId('tweak-field-font-size').fill('40')
    await expect(frame.locator('#title')).toHaveCSS('font-size', '40px', { timeout: 3000 })

    await page.getByTestId('tweak-field-font-weight').selectOption('700')
    await expect(frame.locator('#title')).toHaveCSS('font-weight', '700', { timeout: 3000 })

    await page.getByTestId('tweak-field-padding-top').fill('20')
    await expect(frame.locator('#title')).toHaveCSS('padding-top', '20px', { timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t6-fontsize-weight-padding-preview.png`, fullPage: true })
  })

  test('T7 宽高联动锁：开锁改宽 → 高按原始宽高比联动变化', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t7')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    const widthField = page.getByTestId('tweak-field-width')
    const heightField = page.getByTestId('tweak-field-height')
    const initialWidth = parseFloat(await widthField.inputValue())
    const initialHeight = parseFloat(await heightField.inputValue())
    expect(initialWidth).toBeGreaterThan(0)
    expect(initialHeight).toBeGreaterThan(0)

    await page.getByTestId('tweak-field-link-lock').click()
    const newWidth = Math.round(initialWidth * 2)
    await widthField.fill(String(newWidth))

    const expectedHeight = Math.round(newWidth / (initialWidth / initialHeight))
    await expect(heightField).toHaveValue(String(expectedHeight))
    // 预览宿主的通用宽度适配给 iframe 文档根打 CSS zoom（HtmlPreview._applyZoom），
    // Chromium 在 zoom 下对长度做设备像素量化：height:73px 的 computed 是 72.9892px 之类
    // ——逐字节 toHaveCSS 必挂（本断言写于宽度适配上线之前）。改为 0.5px 容差数值比对；
    // 面板字段的联动值（上一行 toHaveValue）仍是逐字节精确断言，产品逻辑不放松。
    await expect.poll(async () => {
      const h = await frame.locator('#title').evaluate(el => parseFloat(getComputedStyle(el).height))
      return Math.abs(h - expectedHeight)
    }, { timeout: 3000 }).toBeLessThan(0.5)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t7-width-height-linked.png`, fullPage: true })
  })

  test('T8 切换元素时未确认预览先还原（不孤儿化）', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t8')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    await page.getByTestId('tweak-field-color').fill('#ff0000')
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)', { timeout: 3000 })

    // 不确认，直接点选另一个元素 B（#para）——continuous 点选流程（此刻面板仍展开）
    await frame.locator('#para').click()

    // A 的内联样式应已回滚到原色
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(26, 43, 60)', { timeout: 3000 })

    // 面板切到 B：气泡重新出现，展开后字段初值应是 B 的原始值（未被 A 的编辑污染）
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
    await expandPanel(page)
    await expect(page.getByTestId('tweak-tag-name')).toHaveText('p')
    await expect(page.getByTestId('tweak-field-color')).toHaveValue('#000000')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t8-switch-reverts-a.png`, fullPage: true })
  })

  test('T9 连续多元素确认样式 → 各自独立直写落盘，互不干扰，零 AI mention 残留', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t9')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    await page.getByTestId('tweak-field-color').fill('#ff0000')
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)', { timeout: 3000 })
    await page.getByTestId('tweak-confirm').click()

    // 确认后：面板关闭，comment 模式保持（无需重新点 Comment 按钮），A 的确认改动留在 DOM 上
    await expect(page.getByTestId('element-tweak-panel')).toHaveCount(0)
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)', { timeout: 3000 })

    // 直接点选下一个元素 B，继续编辑流
    await frame.locator('#para').click()
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
    await expandPanel(page)
    await page.getByTestId('tweak-field-color').fill('#00ff00')
    await expect(frame.locator('#para')).toHaveCSS('color', 'rgb(0, 255, 0)', { timeout: 3000 })
    await page.getByTestId('tweak-confirm').click()
    await page.waitForTimeout(200)

    // A 的确认改动仍应保留（不会被 B 的切换/确认误回滚）
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)', { timeout: 3000 })

    // #title 与 #para 都带 id → 两次都走确定性阶梯 (a) 直写，全程零 AI 介入：
    // 最终落盘内容里两处颜色都在，且 pendingMentions（含两次点选各自留下的"元素引用"chip）已清空
    const saved = await page.evaluate(() => (window as any).__savedCalls)
    expect(saved.length).toBeGreaterThan(0)
    const last = saved[saved.length - 1]
    expect(last.content).toContain('color: #ff0000')
    expect(last.content).toContain('color: #00ff00')

    const mentions = await page.evaluate(() => (window as any).__chatStore.getState().pendingMentions as string[])
    expect(mentions.length).toBe(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t9-continuous-multi-confirm.png`, fullPage: true })
  })

  test('T10 字号调大 → 气泡与高亮框位置/尺寸跟随变化', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t10')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    const bubbleBefore = await page.getByTestId('comment-bubble').boundingBox()
    const boxBefore = await frame.locator('#sw-tweak-selected-box').boundingBox()
    expect(bubbleBefore).not.toBeNull()
    expect(boxBefore).not.toBeNull()

    await page.getByTestId('tweak-field-font-size').fill('96')
    await expect(frame.locator('#title')).toHaveCSS('font-size', '96px', { timeout: 3000 })
    // 宿主处理 comment:rect-changed 重新定位气泡/面板/高亮框
    await page.waitForTimeout(200)

    const bubbleAfter = await page.getByTestId('comment-bubble').boundingBox()
    const boxAfter = await frame.locator('#sw-tweak-selected-box').boundingBox()
    expect(bubbleAfter).not.toBeNull()
    expect(boxAfter).not.toBeNull()

    if (bubbleBefore && bubbleAfter && boxBefore && boxAfter) {
      // 字号变大 → 元素更高 → 高亮框 height 增大；气泡默认落在元素下方 → top 随之下移
      expect(boxAfter.height).toBeGreaterThan(boxBefore.height)
      expect(bubbleAfter.y).toBeGreaterThan(bubbleBefore.y)
    }

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t10-rect-follow.png`, fullPage: true })
  })

  test('T11 麦克风按钮：气泡与面板输入框均存在，点击进入录音态', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t11')

    const bubbleMic = page.getByTestId('comment-bubble-mic')
    await expect(bubbleMic).toBeVisible()
    await bubbleMic.click()
    await expect(bubbleMic).toHaveClass(/bg-red-500/, { timeout: 3000 })
    // animate-pulse 的关键帧会周期性把不透明度压到接近 0——recording 态的 class 断言已在上面
    // 验证过，这里截图前去掉 pulse class 只是为了让截图稳定显示实心红，不受动画相位影响
    await bubbleMic.evaluate((el) => el.classList.remove('animate-pulse'))
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t11a-bubble-mic-recording.png`, fullPage: true })
    await bubbleMic.click() // 停止，避免残留录音态影响后续断言

    await expandPanel(page)
    const panelMic = page.getByTestId('tweak-description-mic')
    await expect(panelMic).toBeVisible()
    await panelMic.click()
    await expect(panelMic).toHaveClass(/bg-red-500/, { timeout: 3000 })
    await panelMic.evaluate((el) => el.classList.remove('animate-pulse'))
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t11b-panel-mic-recording.png`, fullPage: true })
    await panelMic.click()
  })

  test('T12a 锚点贴容器底部 → 面板翻转到上方且完整落在容器内，取消/确认可见可点', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, 'inline-t12a', CONTENT_BOTTOM)
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#bottom-el')).toBeVisible({ timeout: 8000 })

    await page.getByRole('button', { name: '评论' }).first().click()
    await frame.locator('#bottom-el').click()
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
    await page.getByTestId('comment-bubble-expand').click()
    await expect(page.getByTestId('element-tweak-panel')).toBeVisible({ timeout: 5000 })

    const wrapperBox = await page.getByTestId('html-preview-wrapper').boundingBox()
    const panelBox = await page.getByTestId('element-tweak-panel-wrap').boundingBox()
    expect(wrapperBox).not.toBeNull()
    expect(panelBox).not.toBeNull()
    if (wrapperBox && panelBox) {
      // ① 面板 boundingBox 完整落在预览容器 boundingBox 内
      expect(panelBox.y).toBeGreaterThanOrEqual(wrapperBox.y - 1)
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(wrapperBox.y + wrapperBox.height + 1)
      expect(panelBox.x).toBeGreaterThanOrEqual(wrapperBox.x - 1)
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(wrapperBox.x + wrapperBox.width + 1)
      // 翻转场景：面板应出现在锚点上方（面板底 <= 锚点顶附近），而不是按默认偏移出现在气泡下方
      const anchorBox = await frame.locator('#bottom-el').boundingBox()
      expect(anchorBox).not.toBeNull()
      if (anchorBox) expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(anchorBox.y + 4)
    }

    // ② 取消与确认按钮均可见且可点击
    const cancelBtn = page.getByTestId('tweak-cancel')
    const confirmBtn = page.getByTestId('tweak-confirm')
    await expect(cancelBtn).toBeVisible()
    await expect(confirmBtn).toBeVisible()
    await expect(cancelBtn).toBeInViewport()
    await expect(confirmBtn).toBeInViewport()

    // 翻转场景截图（面板出现在元素上方）
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t12a-flip-above-anchor.png`, fullPage: true })

    // 实际点一下取消，验证按钮真的可点（面板随之关闭）
    await cancelBtn.click()
    await expect(page.getByTestId('element-tweak-panel')).toHaveCount(0)
  })

  test('T12b 矮容器场景：面板 max-height 收缩，内容区出现滚动条而底栏仍可见', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 480 })
    await setup(page)
    await emitArtifact(page, 'inline-t12b', CONTENT_MID)
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#mid-el')).toBeVisible({ timeout: 8000 })

    await page.getByRole('button', { name: '评论' }).first().click()
    await frame.locator('#mid-el').click()
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
    await page.getByTestId('comment-bubble-expand').click()
    const panel = page.getByTestId('element-tweak-panel')
    await expect(panel).toBeVisible({ timeout: 5000 })

    const wrapperBox = await page.getByTestId('html-preview-wrapper').boundingBox()
    const panelBox = await panel.boundingBox()
    expect(wrapperBox).not.toBeNull()
    expect(panelBox).not.toBeNull()
    if (wrapperBox && panelBox) {
      // 面板仍完整落在矮容器内（没有被裁掉）
      expect(panelBox.y).toBeGreaterThanOrEqual(wrapperBox.y - 1)
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(wrapperBox.y + wrapperBox.height + 1)
    }

    // 内容区确实发生了收缩滚动（scrollHeight 明显大于 clientHeight）
    const scrollInfo = await panel.evaluate((el) => {
      const sc = el.querySelector('.overflow-y-auto') as HTMLElement | null
      return sc ? { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight } : null
    })
    expect(scrollInfo).not.toBeNull()
    if (scrollInfo) expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight)

    // 底栏（取消/确认）依旧完整可见可点
    const cancelBtn = page.getByTestId('tweak-cancel')
    const confirmBtn = page.getByTestId('tweak-confirm')
    await expect(cancelBtn).toBeVisible()
    await expect(confirmBtn).toBeVisible()
    await expect(cancelBtn).toBeInViewport()
    await expect(confirmBtn).toBeInViewport()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t12b-short-container-shrunk.png`, fullPage: true })

    await cancelBtn.click()
    await expect(panel).toHaveCount(0)
  })

  test('T13 拾取元素 → 改颜色 → commit → 样式直写落盘且零 pendingMentions 残留', async ({ page }) => {
    await activateAndClickTitle(page, 'inline-t13')
    const frame = page.frameLocator(DC_IFRAME)
    await expandPanel(page)

    await page.getByTestId('tweak-field-color').fill('#336699')
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(51, 102, 153)', { timeout: 3000 })

    await page.getByTestId('tweak-confirm').click()
    await page.waitForTimeout(200)

    // (a) mock 的 saveArtifact 收到含新样式的内容——直写落盘到源码的 style="..."，不是只活在
    // iframe 内联样式里（iframe 重建即丢的旧 bug 场景）
    const saved = await page.evaluate(() => (window as any).__savedCalls)
    expect(saved.length).toBeGreaterThan(0)
    const last = saved[saved.length - 1]
    expect(last.content).toContain('color: #336699')

    // (b) 全程零 AI 介入：pendingMentions（含点选时留下的"元素引用"chip）清空为 0
    const mentions = await page.evaluate(() => (window as any).__chatStore.getState().pendingMentions as string[])
    expect(mentions.length).toBe(0)

    // (c) 截图
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t13-style-direct-write.png`, fullPage: true })
  })
})

// ── 圈画评论 + Reload 门闩（2026-08 新契约：Comment 模式默认即画笔，拖拽=圈画，点击=点选）──
test.describe('圈画评论与 Reload 门闩', () => {
  /** 在 iframe 区域内画一段拖拽笔迹（host 坐标系；事件自动路由进 iframe） */
  async function drawStroke(page: Page): Promise<void> {
    const box = (await page.locator(DC_IFRAME).first().boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx - 60, cy - 40)
    await page.mouse.down()
    await page.mouse.move(cx + 60, cy - 40, { steps: 6 })
    await page.mouse.move(cx + 60, cy + 40, { steps: 6 })
    await page.mouse.move(cx - 60, cy + 40, { steps: 6 })
    await page.mouse.up()
  }

  test('S1 拖拽圈画 → 笔迹 + 无⚙气泡 → 评论提交 → 截图进待发区、笔迹清除', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, 'stroke-s1')
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#title')).toBeVisible({ timeout: 8000 })

    await page.getByRole('button', { name: '评论' }).first().click()
    await drawStroke(page)

    // 笔迹落在 iframe 内 SVG 层；气泡出现且是 stroke 形态（无 ⚙ 展开按钮）
    await expect(frame.locator('#sw-stroke-layer path')).toHaveCount(1, { timeout: 5000 })
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('comment-bubble-expand')).toHaveCount(0)

    // 圈画气泡固定停靠画布底部（位置习惯记忆，不跟笔迹跑——真机反馈契约）
    const wrapperBox = (await page.locator('[data-testid="html-preview-wrapper"]').first().boundingBox())!
    const bubbleBox = (await page.getByTestId('comment-bubble').boundingBox())!
    expect(bubbleBox.y + bubbleBox.height).toBeGreaterThan(wrapperBox.y + wrapperBox.height - 60)
    // 多笔累积与撤销：先输入文字，气泡开着再画一笔 → 2 条笔迹且输入不被清；撤销 → 回到 1 条
    await page.getByTestId('comment-bubble-input').fill('这一块配色太闷了')
    await drawStroke(page)
    await expect(frame.locator('#sw-stroke-layer path')).toHaveCount(2)
    await expect(page.getByTestId('comment-bubble-input')).toHaveValue('这一块配色太闷了')
    await page.getByTestId('stroke-undo').click()
    await expect(frame.locator('#sw-stroke-layer path')).toHaveCount(1)
    await expect(page.getByTestId('comment-bubble')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/s1-stroke-drawn.png`, fullPage: true })

    // 发送按钮提交（与 Enter 同路径）
    await page.getByTestId('stroke-send').click()

    // 截图（mock captureRegion）+ 文字进 pendingAnnotations；笔迹随提交清除
    await expect
      .poll(async () => page.evaluate(() => (window as any).__chatStore.getState().pendingAnnotations))
      .toMatchObject([{ text: '这一块配色太闷了', image: 'ZmFrZQ==' }])
    await expect(frame.locator('#sw-stroke-layer path')).toHaveCount(0)

    // 画笔活跃时点选仍可用：点击 h1 → element 形态气泡（带 ⚙）
    await frame.locator('#title').click()
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('comment-bubble-expand')).toBeVisible()
  })

  test('S2 操作画布期间内容更新 → 不打断亮 Reload → 点击后应用新内容', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, 'stroke-s2')
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#title')).toBeVisible({ timeout: 8000 })

    // 进入评论模式 = 显式"正在操作画布"
    await page.getByRole('button', { name: '评论' }).first().click()

    // 内容更新到达（首 50 字符不变 → 不触发模式重置，忙态保持）
    await emitArtifact(page, 'stroke-s2', CONTENT.replace('Hello Title', 'Updated Title'))

    // 门闩生效：预览没变，Reload 亮起 + 文案 toast 提示（真机反馈：仅小蓝点不醒目）
    await expect(frame.locator('#title')).toHaveText('Hello Title')
    await expect(page.getByTestId('preview-reload')).toHaveAttribute('title', /有新版本待加载/)
    await expect(page.getByText('画布有新版本待加载', { exact: false })).toBeVisible()

    // 点 Reload → 新内容应用；comment 模式经 iframe onLoad 补激活，点选仍可用
    await page.getByTestId('preview-reload').click()
    await expect(frame.locator('#title')).toHaveText('Updated Title', { timeout: 5000 })
    await frame.locator('#title').click()
    await expect(page.getByTestId('comment-bubble')).toBeVisible({ timeout: 5000 })
  })
})
