/**
 * export_artifact 纯函数面（export-artifact-validate.ts）+ 三处登记契约。
 * execute 本体依赖 electron（dc-export.ts 的 BrowserWindow / dc-video-export.ts 的
 * debugger），node 环境不可直接 import pi-tools.ts（同 todos-tool.test.ts 的既有结论：
 * pi-tools.ts → web-search.ts → env.ts 顶层触达 electron `app` 单例会直接抛错）。
 * 这里锁住可被单测覆盖的两个契约面：
 *   ① 格式门槛 + 校验文本格式化的纯函数逻辑（export-artifact-validate.ts）
 *   ② 三处登记：pi-tools.ts 工具定义（本测试文件不验证，见冒烟脚本）/ role-manager COMMON_TOOLS /
 *      pi-security classifyToolRisk
 */
import { describe, it, expect } from 'vitest'
import {
  looksLikeAnimationDc,
  mp4FormatGateMessage,
  looksLikeDeckDc,
  pptxFormatGateMessage,
  isDcContent,
  handoffFormatGateMessage,
  projectZipFormatGateMessage,
  describeFileSize,
  formatMp4ValidationText,
  formatFileValidationText,
  formatPptxValidationText,
  formatHandoffValidationText
} from '../../src/main/export-artifact-validate'
import { classifyToolRisk } from '../../src/main/pi-security'
import { COMMON_TOOLS } from '../../src/main/role-manager'

describe('looksLikeAnimationDc / mp4FormatGateMessage（格式门槛）', () => {
  it('引用 animations.jsx 的产物判定为动画', () => {
    const c = '<x-import from="./animations.jsx ./artifact-scene1.jsx"></x-import>'
    expect(looksLikeAnimationDc(c)).toBe(true)
    expect(mp4FormatGateMessage(c)).toBeNull()
  })

  it('用 useSprite/useTime 的产物判定为动画', () => {
    expect(looksLikeAnimationDc('const x = useSprite(cfg)')).toBe(true)
    expect(looksLikeAnimationDc('const t = useTime()')).toBe(true)
  })

  it('定义 function Stage 的产物判定为动画', () => {
    expect(looksLikeAnimationDc('function Stage(props) { return null }')).toBe(true)
  })

  it('含 <Beat> 标签的产物判定为动画', () => {
    expect(looksLikeAnimationDc('<Beat at={0} />')).toBe(true)
  })

  it('普通静态 DC（无动画特征）→ 门闩拒绝，文案给出可选格式', () => {
    const c = '<!doctype html><html><x-dc></x-dc><script src="./support.js"></script></html>'
    expect(looksLikeAnimationDc(c)).toBe(false)
    const msg = mp4FormatGateMessage(c)
    expect(msg).toBeTruthy()
    expect(msg).toContain('不是动画')
    expect(msg).toContain('pdf')
    expect(msg).toContain('standalone-html')
    expect(msg).toContain('project-zip')
  })

  it('空字符串/纯文本内容 → 同样拒绝', () => {
    expect(mp4FormatGateMessage('')).toBeTruthy()
    expect(mp4FormatGateMessage('# 只是个 markdown 文档')).toBeTruthy()
  })
})

describe('looksLikeDeckDc / pptxFormatGateMessage（格式门槛）', () => {
  it('引用 deck-stage.js 的产物判定为 deck', () => {
    const c = '<x-import component-from-global-scope="deck-stage" from="./deck-stage.js" width="1920" height="1080"></x-import>'
    expect(looksLikeDeckDc(c)).toBe(true)
    expect(pptxFormatGateMessage(c)).toBeNull()
  })

  it('含字面量 <deck-stage> 标签的产物判定为 deck（手写兜底场景）', () => {
    expect(looksLikeDeckDc('<deck-stage width="1920" height="1080"></deck-stage>')).toBe(true)
  })

  it('普通静态 DC（无 deck 特征）→ 门闩拒绝，文案给出可选格式', () => {
    const c = '<!doctype html><html><x-dc></x-dc><script src="./support.js"></script></html>'
    expect(looksLikeDeckDc(c)).toBe(false)
    const msg = pptxFormatGateMessage(c)
    expect(msg).toBeTruthy()
    expect(msg).toContain('不是幻灯片')
    expect(msg).toContain('pdf')
    expect(msg).toContain('standalone-html')
    expect(msg).toContain('project-zip')
  })

  it('动画 dc（无 deck-stage 引用）→ 同样被 pptx 门闩拒绝', () => {
    const c = '<x-import from="./animations.jsx ./artifact-scene1.jsx"></x-import>'
    expect(looksLikeDeckDc(c)).toBe(false)
    expect(pptxFormatGateMessage(c)).toBeTruthy()
  })

  it('空字符串/纯文本内容 → 同样拒绝', () => {
    expect(pptxFormatGateMessage('')).toBeTruthy()
    expect(pptxFormatGateMessage('# 只是个 markdown 文档')).toBeTruthy()
  })
})

