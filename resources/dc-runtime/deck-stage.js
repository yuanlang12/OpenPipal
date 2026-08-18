/**
 * deck-stage —— OpenPipal 自研的幻灯舞台（零依赖、自注册 Web Component，无 React / 无 Babel / 无构建步骤）。
 *
 * 把「一页一个直接子元素」的静态 HTML 变成能翻页、能自适应任意容器、能一页一张纸导出的幻灯片。
 * 作者只写「这一页说什么、怎么排」，翻页 / 缩放 / 页码 / 打印这四件确定性的机械活全部归本组件——
 * 它们恰好是弱模型最容易写错、且错了就整份废掉的部分。
 *
 * 用法（标准挂载形态，宿主装配时把本文件整段内联进单文档、按全局名取用）：
 *   x-import component-from-global-scope='deck-stage' width='1920' height='1080' hint-size='100%,100%'
 *   里面每一个直接子元素就是一页；template / script / style 子节点不算页。
 * 兜底形态（手写场景）：裸标签 + 末尾一句 script src='./deck-stage.js'，同样能跑。
 *
 * 宿主契约（改动前先读 docs/claude/design-rewrite/deck-stage-spec.md 第四节）：
 *   - length / designWidth / designHeight / goTo(i) / next() / prev() / reset() 是导出链的公开面
 *   - data-fonts-pending 是就绪握手位：宿主轮询上限 8s，本组件内部封顶 2s 自摘
 *     （一个 404 的字体 URL 不许把整条导出线卡死）
 *   - noscale = 导出通道：零缩放裸几何 + 全部 chrome 隐藏，活动页 rect 恰好 {0,0,设计宽,设计高}
 *   - goTo(i) 的 i 与「过滤掉 template/script/style 后的直接元素子节点」下标严格对齐
 *   - 一切组件 chrome 住在 shadow DOM，光 DOM 只留作者的页（重叠检测与文本摘要都只走光 DOM）
 *   - 打印几何（@page）必须落在 document 层且挂载时就落地：PDF 直出走 data: URL + printToPDF，
 *     不给第二次机会
 *   - 本文件会被整段内联进 HTML：源码里不得出现 script 闭合标签字面量、x-dc 标签字面量，
 *     属性示例一律写单引号（宿主按「空格 + from + 等号 + 双引号」扫兄弟件引用）
 */
