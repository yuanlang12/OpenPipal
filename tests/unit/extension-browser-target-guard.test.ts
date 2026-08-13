import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type CommandHook = (
  method: string,
  params: Record<string, unknown>,
  controls: HarnessControls
) => unknown

interface HarnessControls {
  state: { url: string; loaderId: string }
  calls: Array<{ method: string; params: Record<string, unknown> }>
  emitUpdated: (changeInfo: Record<string, unknown>) => void
}

interface Harness extends HarnessControls {
  execute: (action: string, params: Record<string, unknown>) => Promise<unknown>
  updatedListenerCount: () => number
}

function loadBrowserControlHarness(commandHook?: CommandHook): Harness {
  const background = readFileSync(resolve('openpipal-extension/background.js'), 'utf8')
  const start = background.indexOf('const bcAttached = new Set()')
  const end = background.indexOf('// 启动即连;SW 被唤醒')
  if (start < 0 || end <= start) throw new Error('browser-control source anchors missing')

  const updatedListeners = new Set<(...args: unknown[]) => void>()
  const state = { url: 'https://trusted.example/account', loaderId: 'loader-1' }
  const calls: HarnessControls['calls'] = []
  const controls: HarnessControls = {
    state,
    calls,
    emitUpdated(changeInfo) {
      for (const listener of updatedListeners) {
        listener(7, changeInfo, { id: 7, url: state.url, title: 'Tab' })
      }
    }
  }

  const passiveEvent = () => {
    const listeners = new Set<(...args: unknown[]) => void>()
    return {
      addListener(listener: (...args: unknown[]) => void) { listeners.add(listener) },
      removeListener(listener: (...args: unknown[]) => void) { listeners.delete(listener) }
    }
  }

  const chrome = {
    runtime: { lastError: undefined },
    debugger: {
      onDetach: passiveEvent(),
      attach(_target: unknown, _version: string, callback: () => void) { callback() },
      sendCommand(
        _target: unknown,
        method: string,
        params: Record<string, unknown>,
        callback: (result: unknown) => void
      ) {
        calls.push({ method, params })
        const overridden = commandHook?.(method, params, controls)
        if (overridden !== undefined) return callback(overridden)
        if (method === 'Page.getFrameTree') {
          return callback({
            frameTree: { frame: { id: 'frame-1', loaderId: state.loaderId, url: state.url } }
          })
        }
        if (method === 'Runtime.evaluate') {
          return callback({
            result: {
              value: {
                authorized: true,
                title: 'Trusted',
                url: state.url,
                text: 'public text',
                found: true,
                x: 10,
                y: 20
              }
            }
          })
        }
        if (method === 'Page.captureScreenshot') return callback({ data: 'SAFE_PIXELS' })
        return callback({})
      }
    },
    tabs: {
      onRemoved: passiveEvent(),
      onUpdated: {
        addListener(listener: (...args: unknown[]) => void) { updatedListeners.add(listener) },
        removeListener(listener: (...args: unknown[]) => void) { updatedListeners.delete(listener) }
      },
      async get(tabId: number) { return { id: tabId, url: state.url, title: 'Tab' } },
      async query() { return [{ id: 7, url: state.url, title: 'Tab', active: true }] },
      async update() { return { id: 7, url: state.url, title: 'Tab' } }
    },
    scripting: { async executeScript() { return [{ result: 'complete' }] } }
  }

  const context: Record<string, unknown> = {
    chrome,
    URL,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    Error,
    setTimeout,
    clearTimeout
  }
  runInNewContext(
    `${background.slice(start, end)}\nglobalThis.__bcExecute = bcExecute`,
    context,
    { filename: 'openpipal-extension/background.browser-control.js' }
  )

  return {
    ...controls,
    execute: context.__bcExecute as Harness['execute'],
    updatedListenerCount: () => updatedListeners.size
  }
}

