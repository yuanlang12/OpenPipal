/**
 * PPTX 演讲备注（deck-stage 规格 Q2 的 (c)，2026-08-17 从"只读不外发"改判）。
 *
 * 断言的是 **OOXML 树的形状**而不是最终 zip：assemblePptxZip 打完包后 ooxmlDir 仍在原地，
 * 直接读目录比解压再读少一层依赖，且断言更精确（能逐个 part 看关系指向）。
 *
 * 两条不变量并重：
 *   1. 有备注时，notes 子树完整且关系闭环（slide → notesSlide → notesMaster + slide）；
 *   2. **一页备注都没有时，整棵 notes 子树不存在**——这条是回归护栏：备注功能不能改变
 *      不写备注的存量产物的字节形状（PPTX 解析器对多余 part 的容忍度各家不同）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const { assemblePptxZip } = await import('../../src/main/dc-pptx-export')

/** 1×1 透明 PNG——组装器只做 copyFileSync，内容不参与断言 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

function makeTree(notes: string[]): { dir: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-pptx-notes-'))
  const dir = path.join(root, 'ooxml')
  fs.mkdirSync(dir, { recursive: true })
  return { dir, out: path.join(root, 'out.pptx') }
}

function pngs(root: string, n: number): string[] {
  const dir = path.join(root, 'frames')
  fs.mkdirSync(dir, { recursive: true })
  return Array.from({ length: n }, (_, i) => {
    const p = path.join(dir, `f${i + 1}.png`)
    fs.writeFileSync(p, PNG_1PX)
    return p
  })
}

const read = (dir: string, ...seg: string[]) => fs.readFileSync(path.join(dir, ...seg), 'utf8')
const has = (dir: string, ...seg: string[]) => fs.existsSync(path.join(dir, ...seg))

describe('PPTX 演讲备注', () => {
  it('只给有备注的页建 notesSlide，关系闭环且文本被转义', async () => {
    const { dir, out } = makeTree([])
    const frames = pngs(path.dirname(dir), 3)
    // 第 2 页有备注（含需转义字符与换行），第 1、3 页没有
    await assemblePptxZip(dir, frames, 1920, 1080, out, ['', '开场白 <重点> & 停顿\n第二段', '   '])

    // notesSlide 只为第 2 页而建
    expect(has(dir, 'ppt', 'notesSlides', 'notesSlide2.xml')).toBe(true)
    expect(has(dir, 'ppt', 'notesSlides', 'notesSlide1.xml')).toBe(false)
    expect(has(dir, 'ppt', 'notesSlides', 'notesSlide3.xml')).toBe(false) // 纯空白视为没写

    // 文本转义 + 换行拆成两个段落
    const note = read(dir, 'ppt', 'notesSlides', 'notesSlide2.xml')
    expect(note).toContain('开场白 &lt;重点&gt; &amp; 停顿')
    expect(note).toContain('第二段')
    expect(note).not.toContain('<重点>')
    expect((note.match(/<a:p>/g) || []).length).toBe(2)

    // 关系闭环：slide2 → notesSlide2 → (notesMaster + slide2)
    expect(read(dir, 'ppt', 'slides', '_rels', 'slide2.xml.rels')).toContain('../notesSlides/notesSlide2.xml')
    expect(read(dir, 'ppt', 'slides', '_rels', 'slide1.xml.rels')).not.toContain('notesSlide')
    const nrels = read(dir, 'ppt', 'notesSlides', '_rels', 'notesSlide2.xml.rels')
    expect(nrels).toContain('../notesMasters/notesMaster1.xml')
    expect(nrels).toContain('../slides/slide2.xml')

    // notesMaster 及其专属 theme 在场，且被 presentation 登记
    expect(has(dir, 'ppt', 'notesMasters', 'notesMaster1.xml')).toBe(true)
    expect(has(dir, 'ppt', 'theme', 'theme2.xml')).toBe(true)
    expect(read(dir, 'ppt', 'notesMasters', '_rels', 'notesMaster1.xml.rels')).toContain('../theme/theme2.xml')

    const pres = read(dir, 'ppt', 'presentation.xml')
    expect(pres).toContain('<p:notesMasterIdLst>')
    // schema 要求 notesMasterIdLst 排在 sldIdLst 之前
    expect(pres.indexOf('notesMasterIdLst')).toBeLessThan(pres.indexOf('sldIdLst'))
    // 关系 id 接在 3 页幻灯片之后（rId1=master，rId2..4=slides，rId5=notesMaster）
    expect(pres).toContain('<p:notesMasterId r:id="rId5"/>')
    expect(read(dir, 'ppt', '_rels', 'presentation.xml.rels')).toContain(
      'Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster"'
    )

    // 内容类型登记齐全
    const ct = read(dir, '[Content_Types].xml')
    expect(ct).toContain('/ppt/notesSlides/notesSlide2.xml')
    expect(ct).toContain('/ppt/notesMasters/notesMaster1.xml')
    expect(ct).toContain('/ppt/theme/theme2.xml')
    expect(ct).not.toContain('/ppt/notesSlides/notesSlide1.xml')
  })

  it('一页备注都没有时整棵 notes 子树不存在（存量产物形状不变）', async () => {
    const { dir, out } = makeTree([])
    const frames = pngs(path.dirname(dir), 2)
    await assemblePptxZip(dir, frames, 1920, 1080, out, ['', ''])

    expect(has(dir, 'ppt', 'notesSlides')).toBe(false)
    expect(has(dir, 'ppt', 'notesMasters')).toBe(false)
    expect(has(dir, 'ppt', 'theme', 'theme2.xml')).toBe(false)
    expect(read(dir, 'ppt', 'presentation.xml')).not.toContain('notesMasterIdLst')
    expect(read(dir, 'ppt', '_rels', 'presentation.xml.rels')).not.toContain('notesMaster')
    expect(read(dir, 'ppt', 'slides', '_rels', 'slide1.xml.rels')).not.toContain('notesSlide')
    expect(read(dir, '[Content_Types].xml')).not.toContain('notesSlide')
  })

  it('不传 slideNotes 时与不写备注等价（默认参数不改变既有调用方行为）', async () => {
    const { dir, out } = makeTree([])
    const frames = pngs(path.dirname(dir), 1)
    await assemblePptxZip(dir, frames, 1280, 720, out)
    expect(has(dir, 'ppt', 'notesSlides')).toBe(false)
    expect(read(dir, 'ppt', 'presentation.xml')).not.toContain('notesMasterIdLst')
  })
})
