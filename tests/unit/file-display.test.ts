/**
 * 长期档案路径 → 面向用户的说法。
 * 覆盖：①教学风格三段路径 ②序号/扩展名剥离 ③风格/SKILL/README 别名 ④资产库散文件不算档案
 * ⑤记忆目录 feedback_ 前缀剥离 ⑥普通路径返回 null（走原通用文件行）
 */
import { describe, it, expect } from 'vitest'
import {
  describeFilePath,
  prettyDocName,
  resolveFileDisplayLabel,
} from '../../src/renderer/src/chat/fileDisplay'
import { createRendererI18n } from '../../src/renderer/src/i18n'

const SYS = '/Users/u/.openpipal/workspace/assets/teacher/小学语文'

describe('prettyDocName', () => {
  it('剥掉序号前缀与扩展名', () => {
    expect(prettyDocName('01-硬约束.md')).toEqual({ raw: '硬约束' })
    expect(prettyDocName('02-版式.md')).toEqual({ raw: '版式' })
    expect(prettyDocName('公开课要求.md')).toEqual({ raw: '公开课要求' })
  })
  it('风格主文件与旧 SKILL/README 返回稳定别名 key，渲染时再按语言解析', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')
    const style = prettyDocName('风格.md')
    const skill = prettyDocName('SKILL.md')
    const readme = prettyDocName('README.md')

    expect(style).toEqual({ raw: '风格', translationKey: 'chat.fileDisplay.aliases.styleOverview' })
    expect(skill).toEqual({ raw: 'SKILL', translationKey: 'chat.fileDisplay.aliases.archiveOverview' })
    expect(readme).toEqual({ raw: 'README', translationKey: 'chat.fileDisplay.aliases.description' })
    expect(resolveFileDisplayLabel(style, english.t)).toBe('Style overview')
    expect(resolveFileDisplayLabel(style, chinese.t)).toBe('风格概览')
    expect(resolveFileDisplayLabel(skill, english.t)).toBe('Archive overview')
    expect(resolveFileDisplayLabel(readme, english.t)).toBe('About')
  })
  it('无扩展名照原样；剥到空串时回落原文件名', () => {
    expect(prettyDocName('惯用做法')).toEqual({ raw: '惯用做法' })
    expect(prettyDocName('01.md')).toEqual({ raw: '01' }) // 没有分隔符就不算序号前缀
    expect(prettyDocName('01-.md')).toEqual({ raw: '01-.md' }) // 剥完是空的，宁可露文件名也不给空行
  })
})

describe('describeFilePath · 教学系统', () => {
  it('系统名取 assets/<role>/<系统名>，文档名去序号去扩展名', () => {
    const info = describeFilePath(`${SYS}/01-硬约束.md`)
    expect(info).toMatchObject({ scope: 'role-system', groupName: '小学语文', docName: { raw: '硬约束' } })
  })
  it('同一系统下不同文件共享聚合键（含子目录）', () => {
    const a = describeFilePath(`${SYS}/风格.md`)
    const b = describeFilePath(`${SYS}/refs/README.md`)
    expect(a!.groupKey).toBe(b!.groupKey)
    expect(b!.docName).toEqual({ raw: 'README', translationKey: 'chat.fileDisplay.aliases.description' })
  })
  it('不同系统不共享聚合键', () => {
    const a = describeFilePath(`${SYS}/风格.md`)
    const b = describeFilePath('/Users/u/.openpipal/workspace/assets/teacher/初中物理/风格.md')
    expect(a!.groupKey).not.toBe(b!.groupKey)
  })
  it('资产库根下的散文件不是档案（备课资料照片等）', () => {
    expect(describeFilePath('/Users/u/.openpipal/workspace/assets/teacher/模板照片.png')).toBeNull()
  })
})

describe('describeFilePath · 记忆与兜底', () => {
  it('记忆文件剥掉 feedback_ 前缀', () => {
    const info = describeFilePath('/Users/u/.openpipal/memory/feedback_教学PPT制作规范.md')
    expect(info).toMatchObject({ scope: 'memory', groupName: '', docName: { raw: '教学PPT制作规范' } })
  })
  it('普通路径返回 null，走原来的通用文件行', () => {
    expect(describeFilePath('/Users/u/code/app/src/index.ts')).toBeNull()
    expect(describeFilePath('')).toBeNull()
    expect(describeFilePath(null)).toBeNull()
  })
})
