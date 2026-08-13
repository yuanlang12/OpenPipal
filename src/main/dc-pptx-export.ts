/**
 * DC 幻灯片（deck）导出 PPTX（截图版）—— 对齐官方 Claude Design 的 "Export as PPTX (screenshots)"：
 * 每页一张整幅截图的 .pptx，像素级还原、不可编辑。
 *
 * 核心机制：resources/dc-runtime/deck-stage.js 的 <deck-stage> 组件已经内置了导出协议——
 * `noscale` 属性关闭内部 transform:scale() 缩放（改用作者尺寸的裸几何，见该文件 `_fit()` 里
 * "PPTX exporter sets noscale..." 的注释——这是它专门为本导出器预留的钩子），配合向 window
 * postMessage `{__omelette_presenting:true}` 进入"演示模式"（隐藏 prev/next 覆层、缩略图侧栏、
 * 右键菜单），真机验证（2026-07-09）两者叠加后活动幻灯片的 getBoundingClientRect() 恰好等于
 * `{x:0,y:0,width:designWidth,height:designHeight}`——不需要 mp4 导出器那种 autofit 收敛轮询。
 * 翻页用组件的公开 API `deckEl.goTo(i)`（0-based），每次翻页后 `slidechange` CustomEvent 佐证
 * 导航生效；跳过的幻灯片（data-deck-skip，用户在缩略图侧栏右键 Skip）与 PDF/print 路线保持
 * 一致——不出现在导出结果里。
 *
 * 舞台真实尺寸同样以 DOM 为唯一真值：`deckEl.designWidth`/`designHeight` 是组件从 width/height
 * 属性解析出的数字 getter（源自 <x-import ... width="1920" height="1080">），不是对 content
 * 做正则猜测。
 *
 * 装配复用 dc-export.ts 的 assembleOfflineDc（headless 内联 + React vendor 内联，断网可开）；
 * 隐藏窗口 + CDP 截图管线复用 dc-capture.ts（与 dc-video-export.ts 共用同一套原语，逐行同源）。
 *
 * OOXML 组装：临时目录手写 [Content_Types].xml / _rels / ppt/presentation.xml /
 * slideMaster(1) / slideLayout(1，blank) / theme(1) / slides(N，每页一个铺满的 <p:pic>) +
 * media 图片，用系统 `/usr/bin/zip` 打包（模式照抄 dc-export.ts exportZip，不引入 npm 依赖）。
 * 这套最小结构在开发期用 python-pptx 生成参考件解包验证过字段完整性，并用真实 zip 包过
 * python-pptx round-trip 解析 + macOS `qlmanage` 缩略图渲染验证（证明是可被真实实现解析的
 * 合法 OOXML，不是"编译通过但打不开"的臆造结构）。EMU 换算：96dpi 下 1px = 9525 EMU。
 */
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { assembleOfflineDc, sanitizeName } from './dc-export'
import { evalChecked, pollUntil, hideScrollbarsAndOverflow, setDeviceMetricsOverride, clipFromRect } from './dc-capture'
import { mainError, tMain } from './main-i18n'
import { dataPath } from './data-root'

const execFileAsync = promisify(execFile)
const OUTPUTS_ROOT = dataPath('outputs')
const EMU_PER_PX = 9525

export interface PptxExportResult {
  ok: boolean
  path?: string
  error?: string
  pageCount?: number
  width?: number
  height?: number
}

const DECK_SELECTOR = "document.querySelector('deck-stage')"

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** [Content_Types].xml —— Default(rels/xml/png) + Override 每个固定 part 与每页 slideN.xml。 */
function buildContentTypes(pageCount: number): string {
  const slideOverrides = Array.from({ length: pageCount }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides}
</Types>`
}

function buildPackageRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
}

function buildPresentationXml(pageCount: number, widthEmu: number, heightEmu: number): string {
  const sldIds = Array.from({ length: pageCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${2 + i}"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${sldIds}</p:sldIdLst>
<p:sldSz cx="${widthEmu}" cy="${heightEmu}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`
}