describe('isDcContent / handoffFormatGateMessage（handoff 格式门槛——所有 dc 无门槛，非 dc 拒绝）', () => {
  it('含 <x-dc> 标签的产物判定为 dc', () => {
    expect(isDcContent('<!doctype html><html><x-dc></x-dc></html>')).toBe(true)
  })

  it('deck dc → 放行（handoff 对所有 dc 类型都有效）', () => {
    const c = '<x-dc><x-import from="./deck-stage.js"></x-import></x-dc>'
    expect(handoffFormatGateMessage(c)).toBeNull()
  })

  it('动画 dc → 放行', () => {
    const c = '<x-dc><x-import from="./animations.jsx"></x-import></x-dc>'
    expect(handoffFormatGateMessage(c)).toBeNull()
  })

  it('静态 dc（无 deck/动画特征）→ 同样放行', () => {
    const c = '<x-dc><div>static content</div></x-dc>'
    expect(handoffFormatGateMessage(c)).toBeNull()
  })

  it('非 dc 内容（无 <x-dc> 标签）→ 拒绝，文案给出可选格式', () => {
    const msg = handoffFormatGateMessage('# 只是个 markdown 文档')
    expect(msg).toBeTruthy()
    expect(msg).toContain('不是')
    expect(msg).toContain('pdf')
    expect(msg).toContain('standalone-html')
    // 非 dc 时 project-zip 同样会被拒（projectZipFormatGateMessage），不得作为替代格式推荐
    expect(msg).not.toContain('project-zip')
  })

  it('空字符串 → 拒绝', () => {
    expect(handoffFormatGateMessage('')).toBeTruthy()
  })
})

describe('projectZipFormatGateMessage（project-zip 格式门槛——非 dc 产物拒绝，dc 放行）', () => {
  it('非 dc 内容（如裸 HTML 的 3D 物体产物，无 <x-dc> 标签）→ 拒绝，文案给出可选格式', () => {
    const c = '<!-- non-dc: 3d-object -->\n<!DOCTYPE html><html><body><three-d-stage></three-d-stage></body></html>'
    const msg = projectZipFormatGateMessage(c)
    expect(msg).toBeTruthy()
    expect(msg).toContain('不是')
    expect(msg).toContain('pdf')
    expect(msg).toContain('standalone-html')
  })

  it('含 <x-dc> 标签的产物 → 放行', () => {
    const c = '<!doctype html><html><x-dc></x-dc><script src="./support.js"></script></html>'
    expect(projectZipFormatGateMessage(c)).toBeNull()
  })

  it('空字符串 → 拒绝', () => {
    expect(projectZipFormatGateMessage('')).toBeTruthy()
  })
})

describe('formatHandoffValidationText（交接包校验文本）', () => {
  it('拼出「路径（N 张截图，M 个文件，大小）」，字段齐全供模型判断', () => {
    const text = formatHandoffValidationText(
      '/Users/x/.openpipal/outputs/handoff-demo.zip',
      { screenshotCount: 11, fileCount: 16 },
      Math.round(3.4 * 1024 * 1024)
    )
    expect(text).toBe('已导出交接包：/Users/x/.openpipal/outputs/handoff-demo.zip（11 张截图，16 个文件，3.4MB）')
  })

  it('门槛比通用文件高（10KB 内判异常）——几 KB 的"交接包"大概率是空包/坏导出', () => {
    const text = formatHandoffValidationText('/x/handoff-demo.zip', { screenshotCount: 1, fileCount: 3 }, 3 * 1024)
    expect(text).toContain('异常小')
  })

  it('正常体量不误报', () => {
    const text = formatHandoffValidationText('/x/handoff-demo.zip', { screenshotCount: 3, fileCount: 8 }, 200 * 1024)
    expect(text).not.toContain('异常小')
  })
})