(function () {
  'use strict'

  if (typeof window === 'undefined' || !window.customElements) return
  if (window.customElements.get('deck-stage')) return

  var DEFAULT_W = 1920
  var DEFAULT_H = 1080
  var FONT_CAP_MS = 2000 // 就绪握手内部封顶，必须远小于宿主的 8s 上限
  var HUD_IDLE_MS = 2400
  var RAIL_MIN_W = 150
  var RAIL_MAX_W = 400
  var RAIL_DEFAULT_W = 210 // 缩略图要看得出是哪一页，比纯目录时的 180 加宽
  // 缩略图盒宽 = 栏宽 - 这个数：列表右侧留白 6 + 条目左右内边距 20 + 当前页高亮左边框 2。
  // 盒宽同时写成显式像素（不是 100%），克隆的缩放比才和盒子严丝合缝——用 100% 的话
  // 这三笔任何一笔改了，缩略图就会被裁掉右边一条。
  var RAIL_PAD = 28
  var RAIL_MIN_STAGE = 900 // 窄视口不出侧栏：480px 预览面板里侧栏比幻灯本身还宽
  var PREF_KEY = 'openpipal.deck-stage.rail'
  var THUMB_PH = 'dc-thumb-ph' // 克隆里替换 iframe/video 的中性占位块类名（刻意不像作者会用的名字）

  // 页 = 直接元素子节点去掉 template / script / style。**这份口径与 dc-pptx-export.ts 枚举
  // rawIndex 的口径必须逐字一致**：两侧口径一旦漂移，跳过页一多就整份错页。
  var NOT_A_PAGE = { TEMPLATE: 1, SCRIPT: 1, STYLE: 1 }

  var INTERACTIVE = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'option', 'label', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    '[role="switch"]', '[role="slider"]', '[role="menuitem"]',
    '[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])'
  ].join(',')

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }

  function intAttr(el, name, fallback) {
    var raw = (el.getAttribute(name) || '').trim()
    var n = parseFloat(raw)
    return isFinite(n) && n > 0 ? Math.round(n) : fallback
  }

  function collapse(s) {
    return (s || '').replace(/\s+/g, ' ').trim()
  }

  // ---- 缩略图：作者样式镜像 ----
  // 缩略图是页的真克隆，而克隆住在 shadow 里——作者的样式全在 document 层，跨不过 shadow 边界。
  // 产物是自包含的（样式一律内联，CSP 断网所以不存在外链样式表），所以「把文档 style 元素的文本
  // 搬进来」是可枚举、可完整的一次性操作，不需要原件那套按选择器改写字符串的机器。
  // 注意 :root/html 上的自定义属性（设计 token、明暗模式）本来就顺着继承链穿过 shadow 边界，
  // 不用镜像，主题自然跟着对。
  function mirrorCss() {
    var out = []
    var styles = document.querySelectorAll('style')
    for (var i = 0; i < styles.length; i++) {
      var s = styles[i]
      // 跳过运行时自己的两类样式：本组件的 @page/打印定格、流式运行时的挂载点壳样式。
      // 它们是 chrome 与文档几何，搬进缩略图只会捣乱。
      if (s.hasAttribute('data-deck-stage') || s.hasAttribute('data-dc-shell')) continue
      out.push(s.textContent || '')
    }
    return out.join('\n')
  }

  // 缩略图的几何与隔离规则，永远排在镜像文本**之后**（同特异性下后写的赢）。
  // 尺寸走 --deck-w/--deck-h/--deck-thumb-k 三个自定义属性：拖宽侧栏只改属性值，
  // 不必重新解析整张样式表。
  var THUMB_CSS = [
    ':host{position:absolute;inset:0;display:block;overflow:hidden;background:#fff}',
    '.w{position:absolute;left:0;top:0;width:var(--deck-w);height:var(--deck-h);',
    'transform:scale(var(--deck-thumb-k,.1));transform-origin:0 0}',
    '.w>*{position:absolute!important;left:0!important;top:0!important;right:auto!important;',
    'bottom:auto!important;width:var(--deck-w)!important;height:var(--deck-h)!important;',
    'margin:0!important;box-sizing:border-box;overflow:hidden;visibility:visible!important}',
    '.' + THUMB_PH + '{background:repeating-linear-gradient(45deg,rgba(128,128,128,.16) 0 8px,',
    'rgba(128,128,128,.08) 8px 16px);border-radius:2px}'
  ].join('')

  /**
   * 页 → 缩略图快照。
   * - 摘掉 data-screen-label：宿主按它分组做逐屏摘要，克隆体不该出现在任何这类查询口径里
   *   （克隆在 shadow 里本来就查不到，摘掉是双保险）。
   * - **保留 data-deck-active**：作者的入场动画是这个属性门控的（规格第二节），摘掉的话
   *   缩略图会停在动画起始态——通常是 opacity:0，一栏空白缩略图比没有缩略图更糟。
   *   它在嵌套 shadow 里对宿主的每一条查询口径都不可达（见报告里的证明与 harness 用例）。
   * - iframe / video / audio / object / embed 换成中性占位块：不许为了一张缩略图再拉一次
   *   媒体或网络。克隆里的 script 天生不会执行（克隆出来就是 already-started 状态）。
   */
  function snapshot(page) {
    var c = page.cloneNode(true)
    c.removeAttribute('data-screen-label')
    c.setAttribute('data-deck-active', '')
    var media = c.querySelectorAll('iframe,video,audio,object,embed')
    for (var i = 0; i < media.length; i++) {
      var el = media[i]
      if (!el.parentNode) continue
      var box = document.createElement('div')
      box.className = THUMB_PH
      box.style.cssText = el.getAttribute('style') || ''
      box.style.width = box.style.width || (el.getAttribute('width') ? el.getAttribute('width') + 'px' : '100%')
      box.style.height = box.style.height || (el.getAttribute('height') ? el.getAttribute('height') + 'px' : '100%')
      el.parentNode.replaceChild(box, el)
    }
    return c
  }

  // H-15：预览 iframe 没有 allow-same-origin，localStorage 连读都会抛。记不住侧栏宽度是可接受
  // 的降级，翻页失灵不是——所以每一处都 try/catch，且没有任何功能以它可用为前提。
  function readPref() {
    try {
      var raw = window.localStorage.getItem(PREF_KEY)
      var v = raw ? JSON.parse(raw) : null
      return v && typeof v === 'object' ? v : null
    } catch (e) {
      return null
    }
  }

  function writePref(v) {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify(v))
    } catch (e) { /* 沙箱里没有存储，忘掉就忘掉 */ }
  }

  // ---- 文档层样式（shadow 里的 @page 是空操作，打印几何只能落在 document 层）----
  function docStyle(kind) {
    var head = document.head || document.documentElement
    if (!head) return null
    var el = head.querySelector('style[data-deck-stage="' + kind + '"]')
    if (!el) {
      el = document.createElement('style')
      el.setAttribute('data-deck-stage', kind)
      head.appendChild(el)
    }
    return el
  }

  var BASE_DOC_CSS = [
    '@media print{',
    'html,body{margin:0!important;padding:0!important}',
    // 截图链路的 printBackground 走 CDP，用户手动 Cmd+P 这条得靠它才印得出底色
    'deck-stage,deck-stage>*{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '}'
  ].join('')

  // 打印定格：入场动画半截被捕获是「PDF 里有几页是空的」最常见的根因。duration 归零 + forwards
  // 让每条动画瞬间停在终态；transition:none 让属性变更即时生效。**必须先于属性变更落地**——
  // 过渡一旦已经开始，再改时长不影响它。
  var FREEZE_CSS = '*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;' +
    'animation-iteration-count:1!important;animation-fill-mode:forwards!important;transition:none!important}'

  // ---- shadow 壳样式 ----
  // 光 DOM 只放作者的页，覆层 / 侧栏 / 一切 chrome 都住在这里（H-12）。
  var SHELL_CSS = [
    // 舞台占满所在 iframe 的视口，而不是被挂载盒的盒高约束：预览面板里挂载盒可能只有内容高
    // （幻灯会变成一条缝），导出时几何又必须可预测。fixed 同时保证**零横向文档溢出**——
    // 预览垫片按 documentElement.scrollWidth 判断要不要给整页上 zoom（H-13）。
    ':host{position:fixed!important;inset:0!important;display:block!important;',
    'overflow:hidden;background:var(--deck-letterbox,#0b0b0d);',
    'font:400 13px/1.35 ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}',
    ':host([hidden]){display:none!important}',
    '.stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
    'padding-left:var(--deck-rail,0px);box-sizing:border-box}',
    // 设计画布：等比缩放居中，四周留黑边。永远不裁切、永远不变形。
    '.canvas{position:relative;flex:none;width:var(--deck-w);height:var(--deck-h);',
    'transform:scale(var(--deck-k,1));transform-origin:50% 50%}',
    // noscale = 导出通道：不缩放、不居中、不留边，按设计尺寸左上角对齐的裸几何。
    // 导出器设完属性只等双 rAF 就一次量到 rect 直接当截图 clip 用，差一个像素每页都歪。
    ':host([noscale]) .stage{display:block;padding:0}',
    ':host([noscale]) .canvas{transform:none}',

    // 每页绝对定位铺满设计画布——作者写的 position/inset/width/height 一律被覆盖（规格明说
    // 这几个属性归舞台）。非当前页只隐藏、不卸载：视频进度 / iframe / 表单输入 / 组件内部状态
    // 全都保住，这是「翻回去东西还在」的全部理由。
    '::slotted(*){position:absolute!important;left:0!important;top:0!important;right:auto!important;',
    'bottom:auto!important;width:var(--deck-w)!important;height:var(--deck-h)!important;',
    'margin:0!important;box-sizing:border-box;overflow:hidden}',
    '::slotted(template),::slotted(script),::slotted(style){display:none!important}',
    '::slotted(:not([data-deck-active])){visibility:hidden!important}',
    // 逐页取文的可读态（见 readPages）：把上面那道可见性门临时放开。**必须排在它后面**——
    // 两条同特异性，后写的赢。只改可见性：不翻页、不动当前页状态、不动几何。
    '.reading ::slotted(*){visibility:visible!important}',

    // 覆层：鼠标移动或翻页时浮现，静置后淡出。演示模式与 noscale 下完全不出现。
    '.hud{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:3;',
    'display:flex;align-items:center;gap:2px;padding:5px 6px;border-radius:999px;',
    'background:rgba(18,18,20,.66);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'box-shadow:0 2px 8px rgba(0,0,0,.28);color:#f2f0ec;opacity:0;visibility:hidden;',
    'transition:opacity .16s ease;pointer-events:none}',
    '.hud.on{opacity:1;visibility:visible;pointer-events:auto}',
    '.hud button{width:28px;height:28px;display:flex;align-items:center;justify-content:center;',
    'padding:0;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer}',
    '.hud button:hover{background:rgba(255,255,255,.14)}',
    '.hud button:focus-visible{outline:2px solid #7fb2ff;outline-offset:1px}',
    '.hud svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;',
    'stroke-linecap:round;stroke-linejoin:round}',
    '.count{min-width:52px;padding:0 6px;text-align:center;font-variant-numeric:tabular-nums;',
    'font-size:12px;letter-spacing:.02em;opacity:.92}',

    // 侧栏：第一版只做导航（点击跳页 + 当前页高亮 + 跳过页标记）。一切改结构的入口都不做——
    // 组件只提议、宿主才改 DOM 的那套协议在本宿主里没有对端，做了就是点了没反应的 UI。
    '.rail{position:absolute;left:0;top:0;bottom:0;z-index:2;width:var(--deck-rail,0px);',
    'display:none;background:rgba(16,16,18,.9);color:#e8e5e0;',
    'border-right:1px solid rgba(255,255,255,.08)}',
    '.rail.on{display:block}',
    '.list{position:absolute;inset:0 6px 0 0;overflow-y:auto;overflow-x:hidden;padding:8px 0}',
    '.thumb{display:block;width:100%;box-sizing:border-box;',
    'padding:7px 10px;border:0;border-left:2px solid transparent;background:transparent;',
    'color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.thumb:hover{background:rgba(255,255,255,.07)}',
    '.thumb:focus-visible{outline:2px solid #7fb2ff;outline-offset:-2px}',
    '.thumb.on{background:rgba(255,255,255,.14);border-left-color:#7fb2ff}',
    // 缩略预览盒：宽 = 栏宽减留白，高按设计比例；克隆住在 .cage 自己的嵌套 shadow 里，
    // 作者样式与组件 chrome 因此互不串门（一层 shadow 换掉原件那套选择器改写机器）。
    '.shot{display:block;position:relative;width:var(--deck-thumb-w,0px);height:var(--deck-thumb-h,0px);',
    'border-radius:3px;overflow:hidden;background:#fff;pointer-events:none;',
    'box-shadow:0 0 0 1px rgba(255,255,255,.12),0 1px 3px rgba(0,0,0,.35)}',
    '.cage{position:absolute;inset:0;display:block}',
    '.meta{display:flex;align-items:baseline;gap:6px;padding:5px 1px 0}',
    '.thumb.skip .shot{filter:grayscale(1);opacity:.45}',
    '.thumb.skip .meta{opacity:.5}',
    '.thumb .i{flex:none;font-variant-numeric:tabular-nums;font-size:11px;opacity:.6}',
    '.thumb .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}',
    '.thumb .s{flex:none;font-size:9px;letter-spacing:.06em;text-transform:uppercase;opacity:.7;',
    'border:1px solid currentColor;border-radius:3px;padding:0 3px}',
    '.grip{position:absolute;top:0;bottom:0;right:0;width:6px;cursor:col-resize}',
    '.grip:hover{background:rgba(255,255,255,.16)}',

    // 打印 / PDF：一页一张纸。fixed 舞台整体退回文档流，页恢复静态块并逐页强制分页。
    // 分页用 break-before（而不是 break-after）——末页带强制分页会多出一张空白纸。
    '@media print{',
    ':host{position:static!important;inset:auto!important;overflow:visible!important;',
    'background:transparent!important}',
    '.stage{position:static!important;display:block!important;padding:0!important;',
    'overflow:visible!important}',
    '.canvas{position:static!important;display:block!important;transform:none!important;',
    'width:auto!important;height:auto!important}',
    '.hud,.rail{display:none!important}',
    '::slotted(*){position:relative!important;left:auto!important;top:auto!important;',
    'visibility:visible!important;width:var(--deck-w)!important;height:var(--deck-h)!important;',
    'overflow:hidden!important;break-before:page!important;break-inside:avoid!important}',
    '::slotted([data-deck-skip]){display:none!important}',
    '}'
  ].join('')

  var ICONS = {
    prev: '<svg viewBox="0 0 16 16"><path d="M10.5 3 5.5 8l5 5"/></svg>',
    next: '<svg viewBox="0 0 16 16"><path d="M5.5 3l5 5-5 5"/></svg>',
    reset: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/></svg>',
    rail: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h4v9h-4z"/><path d="M8 4.5h5.5M8 8h5.5M8 11.5h5.5"/></svg>'
  }

  /** 点按翻页要给交互内容让位。判定穿透开放 shadow root：页里嵌自定义元素时事件目标会被
   *  重定向到宿主元素，只看 event.target 判不出来。 */
  function interactiveInPath(path, stopAt) {
    for (var i = 0; i < path.length; i++) {
      var n = path[i]
      if (n === stopAt) break
      if (!n || n.nodeType !== 1 || !n.matches) continue
      if (n.isContentEditable || n.matches(INTERACTIVE)) return true
    }
    return false
  }

  /** 焦点在输入态里时键盘一律不接管 */
  function typingTarget(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.isContentEditable) return true
    var tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  class DeckStage extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'noscale', 'no-rail']
    }

    // ---- 公开 API（导出链与作者面共用，见规格第三节）----
    get length() {
      return this._pages ? this._pages.length : 0
    }

    get index() {
      return this._index || 0
    }

    get designWidth() {
      return intAttr(this, 'width', DEFAULT_W)
    }

    get designHeight() {
      return intAttr(this, 'height', DEFAULT_H)
    }

    /**
     * 逐页演讲备注，下标与 children 的原始序号（rawIndex）同口径——与 goTo 一致，
     * 导出器按 rawIndex 取就不会因「跳过页」错位。返回副本，外部改不动内部表。
     *
     * 这是备注的唯一外发通道（规格 Q2 的 (c)）：两种来源（每页属性 / 文档级 JSON 数组）
     * 的合并规则住在组件里一份，消费方直接拿结果，不必各自再实现一遍那套逐页兜底。
     */
    get notes() {
      return this._notes ? this._notes.slice() : []
    }

    goTo(n) {
      // 直达型导航不跳过「跳过页」：goTo 必须与导出器枚举 rawIndex 的口径严格一致（H-8），
      // 不能有第二套语义。越界钳到两端。
      this._activate(n, 'api')
    }

    next() {
      this._step(1, 'api')
    }

    prev() {
      this._step(-1, 'api')
    }

    reset() {
      this._activate(0, 'api')
    }

    /**
     * 逐页取文的可读态：同步跑一遍 fn，期间**每一页都可读**，跑完立刻收回，返回 fn 的返回值。
     *
     * 为什么需要：非当前页是 visibility:hidden，而 innerText 对隐藏元素恒返回空串——
     * 自检的文本摘要于是「屏名齐全、只有当前页有正文」，模型拿不到自己后 11 页的任何事实反馈，
     * 只能凭想象宣布完成。这是「弱模型单次生成即可交付」的直接障碍。
     *
     * 为什么是"作用域"而不是"返回文本数组"：**什么算正文**（innerText vs textContent、
     * 折叠空白、穿 shadowRoot 补取、截断长度）是宿主自检链路的口径，`dc-text-summary.ts`
     * 已经有一份。组件再实现一份就是同一件事的两处拷贝——这个仓库在"两处正则漂移"上出过事故。
     * 于是组件只管自己真正拥有的那件事：**页的可见性**；取文口径留在宿主，一份。
     *
     * 不翻页、不改当前页、不动几何，也不会闪：加类与去类在同一个任务里完成，中间没有帧边界，
     * 合成器永远看不到这个中间态。fn 必须是同步的（异步的话恢复会早于它读到的时刻）。
     */
    readPages(fn) {
      if (typeof fn !== 'function') return undefined
      if (!this._stage || this._reading) return fn() // 重入：门已经开着，直接跑
      this._reading = true
      this._stage.classList.add('reading')
      try {
        return fn()
      } finally {
        this._stage.classList.remove('reading')
        this._reading = false
      }
    }

    connectedCallback() {
      if (!this.shadowRoot) this._build()
      var s = docStyle('base')
      if (s) s.textContent = BASE_DOC_CSS
      this._writePageRule()
      // @page 要在挂载时就落地：PDF 直出走 data: URL + printToPDF({preferCSSPageSize:true})，
      // 等字体就绪 + 双 rAF 之后立刻打印，不存在第二次时机（H-14）。
      this._raisePageRule()

      if (!this._mo) {
        var self = this
        var bump = function () { self._schedule() }
        // 流式期间页是一页一页到的（React 增量提交），childList 变化必须重收集，
        // 否则一份 12 页的 deck 会永远停在建壳时那几页。
        // **两个 observer 不能合成一个**：同一个 MutationObserver 对同一节点第二次 observe()
        // 会顶掉前一次的注册（规范如此），合并成一次又得开 subtree childList——流式期每一个
        // 文字节点变动都要回调。分成两个各管各的：结构只看直接子节点，属性只看这两个。
        this._mo = new MutationObserver(bump)
        this._mo.observe(this, { childList: true })
        this._amo = new MutationObserver(bump)
        this._amo.observe(this, { attributes: true, subtree: true, attributeFilter: ['data-label', 'data-deck-skip'] })
      }
      if (!this._hmo && document.head) {
        var him = this
        // 作者样式是流式运行时边解析 helmet 边注进 head 的，晚于首次收集很常见。
        // 样式一变，缩略图的镜像样式表就该跟着刷（打印期让路：那会儿是我们自己在往 head 里
        // 放定格样式，别自触发）。
        this._hmo = new MutationObserver(function () {
          if (!him._printing) him._scheduleThumbs()
        })
        this._hmo.observe(document.head, { childList: true })
      }
      if (!this._ro && window.ResizeObserver) {
        var me = this
        this._ro = new ResizeObserver(function () { me._fit() })
        this._ro.observe(this)
      }
      this._bind()
      this._collect()
      this._markPending()
    }

    disconnectedCallback() {
      if (this._mo) { this._mo.disconnect(); this._mo = null }
      if (this._amo) { this._amo.disconnect(); this._amo = null }
      if (this._hmo) { this._hmo.disconnect(); this._hmo = null }
      if (this._ro) { this._ro.disconnect(); this._ro = null }
      this._unbind()
      if (this._hudTimer) { clearTimeout(this._hudTimer); this._hudTimer = null }
    }

    // 元素升级时 attributeChangedCallback 先于 connectedCallback 触发，此时 shadow 骨架还没建
    attributeChangedCallback(name) {
      if (!this._stage) return
      if (name === 'width' || name === 'height') this._writePageRule()
      if (name === 'noscale') this._freezeForCapture(this.hasAttribute('noscale'))
      // 导出器设完 noscale 只等双 rAF 就量几何，这里必须同步落地，不能推到下一帧
      this._fit()
      this._syncChrome()
    }

    /**
     * 逐页截图通道（PPTX / 交接包）的动画定格。
     *
     * 打印那条路靠 beforeprint / matchMedia('print') 触发 _allPages(true) 顺带定格；截图这条路
     * 不进 print 媒体（`goTo(i)` → 双 rAF → captureScreenshot），于是入场动画会被拍在刚起步处——
     * 一页 `opacity:0` 起手的动效，导出的 PPTX 上就是一张空白。这不是模型写错，是通道少了一步：
     * 更强的模型也躲不开，所以归运行时兜（CLAUDE.md 的「确定性归代码」）。
     *
     * 只定格、不碰 data-deck-active：截图要的是「当前这一页的终态」，而不是打印那种全页同时上纸。
     * 复用 _allPages 用的同一块 freeze 样式与同一个 kind，两条路不会各自留一份。
     */
    _freezeForCapture(on) {
      if (this._printing) return // 打印期由 _allPages 管，别互相踩
      var fz = docStyle('freeze')
      if (fz) fz.textContent = on ? FREEZE_CSS : ''
    }

    // ---- 骨架 ----
    _build() {
      var root = this.attachShadow({ mode: 'open' })
      var shell = document.createElement('style')
      shell.textContent = SHELL_CSS
      this._vars = document.createElement('style')
      this._stage = document.createElement('div')
      this._stage.className = 'stage'
      this._stage.innerHTML =
        '<div class="canvas"><slot></slot></div>' +
        '<nav class="rail" aria-label="Slides"><div class="list"></div><div class="grip"></div></nav>' +
        '<div class="hud">' +
        '<button class="p" title="Previous" aria-label="Previous slide">' + ICONS.prev + '</button>' +
        '<span class="count"></span>' +
        '<button class="n" title="Next" aria-label="Next slide">' + ICONS.next + '</button>' +
        '<button class="r" title="Reset" aria-label="Back to first slide">' + ICONS.reset + '</button>' +
        '<button class="b" title="Slides" aria-label="Toggle slide list">' + ICONS.rail + '</button>' +
        '</div>'
      root.appendChild(shell)
      root.appendChild(this._vars)
      root.appendChild(this._stage)

      this._canvas = this._stage.querySelector('.canvas')
      this._rail = this._stage.querySelector('.rail')
      this._list = this._stage.querySelector('.list')
      this._hud = this._stage.querySelector('.hud')
      this._count = this._stage.querySelector('.count')

      this._pages = []
      this._notes = []
      this._index = 0
      this._settled = false
      this._presenting = false
      this._printing = false
      this._seen = new WeakMap() // 作者原始屏名（我们自己写的 data-screen-label 不算「已有屏名」）
      var pref = readPref() || {}
      this._railW = Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, pref.w > 0 ? pref.w : RAIL_DEFAULT_W))
      this._railOn = pref.on !== false

      var self = this
      this._stage.querySelector('.p').addEventListener('click', function () { self._step(-1, 'click') })
      this._stage.querySelector('.n').addEventListener('click', function () { self._step(1, 'click') })
      this._stage.querySelector('.r').addEventListener('click', function () { self._activate(0, 'click') })
      this._stage.querySelector('.b').addEventListener('click', function () {
        self._railOn = !self._railOn
        writePref({ w: self._railW, on: self._railOn })
        self._syncChrome()
        self._fit()
      })
      this._list.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('.thumb') : null
        if (t) self._activate(parseInt(t.getAttribute('data-i'), 10), 'click')
      })
      // 缩略图获得焦点后 ↑/↓ 在页间步进
      this._list.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
        e.preventDefault()
        self._activate(self._index + (e.key === 'ArrowDown' ? 1 : -1), 'keyboard')
        var el = self._list.querySelector('.thumb.on')
        if (el) el.focus()
      })
      this._stage.querySelector('.grip').addEventListener('pointerdown', function (e) { self._drag(e) })
      this._stage.addEventListener('mousemove', function () { self._ping() })
      this._stage.addEventListener('click', function (e) { self._tap(e) })
    }

    _bind() {
      if (this._bound) return
      var self = this
      this._bound = {
        key: function (e) { self._key(e) },
        msg: function (e) { self._msg(e) },
        before: function () { self._allPages(true) },
        after: function () { self._allPages(false) },
        load: function () { self._raisePageRule() }
      }
      window.addEventListener('keydown', this._bound.key)
      window.addEventListener('message', this._bound.msg)
      window.addEventListener('beforeprint', this._bound.before)
      window.addEventListener('afterprint', this._bound.after)
      window.addEventListener('load', this._bound.load)
      // 部分打印通道不派发 beforeprint，媒体查询这条兜住它
      try {
        this._pm = window.matchMedia('print')
        this._bound.media = function (e) { self._allPages(!!e.matches) }
        if (this._pm.addEventListener) this._pm.addEventListener('change', this._bound.media)
        else if (this._pm.addListener) this._pm.addListener(this._bound.media)
      } catch (e) { /* 没有 matchMedia 就只靠 beforeprint */ }
    }

    _unbind() {
      if (!this._bound) return
      window.removeEventListener('keydown', this._bound.key)
      window.removeEventListener('message', this._bound.msg)
      window.removeEventListener('beforeprint', this._bound.before)
      window.removeEventListener('afterprint', this._bound.after)
      window.removeEventListener('load', this._bound.load)
      try {
        if (this._pm && this._bound.media) {
          if (this._pm.removeEventListener) this._pm.removeEventListener('change', this._bound.media)
          else if (this._pm.removeListener) this._pm.removeListener(this._bound.media)
        }
      } catch (e) { /* ignore */ }
      this._bound = null
    }

    // ---- 就绪握手（H-4）----
    // 宿主的判据是 length > 0 && !data-fonts-pending，轮询上限 8s。字体没就绪就截图会印出
    // 一份字体全错的 PPTX，所以要等；但一个 404 的字体 URL 不能把整条导出线卡死，所以内部封顶。
    _markPending() {
      if (this._fontsDone) return
      this._fontsDone = true
      this.setAttribute('data-fonts-pending', '')
      var self = this
      var clear = function () {
        if (!self._fontsCleared) {
          self._fontsCleared = true
          self.removeAttribute('data-fonts-pending')
        }
      }
      setTimeout(clear, FONT_CAP_MS)
      try {
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(clear, clear)
        else clear()
      } catch (e) {
        clear()
      }
    }

    // ---- 页收集 ----
    _schedule() {
      if (this._queued) return
      this._queued = true
      var self = this
      var run = function () { self._queued = false; self._collect() }
      if (window.requestAnimationFrame) window.requestAnimationFrame(run)
      else setTimeout(run, 0)
    }

    /** 缩略图刷新的合帧闸：样式晚到、侧栏刚露面都走这里，不叠成同一帧里的多次重画 */
    _scheduleThumbs() {
      if (this._tq) return
      this._tq = true
      var self = this
      var run = function () { self._tq = false; self._renderThumbs(false) }
      if (window.requestAnimationFrame) window.requestAnimationFrame(run)
      else setTimeout(run, 0)
    }

    _collect() {
      if (!this._stage) return
      var kids = this.children
      var pages = []
      for (var i = 0; i < kids.length; i++) {
        if (!NOT_A_PAGE[kids[i].tagName]) pages.push(kids[i])
      }
      this._pages = pages

      // data-screen-label 在收集时一次性打给每一页（不只当前页）：文本摘要按它分组做逐屏
      // 自检，交接包拿它当 reference/ 文件名并用 ^\d+\s+ 剥掉编号前缀与摘要对账（H-11）。
      for (i = 0; i < pages.length; i++) {
        var el = pages[i]
        if (!this._seen.has(el)) {
          this._seen.set(el, collapse((el.getAttribute('data-screen-label') || '').replace(/^\d+\s+/, '')))
        }
        el.setAttribute('data-screen-label', pad2(i + 1) + ' ' + this._labelOf(el, i))
      }
      this._readNotes(pages)
      this._writePageRule()
      this._index = Math.max(0, Math.min(pages.length - 1, this._index || 0))
      this._buildRail()
      // 首次收到页时也要派发一次 slidechange（含首次挂载，页内脚本靠它做逐页入场）
      if (!this._settled && pages.length) this._activate(this._index, 'init')
      else this._paint()
      this._fit()
      this._syncChrome()
      // 流式期间整栏随收集重建是可接受的（本方法已被 rAF 合并过一次）
      this._renderThumbs(true)
    }

    /** 屏名：data-label → 作者原有屏名 → 页内首个标题文本 → 通用兜底 */
    _labelOf(el, i) {
      var attr = collapse(el.getAttribute('data-label'))
      if (attr) return attr
      var kept = this._seen.get(el)
      if (kept) return kept
      var h = el.querySelector('h1,h2,h3,h4,h5,h6')
      var text = h ? collapse(h.textContent) : ''
      if (text) return text.length > 60 ? text.slice(0, 60) : text
      return 'Slide ' + (i + 1)
    }

    /**
     * 演讲备注两种来源：每页 data-speaker-notes 属性（推荐，存在即权威，跟着元素走所以重排
     * 复制删除都不会错位）；文档里一个 id='speaker-notes' 的 JSON 字符串数组按下标兜底——
     * 逐页兜底，某页有属性用属性，其余那几页仍回落到数组。
     * 出口是上面的 `notes` getter（规格 Q2 于 2026-08-17 从 (a) 改判 (c)）：`dc-pptx-export.ts`
     * 把它写进 PPTX 的 notesSlide，作者写的备注真的会到用户手里。合并规则只住在这里一份。
     */
    _readNotes(pages) {
      var arr = null
      var tag = document.getElementById('speaker-notes')
      if (tag && /json/i.test(tag.getAttribute('type') || '')) {
        try {
          var parsed = JSON.parse(tag.textContent || '')
          if (Array.isArray(parsed)) arr = parsed
        } catch (e) {
          console.warn('[deck-stage] speaker-notes 不是合法 JSON，已忽略：', e && e.message)
        }
      }
      this._notes = pages.map(function (el, i) {
        var own = el.getAttribute('data-speaker-notes')
        if (own != null) return own
        return arr && typeof arr[i] === 'string' ? arr[i] : ''
      })
    }

    // ---- 导航 ----
    _skipped(i) {
      var el = this._pages[i]
      return !!(el && el.hasAttribute('data-deck-skip'))
    }

    /** 翻页型导航连续跳过 data-deck-skip，两端到头时停在原地 */
    _step(dir, reason) {
      var i = this._index + dir
      while (i >= 0 && i < this._pages.length && this._skipped(i)) i += dir
      if (i < 0 || i >= this._pages.length) return
      this._activate(i, reason)
    }

    _activate(n, reason) {
      var total = this._pages.length
      if (!total) return
      var i = Math.floor(Number(n))
      if (!isFinite(i)) i = 0
      i = Math.max(0, Math.min(total - 1, i))
      if (this._settled && i === this._index) return
      var prevIndex = this._settled ? this._index : -1
      var prevSlide = prevIndex >= 0 ? this._pages[prevIndex] || null : null
      this._index = i
      this._settled = true
      this._paint()
      this._ping()
      // 缩略图是静态快照，翻页只刷新出入两页——每次击键重扫全栏是原件那条性能陷阱
      if (prevIndex >= 0) this._refreshThumb(prevIndex)
      this._refreshThumb(i)
      this.dispatchEvent(new CustomEvent('slidechange', {
        bubbles: true,
        composed: true,
        detail: {
          index: i,
          previousIndex: prevIndex,
          total: total,
          slide: this._pages[i] || null,
          previousSlide: prevSlide,
          reason: reason || 'api'
        }
      }))
    }

    /** 把当前页状态刷到光 DOM（data-deck-active）与 chrome 上 */
    _paint() {
      var pages = this._pages
      if (!pages.length) return
      // 打印期是「全页模式」：每页都带 active，交给 _allPages 管，这里不要把它撤回单页
      if (!this._printing) {
        for (var i = 0; i < pages.length; i++) {
          if (i === this._index) pages[i].setAttribute('data-deck-active', '')
          else pages[i].removeAttribute('data-deck-active')
        }
      }
      if (this._count) this._count.textContent = (this._index + 1) + ' / ' + pages.length
      var items = this._list ? this._list.children : []
      for (var k = 0; k < items.length; k++) items[k].classList.toggle('on', k === this._index)
    }

    // ---- 缩放适配 ----
    // min(容器宽/设计宽, 容器高/设计高) 等比缩放并居中，四周留黑边。永远不裁切、永远不变形。
    _fit() {
      if (!this._vars) return
      var W = this.designWidth
      var H = this.designHeight
      var bare = this._bare()
      var railOn = !bare && this._railOn && !this.hasAttribute('no-rail') && this.clientWidth >= RAIL_MIN_STAGE
      var rail = railOn ? this._railW : 0
      var k = 1
      if (!this.hasAttribute('noscale')) {
        var vw = Math.max(0, this.clientWidth - rail)
        var vh = this.clientHeight
        if (vw > 0 && vh > 0) k = Math.min(vw / W, vh / H)
        if (!(k > 0) || !isFinite(k)) k = 1
      }
      // 缩略图几何：盒宽 = 栏宽减留白，盒高按设计比例，克隆缩放比 = 盒宽/设计宽。
      // 三个值都走自定义属性（继承穿得过嵌套 shadow），拖宽侧栏只改属性、不重解析样式表。
      var boxW = Math.max(0, rail - RAIL_PAD)
      var boxH = Math.round(boxW * H / W)
      var thumbK = W > 0 ? Math.round((boxW / W) * 100000) / 100000 : 0
      var appeared = railOn && !this._railShown
      this._railShown = railOn
      this._vars.textContent =
        ':host{--deck-w:' + W + 'px;--deck-h:' + H + 'px;--deck-k:' + (Math.round(k * 100000) / 100000) +
        ';--deck-rail:' + rail + 'px;--deck-thumb-w:' + boxW + 'px;--deck-thumb-h:' + boxH +
        'px;--deck-thumb-k:' + thumbK + '}' +
        this._printRule()
      if (this._rail) this._rail.classList.toggle('on', railOn)
      // 侧栏刚露面才去付克隆的代价（窄视口 / 演示 / noscale 全程零克隆）
      if (appeared) this._renderThumbs(true)
    }

    /** 演示模式 / noscale：隐藏全部组件 chrome */
    _bare() {
      return this._presenting || this.hasAttribute('noscale')
    }

    _syncChrome() {
      if (!this._hud) return
      if (this._bare()) {
        this._hud.classList.remove('on')
        this._hudOn = false
        if (this._hudTimer) { clearTimeout(this._hudTimer); this._hudTimer = null }
      }
      this._fit()
    }

    /**
     * 打印分页规则：除首个可打印页外每页强制 break-before。首页用 nth-child 免掉（选择器写在
     * shadow 里，光 DOM 不落任何内部标记——[data-screen-label] 的查询结果不许被我们污染）。
     */
    _printRule() {
      var pages = this._pages || []
      for (var i = 0; i < pages.length; i++) {
        if (pages[i].hasAttribute('data-deck-skip')) continue
        var nth = 0
        var kids = this.children
        for (var k = 0; k < kids.length; k++) { nth++; if (kids[k] === pages[i]) break }
        return '@media print{::slotted(:nth-child(' + nth + ')){break-before:auto!important}}'
      }
      return ''
    }

    /** 纸张尺寸 = 设计尺寸、零页边距。margin 用 !important 压过作者后写的 @page——任何非零
     *  边距都会让每页溢到第二张空白纸。 */
    _writePageRule() {
      var el = docStyle('page')
      if (!el) return
      el.textContent = '@page{size:' + this.designWidth + 'px ' + this.designHeight + 'px;margin:0!important}'
    }

    /** 把 @page 挪到 head 末尾：同特异性下后写的赢，作者的 helmet 样式是挂载后才注入的 */
    _raisePageRule() {
      var el = docStyle('page')
      var head = document.head || document.documentElement
      if (el && head && el !== head.lastChild) head.appendChild(el)
    }

    // ---- 打印：单页模式 ↔ 全页模式 ----
    // 打印时所有页同时上纸，只有当前页带 data-deck-active 的话，其余页会以入场动画的起始态
    // （通常是透明/位移后）印出来。全页模式让每一页都满足终态条件，打印结束后恢复原状。
    _allPages(on) {
      if (!this._pages || !this._pages.length) return
      if (on === this._printing) return
      this._printing = on
      var pages = this._pages
      var i
      if (on) {
        // 定格样式必须先于属性变更落地
        var fz = docStyle('freeze')
        if (fz) fz.textContent = FREEZE_CSS
        this._raisePageRule()
        this._holdAncestors(true)
        this._wasActive = []
        for (i = 0; i < pages.length; i++) {
          this._wasActive.push(pages[i].hasAttribute('data-deck-active'))
          if (!pages[i].hasAttribute('data-deck-skip')) pages[i].setAttribute('data-deck-active', '')
        }
      } else {
        for (i = 0; i < pages.length; i++) {
          if (this._wasActive && this._wasActive[i]) pages[i].setAttribute('data-deck-active', '')
          else pages[i].removeAttribute('data-deck-active')
        }
        this._wasActive = null
        this._holdAncestors(false)
        var f = docStyle('freeze')
        // 打印结束时若 noscale 仍在（同一窗口既截图又打印），定格要留给截图通道，不能一并清掉
        if (f) f.textContent = this.hasAttribute('noscale') ? FREEZE_CSS : ''
      }
    }

    /**
     * 祖先几何中和：满屏挂载点惯例是 height:100vh / overflow:hidden（流式运行时给百分比高度链
     * 用的确定高度），打印时会把 N 页的纸压成一屏。只在打印期改内联样式，结束即还原。
     */
    _holdAncestors(on) {
      if (on) {
        this._held = []
        var node = this.parentElement
        while (node) {
          this._held.push({ el: node, h: node.style.height, o: node.style.overflow })
          node.style.height = 'auto'
          node.style.overflow = 'visible'
          node = node.parentElement
        }
      } else if (this._held) {
        for (var i = 0; i < this._held.length; i++) {
          var it = this._held[i]
          it.el.style.height = it.h
          it.el.style.overflow = it.o
        }
        this._held = null
      }
    }

    // ---- 侧栏 ----
    _buildRail() {
      if (!this._list) return
      var html = ''
      for (var i = 0; i < this._pages.length; i++) {
        var skip = this._pages[i].hasAttribute('data-deck-skip')
        html += '<button type="button" class="thumb' + (skip ? ' skip' : '') + '" data-i="' + i + '">' +
          // inert + aria-hidden + pointer-events:none：缩略图是给眼睛看的一张画，
          // 里面克隆来的链接与按钮不许进 Tab 序、不许被点、不许进无障碍树。
          // 导航焦点始终在外层这个 .thumb 按钮上。
          '<span class="shot" aria-hidden="true"><span class="cage" inert></span></span>' +
          '<span class="meta"><span class="i">' + pad2(i + 1) + '</span>' +
          '<span class="t"></span>' +
          (skip ? '<span class="s">skip</span>' : '') + '</span>' +
          '</button>'
      }
      this._list.innerHTML = html
      // 屏名走 textContent 落地：作者的标题可能含 HTML 元字符，拼串会出转义事故
      var items = this._list.children
      for (var k = 0; k < items.length; k++) {
        var t = items[k].querySelector('.t')
        if (t) t.textContent = (this._pages[k].getAttribute('data-screen-label') || '').replace(/^\d+\s+/, '')
        items[k].classList.toggle('on', k === this._index)
      }
      this._thumbsBuilt = false
    }

    // ---- 缩略图 ----
    // 一张缩略图 = 该页的真克隆，装在条目自己的**嵌套 shadow** 里：
    //   往外——克隆与作者样式碰不到组件 chrome；
    //   往内——组件 chrome 的样式也碰不到克隆；
    //   对宿主——H-11/H-12 一字不松，光 DOM 仍然只有作者的页。
    // 一份镜像样式表由全部条目共享（constructable stylesheet 只解析一次），
    // 原件那套"每次调参重跑全量样式搬运 + 选择器改写"整块不需要。
    _sheet() {
      var css = mirrorCss() + THUMB_CSS
      if (css === this._css && this._cssSheet !== undefined) return this._cssSheet
      this._css = css
      try {
        var s = new CSSStyleSheet()
        s.replaceSync(css)
        this._cssSheet = s
      } catch (e) {
        this._cssSheet = null // 没有可构造样式表就退回每个条目一份 style 元素
      }
      return this._cssSheet
    }

    /** 侧栏没露面就一克隆都不做：窄视口预览、演示模式、noscale 导出通道全都零代价 */
    _renderThumbs(force) {
      if (!this._list || !this._railShown) return
      var before = this._css
      var sheet = this._sheet()
      // 样式没真变就不重画：head 里挪一下我们自己的 @page 也会触发观察者，别为它重扫全栏
      if (!force && this._thumbsBuilt && this._css === before) return
      var cages = this._list.querySelectorAll('.cage')
      for (var i = 0; i < cages.length && i < this._pages.length; i++) {
        this._fillCage(cages[i], this._pages[i], sheet)
      }
      this._thumbsBuilt = true
    }

    /** 只重画一张（翻页时刷新出入两页，别为一次击键重扫全栏） */
    _refreshThumb(i) {
      if (!this._list || !this._railShown || !this._thumbsBuilt) return
      var item = this._list.children[i]
      if (!item || !this._pages[i]) return
      var cage = item.querySelector('.cage')
      if (cage) this._fillCage(cage, this._pages[i], this._sheet())
    }

    _fillCage(cage, page, sheet) {
      var sr = cage.shadowRoot
      if (!sr) {
        try {
          sr = cage.attachShadow({ mode: 'open' })
        } catch (e) {
          return
        }
      }
      while (sr.firstChild) sr.removeChild(sr.firstChild)
      if (sheet) {
        try { sr.adoptedStyleSheets = [sheet] } catch (e) { sheet = null }
      }
      if (!sheet) {
        var st = document.createElement('style')
        st.textContent = this._css || THUMB_CSS
        sr.appendChild(st)
      }
      var w = document.createElement('div')
      w.className = 'w'
      w.appendChild(snapshot(page))
      sr.appendChild(w)
    }

    _drag(e) {
      var self = this
      var startX = e.clientX
      var startW = this._railW
      var move = function (ev) {
        self._railW = Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, startW + (ev.clientX - startX)))
        self._fit()
      }
      var up = function () {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        writePref({ w: self._railW, on: self._railOn })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      e.preventDefault()
    }

    // ---- 覆层显隐 ----
    _ping() {
      if (!this._hud || this._bare()) return
      this._hud.classList.add('on')
      this._hudOn = true
      var self = this
      if (this._hudTimer) clearTimeout(this._hudTimer)
      this._hudTimer = setTimeout(function () {
        self._hud.classList.remove('on')
        self._hudOn = false
      }, HUD_IDLE_MS)
    }

    // ---- 输入 ----
    _key(e) {
      // 演示模式只是把 chrome 收起来，导航照常（人在演示时就靠键盘翻）；只有 noscale 这条
      // 导出通道要完全静默——那一刻页序由导出器用 goTo 说了算。
      if (!this._pages.length || this.hasAttribute('noscale')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return // 组合键让给宿主与浏览器
      var path = e.composedPath ? e.composedPath() : [e.target]
      if (typingTarget(path[0]) || typingTarget(document.activeElement)) return
      var k = e.key
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Spacebar') this._step(1, 'keyboard')
      else if (k === 'ArrowLeft' || k === 'PageUp') this._step(-1, 'keyboard')
      else if (k === 'Home') this._activate(0, 'keyboard')
      else if (k === 'End') this._activate(this._pages.length - 1, 'keyboard')
      else if (k >= '1' && k <= '9') this._activate(parseInt(k, 10) - 1, 'keyboard')
      else if (k === '0') this._activate(9, 'keyboard')
      // 无修饰的全局 R 是破坏性的（整份跳回第一页且不可撤销），且会和幻灯里自制的键盘交互
      // 撞车——收紧到「覆层可见时才生效」：用户刚动过鼠标才认这个键。
      else if ((k === 'r' || k === 'R') && this._hudOn) this._activate(0, 'keyboard')
      else return
      e.preventDefault()
    }

    /** 粗指针设备上点舞台左右半边翻页。精细指针（鼠标）不启用——桌面有键盘和覆层按钮，
     *  再劫持点击会把幻灯片里的交互内容废掉。 */
    _tap(e) {
      if (this.hasAttribute('noscale') || !this._pages.length) return
      try {
        if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return
      } catch (err) {
        return
      }
      var path = e.composedPath ? e.composedPath() : [e.target]
      if (interactiveInPath(path, this._stage)) return
      if (this._rail && this._rail.contains(e.target)) return
      if (this._hud && this._hud.contains(e.target)) return
      var rect = this.getBoundingClientRect()
      if (!rect.width) return
      this._step(e.clientX - rect.left < rect.width / 2 ? -1 : 1, 'tap')
    }

    /** 我方唯一在用的入站消息：进入演示模式（隐藏一切 chrome），PPTX 截图链路用（H-7）。
     *  发送方是 dc-pptx-export.ts 的注入脚本，键名两边必须同步改。 */
    _msg(e) {
      var d = e && e.data
      if (!d || typeof d !== 'object' || !('__openpipal_presenting' in d)) return
      this._presenting = !!d.__openpipal_presenting
      this._syncChrome()
    }
  }

  window.customElements.define('deck-stage', DeckStage)
})()
