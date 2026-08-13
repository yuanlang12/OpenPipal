import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'

/**
 * Main 进程里"会被渲染层原样显示给用户"的失败文案已经全部走 errorKey / tMain。
 *
 * 这里锁的是已清理过的文件：它们的 error / invalid / warnings / skip 位置上
 * 不允许再出现中文字面量——否则英文界面会突然冒出一句中文。
 *
 * 名单是白名单式的：新文件要不要进来由人判断（模型可见的工具结果、日志、
 * 给 Agent 的提示词都不该进来——那些不能跟 UI 语言绑定）。
 */
const LOCALIZED_MAIN_FILES = [
  'skill-import.ts',
  'plugin-import.ts',
  'plugin-manager.ts',
  'whisper-stt.ts',
  'realtime-session.ts',
  'doubao-duplex-session.ts',
  'dc-export.ts',
  'dc-pptx-export.ts',
  'dc-video-export.ts',
  'dc-handoff-export.ts',
  'mcp-oauth.ts'
]

/** 只看"会变成用户可见文案"的位置，不看注释、日志和模型侧字符串 */
const USER_FACING_SLOT =
  /(?:\berror:|\binvalid:|\breason:|warnings(?:\.push\(|: \[)|\bskip\(|throw new Error\()[^\n]*/g
const HAS_CHINESE = /[一-龥]/
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/
/** 上一行标了豁免的，是模型侧文案（工具结果 / 提示词），故意不跟 UI 语言走 */
const EXEMPT_MARKER = 'i18n-exempt'

/** 去掉行尾注释——注释里的中文不会进界面 */
function stripTrailingComment(line: string): string {
  const at = line.indexOf('//')
  return at === -1 ? line : line.slice(0, at)
}

describe('main-process user-facing copy', () => {
  it.each(LOCALIZED_MAIN_FILES)('%s keeps no raw Chinese in user-facing slots', file => {
    const source = readFileSync(path.resolve(__dirname, '../../src/main', file), 'utf-8')
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line, lineNumber }) =>
        !COMMENT_LINE.test(line) && !(source.split('\n')[lineNumber - 2] || '').includes(EXEMPT_MARKER)
      )
      .flatMap(({ line, lineNumber }) =>
        (stripTrailingComment(line).match(USER_FACING_SLOT) || [])
          .filter(slot => HAS_CHINESE.test(slot))
          .map(slot => `${file}:${lineNumber} ${slot.trim()}`)
      )
    expect(offenders).toEqual([])
  })
})