function buildPresentationRels(pageCount: number): string {
  const slideRels = Array.from({ length: pageCount }, (_, i) =>
    `<Relationship Id="rId${2 + i}" Type="${NS_R}/slide" Target="slides/slide${i + 1}.xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
<Relationship Id="rId1" Type="${NS_R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRels}
</Relationships>`
}

function buildSlideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`
}

function buildSlideMasterRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
<Relationship Id="rId1" Type="${NS_R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${NS_R}/theme" Target="../theme/theme1.xml"/>
</Relationships>`
}

function buildSlideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`
}

function buildSlideLayoutRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
<Relationship Id="rId1" Type="${NS_R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`
}

/** 最小但字段完整的 DrawingML 主题（clrScheme 12 色槽 + fontScheme + fmtScheme 三套各 3 档）——
 *  PowerPoint 的 schema 要求这三段齐全，随手删减会让文件在真实实现里判定为"需要修复"。 */
function buildThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OpenPipal PPTX Export">
<a:themeElements>
<a:clrScheme name="OpenPipal">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="D97757"/></a:accent1>
<a:accent2><a:srgbClr val="4472C4"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="OpenPipal">
<a:majorFont><a:latin typeface="Helvetica Neue"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Helvetica Neue"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="OpenPipal">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`
}