describe('describeFileSize（文件大小校验）', () => {
  it('小于阈值 → suspicious=true，label 带异常提示', () => {
    const r = describeFileSize(200, 1024)
    expect(r.suspicious).toBe(true)
    expect(r.label).toContain('异常小')
    expect(r.label).toContain('200B')
  })

  it('等于阈值 → 不算异常（严格小于才算）', () => {
    const r = describeFileSize(1024, 1024)
    expect(r.suspicious).toBe(false)
  })

  it('正常大小（KB 级）→ 不异常，label 格式 x.xKB', () => {
    const r = describeFileSize(15 * 1024, 1024)
    expect(r.suspicious).toBe(false)
    expect(r.label).toBe('15.0KB')
  })

  it('正常大小（MB 级）→ label 格式 x.xMB', () => {
    const r = describeFileSize(14.2 * 1024 * 1024, 1024)
    expect(r.suspicious).toBe(false)
    expect(r.label).toBe('14.2MB')
  })
})

describe('formatMp4ValidationText（mp4 校验文本）', () => {
  it('拼出「路径（宽x高，时长s，帧数 帧，大小）」，字段齐全供模型判断', () => {
    const text = formatMp4ValidationText(
      '/Users/x/.openpipal/outputs/demo.mp4',
      { width: 1280, height: 720, durationSec: 48, frames: 1440 },
      Math.round(14.2 * 1024 * 1024)
    )
    expect(text).toBe('已导出 mp4：/Users/x/.openpipal/outputs/demo.mp4（1280x720，48.0s，1440 帧，14.2MB）')
  })

  it('mp4 门槛比通用文件高（10KB 内判异常）——几 KB 的"视频"大概率是坏导出', () => {
    const text = formatMp4ValidationText('/x/demo.mp4', { width: 1280, height: 720, durationSec: 1, frames: 30 }, 3 * 1024)
    expect(text).toContain('异常小')
  })

  it('时长格式化保留一位小数（非整数秒）', () => {
    const text = formatMp4ValidationText('/x/demo.mp4', { width: 640, height: 360, durationSec: 12.345, frames: 300 }, 500 * 1024)
    expect(text).toContain('12.3s')
  })
})

describe('formatPptxValidationText（pptx 校验文本）', () => {
  it('拼出「路径（N 页，宽x高，大小）」，字段齐全供模型判断', () => {
    const text = formatPptxValidationText(
      '/Users/x/.openpipal/outputs/demo.pptx',
      { pageCount: 11, width: 1920, height: 1080 },
      Math.round(2.2 * 1024 * 1024)
    )
    expect(text).toBe('已导出 pptx：/Users/x/.openpipal/outputs/demo.pptx（11 页，1920x1080，2.2MB）')
  })

  it('pptx 门槛比通用文件高（10KB 内判异常）——几 KB 的"pptx"大概率是空画布/坏帧', () => {
    const text = formatPptxValidationText('/x/demo.pptx', { pageCount: 1, width: 1920, height: 1080 }, 3 * 1024)
    expect(text).toContain('异常小')
  })

  it('正常体量不误报', () => {
    const text = formatPptxValidationText('/x/demo.pptx', { pageCount: 3, width: 1920, height: 1080 }, 500 * 1024)
    expect(text).not.toContain('异常小')
  })
})

describe('formatFileValidationText（pdf/html/zip 共用校验文本）', () => {
  it('拼出「已导出 <格式>：路径（大小）」', () => {
    const text = formatFileValidationText('pdf', '/x/doc.pdf', 200 * 1024)
    expect(text).toBe('已导出 pdf：/x/doc.pdf（200.0KB）')
  })

  it('异常小文件标出可疑', () => {
    const text = formatFileValidationText('standalone-html', '/x/demo.html', 100)
    expect(text).toContain('异常小')
  })

  it('pdf 阈值 5KB：空白页 printToPDF 体量（~1KB，真机实测动画壳误导出 pdf 为 1026B）必须被标可疑', () => {
    const text = formatFileValidationText('pdf', '/x/blank.pdf', 1026)
    expect(text).toContain('异常小')
  })

  it('pdf 正常体量（>5KB）不误报', () => {
    const text = formatFileValidationText('pdf', '/x/real.pdf', 60 * 1024)
    expect(text).not.toContain('异常小')
  })
})

describe('三处登记：role-manager / pi-security', () => {
  it('② COMMON_TOOLS 白名单含 export_artifact（否则 AI 收不到工具 schema）', () => {
    expect(COMMON_TOOLS).toContain('export_artifact')
  })

  it('③ classifyToolRisk(export_artifact) → safe（否则走确认弹窗把 IPC 卡住）', () => {
    const r = classifyToolRisk('export_artifact', { id: 'artifact-123', format: 'pdf' })
    expect(r.level).toBe('safe')
  })
})
