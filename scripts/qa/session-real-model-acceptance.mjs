#!/usr/bin/env node
/* global document, HTMLElement, window */
/**
 * OpenPipal JSONL 会话真模型验收。
 *
 * - 只读用户正式配置中的一个模型预设，凭据复制到 0700 临时 home / 0600 config。
 * - 真 Electron + 真 renderer UI 点击发送，不直接调用模型 SDK。
 * - 第一轮让模型记住随机验收码；关闭 App 后重启同一隔离 home；第二轮只凭历史取回验收码。
 * - 截取流式、完成、重启恢复、窄屏和宽屏画面，并检查 renderer 错误与横向溢出。
 * - 不触碰用户正式会话、记忆、Agent 或产物；默认结束即删除临时 home。
 *
 * 使用：
 *   node scripts/qa/session-real-model-acceptance.mjs
 *   node scripts/qa/session-real-model-acceptance.mjs --preset <presetId> --timeout 180000
 */
import { _electron as electron } from 'playwright'
import console from 'node:console'
import { createServer } from 'node:net'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const options = { timeout: 180_000, keepHome: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--keep-home') {
      options.keepHome = true
      continue
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--preset') options.preset = value
    else if (argument === '--timeout') options.timeout = Number(value)
    else if (argument === '--marker') options.marker = value
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 10_000) {
    throw new Error('--timeout must be at least 10000ms')
  }
  return options
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findFiles(root, suffix) {
  if (!await exists(root)) return []
  const found = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path)
    }
  }
  await visit(root)
  return found
}

async function freePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
  })
  assert(port > 0, 'failed to allocate an isolated HTTP port')
  return port
}

async function buildIsolatedHome(presetId) {
  const sourcePath = join(homedir(), '.openpipal', 'config.json')
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  const selectedId = presetId || source.activePresetId
  const preset = (source.modelPresets || []).find((candidate) => candidate.id === selectedId)
  if (!preset) throw new Error(`model preset not found: ${selectedId || '(no active preset)'}`)
  const provider = (source.modelProviders || []).find((candidate) => candidate.id === preset.providerId)
  const modelConfig = {
    ...(provider ? {
      provider: provider.provider,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
    } : {}),
    ...preset.config,
  }
  if (!modelConfig.apiKey) throw new Error(`preset ${preset.id} has no resolvable apiKey`)
  if (!modelConfig.model) throw new Error(`preset ${preset.id} has no model`)

  const home = await mkdtemp(join(tmpdir(), 'openpipal-session-real-model-'))
  await chmod(home, 0o700)
  const dataRoot = join(home, '.openpipal')
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await chmod(dataRoot, 0o700)
  await writeFile(join(dataRoot, 'config.json'), JSON.stringify({
    configVersion: 2,
    onboardingCompleted: true,
    appFollowingEnabled: false,
    autoMemoryEnabled: false,
    role: 'general',
    modelConfig,
    modelProviders: provider ? [{ ...provider }] : [],
    modelPresets: [{ ...preset }],
    activePresetId: preset.id,
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return { home, presetId: preset.id, model: modelConfig.model }
}

function attachRendererDiagnostics(page, diagnostics) {
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text())
  })
  page.on('crash', () => diagnostics.pageErrors.push('renderer crashed'))
}

async function installInteractionTrace(page) {
  await page.evaluate(() => {
    window.__sessionAcceptanceTrace = { clicks: [], views: [] }
    document.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const button = target?.closest('button')
      window.__sessionAcceptanceTrace.clicks.push({
        at: Date.now(),
        tag: target?.tagName || null,
        testId: button?.getAttribute('data-testid') || target?.getAttribute('data-testid') || null,
        title: button?.getAttribute('title') || null,
        text: String(button?.textContent || target?.textContent || '').trim().slice(0, 80),
      })
    }, true)
    const store = window.__appStore
    if (store?.subscribe) {
      let previous = store.getState().activeView
      window.__sessionAcceptanceTrace.views.push({ at: Date.now(), view: previous })
      store.subscribe((state) => {
        if (state.activeView === previous) return
        previous = state.activeView
        window.__sessionAcceptanceTrace.views.push({ at: Date.now(), view: previous })
      })
    }
  })
}

async function interactionTrace(page) {
  return page.evaluate(() => window.__sessionAcceptanceTrace || { clicks: [], views: [] })
}

async function setWindowSize(app, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
  }, { width, height })
}

async function waitForUi(page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__chatStore), null, { timeout: 30_000 })
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('[data-testid="send-btn"]').first().waitFor({ state: 'visible', timeout: 30_000 })
}

async function waitForStableChat(page) {
  await page.waitForFunction(() => (
    window.__appStore?.getState().activeView === 'chat'
    && !window.__chatStore.getState().isStreaming
    && Boolean(document.querySelector('textarea'))
  ), null, { timeout: 10_000, polling: 50 })
  // Framer/CSS entry transitions otherwise make a correct restored view look
  // disabled in a screenshot captured on its first animation frame.
  await page.waitForTimeout(500)
}