/** 单页幻灯片：spTree 里一个铺满画布的 <p:pic>，r:embed 指向本页唯一的图片关系。 */
function buildSlideXml(n: number, widthEmu: number, heightEmu: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${NS_R}">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:pic>
<p:nvPicPr>
<p:cNvPr id="2" name="Slide ${n}"/>
<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
<p:nvPr/>
</p:nvPicPr>
<p:blipFill>
<a:blip r:embed="rId2"/>
<a:stretch><a:fillRect/></a:stretch>
</p:blipFill>
<p:spPr>
<a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
</p:pic>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

function buildSlideRels(n: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
<Relationship Id="rId1" Type="${NS_R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${NS_R}/image" Target="../media/image${n}.png"/>
</Relationships>`
}

/** 把已截好的逐页 PNG 组装成 OOXML 树并用系统 zip 打包。ooxmlDir 是全新的临时目录（调用方负责
 *  最终清理）；zip 的 cwd 设为 ooxmlDir 本身（而不是父目录起别名），让 [Content_Types].xml 等
 *  part 落在 zip 根，不是嵌套在一层子文件夹里——这与 dc-export.ts exportZip 的"分享打包成
 *  <basename>/…"语义不同，OOXML 要求 part 路径就是 zip 内的绝对根路径。 */
async function assemblePptxZip(
  ooxmlDir: string,
  slidePngPaths: string[],
  widthPx: number,
  heightPx: number,
  outPath: string
): Promise<void> {
  const widthEmu = Math.round(widthPx * EMU_PER_PX)
  const heightEmu = Math.round(heightPx * EMU_PER_PX)
  const pageCount = slidePngPaths.length

  fs.mkdirSync(path.join(ooxmlDir, '_rels'), { recursive: true })
  fs.mkdirSync(path.join(ooxmlDir, 'ppt', '_rels'), { recursive: true })
  fs.mkdirSync(path.join(ooxmlDir, 'ppt', 'slideMasters', '_rels'), { recursive: true })
  fs.mkdirSync(path.join(ooxmlDir, 'ppt', 'slideLayouts', '_rels'), { recursive: true })
  fs.mkdirSync(path.join(ooxmlDir, 'ppt', 'slides', '_rels'), { recursive: true })
  fs.mkdirSync(path.join(ooxmlDir, 'ppt', 'theme'), { recursive: true })
  fs.mkdirSync(path.join(ooxmlDir, 'ppt', 'media'), { recursive: true })

  fs.writeFileSync(path.join(ooxmlDir, '[Content_Types].xml'), buildContentTypes(pageCount))
  fs.writeFileSync(path.join(ooxmlDir, '_rels', '.rels'), buildPackageRels())
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'presentation.xml'), buildPresentationXml(pageCount, widthEmu, heightEmu))
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', '_rels', 'presentation.xml.rels'), buildPresentationRels(pageCount))
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'slideMasters', 'slideMaster1.xml'), buildSlideMasterXml())
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'slideMasters', '_rels', 'slideMaster1.xml.rels'), buildSlideMasterRels())
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'slideLayouts', 'slideLayout1.xml'), buildSlideLayoutXml())
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'slideLayouts', '_rels', 'slideLayout1.xml.rels'), buildSlideLayoutRels())
  fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'theme', 'theme1.xml'), buildThemeXml())

  for (let i = 0; i < pageCount; i++) {
    const n = i + 1
    fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'slides', `slide${n}.xml`), buildSlideXml(n, widthEmu, heightEmu))
    fs.writeFileSync(path.join(ooxmlDir, 'ppt', 'slides', '_rels', `slide${n}.xml.rels`), buildSlideRels(n))
    fs.copyFileSync(slidePngPaths[i], path.join(ooxmlDir, 'ppt', 'media', `image${n}.png`))
  }

  // 对齐 dc-export.ts exportZip 用系统 /usr/bin/zip 的模式——不引入新 npm 依赖。cwd=ooxmlDir，
  // "." 让 part 落在 zip 根（不是嵌套子文件夹），这是 OOXML 能被解析的硬要求。
  await execFileAsync('zip', ['-r', '-q', outPath, '.'], { cwd: ooxmlDir, maxBuffer: 64 * 1024 * 1024 })
}

export interface DeckStageFrame {
  rawIndex: number
  screenLabel: string | null
  pngPath: string
  text: string
}

export interface DeckStageCapture {
  frames: DeckStageFrame[]
  width: number
  height: number
}

/**
 * deck-stage 逐页截图（原 exportArtifactPptx 内联逻辑抽出，供 dc-handoff-export.ts 复用同一条
 * 翻页+截图路径——两处消费者都要求逐字节一致的截图行为，抽取时逐行搬运不顺手改进，pptx 冒烟
 * （Clio 11 页）是这段逻辑的不变量守卫）。
 * 调用方需先完成 assembleOfflineDc→loadURL→CDP attach+Page.enable，把已 attach 的 dbg 传进来；
 * 本函数只负责"等舞台就绪→仿真视口→逐页 goTo+截图"，不管窗口生命周期。
 */
export async function captureDeckStageFrames(
  dbg: Electron.Debugger,
  frameDir: string,
  filePrefix: string,
  onProgress?: (done: number, total: number) => void
): Promise<DeckStageCapture> {
  // 等 <deck-stage> 挂载完成：组件内部持有 data-fonts-pending 直到 webfonts 就绪（内部封顶
  // 2s），length>0 说明 slotchange 已收集完幻灯片。8s 超时报中文错误（非 deck 产物、或组件
  // 加载失败都会卡在这里）。
  const ready = await pollUntil(
    dbg,
    `(() => { const el = ${DECK_SELECTOR}; return !!(el && el.length > 0 && !el.hasAttribute('data-fonts-pending')); })()`,
    8000
  )
  if (!ready) throw new Error(tMain('artifacts.shell.export.errors.stageNotReady'))

  // 舞台真实尺寸的唯一来源：designWidth/designHeight 是组件从 width/height 属性解析出的
  // getter（DOM 真值），不是对 content 源码做正则猜测。
  const stageSize = await evalChecked(
    dbg,
    `(() => { const el = ${DECK_SELECTOR}; return { width: el.designWidth, height: el.designHeight }; })()`
  )
  const width = Math.round(stageSize?.width)
  const height = Math.round(stageSize?.height)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(tMain('artifacts.shell.export.errors.stageSizeUnreadable'))
  }

  // 视口仿真到舞台原生尺寸（deck-stage 无 mp4 场景那种常驻播放条，不需要额外高度补偿）；
  // deviceScaleFactor=2：2x 超采样截图，PNG 归档保留细节，PowerPoint/Keynote 按 EMU 尺寸
  // 显示时天然降采样，文字边缘更锐。
  await hideScrollbarsAndOverflow(dbg)
  await setDeviceMetricsOverride(dbg, width, height, 2)

  // noscale 关闭内部 transform:scale()，改用作者尺寸裸几何；presenting 消息隐藏 prev/next
  // 覆层、缩略图侧栏、右键菜单/确认弹窗——真机验证两者叠加后活动幻灯片的 rect 恰好是
  // {0,0,width,height}，不需要 mp4 导出器那种 autofit 收敛轮询。
  await evalChecked(
    dbg,
    `(() => { const el = ${DECK_SELECTOR}; el.setAttribute('noscale', ''); window.postMessage({ __omelette_presenting: true }, '*'); return true; })()`
  )
  await evalChecked(dbg, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`, {
    awaitPromise: true
  })

  // 页面枚举：跳过 data-deck-skip（用户在缩略图侧栏右键 Skip 的幻灯片），与 PDF/print 导出
  // 路线保持一致语义。rawIndex 供 goTo() 寻址；可见序号才是 pptx 的页码。
  const rawIndices: number[] = await evalChecked(
    dbg,
    `(() => {
      const el = ${DECK_SELECTOR};
      const children = Array.from(el.children).filter((c) => !['TEMPLATE', 'SCRIPT', 'STYLE'].includes(c.tagName));
      const out = [];
      children.forEach((c, i) => { if (!c.hasAttribute('data-deck-skip')) out.push(i); });
      return out;
    })()`
  )
  if (!Array.isArray(rawIndices) || !rawIndices.length) {
    throw new Error(tMain('artifacts.shell.export.errors.noSlides'))
  }

  const frames: DeckStageFrame[] = []
  for (let p = 0; p < rawIndices.length; p++) {
    const rawIndex = rawIndices[p]
    await evalChecked(dbg, `(() => { ${DECK_SELECTOR}.goTo(${rawIndex}); return true; })()`)
    // 双 rAF 确保 React 提交 + 合成绘制完成后才截图（同 dc-video-export.ts 的逐帧节奏）。
    await evalChecked(dbg, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`, {
      awaitPromise: true
    })
    // 文本摘要须在"该页是 active 页"这一刻现取——deck-stage 用 visibility 隐藏非 active 页，
    // innerText 遇 visibility:hidden 恒返回空串（textContent 不受影响但会带隐藏页噪音），
    // 导出后统一跑一遍 PAGE_TEXT_SUMMARY_JS 只会拿到"最后停留那页"的文本（真机验证过的坑，
    // handoff 交接包首版曾在这里踩过：11 页只有最后一页有摘要）。故文本随每页截图同步现取。
    const active = await evalChecked(
      dbg,
      `(() => {
        const el = ${DECK_SELECTOR};
        const active = el.querySelector(':scope > [data-deck-active]');
        if (!active) return null;
        const r = active.getBoundingClientRect();
        function collapse(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
        function shadowText(root) {
          if (!root) return '';
          var target = root.querySelector('.sheet') || root;
          return collapse(target.textContent);
        }
        var base = collapse(active.innerText !== undefined ? active.innerText : active.textContent);
        var shadowParts = [];
        var allEls = active.querySelectorAll('*');
        for (var i = 0; i < allEls.length; i++) {
          if (allEls[i].shadowRoot) shadowParts.push(shadowText(allEls[i].shadowRoot));
        }
        var extra = shadowParts.filter(Boolean).join(' ');
        var text = collapse(extra ? base + ' ' + extra : base);
        return { x: r.x, y: r.y, width: r.width, height: r.height, label: active.getAttribute('data-screen-label'), text: text };
      })()`
    )
    if (!active) throw new Error(tMain('artifacts.shell.export.errors.slideMissing', { page: p + 1 }))
    const clip = clipFromRect(active)
    if (clip.width < 2 || clip.height < 2) {
      throw new Error(tMain('artifacts.shell.export.errors.slideClipInvalid', { page: p + 1, detail: JSON.stringify(active) }))
    }

    const shot: any = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
      optimizeForSpeed: true
    })
    const pngPath = path.join(frameDir, `${filePrefix}${String(p + 1).padStart(3, '0')}.png`)
    fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))
    frames.push({ rawIndex, screenLabel: active.label ?? null, pngPath, text: active.text || '' })
    onProgress?.(p + 1, rawIndices.length)
  }

  return { frames, width, height }
}

export async function exportArtifactPptx(
  title: string,
  content: string,
  artifactId: string | undefined,
  targetDir?: string,
  onProgress?: (done: number, total: number) => void
): Promise<PptxExportResult> {
  const { app, BrowserWindow } = require('electron')
  if (!BrowserWindow) return { ok: false, ...mainError('artifacts.shell.export.errors.noBrowserWindow') }

  let html: string
  try {
    html = assembleOfflineDc(content, artifactId)
  } catch (err: any) {
    return { ok: false, ...mainError('artifacts.shell.export.errors.assembleFailed', { detail: err?.message || String(err) }) }
  }

  const tmpRoot = path.join(app.getPath('temp'), `openpipal-pptx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const frameDir = path.join(tmpRoot, 'frames')
  const ooxmlDir = path.join(tmpRoot, 'ooxml')
  fs.mkdirSync(frameDir, { recursive: true })
  fs.mkdirSync(ooxmlDir, { recursive: true })

  let win: Electron.BrowserWindow | null = null
  let width = 0
  let height = 0
  let slidePngPaths: string[] = []
  try {
    win = new BrowserWindow({
      show: false,
      useContentSize: true,
      // 初始猜测（1920x1080 是 deck-stage 骨架/技能约定的默认设计尺寸）——真实尺寸随后
      // 从 DOM（designWidth/designHeight getter）覆盖，这里只是给隐藏窗口一个大致合适的初值。
      width: 1920,
      height: 1080,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    const w = win!
    // 关键顺序（真机验证过，见 dc-capture.ts 顶部注释）：loadURL 必须先完全 await 完成，
    // 再 attach CDP debugger + Page.enable——反过来会导致 Page.enable 无限期挂起。
    await w.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))

    const dbg = w.webContents.debugger
    try {
      dbg.attach('1.3')
    } catch (err: any) {
      return { ok: false, ...mainError('artifacts.shell.export.errors.cdpAttachFailed', { detail: err?.message || String(err) }) }
    }
    await dbg.sendCommand('Page.enable')

    const capture = await captureDeckStageFrames(dbg, frameDir, 'slide', onProgress)
    width = capture.width
    height = capture.height
    slidePngPaths = capture.frames.map((f) => f.pngPath)
  } catch (err: any) {
    console.error('[dc-pptx-export] 截图渲染异常', err)
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, ...mainError('artifacts.shell.export.errors.renderFailed', { detail: err?.message || String(err) }) }
  } finally {
    try {
      if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch {
      /* ignore */
    }
    try {
      win?.destroy()
    } catch {
      /* ignore */
    }
  }

  const outRoot = targetDir || OUTPUTS_ROOT
  fs.mkdirSync(outRoot, { recursive: true })
  // title 常带 .dc.html/.html 后缀（源自 artifact 文件名），去掉避免产出双后缀文件名。
  // 对齐 dc-export.ts exportStandaloneHtml / dc-video-export.ts 的同款处理。
  const baseName = sanitizeName(title).replace(/\.dc\.html?$/i, '').replace(/\.html?$/i, '')
  const outPath = path.join(outRoot, `${baseName || 'design'}.pptx`)

  try {
    await assemblePptxZip(ooxmlDir, slidePngPaths, width, height, outPath)
  } catch (err: any) {
    console.error('[dc-pptx-export] OOXML 打包异常', err)
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    if (err?.code === 'ENOENT') return { ok: false, ...mainError('artifacts.shell.export.errors.zipCommandMissing') }
    return { ok: false, ...mainError('artifacts.shell.export.errors.packFailed', { detail: err?.message || String(err) }) }
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  return { ok: true, path: outPath, pageCount: slidePngPaths.length, width, height }
}