describe('extension browser stable-target guard', () => {
  it('discards page text when the live tab switches host after Runtime.evaluate', async () => {
    const harness = loadBrowserControlHarness((method, _params, controls) => {
      if (method !== 'Runtime.evaluate') return undefined
      controls.state.url = 'https://private.example/secrets'
      return {
        result: {
          value: {
            authorized: true,
            title: 'Private',
            url: 'https://trusted.example/account',
            text: 'DO_NOT_RETURN_THIS_SECRET'
          }
        }
      }
    })

    await expect(harness.execute('read_page', { tabId: 7, expectedHost: 'trusted.example' }))
      .rejects.toThrow(/已丢弃结果|站点已变化/)
    expect(harness.updatedListenerCount()).toBe(0)
  })

  it('rejects a read result whose effective URL is outside the authorized host', async () => {
    const harness = loadBrowserControlHarness((method) => {
      if (method !== 'Runtime.evaluate') return undefined
      return {
        result: {
          value: {
            authorized: true,
            title: 'Private',
            url: 'https://private.example/secrets',
            text: 'DO_NOT_RETURN_THIS_SECRET'
          }
        }
      }
    })

    await expect(harness.execute('read_page', { tabId: 7, expectedHost: 'trusted.example' }))
      .rejects.toThrow('已丢弃结果')
  })

  it('detects a cross-host navigation even when the tab returns before the post-check', async () => {
    const harness = loadBrowserControlHarness((method, _params, controls) => {
      if (method !== 'Runtime.evaluate') return undefined
      controls.state.url = 'https://private.example/secrets'
      controls.emitUpdated({ status: 'loading', url: controls.state.url })
      controls.state.url = 'https://trusted.example/account'
      controls.state.loaderId = 'loader-2'
      return {
        result: {
          value: {
            authorized: true,
            title: 'Trusted again',
            url: controls.state.url,
            text: 'DO_NOT_RETURN_TRANSIENT_TEXT'
          }
        }
      }
    })

    await expect(harness.execute('read_page', { tabId: 7, expectedHost: 'trusted.example' }))
      .rejects.toThrow('已丢弃结果')
  })

  it('discards captured pixels when the main-frame loader changes during capture', async () => {
    const harness = loadBrowserControlHarness((method, _params, controls) => {
      if (method !== 'Page.captureScreenshot') return undefined
      controls.state.loaderId = 'loader-after-navigation'
      return { data: 'DO_NOT_RETURN_THESE_PIXELS' }
    })

    await expect(harness.execute('screenshot', { tabId: 7, expectedHost: 'trusted.example' }))
      .rejects.toThrow('已丢弃结果')
  })

  it('checks the authorized host inside DOM mutation evaluation', async () => {
    let evaluatedExpression = ''
    const harness = loadBrowserControlHarness((method, params, controls) => {
      if (method !== 'Runtime.evaluate') return undefined
      evaluatedExpression = String(params.expression || '')
      // Simulate navigation in the narrow interval after the outer pre-check
      // and immediately before the page expression executes.
      controls.state.url = 'https://private.example/form'
      return { result: { value: { authorized: false } } }
    })

    await expect(harness.execute('fill', {
      tabId: 7,
      expectedHost: 'trusted.example',
      selector: '#password',
      value: 'must-not-cross-host'
    })).rejects.toThrow('已丢弃结果')
    expect(evaluatedExpression).toContain('location.hostname.toLowerCase()')
    expect(evaluatedExpression).toContain('trusted.example')
  })

  it('stops trusted click dispatch when the target changes after coordinate lookup', async () => {
    const harness = loadBrowserControlHarness((method, _params, controls) => {
      if (method !== 'Runtime.evaluate') return undefined
      controls.state.url = 'https://private.example/button'
      controls.emitUpdated({ status: 'loading', url: controls.state.url })
      return { result: { value: { authorized: true, found: true, x: 10, y: 20 } } }
    })

    await expect(harness.execute('click', {
      tabId: 7,
      expectedHost: 'trusted.example',
      selector: '#submit'
    })).rejects.toThrow('已丢弃结果')
    expect(harness.calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
  })
})
