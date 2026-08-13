/**
 * 盲区回归锁：渲染层 **非 .tsx** 文件里的用户可见中文。
 *
 * 现有 i18n 回归测试都是"读某个 .tsx 源码找已知中文字面量"的黑名单式写法，
 * 结构上看不见 hooks/*.ts、utils/*.ts 里的文案——useLocalSTT 的四条错误提示
 * 就是这样漏到英文界面的（经 OrbView 的 title 直接显示给用户）。
 *
 * 这里改成扫描式：凡是把中文字面量塞进错误态 setter 的，一律拦下。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'

const RENDERER_ROOT = resolve('src/renderer/src')
const CJK = /[一-鿿]/

function collect(dir: string, ext: RegExp, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, ext, acc)
    else if (ext.test(entry)) acc.push(full)
  }
  return acc
}

/** 去掉行注释与块注释——注释里的中文是说明，不是文案 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('渲染层非 tsx 文件的用户可见文案', () => {
  it('错误态 setter 里不得出现中文字面量', () => {
    const offenders: string[] = []
    const files = collect(RENDERER_ROOT, /\.ts$/).filter(f => !f.endsWith('.d.ts'))
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'))
      // setError('…') / setErrorMsg("…") / setXxxError(a || '…')
      for (const match of source.matchAll(/set[A-Za-z]*(?:Error|ErrorMsg|Message)\s*\(([^)]*)\)/g)) {
        for (const literal of match[1].matchAll(/'([^']*)'|"([^"]*)"/g)) {
          const text = literal[1] ?? literal[2] ?? ''
          if (CJK.test(text)) offenders.push(`${relative(RENDERER_ROOT, file)}: ${text}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('useLocalSTT 的四条提示走 i18n，且两种语言都能解析', async () => {
    const source = readFileSync(join(RENDERER_ROOT, 'hooks/useLocalSTT.ts'), 'utf8')
    const keys = [
      'speech.errors.startFailed',
      'speech.errors.noAudio',
      'speech.errors.transcribeFailed',
      'speech.errors.ipcFailed'
    ]
    for (const key of keys) expect(source).toContain(`t('${key}')`)

    const en = await createRendererI18n('en')
    for (const key of keys) {
      expect(en.t(key)).not.toBe(key)
      expect(CJK.test(en.t(key))).toBe(false)
    }
    await en.changeLanguage('zh-CN')
    for (const key of keys) expect(en.t(key)).not.toBe(key)
  })
})
