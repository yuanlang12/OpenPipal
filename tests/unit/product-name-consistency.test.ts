import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'
import { trackedFiles } from '../helpers/tracked-files'

/**
 * 产品名一致性。
 *
 * 改名当天全仓是干净的；漂移都是后来一点点渗进来的——有人写 `Openpipal`，
 * 有人从旧代码里拷来一段 `sidewise`，半年后仓库里就同时住着四五种写法。
 * 与其靠纪律，不如让 CI 直接拦住。
 *
 * 定死两种形态：展示名 `OpenPipal`，标识符 `openpipal`（npm 包名强制小写，
 * 反向域名 appId、数据目录、仓库名同理）。常量与环境变量用 `OPENPIPAL_`。
 */
const REPO = path.resolve(__dirname, '../..')
const BINARY = /\.(png|jpe?g|gif|icns|ico|woff2?|ttf|wasm|zip|pdf|mp4|webp)$/i

/** 只有这三种写法合法；其余大小写组合一律视为漂移 */
const ALLOWED = new Set(['OpenPipal', 'openpipal', 'OPENPIPAL'])
const ANY_FORM = /[Oo][Pp][Ee][Nn][Pp][Ii][Pp][Aa][Ll]/g
const OLD_NAME = /sidewise/gi

/** 本文件必须点名那些被禁的写法，否则规则没法表达；其余文件想留旧名要逐行标记豁免 */
const SELF = 'tests/unit/product-name-consistency.test.ts'
const EXEMPT_MARKER = 'product-name-exempt'

function trackedTextFiles(): string[] {
  return trackedFiles(REPO).filter(f => f !== SELF && !BINARY.test(f))
}

/** 去掉标了豁免的行再检查 */
function checkable(source: string): string {
  return source
    .split('\n')
    .filter(line => !line.includes(EXEMPT_MARKER))
    .join('\n')
}

function read(file: string): string | null {
  try {
    return readFileSync(path.join(REPO, file), 'utf-8')
  } catch {
    return null // 二进制或已删除
  }
}

describe('product name', () => {
  const files = trackedTextFiles()

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('never drifts into another capitalization', () => {
    const drift = files.flatMap(file => {
      const source = read(file)
      if (source === null) return []
      return [...checkable(source).matchAll(ANY_FORM)]
        .map(m => m[0])
        .filter(form => !ALLOWED.has(form))
        .map(form => `${file}: ${form}`)
    })
    expect([...new Set(drift)]).toEqual([])
  })

  it('carries no leftover of the previous product name', () => {
    const leftovers = files.flatMap(file => {
      const source = read(file)
      if (source === null) return []
      return checkable(source).match(OLD_NAME) ? [file] : []
    })
    expect(leftovers).toEqual([])
  })

  it('keeps every path free of the previous product name', () => {
    expect(files.filter(f => OLD_NAME.test(f))).toEqual([])
  })
})
