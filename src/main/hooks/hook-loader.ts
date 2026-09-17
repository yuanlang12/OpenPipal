/**
 * 把一个 hook 文件（TS / JS）编译并求值成 LoadedHook。
 *
 * 编译走随包的 esbuild（artifact-store / ds-compile 同款 require 写法，asar 已 unpack，
 * 装机版的二进制路径由 env.ts 指到 unpacked 真实文件——1.1.2 实撞 `spawn ENOTDIR`，见那里的注释；
 * 修后用 scripts/qa/packaged-esbuild-probe.mjs 在装机版主进程里验过）；
 * 不用 jiti——它要写编译缓存目录，asar 内没地方写。
 *
 * 本阶段 hook 里**不能 import 任何值模块**：`require` 一律抛清楚的错。类型 import 会被
 * esbuild 擦掉，不受影响。给 hook 文件/进程能力是下一阶段「能力对象」的事——那层要经
 * pi-security 与沙箱，不能在这里用裸 node 抢跑。`importResolver` 参数就是给那一阶段留的口。
 */
import { readFileSync } from 'fs'
import { basename, dirname, extname } from 'path'
import { compileFunction } from 'vm'
import {
  HOOK_EVENT_NAMES,
  type HookAPI,
  type HookEventName,
  type HookFactory,
  type HookHandler,
  type HookLoadResult,
  type LoadedHook
} from './hook-types'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadEsbuild = (): typeof import('esbuild') => require('esbuild')

const FACTORY_TIMEOUT_MS = 5_000
const DESCRIPTION_MAX = 120

export interface LoadHookFileOptions {
  /** 下一阶段的能力对象注入口：返回 undefined 表示不认识这个模块名 */
  importResolver?: (specifier: string) => unknown
}

export function hookIdFor(pluginName: string, file: string): string {
  return `${pluginName}/${basename(file, extname(file))}`
}

function esbuildLoader(file: string): 'ts' | 'js' {
  return extname(file).toLowerCase() === '.ts' ? 'ts' : 'js'
}

function formatCompileError(error: unknown): string {
  const errors = (error as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } | null }> })?.errors
  const first = errors?.[0]
  if (first?.text) {
    const loc = first.location
    return loc?.line ? `第 ${loc.line} 行：${first.text}` : first.text
  }
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 还没完成`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 编译 + 求值 + 收集 handler。任何一步失败都返回带原因的 failure，绝不抛出 */
export async function loadHookFile(
  file: string,
  pluginName: string,
  options?: LoadHookFileOptions
): Promise<HookLoadResult> {
  const id = hookIdFor(pluginName, file)
  const fail = (error: string): HookLoadResult => ({ ok: false, failure: { id, pluginName, file, error } })

  let source: string
  try {
    source = readFileSync(file, 'utf-8')
  } catch (error) {
    return fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let code: string
  try {
    code = loadEsbuild().transformSync(source, {
      loader: esbuildLoader(file),
      format: 'cjs',
      target: 'node20',
      sourcefile: file,
      logLevel: 'silent'
    }).code
  } catch (error) {
    return fail(`编译失败：${formatCompileError(error)}`)
  }

  const module: { exports: Record<string, unknown> | HookFactory } = { exports: {} }
  const restrictedRequire = (specifier: string): unknown => {
    const resolved = options?.importResolver?.(specifier)
    if (resolved !== undefined) return resolved
    throw new Error(`hook 里暂时不能 import「${specifier}」——现在只支持纯逻辑（字符串、正则、判断）；类型 import（import type）不受影响`)
  }
  try {
    const wrapper = compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file })
    wrapper(module.exports, restrictedRequire, module, file, dirname(file))
  } catch (error) {
    return fail(`执行失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const exported = module.exports
  const factory: unknown = typeof exported === 'function'
    ? exported
    : (exported as Record<string, unknown>).default
  if (typeof factory !== 'function') {
    return fail('没有导出默认函数：文件里需要 `export default function (hook) { ... }`')
  }

  const rawDescription = typeof exported === 'function' ? undefined : (exported as Record<string, unknown>).description
  const description = typeof rawDescription === 'string' && rawDescription.trim()
    ? rawDescription.trim().slice(0, DESCRIPTION_MAX)
    : basename(file, extname(file))

  const handlers: LoadedHook['handlers'] = { tool_call: [], tool_result: [], before_agent_start: [], agent_end: [] }
  let registrationError: string | undefined
  const api: HookAPI = {
    on(event, handler) {
      if (!HOOK_EVENT_NAMES.includes(event as HookEventName)) {
        registrationError ??= `不认识的事件「${String(event)}」，可用：${HOOK_EVENT_NAMES.join(' / ')}`
        return
      }
      if (typeof handler !== 'function') {
        registrationError ??= `事件「${event}」的处理函数不是函数`
        return
      }
      ;(handlers[event] as HookHandler<typeof event>[]).push(handler)
    }
  }

  try {
    await withTimeout(Promise.resolve((factory as HookFactory)(api)), FACTORY_TIMEOUT_MS, '初始化')
  } catch (error) {
    return fail(`初始化失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (registrationError) return fail(registrationError)
  if (HOOK_EVENT_NAMES.every((name) => handlers[name].length === 0)) {
    return fail('没有注册任何事件：初始化函数里要调用 hook.on(...)')
  }

  return { ok: true, hook: { id, pluginName, file, description, handlers } }
}
