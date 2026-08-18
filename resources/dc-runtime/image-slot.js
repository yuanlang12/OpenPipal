/**
 * image-slot —— OpenPipal 自研的「可填充图片位」（零依赖、自注册 Web Component，无 React / 无 Babel / 无构建步骤）。
 *
 * 模型做海报/传单/文档时，需要真实照片的位置本来只有两条路：等用户先发图（阻断），或画个灰色
 * 矩形交差（半成品）。这是第三条路——模型不必拥有图片就能把版式做完，用户在预览里把图拖进槽位
 * 即可补齐，且这次补齐是持久的：预览重开、导出 PDF / 独立 HTML / zip 都还在。
 *
 * 职责边界：图片的落盘、读回、随包携带是宿主自己的 sidecar 管线（chat-uploads.ts /
 * HtmlPreview.tsx / dc-export.ts / dc-headless.ts）。本组件只是这条管线的**展示端 + 采集端**：
 * 负责呈现、负责把用户拖进来的图交给宿主，不负责存储策略。
 *
 * 用法：helmet 里挂一句 script 指向 './image-slot.js'（宿主按引用内联/随包拷贝），正文直接写
 *   <image-slot id='hero' shape='rounded' placeholder='产品图 / product shot'></image-slot>
 * id 页内唯一——它就是持久化键。与 doc-page.js 同型（自注册，不走 x-import）。
 */