async function waitForCompactSidebar(page) {
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]')
    return sidebar instanceof HTMLElement && sidebar.getBoundingClientRect().width <= 60
  }, null, { timeout: 5_000, polling: 50 })
}

async function visualMetrics(page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const width = Math.max(root.scrollWidth, body.scrollWidth)
    return {
      viewportWidth: window.innerWidth,
      documentWidth: width,
      horizontalOverflow: Math.max(0, width - window.innerWidth),
      inputVisible: Boolean(document.querySelector('textarea')),
      activeProcessGroups: document.querySelectorAll('[data-testid="process-group-toggle"][data-active="true"]').length,
    }
  })
}

async function sendThroughUi(page, prompt, assistantCountBefore, timeout, streamingShot) {
  const input = page.locator('textarea').first()
  await input.fill(prompt)
  await page.locator('[data-testid="send-btn"]').first().click()
  await page.waitForFunction(() => window.__chatStore.getState().isStreaming, null, {
    timeout: 10_000,
    polling: 25,
  })
  await page.screenshot({ path: streamingShot, fullPage: true })

  const outcome = await page.waitForFunction((previousCount) => {
    const state = window.__chatStore.getState()
    const assistants = state.messages.filter((message) => (
      message.role === 'assistant' && message.messageKind !== 'thinking'
    ))
    if (state.isStreaming || assistants.length <= previousCount) return null
    const last = assistants[assistants.length - 1]
    return {
      content: typeof last.content === 'string' ? last.content : JSON.stringify(last.content || ''),
      assistantCount: assistants.length,
      conversationId: state.activeConversationId,
    }
  }, assistantCountBefore, { timeout, polling: 250 }).then((handle) => handle.jsonValue())
  assert(outcome?.conversationId, 'conversation id missing after model completion')
  assert(outcome?.content?.trim(), 'model completed without a visible assistant reply')
  return outcome
}

async function waitForPersistedAssistant(page, conversationId, expectedText, timeout) {
  await page.waitForFunction(async ({ id, text }) => {
    const messages = await window.api.getConversationMessages(id)
    return messages.some((message) => (
      message.role === 'assistant' && String(message.content || '').includes(text)
    ))
  }, { id: conversationId, text: expectedText }, { timeout, polling: 250 })
}

async function launchApp(home, port) {
  return electron.launch({
    executablePath: join(
      process.cwd(), 'node_modules', 'electron', 'dist',
      'Electron.app', 'Contents', 'MacOS', 'Electron'
    ),
    args: [process.cwd()],
    env: {
      ...process.env,
      HOME: home,
      OPENPIPAL_ISOLATED_HOME: home,
      OPENPIPAL_DISABLE_APP_TRACKING: '1',
      OPENPIPAL_SESSION_STORE: 'pi-jsonl-v4',
      OPENPIPAL_HTTP_PORT: String(port),
    },
  })
}

const options = parseArgs(process.argv.slice(2))
const marker = options.marker || `OPENPIPAL_${Date.now().toString(36).toUpperCase()}`
assert(/^[A-Za-z0-9_-]{8,80}$/.test(marker), 'marker must be 8-80 safe ASCII characters')
const runDirectory = resolve(
  process.cwd(),
  'output',
  'playwright',
  'session-real-model',
  marker
)
await mkdir(runDirectory, { recursive: true })

const isolated = await buildIsolatedHome(options.preset)
const diagnostics = { pageErrors: [], consoleErrors: [] }
const screenshots = []
let firstApp
let secondApp
let result
const startedAt = Date.now()

