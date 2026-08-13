import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'
import { trackedFiles } from '../helpers/tracked-files'

/**
 * Tailwind 尺寸类必须真的存在。
 *
 * 起因：自动记忆开关写成 `w-10 h-5.5` + 滑块 `w-4.5 h-4.5`。Tailwind 默认间距刻度
 * 只有 0.5 / 1.5 / 2.5 / 3.5，没有 4.5 和 5.5——类名不生成任何 CSS，轨道高度塌成 0，
 * **整个开关在界面上彻底消失**。没有报错、没有警告，构建照样绿。
 *
 * 这类错误肉眼审不出来（`h-5.5` 和 `h-3.5` 长得一样合法），只能靠机制拦。
 */
const REPO = path.resolve(__dirname, '../..')

/** Tailwind 默认 spacing 里带小数的只有这四档 */
const VALID_FRACTIONS = new Set(['0.5', '1.5', '2.5', '3.5'])

/** w- / h- / p- / m- / gap- 等吃 spacing 刻度的前缀 */
const FRACTIONAL_UTILITY =
  /\b(?:-?(?:w|h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|inset|top|bottom|left|right|translate-x|translate-y|size)-)(\d+\.\d+)\b/g

function rendererSources(): string[] {
  return trackedFiles(REPO, 'src/renderer').filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
}

describe('tailwind spacing classes', () => {
  it('uses only fractions that exist in the default scale', () => {
    const offenders = rendererSources().flatMap(file => {
      const source = readFileSync(path.join(REPO, file), 'utf-8')
      return source.split('\n').flatMap((line, index) =>
        [...line.matchAll(FRACTIONAL_UTILITY)]
          .filter(m => !VALID_FRACTIONS.has(m[1]))
          .map(m => `${file}:${index + 1} ${m[0]}`)
      )
    })
    expect(offenders).toEqual([])
  })
})
