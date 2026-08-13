/**
 * 契约锁：暗色下背景/描边必须落在低档位，且不许留「与基类逐字节相同」的 dark: 空对。
 *
 * 背景：deriveSurfaceScale 在暗色下 0 档是画布、700 档是正文，所以
 *   - 背景/描边写 dark:*-surface-{500..900} 会刷出接近正文色的一块（历史坑）
 *   - 而重映射之后 dark:X 常常和基类完全相同，那是纯噪音：它宣称此处有明暗决策，
 *     实际没有，下一个改配色的人得自己去令牌表里反推，而且很容易只改一边。
 *
 * 这两条以前只写在 docs/claude/known-limitations.md 的散文里，散文管不住新代码。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) tsxFiles(p, acc)
    else if (p.endsWith('.tsx')) acc.push(p)
  }
  return acc
}

const FILES = tsxFiles('src/renderer/src')
const CLASS_STRING = /(["'`])((?:[^"'`\\]|\\.)*?)\1/gs
const TOKEN = /(?<![\w:-])((?:[a-z-]+:)*)((?:bg|border|divide)-surface-(\d+)(?:\/\[?[\d.]+\]?)?)/g

describe('暗色 surface 阶', () => {
  it('浅色在低档位时，暗色不许跳到高档位（那是「以为阶会翻转」的经典写法）', () => {
    // 规则刻意只针对这个 bug 形态,而不是「暗色一律不许用高档位」:
    // 设备外框、反相高对比按钮这类**故意的反相面**本来就该拿 ink 档位当背景,
    // 它们的浅色搭档同样在高档位,一眼可辨,不该被规则误伤。
    const offenders: string[] = []
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8')
      for (const cs of src.matchAll(CLASS_STRING)) {
        const body = cs[2]
        if (!body.includes('dark:')) continue
        const base = new Map<string, number>()
        for (const t of body.matchAll(TOKEN)) {
          if (t[1].startsWith('dark:')) continue
          base.set(`${t[1]}|${t[2].split('-surface-')[0]}`, Number(t[3]))
        }
        for (const t of body.matchAll(TOKEN)) {
          if (!t[1].startsWith('dark:')) continue
          const light = base.get(`${t[1].slice(5)}|${t[2].split('-surface-')[0]}`)
          if (light !== undefined && light < 500 && Number(t[3]) >= 500) {
            offenders.push(`${file}: ${t[0].trim()} (浅色搭档在 ${light} 档)`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('不许出现与基类完全相同的 dark: 变体（空操作，只会误导读者）', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8')
      for (const cs of src.matchAll(CLASS_STRING)) {
        const body = cs[2]
        if (!body.includes('dark:')) continue
        const base = new Map<string, string>()
        for (const t of body.matchAll(TOKEN)) {
          if (t[1].startsWith('dark:')) continue
          base.set(`${t[1]}|${t[2].split('-surface-')[0]}`, t[2])
        }
        for (const t of body.matchAll(TOKEN)) {
          if (!t[1].startsWith('dark:')) continue
          const key = `${t[1].slice(5)}|${t[2].split('-surface-')[0]}`
          if (base.get(key) === t[2]) offenders.push(`${file}: ${t[0].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
