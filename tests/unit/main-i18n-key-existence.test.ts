import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import * as path from 'path'
import { APP_I18N_RESOURCES } from '../../src/shared/i18n/resources'

/**
 * Main 进程的 tMain()/mainError() 只吃字符串字面量，TypeScript 管不到 key 是否存在——
 * 写错一个字母就会把 key 原样渲染到用户界面。这里做静态兜底：
 * 把 Main 里所有字面量 key 抽出来，两个语言目录都必须能解析成字符串。
 */
const MAIN_DIR = path.resolve(__dirname, '../../src/main')
const KEY_CALL = /\b(?:tMain|mainError)\(\s*'([^']+)'/g

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

function resolveKey(locale: 'zh-CN' | 'en', key: string): unknown {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[segment]
  }, APP_I18N_RESOURCES[locale])
}

describe('main-process i18n keys', () => {
  const usages = walk(MAIN_DIR).flatMap(file =>
    [...readFileSync(file, 'utf-8').matchAll(KEY_CALL)].map(m => ({
      file: path.relative(MAIN_DIR, file),
      key: m[1]
    }))
  )

  it('finds the literal key call sites it is meant to guard', () => {
    expect(usages.length).toBeGreaterThan(50)
  })

  it.each(['zh-CN', 'en'] as const)('resolves every Main key in %s', locale => {
    const broken = usages.filter(u => typeof resolveKey(locale, u.key) !== 'string')
    expect(broken.map(u => `${u.file}: ${u.key}`)).toEqual([])
  })
})