try {
  firstApp = await launchApp(isolated.home, await freePort())
  let page = await firstApp.firstWindow()
  attachRendererDiagnostics(page, diagnostics)
  await setWindowSize(firstApp, 400, 740)
  await waitForUi(page)
  await waitForCompactSidebar(page)
  await installInteractionTrace(page)

  const readyShot = join(runDirectory, '01-ready.png')
  await page.screenshot({ path: readyShot, fullPage: true })
  screenshots.push(readyShot)

  const firstPrompt = `请记住这段验收码：${marker}。现在只回复“已记住”。`
  const firstStreamingShot = join(runDirectory, '02-first-streaming.png')
  screenshots.push(firstStreamingShot)
  const first = await sendThroughUi(page, firstPrompt, 0, options.timeout, firstStreamingShot)
  assert(first.content.includes('已记住'), `first model reply did not acknowledge memory: ${first.content}`)
  await waitForPersistedAssistant(page, first.conversationId, '已记住', 15_000)
  const firstView = await page.evaluate(() => window.__appStore.getState().activeView)
  if (firstView !== 'chat') {
    throw new Error(`first completion left chat view (${firstView}): ${JSON.stringify(await interactionTrace(page))}`)
  }
  await waitForStableChat(page)

  const firstCompleteShot = join(runDirectory, '03-first-complete.png')
  await page.screenshot({ path: firstCompleteShot, fullPage: true })
  screenshots.push(firstCompleteShot)
  const firstMetrics = await visualMetrics(page)
  assert(firstMetrics.horizontalOverflow <= 1, `narrow UI overflows horizontally by ${firstMetrics.horizontalOverflow}px`)
  assert(firstMetrics.inputVisible, 'chat input disappeared after first completion')

  await firstApp.close()
  firstApp = undefined

  secondApp = await launchApp(isolated.home, await freePort())
  page = await secondApp.firstWindow()
  attachRendererDiagnostics(page, diagnostics)
  await setWindowSize(secondApp, 400, 740)
  await waitForUi(page)
  await waitForCompactSidebar(page)
  await installInteractionTrace(page)
  await page.evaluate(async (conversationId) => {
    await window.__chatStore.getState().switchConversation(conversationId)
  }, first.conversationId)
  await page.waitForFunction((conversationId) => {
    const state = window.__chatStore.getState()
    return state.activeConversationId === conversationId && state.messages.some((message) => (
      message.role === 'assistant' && String(message.content || '').includes('已记住')
    ))
  }, first.conversationId, { timeout: 30_000, polling: 250 })
  await waitForStableChat(page)

  const restoredShot = join(runDirectory, '04-restored-after-restart.png')
  await page.screenshot({ path: restoredShot, fullPage: true })
  screenshots.push(restoredShot)

  const secondPrompt = '请只回复上一条用户消息里的验收码，不要添加其他文字。'
  const secondStreamingShot = join(runDirectory, '05-restart-streaming.png')
  screenshots.push(secondStreamingShot)
  const second = await sendThroughUi(page, secondPrompt, 1, options.timeout, secondStreamingShot)
  assert(second.content.includes(marker), `model did not recover the prior marker after restart: ${second.content}`)
  await waitForPersistedAssistant(page, first.conversationId, marker, 15_000)

  const narrowCompleteShot = join(runDirectory, '06-restart-complete-narrow.png')
  await page.screenshot({ path: narrowCompleteShot, fullPage: true })
  screenshots.push(narrowCompleteShot)
  const narrowMetrics = await visualMetrics(page)
  assert(narrowMetrics.horizontalOverflow <= 1, `restored narrow UI overflows by ${narrowMetrics.horizontalOverflow}px`)
  assert(narrowMetrics.inputVisible, 'chat input disappeared after restart completion')

  await setWindowSize(secondApp, 1000, 820)
  await page.waitForTimeout(300)
  const wideCompleteShot = join(runDirectory, '07-restart-complete-wide.png')
  await page.screenshot({ path: wideCompleteShot, fullPage: true })
  screenshots.push(wideCompleteShot)
  const wideMetrics = await visualMetrics(page)
  assert(wideMetrics.horizontalOverflow <= 1, `restored wide UI overflows by ${wideMetrics.horizontalOverflow}px`)

  const persistedMessages = await page.evaluate(
    (conversationId) => window.api.getConversationMessages(conversationId),
    first.conversationId
  )
  assert(persistedMessages.length >= 4, `expected at least 4 persisted messages, got ${persistedMessages.length}`)

  await secondApp.close()
  secondApp = undefined

  const jsonlFiles = await findFiles(join(isolated.home, '.openpipal', 'sessions-v4'), '.jsonl')
  assert(jsonlFiles.length === 1, `expected exactly 1 JSONL session log, got ${jsonlFiles.length}`)
  const log = await readFile(jsonlFiles[0], 'utf8')
  assert(log.includes(marker), 'JSONL authority log does not contain the recovered marker')
  const legacyFile = join(isolated.home, '.openpipal', 'conversations', `${first.conversationId}.json`)
  assert(!await exists(legacyFile), 'new acceptance conversation unexpectedly wrote a legacy JSON authority file')
  assert(diagnostics.pageErrors.length === 0, `renderer errors: ${diagnostics.pageErrors.join(' | ')}`)
  assert(diagnostics.consoleErrors.length === 0, `renderer console errors: ${diagnostics.consoleErrors.join(' | ')}`)

  result = {
    passed: true,
    presetId: isolated.presetId,
    model: isolated.model,
    marker,
    conversationId: first.conversationId,
    elapsedMs: Date.now() - startedAt,
    firstReply: first.content,
    recoveredReply: second.content,
    persistedMessageCount: persistedMessages.length,
    jsonlLogCount: jsonlFiles.length,
    diagnostics,
    visual: { firstMetrics, narrowMetrics, wideMetrics },
    screenshots,
    ...(options.keepHome ? { isolatedHome: isolated.home } : {}),
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result = {
    passed: false,
    presetId: isolated.presetId,
    model: isolated.model,
    marker,
    elapsedMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
    diagnostics,
    screenshots,
    ...(options.keepHome ? { isolatedHome: isolated.home } : {}),
  }
  console.error(JSON.stringify(result, null, 2))
  process.exitCode = 1
} finally {
  await firstApp?.close().catch(() => undefined)
  await secondApp?.close().catch(() => undefined)
  if (!options.keepHome) await rm(isolated.home, { recursive: true, force: true })
}
