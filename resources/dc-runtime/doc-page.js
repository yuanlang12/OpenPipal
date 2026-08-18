/**
 * doc-page —— OpenPipal 自研的分页文档壳（零依赖、自注册 Web Component，无 React / 无 Babel / 无构建步骤）。
 *
 * 把一段普通 HTML 变成「屏幕上好读、打印与导 PDF 时排版正确」的文档，让内容作者只写内容：
 *   A 连续流（默认）——一张长纸连续滚动；打印时由引擎按用户真实纸张分页，组件负责每页边距与断页卫生。
 *   B 显式分页（存在 .page 直接子元素）——屏幕一页一卡片；打印时一个 .page 恰好一张纸，超出裁切。
 * 纸张几何、@page、break-* 全部由本组件持有；内容侧不该自己写打印 CSS。
 *
 * 用法：helmet 里挂一句 script src="./doc-page.js"（宿主内联进单文档），正文直接写 <doc-page>…</doc-page>。
 */
(function () {
  'use strict'

  if (typeof window === 'undefined' || !window.customElements) return
  if (window.customElements.get('doc-page')) return

  // ---- 长度换算：内部统一用英寸（纸张的天然单位，CSS px 恒为 1/96in）----
  var PER_INCH = { px: 1 / 96, in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6, q: 1 / 101.6 }
  // 纸张保留原生单位字面量（A4 写 210mm 而非折算英寸），@page 与页框少一次换算误差
  var PAPERS = { letter: ['8.5in', '11in'], legal: ['8.5in', '14in'], a4: ['210mm', '297mm'] }
  var DESK_GAP = 24 // 屏幕上纸与纸、纸与桌面边缘的间距（px）

  /** 解析绝对 CSS 长度 → 英寸；相对单位（em/%/vh…）在纸上没有稳定含义，一律判为无效 */
  function len(value) {
    if (value == null) return NaN
    var s = String(value).trim().toLowerCase()
    if (s === '0') return 0
    var m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|in|cm|mm|pt|pc|q)$/.exec(s)
    return m ? parseFloat(m[1]) * PER_INCH[m[2]] : NaN
  }

  /** margin 属性：按 CSS 简写规则收成 [上, 右, 下, 左]（英寸） */
  function box(value, fallback) {
    var parts = String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean).map(len)
    if (!parts.length || parts.some(isNaN)) parts = [fallback]
    var t = parts[0]
    var r = parts.length > 1 ? parts[1] : t
    var b = parts.length > 2 ? parts[2] : t
    var l = parts.length > 3 ? parts[3] : r
    return [t, r, b, l]
  }

  function inch(v) {
    return (Math.round((v || 0) * 10000) / 10000) + 'in'
  }

  // ---- 文档级样式（注入 document.head）----
  // 分两块：base 是与元素无关的排版/断页默认值，只写一次；page 是 @page 几何，由首个 doc-page 持有。
  // 契约：@page 必须在 connectedCallback 内落地——导出走 data: URL + printToPDF({preferCSSPageSize:true})，
  // 不存在 file:// 与二次时机。
  var PAGE_OWNER = null

  function docStyle(kind) {
    var head = document.head || document.documentElement
    var el = head.querySelector('style[data-doc-page="' + kind + '"]')
    if (!el) {
      el = document.createElement('style')
      el.setAttribute('data-doc-page', kind)
      head.appendChild(el)
    }
    return el
  }

  // 全部落在 :where() 里 → 零特异性，作者声明的任何值都能覆盖；只有打印期的纸张几何用 !important 钉死。
  var BASE_DOC_CSS = [
    ':where(html){background:var(--doc-page-desk,#e8e6df)}',
    ':where(body){margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,',
    '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6;color:#181a1f}',
    ':where(doc-page) :where(img){max-width:100%;height:auto}',
    ':where(doc-page) :where(pre){white-space:pre-wrap;overflow-wrap:anywhere}',
    ':where(doc-page) :where(table){max-width:100%}',
    ':where(doc-page) :where(h1,h2,h3,h4,h5,h6){text-wrap:balance}',
    ':where(doc-page) :where(p,li){text-wrap:pretty}',
    '@media print{',
    'html,body{margin:0!important;padding:0!important;background:#fff!important}',
    // 断页卫生：图/代码块/图片/表格行不许被切开；段落与列表项不许留孤行寡行；标题不许落在页底
    ':where(doc-page) :where(figure,pre,img,svg,blockquote,tr,thead,tfoot){break-inside:avoid}',
    ':where(doc-page) :where(p,li){orphans:3;widows:3}',
    ':where(doc-page) :where(h1,h2,h3,h4,h5,h6){break-after:avoid}',
    '}'
  ].join('')

  // ---- shadow 内的壳样式 ----
  // 内容留在 light DOM 用 <slot> 投影：文档级 <style>（设计 token、print-color-adjust）必须还能作用到正文。
  var SHELL_CSS = [
    ':host{display:block;box-sizing:border-box;background:var(--doc-page-desk,#e8e6df);',
    'print-color-adjust:exact;-webkit-print-color-adjust:exact}',
    ':host([hidden]){display:none}',
    '.desk,.sheet,.hdr,.ftr,.fit,.sp,table,td{box-sizing:border-box}',
    '.desk{zoom:var(--dp-zoom,1);display:flex;flex-direction:column;align-items:center;padding:var(--dp-gap) 0}',
    '.sheet{width:var(--dp-paper-w)}',
    '.paper{background:#fff;border-radius:2px;box-shadow:0 1px 2px rgba(16,18,22,.10),0 12px 30px rgba(16,18,22,.13)}',

    // A 连续流：左右边距由纸自身 padding 给；上下边距由表格的 thead/tfoot 占位行给——
    // 它们在打印时每页重复，于是每一页（不只首末页）都有正确的上下留白。
    '.flow-sheet{padding:0 var(--dp-mr) 0 var(--dp-ml)}',
    '.flow{width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0}',
    '.flow td{padding:0;vertical-align:top}',
    '.sp{display:block}',
    '.sp-h{height:var(--dp-mt)}',
    '.sp-f{height:var(--dp-mb)}',
    '.hdr,.ftr{display:none}',
    // 页眉下缘 / 页脚上缘不加组件自己的间距：占位高度 = 页眉实际高度，正文紧接其下起排。
    // 要更大间隔由作者在页眉或正文上自己写 padding/margin。
    '.has-hdr .hdr{display:block;padding:var(--dp-mt) 0 0}',
    '.has-ftr .ftr{display:block;padding:0 0 var(--dp-mb)}',
    '.has-hdr .sp-h{height:0}',
    '.has-ftr .sp-f{height:0}',

    // content-width/height：固定尺寸设计整体缩放贴合纸张，水平居中、顶对齐，页框不变
    '.fit-sheet{width:var(--dp-paper-w);height:var(--dp-paper-h);overflow:hidden;',
    'padding:var(--dp-mt) var(--dp-mr) var(--dp-mb) var(--dp-ml)}',
    // 居中位移由 JS 算好：内容比可打印区宽时 margin:0 auto 在打印分栏里的解算不可靠
    '.fit{width:var(--dp-cw);height:var(--dp-ch);transform-origin:top left;',
    'transform:translateX(var(--dp-fit-x,0)) scale(var(--dp-fit,1))}',

    // B 显式分页：一页一卡片
    '.stack{display:flex;flex-direction:column;align-items:center;gap:var(--dp-gap);width:auto}',
    '::slotted(.page){box-sizing:border-box!important;width:var(--dp-paper-w)!important;',
    'height:var(--dp-paper-h)!important;flex:none;',
    'overflow:hidden;background:#fff;border-radius:2px;container-type:size;',
    'box-shadow:0 1px 2px rgba(16,18,22,.10),0 12px 30px rgba(16,18,22,.13)}',

    '@media print{',
    ':host{background:transparent}',
    '.desk{zoom:1;display:block;padding:0}',
    '.sheet{width:auto}',
    '.paper{box-shadow:none;border-radius:0}',
    '.stack{display:block}',
    // 页眉页脚脱离文档流钉在纸上（每页重复），正文由 thead/tfoot 占位行让出等高空间
    '.has-hdr .hdr{position:fixed;top:0;left:0;right:0;padding:var(--dp-mt) var(--dp-mr) 0 var(--dp-ml)}',
    '.has-ftr .ftr{position:fixed;bottom:0;left:0;right:0;padding:0 var(--dp-mr) var(--dp-mb) var(--dp-ml)}',
    '.has-hdr .sp-h{height:var(--dp-hdr-h,1in)}',
    '.has-ftr .sp-f{height:var(--dp-ftr-h,1in)}',
    '.fit-sheet{width:var(--dp-paper-w);height:var(--dp-paper-h)}',
    '::slotted(.page){box-shadow:none;border-radius:0;margin:0!important;overflow:hidden!important;',
    'break-after:page;break-inside:avoid}',
    '::slotted(.page:last-child){break-after:auto}',
    '}'
  ].join('')

  function slotFilled(slot) {
    if (!slot) return false
    var nodes = slot.assignedNodes({ flatten: true })
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 1) return true
      if (nodes[i].nodeType === 3 && nodes[i].textContent.trim()) return true
    }
    return false
  }

  class DocPage extends HTMLElement {
    static get observedAttributes() {
      return ['size', 'orientation', 'width', 'height', 'content-width', 'content-height', 'margin']
    }

    connectedCallback() {
      if (!this.shadowRoot) {
        var root = this.attachShadow({ mode: 'open' })
        var shell = document.createElement('style')
        shell.textContent = SHELL_CSS
        this._vars = document.createElement('style')
        this._desk = document.createElement('div')
        this._desk.className = 'desk'
        root.appendChild(shell)
        root.appendChild(this._vars)
        root.appendChild(this._desk)
        this._zoom = 1
        this._hdrH = 0
        this._ftrH = 0
      }
      docStyle('base').textContent = BASE_DOC_CSS

      // 流式解析时 connectedCallback 早于子节点到达（宿主把本文件内联进 <head>），
      // 分页模式必须随 childList 重算，否则一篇 .page 文档会被永久当成连续流。
      if (!this._mo) {
        var self = this
        this._mo = new MutationObserver(function () { self._schedule() })
        this._mo.observe(this, { childList: true })
      }
      if (!this._ro && window.ResizeObserver) {
        var el = this
        this._ro = new ResizeObserver(function (entries) {
          el._fit(entries[entries.length - 1].contentRect.width)
        })
        this._ro.observe(this)
      }
      this.sync()
      if (document.fonts && document.fonts.ready) {
        var me = this
        document.fonts.ready.then(function () { me._measure() }, function () {})
      }
      if (document.readyState === 'loading') {
        var d = this
        document.addEventListener('DOMContentLoaded', function () { d.sync() }, { once: true })
      }
    }

    disconnectedCallback() {
      if (this._mo) { this._mo.disconnect(); this._mo = null }
      if (this._ro) { this._ro.disconnect(); this._ro = null }
    }

    // 元素升级时 attributeChangedCallback 先于 connectedCallback 触发，此时 shadow 骨架尚未建立
    attributeChangedCallback() {
      if (this._desk && this.isConnected) this.sync()
    }

    /** 合并同一帧内的多次子节点变化：流式追加内容时别让 sync 变成 O(节点数) */
    _schedule() {
      if (this._queued) return
      this._queued = true
      var self = this
      var run = function () { self._queued = false; self.sync() }
      if (window.requestAnimationFrame) window.requestAnimationFrame(run)
      else setTimeout(run, 0)
    }

    sync() {
      // 一份文档只有一条 @page：首个仍在场的 doc-page 持有它
      if (!PAGE_OWNER || !PAGE_OWNER.isConnected) PAGE_OWNER = this
      var g = this._geometry()
      if (g.mode !== this._mode) {
        this._render(g.mode)
        this._mode = g.mode
      }
      this._g = g
      if (PAGE_OWNER === this) docStyle('page').textContent = g.rule
      this._writeVars()
      this._fit(this.clientWidth)
      this._measure()
    }

    /** 由属性与内容推导出这份文档的全部几何事实 */
    _geometry() {
      var mode = this.querySelector(':scope > .page') ? 'pages' : 'flow'
      var cw = len(this.getAttribute('content-width'))
      var ch = len(this.getAttribute('content-height'))
      // 缩放贴合要求两者同时给出，否则无从算比例
      var fitting = mode === 'flow' && cw > 0 && ch > 0
      if (fitting) mode = 'fit'

      var paper = PAPERS[String(this.getAttribute('size') || '').trim().toLowerCase()] || PAPERS.letter
      var wCss = paper[0]
      var hCss = paper[1]
      if (/landscape/i.test(this.getAttribute('orientation') || '')) { var swap = wCss; wCss = hCss; hCss = swap }
      // 作者显式钉死的物理尺寸原样透传（保留其单位），避免多一次换算误差
      var aw = len(this.getAttribute('width'))
      var ah = len(this.getAttribute('height'))
      if (aw > 0) wCss = String(this.getAttribute('width')).trim()
      if (ah > 0) hCss = String(this.getAttribute('height')).trim()
      var w = len(wCss)
      var h = len(hCss)

      // 边距只属于 A 模式；B 模式恒为出血；贴合模式默认整纸贴合，作者显式写了 margin 才内缩
      var m = [0, 0, 0, 0]
      if (mode === 'flow') m = box(this.getAttribute('margin'), 0.75)
      else if (mode === 'fit' && this.hasAttribute('margin')) m = box(this.getAttribute('margin'), 0)

      var fit = 1
      var fitX = 0
      if (mode === 'fit') {
        var availW = w - m[1] - m[3]
        var availH = h - m[0] - m[2]
        fit = Math.min(availW / cw, availH / ch)
        if (!isFinite(fit) || fit <= 0) fit = 1
        fitX = (availW - cw * fit) / 2 // 水平居中；顶对齐所以没有纵向位移
      }

      // A 模式默认不钉纸张：打印引擎按用户真实纸张分页、内容重排，size 只管屏幕预览比例。
      // 作者显式给了 width+height（如 22×30 海报）、或走 B 模式 / 贴合模式（页框必须确定）才写 size。
      var pinned = aw > 0 && ah > 0 || mode !== 'flow'
      var rule = '@page{' + (pinned ? 'size:' + wCss + ' ' + hCss + ';' : '') + 'margin:0}'
      return {
        mode: mode, w: w, h: h, wCss: wCss, hCss: hCss, m: m,
        cw: cw, ch: ch, fit: fit, fitX: fitX, rule: rule
      }
    }

    _render(mode) {
      var html
      if (mode === 'pages') {
        html = '<div class="sheet stack" part="sheet"><slot></slot></div>'
      } else if (mode === 'fit') {
        html = '<div class="sheet paper fit-sheet" part="sheet"><div class="fit"><slot></slot></div></div>'
      } else {
        html =
          '<div class="sheet paper flow-sheet" part="sheet">' +
          '<div class="hdr"><slot name="header"></slot></div>' +
          '<table class="flow"><thead><tr><td><div class="sp sp-h"></div></td></tr></thead>' +
          '<tbody><tr><td><slot></slot></td></tr></tbody>' +
          '<tfoot><tr><td><div class="sp sp-f"></div></td></tr></tfoot></table>' +
          '<div class="ftr"><slot name="footer"></slot></div>' +
          '</div>'
      }
      this._desk.innerHTML = html
      this._sheet = this._desk.querySelector('.sheet')
      var slots = this._desk.querySelectorAll('slot')
      var self = this
      for (var i = 0; i < slots.length; i++) {
        slots[i].addEventListener('slotchange', function () { self._measure() })
      }
    }

    _writeVars() {
      var g = this._g
      if (!g || !this._vars) return
      this._vars.textContent =
        ':host{--dp-paper-w:' + g.wCss + ';--dp-paper-h:' + g.hCss +
        ';--dp-mt:' + inch(g.m[0]) + ';--dp-mr:' + inch(g.m[1]) +
        ';--dp-mb:' + inch(g.m[2]) + ';--dp-ml:' + inch(g.m[3]) +
        ';--dp-cw:' + inch(g.cw > 0 ? g.cw : 0) + ';--dp-ch:' + inch(g.ch > 0 ? g.ch : 0) +
        ';--dp-fit:' + (Math.round(g.fit * 10000) / 10000) + ';--dp-fit-x:' + inch(g.fitX) +
        ';--dp-gap:' + DESK_GAP + 'px' +
        ';--dp-zoom:' + this._zoom +
        ';--dp-hdr-h:' + this._hdrH + 'px;--dp-ftr-h:' + this._ftrH + 'px}'
    }

    /** 屏幕预览缩放贴合：容器比纸窄时整体缩小，纸永远完整可见（打印期 zoom 恒为 1，不影响出片） */
    _fit(width) {
      if (!this._g || !(width > 0)) return
      var need = this._g.w * 96
      var z = width >= need + 2 * DESK_GAP ? 1 : Math.max(0.2, (width - 8) / need)
      z = Math.round(z * 1000) / 1000
      if (Math.abs(z - this._zoom) < 0.002) return
      this._zoom = z
      this._writeVars()
      this._measure()
    }

    /** 量出页眉页脚实际高度，供打印期的 thead/tfoot 占位行让出等高空间 */
    _measure() {
      if (!this._sheet || this._mode !== 'flow') return
      var hdr = this._desk.querySelector('.hdr')
      var ftr = this._desk.querySelector('.ftr')
      var hasH = slotFilled(this._desk.querySelector('slot[name="header"]'))
      var hasF = slotFilled(this._desk.querySelector('slot[name="footer"]'))
      this._sheet.classList.toggle('has-hdr', hasH)
      this._sheet.classList.toggle('has-ftr', hasF)
      if (!hasH && !hasF) return
      // zoom 会一并缩放 getBoundingClientRect：拿「纸宽实测 ÷ 纸宽应有」反推真实缩放比，
      // 不依赖浏览器对 zoom 的度量口径。
      var k = 1
      var sheetW = this._sheet.getBoundingClientRect().width
      var want = this._g.w * 96
      if (sheetW > 0 && want > 0) k = sheetW / want
      if (!(k > 0.05)) k = 1
      this._hdrH = hasH ? Math.round(hdr.getBoundingClientRect().height / k) : 0
      this._ftrH = hasF ? Math.round(ftr.getBoundingClientRect().height / k) : 0
      this._writeVars()
    }
  }

  window.customElements.define('doc-page', DocPage)
})()