(function () {
  'use strict'

  if (typeof window === 'undefined' || !window.customElements) return
  // 幂等自注册：同一份源码可能经「流式预载通道」与「终稿内联」两条路重复进文档，
  // 重复 define 会抛 NotSupportedError 并带走整段脚本。与 doc-page/deck-stage 同款守卫。
  if (window.customElements.get('image-slot')) return

  // 宿主用正则扫**内联后的整篇文档**找这个 sidecar 基名，再经 IPC 读盘注入
  // window.__openpipalSidecarData。必须以字面量形式留在源码里——拼接/拆开/混淆掉，
  // 预览水合会静默失效（宿主什么都扫不到，也就什么都不注入）。
  var STATE_FILE = '.image-slots.state.json'

  // 写入前必须重编码降采样：图片以 dataURL 内嵌进 sidecar 本体，宿主对整份 sidecar 有 20MB 上限，
  // 一页多槽很快顶到。长边按「零售屏 2× 清晰」取（槽位通常 ≤600 CSS px），单槽落在 100–300KB。
  var MAX_EDGE = 1200
  var WEBP_QUALITY = 0.82
  var MAX_INPUT_BYTES = 40 * 1024 * 1024

  // 只收栅格位图。SVG 可携带脚本且解码行为不一致，一律拒收；GIF / 动图 WebP 这条管线只能留首帧，
  // 明确拒绝好过静默变成静帧。
  var ACCEPT_TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/avif': 1 }
  var ACCEPT_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' }
  var ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,image/avif'

  var TOAST_MS = 3200
  var DEFAULT_PLACEHOLDER = '拖入图片 / Drop an image'
  var MSG = {
    hint: '点击或拖入图片',
    svg: '不支持 SVG（可能带脚本），换 PNG / JPEG / WebP',
    anim: '不支持动图（这条管线只能留首帧），换静态图',
    type: '只收 PNG / JPEG / WebP / AVIF 图片',
    huge: '这张图太大了，先压一下再拖进来',
    decode: '这张图读不出来，换一张试试',
    save: '图已显示，但没能存进产物（重开预览会丢）'
  }

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) }
  function num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : d }
  function warn(msg) { try { console.warn('[image-slot] ' + msg) } catch (e) {} }

  // ---- 页级状态：一份 sidecar 服务页内全部槽位 ----
  // 读一次（全页共享），写是**整文件替换**语义（没有补丁/合并），因此表在内存里、每次改动整表落盘。
  var state = null
  var loading = null

  /** 宿主注入的内联副本：zip 产物 file:// 双击打开时相对 fetch 必败，退到这里 */
  function inlineState() {
    var bag = window.__openpipalSidecarData
    var txt = bag && typeof bag === 'object' ? bag[STATE_FILE] : null
    return typeof txt === 'string' ? txt : null
  }

  /**
   * 同一份 sidecar 也在 agent 写文件工具可达范围内——读回的值不保证出自本组件。
   * 非 data:image/ 开头的一律当空槽（绝不把来路不明的 URL 塞进 img）。
   */
  function parseState(text) {
    var obj = null
    try { obj = JSON.parse(text || '{}') } catch (e) { obj = null }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    var out = {}
    for (var k in obj) {
      if (!own(obj, k)) continue
      var v = obj[k]
      if (!v || typeof v !== 'object') continue
      if (typeof v.u !== 'string' || v.u.slice(0, 11) !== 'data:image/') continue
      // s/x/y 是取景（缩放 + 两轴偏移）。v1 只做 fit 两基线，取景照原样带回去，
      // 别把别的写入方（或将来的取景版本）已经存下的构图抹掉。
      out[k] = { u: v.u, s: num(v.s, 1), x: num(v.x, 0), y: num(v.y, 0) }
    }
    return out
  }

  function loadState() {
    if (loading) return loading
    loading = new Promise(function (resolve) {
      var done = function (text) {
        var loaded = parseState(text)
        // 读回执晚于用户拖图时，用户刚写下的条目优先——否则一次慢 fetch 会把刚填的图冲掉
        if (state) { for (var k in state) if (own(state, k)) loaded[k] = state[k] }
        state = loaded
        resolve(state)
      }
      var fallback = function () { done(inlineState()) }
      var f = window.fetch
      if (typeof f !== 'function') { fallback(); return }
      var p
      // 文档相对 fetch 优先（预览/headless 由宿主垫片截走；zip 服务式打开是真实同层文件）。
      // 无数据回 404 —— 404 是「空槽」，不是错误。
      try { p = f(STATE_FILE) } catch (e) { fallback(); return }
      if (!p || typeof p.then !== 'function') { fallback(); return }
      p.then(function (res) {
        if (!res || !res.ok) throw new Error('sidecar ' + (res ? res.status : 'no response'))
        return res.text()
      }).then(done, fallback)
    })
    return loading
  }

  function canPersist() {
    // 「可编辑」= 宿主 bridge 注入的 writeFile 是否在场。导出后的独立 HTML / PDF 隐藏窗口恒无此 API，
    // 组件据此进入只读呈现（不显示任何编辑 chrome）。
    var api = window.openpipal
    return !!(api && typeof api.writeFile === 'function')
  }

  // 单飞 + 合并的写队列：宿主不保证并发写的顺序，必须等回执再发下一次；
  // 回执期间攒下的多次改动合并成一次整表写（后写覆盖前写，本就没有补丁语义）。
  var writeBusy = false
  var writeDirty = false
  var writeWaiters = []

  function settle(list, ok) { for (var i = 0; i < list.length; i++) list[i](ok) }

  function pumpWrite() {
    if (writeBusy || !writeDirty) return
    writeDirty = false
    var waiters = writeWaiters
    writeWaiters = []
    var text
    try { text = JSON.stringify(state || {}) } catch (e) { settle(waiters, false); return }
    var p
    writeBusy = true
    try { p = window.openpipal.writeFile(STATE_FILE, text) } catch (e) { writeBusy = false; settle(waiters, false); return }
    Promise.resolve(p).then(function (ok) { return ok !== false }, function () { return false })
      .then(function (ok) { writeBusy = false; settle(waiters, ok); pumpWrite() })
  }

  function saveState() {
    if (!canPersist()) return Promise.resolve(false)
    return new Promise(function (resolve) {
      writeWaiters.push(resolve)
      writeDirty = true
      pumpWrite()
    })
  }

  // ---- 图片摄取：类型闸门 → 降采样重编码 → 解码完成再上屏 ----

  function fileType(file) {
    var t = String(file.type || '').toLowerCase()
    if (t) return t
    var m = /\.([A-Za-z0-9]+)$/.exec(file.name || '')
    var ext = m ? m[1].toLowerCase() : ''
    if (ext === 'svg') return 'image/svg+xml'
    if (ext === 'gif') return 'image/gif'
    return ACCEPT_EXT[ext] || ''
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader()
      fr.onload = function () { resolve(String(fr.result || '')) }
      fr.onerror = function () { reject(new Error('read failed')) }
      fr.readAsDataURL(file)
    })
  }

  /** RIFF 容器里 VP8X 扩展块的 flags 第 1 位 = ANIM：只有它能承载多帧，命中即动图 */
  function isAnimatedWebp(dataUrl) {
    if (dataUrl.indexOf(';base64,') < 0) return false
    var i = dataUrl.indexOf(',')
    var head = ''
    try { head = atob(dataUrl.slice(i + 1, i + 61)) } catch (e) { return false }
    return head.length > 20 && head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP' &&
      head.slice(12, 16) === 'VP8X' && (head.charCodeAt(20) & 2) === 2
  }

  function downscale(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image()
      img.onload = function () {
        var w = img.naturalWidth
        var h = img.naturalHeight
        if (!w || !h) { reject(new Error('empty raster')); return }
        var k = Math.min(1, MAX_EDGE / Math.max(w, h))
        var cw = Math.max(1, Math.round(w * k))
        var ch = Math.max(1, Math.round(h * k))
        var cv = document.createElement('canvas')
        cv.width = cw
        cv.height = ch
        var ctx = cv.getContext('2d')
        if (!ctx) { reject(new Error('no 2d context')); return }
        ctx.drawImage(img, 0, 0, cw, ch)
        var out = ''
        try { out = cv.toDataURL('image/webp', WEBP_QUALITY) } catch (e) { out = '' }
        // toDataURL 对不认识的格式会**静默回落成 PNG**，而 PNG 体积能把 20MB 上限一槽顶掉；
        // 认不出 webp 前缀就自己改用 JPEG。
        if (out.slice(0, 15) !== 'data:image/webp') {
          try { out = cv.toDataURL('image/jpeg', 0.85) } catch (e) { out = '' }
        }
        if (out.slice(0, 11) === 'data:image/') resolve(out)
        else reject(new Error('encode failed'))
      }
      img.onerror = function () { reject(new Error('decode failed')) }
      img.src = dataUrl
    })
  }

  /** 先在离屏图上解完码再上屏：浏览器在新图可画之前会继续画旧图，换图闪一下旧图就是这么来的 */
  function predecode(url) {
    var img = new Image()
    img.src = url
    if (typeof img.decode !== 'function') return Promise.resolve(url)
    return img.decode().then(function () { return url }, function () { return url })
  }

  // ---- shadow 内的壳样式 ----
  // 空态 chrome 一律走 currentColor + 透明度：深色底的海报/幻灯上，硬编码的近黑占位会整块看不见。
  var SHELL_CSS = [
    // 默认充满容器（典型用法是放进一个已定尺寸的包裹层）；父级高度不确定时 height:100% 解不出来、
    // 退化为 auto，此时 aspect-ratio 接管 → 整宽 + 固定宽高比，绝不塌成 0 高。
    // 元素自身的行内 width/height 天然覆盖这里（行内样式 > :host 规则）。
    ':host{display:block;position:relative;box-sizing:border-box;width:100%;height:100%;max-width:100%;',
    'aspect-ratio:var(--image-slot-ratio,3/2);color:inherit;print-color-adjust:exact;-webkit-print-color-adjust:exact}',
    ':host([hidden]){display:none}',
    // container-type 挂在盒子自己身上：占位文案按**槽位**大小缩放，而不是按外面那张纸——
    // 同一份版式里 120px 的头像位和半页大的主图位需要的字号本就不是一个量级。
    '.box{position:absolute;inset:0;overflow:hidden;box-sizing:border-box;display:flex;container-type:size;',
    'align-items:center;justify-content:center;border-radius:var(--is-radius,12px)}',
    '.box.act{cursor:pointer}',
    '.box.act:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    // 取景：object-fit 由浏览器随容器尺寸自动重算，响应式栅格/面板拖动都不会拉伸变形
    '.pic{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:var(--is-fit,cover);object-position:center}',
    '.box:not(.has-img) .pic{display:none}',
    '.box.busy .pic{visibility:hidden}',
    // 底色与虚线框各自独立成层：给了 mask 时只留底色（矩形虚线被任意多边形切开只会显得像坏了）
    '.tint{position:absolute;inset:0;background:currentColor;opacity:.05;border-radius:inherit}',
    '.frame{position:absolute;inset:0;border:1.5px dashed currentColor;opacity:.38;border-radius:inherit;pointer-events:none}',
    '.box.has-img .tint,.box.has-img .frame,.box.masked .frame{display:none}',
    '.ring{position:absolute;inset:0;border:2px solid currentColor;opacity:0;border-radius:inherit;',
    'pointer-events:none;transition:opacity .12s ease}',
    '.box.over .ring{opacity:.85}',
    '.box.over .tint{opacity:.12}',
    '.ph{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;',
    'gap:.4em;padding:6px 8px;max-width:100%;text-align:center;pointer-events:none;',
    'font:inherit;font-size:clamp(10px,7cqmin,16px);line-height:1.35}',
    '.box.has-img .ph{display:none}',
    '.ico{width:2.2em;height:2.2em;opacity:.5;flex:none}',
    '.label{opacity:.72;overflow-wrap:anywhere}',
    '.hint{opacity:.45;font-size:.85em}',
    // 小槽位（头像/图标位）里塞不下三行：先丢引导语，再丢图标，保住占位文案本身
    '@container (max-width:150px) or (max-height:110px){.hint{display:none}.ico{width:1.5em;height:1.5em}}',
    '@container (max-width:96px) or (max-height:72px){.ico{display:none}}',
    // 工具条 hover 才出现：隐藏窗口没有指针，PPTX/MP4 的整页截图天然拍不到它
    '.tools{position:absolute;top:6px;right:6px;display:flex;gap:4px;opacity:0;transition:opacity .12s ease}',
    '.box:hover .tools,.tools:focus-within{opacity:1}',
    '.btn{font:inherit;font-size:11px;line-height:1;padding:5px 8px;border-radius:6px;cursor:pointer;',
    'border:1px solid rgba(255,255,255,.28);background:rgba(20,20,22,.72);color:#fff;',
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
    '.btn:hover{background:rgba(20,20,22,.88)}',
    // 指示器的类名不能与盒子的状态类同名：同名时 .load 的规则会连盒子一起命中（等特异性、后来居上），
    // 换图期间整个槽位直接消失。
    '.load{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none}',
    '.box.busy .load{display:flex}',
    '.spin{width:22px;height:22px;border-radius:50%;border:2px solid currentColor;opacity:.35;',
    'border-top-color:transparent;animation:is-spin .8s linear infinite}',
    '@keyframes is-spin{to{transform:rotate(360deg)}}',
    // 减少动效偏好下不强推旋转：静态圆环同样是「在忙」的指示
    '@media (prefers-reduced-motion:reduce){.spin{animation:none}}',
    '.tip{position:absolute;left:6px;right:6px;bottom:6px;padding:6px 8px;border-radius:6px;',
    'font:inherit;font-size:11px;line-height:1.3;text-align:center;background:rgba(20,20,22,.82);',
    'color:#fff;opacity:0;transition:opacity .15s ease;pointer-events:none}',
    '.tip.on{opacity:1}',
    '.file{display:none}',
    // 屏幕专用 chrome 不许被打印进 PDF；占位文案要留下——只读分享里一个纯空框会被当成渲染 bug
    '@media print{.tools,.load,.tip,.ring,.hint{display:none!important}}'
  ].join('')

  var ICON =
    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/>' +
    '<circle cx="8.6" cy="10" r="1.7"/><path d="M3.4 16.8 8.9 11.6l3.9 3.7 3.1-2.6 4.7 4.1"/></svg>'

  var MARKUP =
    '<div class="box" part="box">' +
    '<div class="tint"></div>' +
    '<img class="pic" part="image" alt="">' +
    '<div class="ph" part="placeholder">' + ICON +
    '<span class="label"></span><span class="hint"></span></div>' +
    '<div class="frame"></div><div class="ring"></div>' +
    '<div class="load"><div class="spin"></div></div>' +
    '<div class="tip" role="status" aria-live="polite"></div>' +
    '<div class="tools"></div>' +
    '</div>'

  function radiusOf(el) {
    var shape = String(el.getAttribute('shape') || 'rounded').trim().toLowerCase()
    if (shape === 'rect') return '0'
    if (shape === 'pill') return '999px'
    if (shape === 'circle') return '50%' // 非正方槽位上得到的是椭圆，这是 circle 的定义
    var r = num(el.getAttribute('radius'), 12)
    return (r >= 0 ? r : 12) + 'px'
  }

  class ImageSlot extends HTMLElement {
    static get observedAttributes() {
      return ['id', 'shape', 'radius', 'mask', 'fit', 'placeholder', 'src']
    }

    connectedCallback() {
      if (!this.shadowRoot) this._build()
      this._sync()
      this._wire()
      if (!this._hydrated) {
        this._hydrated = true
        var self = this
        // 一个槽位读不出来不能带走整张海报：失败只写控制台，页面按空槽继续
        loadState().then(function (m) { self._applyState(m) }, function (e) { warn('sidecar 读取失败：' + e); self._paintFallback() })
      }
    }

    attributeChangedCallback(name) {
      if (!this.shadowRoot) return
      this._sync()
      // id 换了 = 换了持久化键；src 被宿主改写成 data URI 后也要重渲染（uploads/xxx.png 的既有改写）
      if ((name === 'id' || name === 'src') && this._hydrated && !this._busyFlag) this._applyState(state || {})
    }

    _build() {
      var root = this.attachShadow({ mode: 'open' }) // open 是硬要求：宿主 E2E 要穿进来选 img
      var style = document.createElement('style')
      style.textContent = SHELL_CSS
      root.appendChild(style)
      var wrap = document.createElement('div')
      wrap.innerHTML = MARKUP
      root.appendChild(wrap.firstChild)
      this._box = root.querySelector('.box')
      this._pic = root.querySelector('.pic')
      this._label = root.querySelector('.label')
      this._hint = root.querySelector('.hint')
      this._tip = root.querySelector('.tip')
      this._tools = root.querySelector('.tools')
      this._depth = 0
      var self = this
      this._pic.addEventListener('error', function () {
        // 裂图/空白框都不如退回空占位态（仍可拖入）。has-img 门控同时兜住"清空 src 反过来
        // 再触发一次 error"的自激循环。
        if (!self._box.classList.contains('has-img')) return
        warn('图片加载失败，退回占位态' + (self.id ? '（' + self.id + '）' : ''))
        self._paint('')
      })
    }

    /** 由属性推导外形与取景基线；clip-path 走 CSSOM 赋值（非法值被浏览器自己丢掉，不会污染样式表） */
    _sync() {
      var box = this._box
      box.style.setProperty('--is-radius', radiusOf(this))
      box.style.setProperty('--is-fit', String(this.getAttribute('fit') || '').trim().toLowerCase() === 'contain' ? 'contain' : 'cover')
      var mask = this.getAttribute('mask')
      box.style.clipPath = mask ? mask : ''
      box.classList.toggle('masked', !!(mask && box.style.clipPath))
      var ph = this.getAttribute('placeholder')
      var text = ph != null && ph !== '' ? ph : DEFAULT_PLACEHOLDER
      this._label.textContent = text
      this._pic.alt = text
    }

    /** 交互只在「可编辑」时挂：导出后的独立 HTML / PDF 里恒无 writeFile，槽位就该是纯呈现 */
    _wire() {
      var editable = canPersist()
      if (this._wired === editable) return
      if (!editable) return // 只读：不挂监听、不出 chrome（本会话内也不会由只读变可编辑）
      this._wired = true
      var self = this
      var box = this._box
      this._hint.textContent = MSG.hint

      var file = document.createElement('input')
      file.type = 'file'
      file.className = 'file'
      file.accept = ACCEPT_ATTR
      file.addEventListener('change', function () {
        var f = file.files && file.files[0]
        file.value = '' // 连选两次同一个文件也要触发 change
        if (f) self._ingest(f)
      })
      box.appendChild(file)
      this._file = file

      this._tools.appendChild(this._button('替换', 'Replace image', function () { file.click() }))
      this._tools.appendChild(this._button('清除', 'Clear image', function () { self._clear() }))

      box.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.btn')) return
        if (!box.classList.contains('has-img')) file.click()
      })
      box.addEventListener('keydown', function (e) {
        if (box.classList.contains('has-img')) return
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); file.click() }
      })
      // 子元素进出会各自触发 enter/leave —— 用深度计数，高亮才不会闪
      box.addEventListener('dragenter', function (e) { e.preventDefault(); self._depth++; box.classList.add('over') })
      box.addEventListener('dragover', function (e) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      })
      box.addEventListener('dragleave', function () { if (--self._depth <= 0) { self._depth = 0; box.classList.remove('over') } })
      box.addEventListener('drop', function (e) {
        e.preventDefault()
        self._depth = 0
        box.classList.remove('over')
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
        if (f) self._ingest(f)
      })
      this._reflectA11y()
    }

    _button(text, label, onClick) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'btn'
      b.textContent = text
      b.setAttribute('aria-label', label)
      b.addEventListener('click', function (e) { e.stopPropagation(); onClick() })
      return b
    }

    /** 空态是个真控件（可聚焦、可键盘触发）；填充后让位给工具条上的按钮，避免嵌套可点区 */
    _reflectA11y() {
      if (!this._wired) return
      var filled = this._box.classList.contains('has-img')
      this._box.classList.toggle('act', !filled)
      if (filled) {
        this._box.removeAttribute('tabindex')
        this._box.removeAttribute('role')
        this._box.removeAttribute('aria-label')
      } else {
        this._box.setAttribute('tabindex', '0')
        this._box.setAttribute('role', 'button')
        this._box.setAttribute('aria-label', this._label.textContent + '（点击或拖入图片）')
      }
      // 清除只对「用户填的图」有意义：回退图不归用户管
      var clr = this._tools.children[1]
      if (clr) clr.style.display = this._userUrl ? '' : 'none'
    }

    _applyState(map) {
      var id = this.getAttribute('id')
      var rec = id ? map[id] : null
      if (rec && rec.u) { this._userUrl = rec.u; this._paint(rec.u) } else { this._userUrl = ''; this._paintFallback() }
    }

    /** 用户的图盖住 src；清掉用户的图后 src 重新露出 */
    _paintFallback() {
      var src = this.getAttribute('src')
      this._paint(src ? src : '')
    }

    _paint(url) {
      if (url) {
        this._pic.src = url
        this._box.classList.add('has-img')
      } else {
        this._pic.removeAttribute('src')
        this._box.classList.remove('has-img')
      }
      this._reflectA11y()
    }

    _busy(on) {
      this._busyFlag = !!on
      this._box.classList.toggle('busy', !!on)
    }

    _toast(msg) {
      var tip = this._tip
      tip.textContent = msg
      tip.classList.add('on')
      clearTimeout(this._tipTimer)
      this._tipTimer = setTimeout(function () { tip.classList.remove('on') }, TOAST_MS)
    }

    /** 摄取失败一律「状态不变 + 就地非阻断提示」：原有的图和取景一动不动 */
    _reject(msg, detail) {
      this._busy(false)
      this._toast(msg)
      if (detail) warn(detail)
    }

    _ingest(f) {
      var t = fileType(f)
      if (t === 'image/svg+xml') return this._reject(MSG.svg)
      if (t === 'image/gif') return this._reject(MSG.anim)
      if (!ACCEPT_TYPES[t]) return this._reject(MSG.type)
      if (f.size > MAX_INPUT_BYTES) return this._reject(MSG.huge)
      var self = this
      // 首次填充不给指示器——占位态本身就是等待态，突然变成空白框反而是退步；
      // 换图才需要：新图能画之前旧图必须先不可见。
      if (this._box.classList.contains('has-img')) this._busy(true)
      readAsDataUrl(f).then(function (raw) {
        if (isAnimatedWebp(raw)) throw new Error('__anim__')
        return downscale(raw)
      }).then(predecode).then(function (url) {
        self._busy(false)
        self._userUrl = url
        self._paint(url)
        self._persist(url)
      }, function (err) {
        // 无论成功失败，指示器都必须落地，不得永久悬挂
        if (err && err.message === '__anim__') self._reject(MSG.anim)
        else self._reject(MSG.decode, 'ingest failed: ' + (err && err.message ? err.message : err))
      })
    }

    _persist(url) {
      var id = this.getAttribute('id')
      if (!id) {
        warn('没有 id 的槽位只在当前会话内可见，重开预览会丢失。给它一个页内唯一的 id。')
        return
      }
      if (!state) state = {}
      // v1 只做 fit 两基线，取景字段照常写出（存储形状被宿主测试钉死，也给取景版本留好位置）
      state[id] = { u: url, s: 1, x: 0, y: 0 }
      var self = this
      saveState().then(function (ok) { if (!ok) self._toast(MSG.save) })
    }

    _clear() {
      var id = this.getAttribute('id')
      if (id && state && own(state, id)) delete state[id]
      this._userUrl = ''
      this._paintFallback()
      var self = this
      saveState().then(function (ok) { if (!ok) self._toast(MSG.save) })
    }
  }

  window.customElements.define('image-slot', ImageSlot)
})()
