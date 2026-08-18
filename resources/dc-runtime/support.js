/**
 * support.js —— OpenPipal 自研的 Design Component 模板运行时（clean-room 实现，无第三方代码）。
 *
 * 把 x-dc 元素里的模板变成一棵 React 元素树挂到页面上。之所以要有运行时而不是直接写 JSX：
 * 模型是一个字符一个字符吐模板的，运行时必须能拿"还没写完的模板"渲染出像样的界面。
 *
 * 已实现到 **P4「外部组件」**（全部四期完成）：
 *   P1 骨架 —— 解析 x-dc → 空穴 {{ 点路径 }} → 属性/事件映射 → helmet → 挂载渲染；
 *   P2 逻辑与流式 —— DCLogic 逻辑类 + renderVals()、sc-if / sc-for、hint-* 占位微光、
 *      __dcUpdate 的 html / js 增量热更新；
 *   P3 宿主协议 —— data-props → __dc_booted 的 propsMeta、__dcSetProps / __dcUpdate('props')
 *      调参重放、style-hover 等伪态样式的按需规则生成；
 *   P4 外部组件 —— x-import（全局名/自定义元素解析、链式 from、hint-size 占位、四态加载机）、
 *      helmet 的 design_doc_mode 识别与 __dc_design_mode 上报（canvas 画板模式）。
 *
 * 三条贯穿全文的架构决定（流式增量全靠它们）：
 *   1. **核心是文本解析器，不是 DOM 遍历器**。流式泵送来的是模板"文本"，不是 DOM；
 *      文本进 → AST → React 树是同一条路，首帧和增量帧走的代码完全一样。
 *   2. **单一重渲染入口 renderEntry()**，永远渲染进同一个 React root。模板变了只是换一棵
 *      元素树，React 自己 reconcile——DOM 复用、无闪烁、不重建文档。
 *   3. **零网络**。缺 React 就明确报错，不去任何 CDN 取包；模板文本也只从本文档拿，
 *      不 fetch 自身 URL（srcdoc / file:// / data: 下那条路本来就走不通）。
 *
 * 硬约束：全文不得出现 script 结束标签的字面量——宿主会把本文件整体内联进 HTML，出现即截断脚本。
 */
;(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return

  // ==========================================================================
  // 0. 常量与小工具
  // ==========================================================================

  var TAG_ROOT = 'x-dc'
  var TAG_HELMET = 'helmet'
  var TAG_IMPORT = 'x-import'
  var HOST_CLASS = 'sc-host'
  var PLACEHOLDER_CLASS = 'sc-placeholder'
  var STREAMING_CLASS = 'sc-dc-streaming'
  var CANVAS_CLASS = 'sc-dc-canvas'
  var FILL_CLASS = 'sc-dc-fill'
  var LOG = '[dc]'

  var warned = {}

  /** 作者错误只报第一次——流式期间每帧都重解析，不去重会把控制台刷爆 */
  function warnOnce(key, msg) {
    if (warned[key]) return
    warned[key] = true
    try { console.warn(LOG + ' ' + msg) } catch (e) {}
  }

  /** 同一套去重，但走 error 通道：拿不到外部组件这类"这块画不出来"的事故不该混在告警里 */
  function errorOnce(key, msg) {
    if (warned[key]) return
    warned[key] = true
    try { console.error(LOG + ' ' + msg) } catch (e) {}
  }

  function errMsg(err) {
    return err && err.message ? err.message : String(err)
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key)
  }

  function set(list) {
    var out = {}
    for (var i = 0; i < list.length; i++) out[list[i]] = true
    return out
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]'
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v)
  }

  // ==========================================================================
  // 1. 实体解码
  // ==========================================================================
  // 模板文本有两个来源：DOM 序列化（浏览器已把 & < > 转义回实体）和流式原文（作者手写的
  // &mdash; 之类）。两条路都要还原成字符，否则要么屏上出现 &amp;，要么排版符号是乱的。

  var NAMED_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  var ENTITY_RE = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g
  var decoderEl = null

  /** 冷门具名实体交给浏览器解码：textarea 是 RCDATA，塞进去只解实体不会执行任何东西 */
  function decodeNamedSlow(raw) {
    try {
      if (!decoderEl) decoderEl = document.createElement('textarea')
      decoderEl.innerHTML = raw
      return decoderEl.value || raw
    } catch (e) {
      return raw
    }
  }

  function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s
    return s.replace(ENTITY_RE, function (raw, body) {
      if (body.charAt(0) === '#') {
        var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
        var code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return raw
        try { return String.fromCodePoint(code) } catch (e) { return raw }
      }
      return has(NAMED_ENTITY, body) ? NAMED_ENTITY[body] : decodeNamedSlow(raw)
    })
  }

  // ==========================================================================
  // 2. 模板文本解析器 → AST
  // ==========================================================================
  // 自己扫文本而不是交给浏览器 parser，有三个理由：
  //   a) 属性名大小写。HTML parser 会把 onClick 压成 onclick，React 就绑不上事件了；
  //      文本里写的是什么就是什么。
  //   b) 半截标签。流式尾部的 "<div cla" 必须整段丢掉，而不是喂给浏览器。
  //   c) 增量帧本来就是文本，没有 DOM 可遍历。
  //
  // AST 节点只有两种：{ type:'text', value } 和 { type:'el', tag, attrs, children }。

  var VOID_TAGS = set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'])
  // 内容按原文吃掉、不再当标记解析的元素
  var RAW_TEXT_TAGS = set(['script', 'style', 'textarea', 'title'])

  // 隐式闭合：作者漏写 </li> 是常态，不处理会让后面的兄弟节点全被吞进上一项
  var CLOSED_BY = {
    li: set(['li']),
    dt: set(['dt', 'dd']),
    dd: set(['dt', 'dd']),
    td: set(['td', 'th']),
    th: set(['td', 'th']),
    tr: set(['tr', 'td', 'th']),
    option: set(['option']),
    optgroup: set(['option', 'optgroup']),
    thead: set(['tr', 'td', 'th']),
    tbody: set(['tr', 'td', 'th', 'thead']),
    tfoot: set(['tr', 'td', 'th', 'thead', 'tbody'])
  }
  // p 会被任何块级开始标签隐式闭合
  var CLOSES_P = set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav',
    'main', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'form', 'fieldset', 'figure',
    'blockquote', 'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'address', 'details'])

  var ATTR_NAME_STOP = ' \t\n\r\f/>='
  var WS = ' \t\n\r\f'

  function isNameStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
  }

  /**
   * 从 '<' 之后的位置读一个开始标签。
   * 返回 null 表示标签没闭合（只可能出现在流式文本末尾）——调用方直接丢弃剩余文本。
   */
  function readOpenTag(src, i) {
    var n = src.length
    var start = i
    while (i < n && ATTR_NAME_STOP.indexOf(src.charAt(i)) === -1) i++
    var tag = src.slice(start, i)
    if (!tag) return null
    var attrs = []
    while (i < n) {
      while (i < n && WS.indexOf(src.charAt(i)) !== -1) i++
      if (i >= n) return null
      var c = src.charAt(i)
      if (c === '>') return { tag: tag, attrs: attrs, selfClose: false, end: i + 1 }
      if (c === '/' && src.charAt(i + 1) === '>') return { tag: tag, attrs: attrs, selfClose: true, end: i + 2 }
      if (c === '/' || c === '=') { i++; continue }
      var nameStart = i
      while (i < n && ATTR_NAME_STOP.indexOf(src.charAt(i)) === -1) i++
      var name = src.slice(nameStart, i)
      if (!name) { i++; continue }
      while (i < n && WS.indexOf(src.charAt(i)) !== -1) i++
      if (src.charAt(i) !== '=') { attrs.push({ name: name, value: null }); continue }
      i++
      while (i < n && WS.indexOf(src.charAt(i)) !== -1) i++
      if (i >= n) return null
      var q = src.charAt(i)
      var value
      if (q === '"' || q === "'") {
        var close = src.indexOf(q, i + 1)
        if (close === -1) return null
        value = src.slice(i + 1, close)
        i = close + 1
      } else {
        var vStart = i
        while (i < n && WS.indexOf(src.charAt(i)) === -1 && src.charAt(i) !== '>') i++
        value = src.slice(vStart, i)
      }
      attrs.push({ name: name, value: decodeEntities(value) })
    }
    return null
  }

  function parseTemplate(src) {
    var root = { type: 'el', tag: null, attrs: [], children: [] }
    var stack = [root]
    var i = 0
    var n = src.length

    function top() { return stack[stack.length - 1] }
    function pushText(text) {
      if (!text) return
      top().children.push({ type: 'text', value: decodeEntities(text) })
    }
    function closeImplied(tag) {
      for (;;) {
        var cur = top()
        if (!cur.tag) return
        var rule = CLOSED_BY[cur.tag]
        if (rule && rule[tag]) { stack.pop(); continue }
        if (cur.tag === 'p' && CLOSES_P[tag]) { stack.pop(); continue }
        return
      }
    }

    while (i < n) {
      var lt = src.indexOf('<', i)
      if (lt === -1) { pushText(src.slice(i)); break }
      if (lt > i) pushText(src.slice(i, lt))
      if (lt + 1 >= n) break // 流式尾巴上孤零零一个 '<'：丢掉，别让它当文本上屏
      var next = src.charAt(lt + 1)

      if (next === '!') {
        if (src.substr(lt, 4) === '<!--') {
          var ce = src.indexOf('-->', lt + 4)
          if (ce === -1) break // 半截注释：整段丢弃，下一帧会补齐
          i = ce + 3
        } else {
          var de = src.indexOf('>', lt)
          if (de === -1) break
          i = de + 1
        }
        continue
      }

      if (next === '/') {
        var ge = src.indexOf('>', lt)
        if (ge === -1) break
        var closing = src.slice(lt + 2, ge).trim().toLowerCase()
        for (var s = stack.length - 1; s > 0; s--) {
          if (stack[s].tag.toLowerCase() === closing) { stack.length = s; break }
        }
        i = ge + 1
        continue
      }

      if (!isNameStart(next)) { pushText('<'); i = lt + 1; continue }

      var open = readOpenTag(src, lt + 1)
      if (!open) break // 半截开始标签：丢掉尾巴，绝不把它交给浏览器
      var tagLower = open.tag.toLowerCase()
      closeImplied(tagLower)

      var node = { type: 'el', tag: open.tag, attrs: open.attrs, children: [] }
      top().children.push(node)
      i = open.end

      if (VOID_TAGS[tagLower] || open.selfClose) continue

      if (RAW_TEXT_TAGS[tagLower]) {
        // 原文吃到对应结束标签为止（结束标签串在这里拼出来，不写字面量）
        var endRe = new RegExp('</' + tagLower + '(?=[\\s/>])', 'ig')
        endRe.lastIndex = i
        var m = endRe.exec(src)
        var textEnd = m ? m.index : n
        if (textEnd > i) node.children.push({ type: 'text', value: src.slice(i, textEnd) })
        if (!m) break
        var rawGe = src.indexOf('>', m.index)
        i = rawGe === -1 ? n : rawGe + 1
        continue
      }

      stack.push(node)
    }

    return root.children
  }

  // ==========================================================================
  // 3. 空穴 {{ }}
  // ==========================================================================
  // 只做点路径查找与字面量，**不求值任何表达式**。理由是流式：半截表达式没法安全求值，
  // 而且允许表达式等于把模板变成第二套编程语言。所有计算都该在逻辑类里做完、按名暴露。

  var INTERP_RE = /\{\{([\s\S]*?)\}\}/g
  var PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\.\d+)*$/
  var NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/
  var KEYWORD = { 'true': true, 'false': false, 'null': null, 'undefined': undefined }

  /** 一段文本 → 片段数组：{ text } 静态串 / { path } 点路径 / { value } 字面量 / { bad } 表达式 */
  function parseParts(text) {
    if (!text || text.indexOf('{{') === -1) return null
    var parts = []
    var last = 0
    var m
    INTERP_RE.lastIndex = 0
    while ((m = INTERP_RE.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index) })
      parts.push(compileHole(m[1].trim()))
      last = m.index + m[0].length
    }
    if (!parts.length) return null
    if (last < text.length) parts.push({ text: text.slice(last) })
    return parts
  }

  function compileHole(src) {
    if (!src) return { bad: '' }
    if (has(KEYWORD, src)) return { value: KEYWORD[src] }
    if (NUMBER_RE.test(src)) return { value: parseFloat(src) }
    var q = src.charAt(0)
    if ((q === '"' || q === "'") && src.charAt(src.length - 1) === q && src.length >= 2) {
      return { value: src.slice(1, -1) }
    }
    if (PATH_RE.test(src)) return { path: src.split('.') }
    // 表达式：静默渲染为空，但控制台留证据——模型下一轮能自己改
    warnOnce('expr:' + src, '空穴只支持点路径与字面量，表达式不会求值（渲染为空）：{{ ' + src +
      ' }}。把计算放进逻辑类的 renderVals() 里，按名字暴露给模板。')
    return { bad: src }
  }

  /** 作用域用原型链串起来：P2 的 sc-for 只要 createScope(父作用域, { item, $index }) 就行 */
  function createScope(parent, extra) {
    var scope = parent ? Object.create(parent) : Object.create(null)
    if (extra) for (var k in extra) if (has(extra, k)) scope[k] = extra[k]
    return scope
  }

  function lookup(scope, path) {
    var cur = scope[path[0]]
    for (var i = 1; i < path.length; i++) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[path[i]]
    }
    return cur
  }

  function evalPart(part, scope) {
    if (has(part, 'text')) return part.text
    if (has(part, 'value')) return part.value
    if (has(part, 'path')) return lookup(scope, part.path)
    return undefined // bad：表达式，恒为空
  }

  /** 文本位置的取值语义与 React 对齐：null/undefined/布尔渲染成空，别把 "false" 印到屏幕上 */
  function toText(v) {
    if (v === null || v === undefined || typeof v === 'boolean') return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number') return isFinite(v) ? String(v) : ''
    return ''
  }

  function partsToString(parts, scope) {
    var out = ''
    for (var i = 0; i < parts.length; i++) out += toText(evalPart(parts[i], scope))
    return out
  }

  // ---- 渲染上下文：这一帧是流式还是终态 ----
  // 占位微光只在流式期间出现，终态要如实呈现"这个值就是空的"。
  // 不挂在作用域上（作用域是作者的命名空间，不该被运行时污染），也不能在 renderEntry 里设一次
  // 就完事——setState 触发的重渲染由 React 自己发起，根本不经过 renderEntry。于是每一趟渲染
  // 的入口（renderEntry / DCLogic.render）都先 beginRender 刷新它；单趟渲染是同步的，不会交错。
  // 当前正在渲染哪个根也记在这里：伪态规则要写进这个根自己的样式表（多根文档互不干扰）。
  var CTX = { streaming: false, entry: null }

  function beginRender(entry) {
    CTX.streaming = !!entry.streaming
    CTX.entry = entry
    entry.pseudo.gen++ // 新的一代：这趟渲染没登记到的伪态规则就是没人用了的，收尾时扫掉
  }

  /** 值没到时的占位块：宽高由 CSS 给，动画由 html.sc-dc-streaming 状态类驱动 */
  function placeholderEl(key) {
    return window.React.createElement('span', { className: PLACEHOLDER_CLASS, key: key })
  }

  // ==========================================================================
  // 4. 属性 → React props
  // ==========================================================================

  var ALIAS = { 'class': 'className', 'for': 'htmlFor' }

  // 多词事件的驼峰形。单词事件（onclick/onfocus/oninput…）按"on + 首字母大写"通用规则还原，
  // 不用列表。只有 DOM 事件名本身是多词或 React 改了名的才需要在这里登记。
  var EVENT_CASE = {
    ondblclick: 'onDoubleClick',
    onmousedown: 'onMouseDown', onmouseup: 'onMouseUp', onmousemove: 'onMouseMove',
    onmouseenter: 'onMouseEnter', onmouseleave: 'onMouseLeave',
    onmouseover: 'onMouseOver', onmouseout: 'onMouseOut',
    onkeydown: 'onKeyDown', onkeyup: 'onKeyUp', onkeypress: 'onKeyPress',
    ontouchstart: 'onTouchStart', ontouchend: 'onTouchEnd',
    ontouchmove: 'onTouchMove', ontouchcancel: 'onTouchCancel',
    onpointerdown: 'onPointerDown', onpointerup: 'onPointerUp', onpointermove: 'onPointerMove',
    onpointerenter: 'onPointerEnter', onpointerleave: 'onPointerLeave',
    onpointerover: 'onPointerOver', onpointerout: 'onPointerOut', onpointercancel: 'onPointerCancel',
    ondragstart: 'onDragStart', ondragend: 'onDragEnd', ondragenter: 'onDragEnter',
    ondragleave: 'onDragLeave', ondragover: 'onDragOver',
    oncontextmenu: 'onContextMenu', onbeforeinput: 'onBeforeInput',
    onanimationstart: 'onAnimationStart', onanimationend: 'onAnimationEnd',
    onanimationiteration: 'onAnimationIteration',
    ontransitionstart: 'onTransitionStart', ontransitionend: 'onTransitionEnd',
    oncompositionstart: 'onCompositionStart', oncompositionend: 'onCompositionEnd',
    oncompositionupdate: 'onCompositionUpdate',
    ontimeupdate: 'onTimeUpdate', onvolumechange: 'onVolumeChange',
    onratechange: 'onRateChange', ondurationchange: 'onDurationChange',
    onloadstart: 'onLoadStart', onloadeddata: 'onLoadedData',
    onloadedmetadata: 'onLoadedMetadata', oncanplay: 'onCanPlay',
    oncanplaythrough: 'onCanPlayThrough', onselectstart: 'onSelect'
  }

  function isEventName(lower) {
    return lower.length > 2 && lower.charAt(0) === 'o' && lower.charAt(1) === 'n'
  }

  /**
   * 属性名归一化。
   * 模板文本来自 DOM 序列化时属性名已被浏览器压成小写（onClick → onclick），React 就绑不上
   * 事件了——这里按事件表还原。只对"全小写"的名字动手，作者原样写的驼峰一律不碰。
   * 其余小写属性（tabindex/colspan/readonly…）本来就是合法 HTML 属性名，React 会原样落到
   * DOM 上，不需要还原。
   */
  function normalizeAttrName(name) {
    if (has(ALIAS, name)) return ALIAS[name]
    var lower = name.toLowerCase()
    if (has(ALIAS, lower) && name === lower) return ALIAS[lower]
    if (!isEventName(lower)) return name
    if (name !== lower) return name
    if (has(EVENT_CASE, lower)) return EVENT_CASE[lower]
    return 'on' + lower.charAt(2).toUpperCase() + lower.slice(3)
  }

  // ---- style 字符串 → React style 对象 ----

  /** 按 ';' 切声明，但要绕开 url(data:…;base64,…) 和引号里的分号 */
  function splitDecls(css) {
    var out = []
    var depth = 0
    var quote = ''
    var start = 0
    for (var i = 0; i < css.length; i++) {
      var c = css.charAt(i)
      if (quote) { if (c === quote) quote = ''; continue }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '(') depth++
      else if (c === ')') { if (depth > 0) depth-- }
      else if (c === ';' && depth === 0) { out.push(css.slice(start, i)); start = i + 1 }
    }
    out.push(css.slice(start))
    return out
  }

  function styleProp(name) {
    if (name.indexOf('--') === 0) return name // CSS 自定义属性原样保留
    var n = name
    var upperFirst = false
    if (n.charAt(0) === '-') {
      // 厂商前缀：React 要 WebkitTransform / MozAppearance，唯独 -ms- 是小写 msTransform
      upperFirst = n.slice(0, 4).toLowerCase() !== '-ms-'
      n = n.slice(1)
    }
    n = n.toLowerCase().replace(/-([a-z0-9])/g, function (m, c) { return c.toUpperCase() })
    return upperFirst ? n.charAt(0).toUpperCase() + n.slice(1) : n
  }

  function parseStyleString(css) {
    var out = {}
    var decls = splitDecls(css)
    for (var i = 0; i < decls.length; i++) {
      var d = decls[i].trim()
      if (!d) continue
      var colon = d.indexOf(':')
      if (colon <= 0) continue
      var key = d.slice(0, colon).trim()
      var value = d.slice(colon + 1).trim()
      if (!key || !value) continue
      out[styleProp(key)] = value
    }
    return out
  }

  function toStyleValue(v) {
    if (v && typeof v === 'object') return v
    if (typeof v === 'string') return parseStyleString(v)
    return undefined
  }

  // ---- 伪态样式 style-hover / style-active / style-focus / style-before / style-after ----
  // :hover / ::before 内联样式表达不了，只能生成真的 CSS 规则。三条设计决定：
  //   a) **按内容做键**。类名不绑元素而绑"这段声明文本"——列表里 100 行同样的 hover 只生成一条
  //      规则，作者改一个字就是另一条规则、旧的自然不再被引用。
  //   b) **按代清扫**。每趟渲染都重走整棵模板，于是"这一代没被登记过的规则"必然已经没有元素在用：
  //      流式期间旧模板的规则不会越积越多，同一节点更新后旧规则当场失效。
  //   c) **按需生成**。没有任何伪态属性时连 style 元素都不建，零开销。
  var PSEUDO_SEL = { hover: ':hover', active: ':active', focus: ':focus', before: '::before', after: '::after' }
  // 元素态要压过同一元素上的内联 style（内联特异性高于任何类规则），故整条规则加 !important；
  // 伪元素没有内联对手，不加——免得把作者 helmet 里的规则也一并锁死。
  var PSEUDO_FORCE = { hover: true, active: true, focus: true }
  var pseudoSeq = 0

  /** React style 对象 → CSS 文本（renderVals 直接返回样式对象时走这条） */
  function styleObjectToCss(obj) {
    var css = ''
    for (var k in obj) {
      if (!has(obj, k)) continue
      var v = obj[k]
      if (v === null || v === undefined || v === '') continue
      var name = k
      if (name.indexOf('--') !== 0) {
        name = name.replace(/([A-Z])/g, '-$1').toLowerCase()
        // WebkitTransform → -webkit-transform；msTransform 的首字母本来就是小写，单独补横杠
        if (k.charAt(0) >= 'A' && k.charAt(0) <= 'Z') name = '-' + name
        else if (/^ms[A-Z]/.test(k)) name = '-' + name
      }
      css += name + ':' + v + ';'
    }
    return css
  }

  function forceImportant(css) {
    var decls = splitDecls(css)
    var out = ''
    for (var i = 0; i < decls.length; i++) {
      var d = decls[i].trim()
      if (!d) continue
      out += (/!\s*important$/i.test(d) ? d : d + ' !important') + ';'
    }
    return out
  }

  /** 一段伪态声明 → 类名（同一份声明只生成一条规则） */
  function pseudoClass(entry, pseudo, css) {
    var reg = entry.pseudo
    var key = pseudo + '|' + css
    var rule = reg.rules[key]
    if (!rule) {
      // ::before / ::after 没有 content 就根本不显示——这是作者最常踩的一脚，默认补上空 content，
      // 作者自己写的 content 排在后面，照 CSS 后来居上覆盖掉这个默认值。
      var body = PSEUDO_FORCE[pseudo] ? forceImportant(css) : 'content:"";' + css
      rule = reg.rules[key] = { cls: 'sc-ps' + (++pseudoSeq), sel: PSEUDO_SEL[pseudo], body: body }
    }
    rule.gen = reg.gen
    return rule.cls
  }

  /** 一趟渲染收尾：扫掉上一代没被再次登记的规则，把剩下的写进这个根自己的 style 元素 */
  function flushPseudo(entry) {
    var reg = entry.pseudo
    var css = ''
    for (var k in reg.rules) {
      var r = reg.rules[k]
      if (r.gen !== reg.gen) { delete reg.rules[k]; continue }
      css += '.' + r.cls + r.sel + '{' + r.body + '}'
    }
    if (css === reg.css) return
    reg.css = css
    if (!reg.styleEl) {
      if (!css) return // 这份文档没用伪态：连 style 元素都不建
      var head = document.head || document.documentElement
      if (!head) return
      reg.styleEl = document.createElement('style')
      reg.styleEl.setAttribute('data-dc-pseudo', entry.name)
      head.appendChild(reg.styleEl)
    }
    reg.styleEl.textContent = css
  }

  /**
   * 编译期把属性拆成三类，渲染期只做取值——流式每帧重渲染时不重复分析字符串。
   *   kind 'static'  字面量
   *   kind 'whole'   整值 {{ path }}：原始值直传（数字/函数/对象不转字符串）
   *   kind 'interp'  插值串 "a {{ p }} b"
   */
  function compileAttrs(attrs) {
    var out = []
    for (var i = 0; i < attrs.length; i++) {
      var raw = attrs[i]
      var name = raw.name
      var lower = name.toLowerCase()
      if (lower.indexOf('hint-') === 0) continue // 流式占位提示，不是 DOM 属性
      var pseudo = ''
      if (lower.indexOf('style-') === 0) {
        pseudo = lower.slice(6)
        if (!has(PSEUDO_SEL, pseudo)) {
          warnOnce('pseudo:' + pseudo, '不认识的伪态属性 ' + name + '（已忽略）。' +
            '只支持 style-hover / style-active / style-focus / style-before / style-after。')
          continue
        }
      }
      var prop = pseudo ? name : normalizeAttrName(name)
      var value = raw.value
      if (value === null) { out.push({ prop: prop, kind: 'static', value: true, pseudo: pseudo }); continue }
      var parts = parseParts(value)
      if (!parts) { out.push({ prop: prop, kind: 'static', value: value, pseudo: pseudo }); continue }
      if (parts.length === 1 && !has(parts[0], 'text')) {
        out.push({ prop: prop, kind: 'whole', part: parts[0], pseudo: pseudo })
      } else {
        out.push({ prop: prop, kind: 'interp', parts: parts, pseudo: pseudo })
      }
    }
    return out
  }

  function buildProps(node, scope) {
    var compiled = node.props || (node.props = compileAttrs(node.attrs))
    if (!compiled.length) return null
    var props = {}
    var pseudoCls = null
    for (var i = 0; i < compiled.length; i++) {
      var a = compiled[i]
      var prop = a.prop
      var v = a.kind === 'static' ? a.value
        : a.kind === 'whole' ? evalPart(a.part, scope)
          : partsToString(a.parts, scope)

      if (a.pseudo) {
        var css = v && typeof v === 'object' ? styleObjectToCss(v) : v
        if (typeof css === 'string' && /\S/.test(css)) {
          if (!pseudoCls) pseudoCls = []
          pseudoCls.push(pseudoClass(CTX.entry, a.pseudo, css))
        }
        continue
      }
      if (prop === 'style') {
        var styleObj = toStyleValue(v)
        if (styleObj) props.style = styleObj
        continue
      }
      if (isEventName(prop.toLowerCase()) && prop.charAt(2) >= 'A' && prop.charAt(2) <= 'Z') {
        if (typeof v === 'function') props[prop] = v
        else if (v !== undefined && v !== null && v !== '') {
          warnOnce('handler:' + prop, prop + ' 的值不是函数，事件未绑定。事件必须写成整值空穴' +
            '（' + prop + '="{{ 处理函数 }}"），处理函数由逻辑类的 renderVals() 暴露。')
        }
        continue
      }
      if (v === undefined) continue
      props[prop] = v
    }
    // 伪态类名并在作者自己的 class 后面（作者的 class 先落，谁都不覆盖谁）
    if (pseudoCls) {
      var own = typeof props.className === 'string' && props.className ? props.className + ' ' : ''
      props.className = own + pseudoCls.join(' ')
    }
    return props
  }

  // ==========================================================================
  // 5. AST → React 元素
  // ==========================================================================

  var SKIP_IN_BODY = set(['script', 'style', 'link', 'meta', 'helmet', 'base'])

  // ---- 控制流：sc-for / sc-if ----
  // 两者都不产生自己的 DOM 元素，只往父级铺子节点；每一轮/每一支包一层带 key 的 Fragment，
  // React 才能按行复用 DOM（行内的输入框、动画不会因为列表长一项就全部重建）。
  // 没有 sc-else / sc-elif：用多个互斥的 sc-if（流式期间"另一支"本来就无从判断）。
  //
  // hint-* 不是装饰而是流式期间的占位依据：列表/条件的值还没到时，按作者给的提示先把骨架画出来。
  // 漏写 hint-* 的后果是该区域流式期间空白——最常见的作者错误，这里给出可见反馈。

  var MAX_PLACEHOLDER_ROWS = 50

  /** 取属性原文（大小写不敏感），没有返回 null */
  function rawAttr(node, name) {
    for (var i = 0; i < node.attrs.length; i++) {
      if (node.attrs[i].name.toLowerCase() === name) return node.attrs[i].value
    }
    return null
  }

  /** 整值空穴 "{{ path }}" → 片段；写成字面量或插值串则返回 null（控制流只接受整值） */
  function compileWhole(raw) {
    if (raw === null || raw === undefined) return null
    var parts = parseParts(raw)
    if (!parts || parts.length !== 1 || has(parts[0], 'text')) return null
    return parts[0]
  }

  function compileDirective(node, tagLower) {
    if (tagLower !== 'sc-for' && tagLower !== 'sc-if') return null
    if (tagLower === 'sc-if') {
      var value = compileWhole(rawAttr(node, 'value'))
      if (!value) warnOnce('scif:value', 'sc-if 的条件要写成整值空穴：value="{{ 条件 }}"。')
      return { kind: 'if', value: value, assume: compileWhole(rawAttr(node, 'hint-placeholder-val')) }
    }
    var list = compileWhole(rawAttr(node, 'list'))
    if (!list) warnOnce('scfor:list', 'sc-for 的数据源要写成整值空穴：list="{{ 数组 }}"。')
    var as = (rawAttr(node, 'as') || '').trim()
    if (!as) {
      warnOnce('scfor:as', 'sc-for 缺 as 属性，本轮变量按 "item" 命名。作用域变量名就是 as 的值。')
      as = 'item'
    }
    var rawCount = rawAttr(node, 'hint-placeholder-count')
    var count = parseInt(rawCount || '', 10)
    if (!isFinite(count) || count < 0) {
      if (rawCount) {
        warnOnce('scfor:count', 'hint-placeholder-count 要写成整数字面量（如 "3"），' +
          '"' + rawCount + '" 解析不出数字，流式期间这块仍是空白。')
      }
      count = 0
    }
    return { kind: 'for', list: list, as: as, count: Math.min(count, MAX_PLACEHOLDER_ROWS) }
  }

  /** 一轮循环的作用域：as 名字 + $index。值写成自有属性，原型链上的同名变量不会漏进来 */
  function loopScope(scope, name, value, index) {
    var extra = {}
    extra[name] = value
    extra.$index = index
    return createScope(scope, extra)
  }

  function renderDirective(node, dir, scope, index, out) {
    var React = window.React
    var i
    if (dir.kind === 'for') {
      var list = dir.list ? evalPart(dir.list, scope) : undefined
      if (Object.prototype.toString.call(list) === '[object Array]') {
        for (i = 0; i < list.length; i++) {
          out.push(React.createElement(React.Fragment, { key: 'r' + index + '_' + i },
            renderNodes(node.children, loopScope(scope, dir.as, list[i], i), [])))
        }
        return
      }
      if (list !== undefined && list !== null) {
        warnOnce('scfor:type', 'sc-for 的 list 不是数组（拿到 ' + typeof list + '），该块未渲染。')
        return
      }
      if (!CTX.streaming) return // 终态：数据就是没有，如实空着
      if (!dir.count) {
        warnOnce('scfor:hint', 'sc-for 没写 hint-placeholder-count，数据到达前这块是空白的。' +
          '加上 hint-placeholder-count="3" 之类的提示，流式期间就能先出骨架。')
        return
      }
      for (i = 0; i < dir.count; i++) {
        out.push(React.createElement(React.Fragment, { key: 'p' + index + '_' + i },
          renderNodes(node.children, loopScope(scope, dir.as, undefined, i), [])))
      }
      return
    }

    var cond = dir.value ? evalPart(dir.value, scope) : undefined
    if (cond === undefined) {
      if (!CTX.streaming) return
      if (!dir.assume) {
        warnOnce('scif:hint', 'sc-if 没写 hint-placeholder-val，条件到达前这块是空白的。' +
          '加上 hint-placeholder-val="{{ true }}" 之类的假设，流式期间就能先出骨架。')
        return
      }
      cond = evalPart(dir.assume, scope)
    }
    if (!cond) return
    out.push(React.createElement(React.Fragment, { key: 'c' + index },
      renderNodes(node.children, scope, [])))
  }

  function renderNodes(nodes, scope, out) {
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i], scope, i, out)
    return out
  }

  function renderNode(node, scope, index, out) {
    if (node.type === 'text') {
      var parts = has(node, 'parts') ? node.parts : (node.parts = parseParts(node.value))
      if (!parts) { out.push(node.value); return }
      // 空穴可以直接吐 React 元素（createElement 逃生舱口的产物），不能一律 toText 掉
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p]
        var v = evalPart(part, scope)
        // 路径查不到值 = 数据还没到：流式期间给一块占位微光，终态如实留空。
        // 表达式（bad）不给占位——它永远不会"到"，给了就是一块永不消失的假骨架。
        if (v === undefined && has(part, 'path')) {
          if (CTX.streaming) out.push(placeholderEl('h' + index + '_' + p))
          continue
        }
        if (v && typeof v === 'object' && window.React.isValidElement(v)) {
          out.push(window.React.cloneElement(v, { key: 'h' + index + '_' + p }))
        } else {
          out.push(toText(v))
        }
      }
      return
    }

    var tagLower = node.tag.toLowerCase()
    var dir = has(node, 'dir') ? node.dir : (node.dir = compileDirective(node, tagLower))
    if (dir) { renderDirective(node, dir, scope, index, out); return }
    if (tagLower === TAG_IMPORT) {
      // compileImport 会就地摘掉 x-import 的语法属性，必须先于 buildProps 的属性编译缓存
      renderImport(node, has(node, 'imp') ? node.imp : (node.imp = compileImport(node)), scope, index, out)
      return
    }
    if (SKIP_IN_BODY[tagLower]) {
      if (tagLower === 'style' || tagLower === 'script') {
        warnOnce('bodytag:' + tagLower, tagLower + ' 只能写在模板顶部的 helmet 里，正文中的已忽略。' +
          '样式请用内联 style；全局的 @font-face / @keyframes / reset 放 helmet。')
      }
      return
    }
    // 标签名原样传给 React：SVG 的 linearGradient / clipPath / foreignObject 这些是大小写敏感的，
    // 压成小写等于渲染出一个浏览器不认识的元素（渐变解析不出来、整块图形消失）。
    // 只有首字母大写才需要处理——那是不支持的组件标签写法。
    var tagName = node.tag
    if (tagName.charAt(0) >= 'A' && tagName.charAt(0) <= 'Z') {
      warnOnce('uppertag:' + tagName, '不支持大写组件标签 ' + tagName + '，已按小写元素渲染。' +
        '外部组件用 x-import 挂载。')
      tagName = tagLower
    }

    var props = buildProps(node, scope) || {}
    props.key = 'n' + index

    if (tagLower === 'textarea') {
      // React 不接受 textarea 有 children，文本内容要走 defaultValue
      var text = ''
      for (var t = 0; t < node.children.length; t++) {
        if (node.children[t].type === 'text') text += node.children[t].value
      }
      if (text && props.value === undefined && props.defaultValue === undefined) props.defaultValue = text
      out.push(window.React.createElement(tagName, props))
      return
    }

    if (VOID_TAGS[tagLower] || !node.children.length) {
      out.push(window.React.createElement(tagName, props))
      return
    }
    out.push(window.React.createElement(tagName, props, renderNodes(node.children, scope, [])))
  }

  // ==========================================================================
  // 5b. x-import：外部组件
  // ==========================================================================
  //     <x-import component-from-global-scope='deck-stage' from='./deck-stage.js'
  //               width='1920' height='1080' hint-size='100%,100%'> …子节点… </x-import>
  // （示例里的属性一律用单引号。本文件要被整体内联进产物 HTML，而宿主与单测都按
  //   「空格 + from + 等号 + 双引号」这个形状扫兄弟引用——写成双引号会被当成一条真引用。）
  //
  // **第一原则：容忍"东西已经在全局里"。** 产物跑在 srcdoc / file: / data: 里——没有可解析的
  // 相对路径，也没有模块加载器。宿主因此在装配阶段就按 from 的链序把兄弟预制件预载成全局
  // （renderer 内联 <script>、导出改写成 <script src>），到运行时手上时 from 多半已经被删掉、
  // 名字已经在场。于是这里只做"按名字取"，**绝不 fetch**：srcdoc 是 null origin，相对 fetch
  // 必然 CORS 红屏；零网络也是本运行时的硬约束（见文件头）。
  //
  // 链式 from（"./animations.jsx ./artifact-x.jsx"，后者依赖前者）的加载顺序同理归宿主：
  // 它按链序把脚本排进 head，浏览器顺序求值。运行时留着这条链只为两件事——
  //   a) 诊断：from 还在 = 宿主没能解析这条链；from 已删 = 预载了但没注册出这个名字。
  //      两种失败的修法完全不同，错误块要说得出是哪一种。
  //   b) 等待：宿主为链式引用注入了 window.__openpipalWaitForDcDependencies 门闩，
  //      boot 之前已经 await 过（见第九节 start）。
  //
  // 名字有两种落点，都从 window 这一侧解析：
  //   a) React 组件 —— window[名字] 是函数（或 memo / forwardRef 那种带 $$typeof 的对象）
  //   b) 自定义元素 —— deck-stage / doc-page 这类自注册 Web Component 带连字符，window 上
  //      根本不会有这个名字，得问 customElements；拿到就按标签名交给 React。
  // `component="导出名"`（模块具名导出的写法）走同一条：没有模块解析器，它在这个环境里
  // 只可能以全局形式到场。
  //
  // 四态加载机：
  //   未登记 → 首次渲染时查一次全局
  //   ready   → 真渲染（子节点作为 children 交给组件）
  //   pending → hint-size 尺寸的占位框（复用 P2 的 sc-placeholder），看门狗轮询，到场即重渲染
  //   failed  → 明确的错误块（不是白屏），且不再重试
  // pending 不看 streaming 标志：这不是"值还没到"，是组件还在装配路上，终态一样要出占位。

  // x-import 自己的语法属性，不透传给组件；其余（width / height / title / size…）原样交出去
  var IMPORT_OWN_ATTR = set(['component', 'component-from-global-scope', 'from', 'src', 'import',
    'data-openpipal-pending-from'])
  var IMPORT_WAIT_MS = 10000
  var importState = {}

  function cssLength(v) {
    return v && NUMBER_RE.test(v) ? v + 'px' : v
  }

  /** hint-size="宽,高" → { w, h }。裸数字补 px，"100%" / "402px" / "50vh" 原样 */
  function parseHintSize(raw) {
    if (!raw || !/\S/.test(raw)) return null
    var parts = String(raw).split(',')
    var w = cssLength(parts[0].trim())
    var h = cssLength((parts.length > 1 ? parts[1] : '').trim())
    return w || h ? { w: w, h: h } : null
  }

  function compileImport(node) {
    var viaGlobal = rawAttr(node, 'component-from-global-scope')
    var name = ((viaGlobal === null ? rawAttr(node, 'component') : viaGlobal) || '').trim()
    var chain = rawAttr(node, 'from')
    if (chain === null) chain = rawAttr(node, 'src')
    if (chain === null) chain = rawAttr(node, 'import')
    chain = (chain || '').trim()
    var imp = {
      name: name,
      chain: chain ? chain.split(/\s+/) : [],
      hint: parseHintSize(rawAttr(node, 'hint-size'))
    }
    // 语法属性就地摘掉，剩下的交给通用的 compileAttrs / buildProps 透传给组件
    var kept = []
    for (var i = 0; i < node.attrs.length; i++) {
      if (!IMPORT_OWN_ATTR[node.attrs[i].name.toLowerCase()]) kept.push(node.attrs[i])
    }
    node.attrs = kept
    if (!name) {
      // 告警文本里的属性同样用单引号：本文件会被整体内联进产物，宿主的兄弟件扫描器按双引号形状取名
      warnOnce('ximport:name', TAG_IMPORT + " 没写组件名：外部预制件写 component-from-global-scope='全局名'，" +
        "模块具名导出写 component='导出名'。")
    }
    return imp
  }

  /**
   * 顶层 x-import 声明了百分比高度 = "这个组件就是整个画面"（deck 舞台、动画舞台、场景件的
   * 惯用写法 hint-size="100%,100%"）。这类预制件的外层盒子惯例是 position:absolute;inset:0，
   * 撑不起任何祖先——而 P3 的 height 链在 body 高度为 auto 时整条退化成内容高，于是挂载点塌成
   * 0 高：宿主与用户都会看到"什么都没渲染出来"。作者用 hint-size 说明的正是"我要占满这一屏"，
   * 那就把这一屏给它。**只认顶层**：嵌在卡片里的 100% 是相对那张卡片说的，不该拽到视口。
   */
  function detectFullBleed(body) {
    for (var i = 0; i < body.length; i++) {
      var node = body[i]
      if (node.type !== 'el' || node.tag.toLowerCase() !== TAG_IMPORT) continue
      var hint = parseHintSize(rawAttr(node, 'hint-size'))
      if (hint && hint.h && hint.h.charAt(hint.h.length - 1) === '%') return true
    }
    return false
  }

  function lookupGlobalComponent(name) {
    var g = window[name]
    if (typeof g === 'function') return g
    if (g && typeof g === 'object' && g.$$typeof) return g // React.memo / forwardRef 的产物是对象
    try {
      if (window.customElements && window.customElements.get(name)) return name
    } catch (e) {}
    return null
  }

  /**
   * 看门狗：名字还没到就轮询等。预载脚本可能要等自己的依赖（场景件等 React + 引擎全就位才
   * 注册），自定义元素的 define 也可能排在 DOMContentLoaded 之后——这些都不是失败，是还没到。
   * 到场即整体重渲染（React 自己 reconcile，占位就地换成组件）；超时才落 failed。
   *
   * **流式进行中永不落 failed，只顺延**（2026-08-14 真机体验修正）：流式预览走泵通道、
   * 不重建 srcdoc，而宿主的兄弟件内联只发生在挂载帧与终稿重建——x-import 行晚于挂载帧
   * 流到时，这个活文档里脚本**必然**等不来。此时判"宿主没能解析"是拿不完整的证据下结论，
   * 用户会在生成中看到一张红色错误卡、直到终稿重建才消失。所以流式期只把 deadline 往后推，
   * 流收尾之后才开始真正的 10s 倒计时。失败分型的文案与判据一个字不改：headless / 导出 /
   * 自检语境 streaming 恒为 false，教学路径原样。
   */
  function importWatchdog(name) {
    var rec = importState[name] = { state: 'pending', comp: null, deadline: Date.now() + IMPORT_WAIT_MS }
    function tick() {
      if (rec.state !== 'pending') return
      var comp = lookupGlobalComponent(name)
      if (comp) { rec.state = 'ready'; rec.comp = comp } else {
        if (CTX.streaming) rec.deadline = Date.now() + IMPORT_WAIT_MS
        if (Date.now() < rec.deadline) {
          setTimeout(tick, 32)
          return
        }
        rec.state = 'failed'
      }
      rerenderAll()
    }
    setTimeout(tick, 32)
    return rec
  }

  function resolveImport(name) {
    var rec = importState[name]
    if (rec && rec.state === 'ready') return rec
    var comp = lookupGlobalComponent(name)
    if (comp) return (importState[name] = { state: 'ready', comp: comp })
    return rec || importWatchdog(name)
  }

  /**
   * 流式预载（__dcUpdate 的 kind='preload'，载荷 { key, code }）——"壳先起、内容依次进"。
   *
   * 流式预览走泵通道、不重建 srcdoc，兄弟预制件的脚本原本只有两个进文档的时机：挂载帧
   * （宿主内联那一刻已流到的引用）与终稿重建。deck 这类产物的 x-import 行前面还隔着整段
   * helmet 样式，几乎必然错过挂载帧——于是整个组件区域停在占位骨架，直到生成结束才"大爆炸"
   * 式一次出现。宿主一扫到完整引用就把源码经这条通道送进来，把这个窗口关掉。
   *
   * 按 key 去重（每文档一次），以 script 元素形态注入执行——与终稿内联同语义（顶层 var
   * 落在全局、document.currentScript 有值），预制件自带幂等守卫，重复到场安全跳过。
   * 注入后不用专门通知：看门狗 32ms 轮询下一 tick 自然拿到全局并整体重渲染。
   */
  var preloaded = {}

  function preloadSibling(payload) {
    var key = payload && payload.key != null ? String(payload.key) : ''
    var code = payload && typeof payload.code === 'string' ? payload.code : ''
    if (!key || !code) {
      try { console.error(LOG + ' __dcUpdate kind="preload": 载荷要有 key 与 code 两个字段，已丢弃。') } catch (e) {}
      return
    }
    if (has(preloaded, key)) return
    preloaded[key] = true
    var el = document.createElement('script')
    el.setAttribute('data-dc-preload', key)
    el.textContent = code
    // 内联脚本的同步异常不会从 appendChild 抛出来，只会走 window 的 error 事件——
    // 临时挂一个捕获期监听把它捞出来，免得预载失败变成静默白骨架（浏览器自己那条照常打印）。
    var failed = null
    var onErr = function (e) { failed = e && (e.error || e.message) }
    window.addEventListener('error', onErr, true)
    try {
      ;(document.head || document.documentElement).appendChild(el)
    } catch (err) {
      failed = err
    }
    window.removeEventListener('error', onErr, true)
    if (failed) {
      try { console.error(LOG + ' 预载 "' + key + '" 执行失败：' + errMsg(failed)) } catch (e) {}
    }
  }

  function importPlaceholder(imp, key) {
    var props = { className: PLACEHOLDER_CLASS, key: key }
    if (imp.hint) {
      var style = { display: 'block' }
      if (imp.hint.w) style.width = imp.hint.w
      if (imp.hint.h) style.height = imp.hint.h
      props.style = style
    } else {
      warnOnce('ximport:hint:' + imp.name, TAG_IMPORT + ' 没写 hint-size，外部组件就绪前这块只有一个' +
        '默认小占位，撑不出版面。加上 hint-size="100%,100%" 之类的尺寸提示。')
    }
    return window.React.createElement('span', props)
  }

  function importFailure(imp, key) {
    // 两种失败的修法完全不同，错误块必须说得出是哪一种
    var why = imp.chain.length
      ? '宿主没能解析并预载 ' + imp.chain.join(' → ') + '（运行时不联网取文件）。'
      : 'from 已被宿主删掉，但预载进来的脚本没有把这个名字注册到全局' +
        '（自定义元素请确认 customElements.define 的标签名与它一致）。'
    var msg = TAG_IMPORT + ' 拿不到外部组件 "' + imp.name + '"：' + why
    errorOnce('ximport:fail:' + imp.name, msg)
    return errorElement(msg, key)
  }

  function renderImport(node, imp, scope, index, out) {
    var key = 'x' + index
    if (!imp.name) {
      out.push(errorElement(TAG_IMPORT + ' 缺组件名（component-from-global-scope / component），无法挂载。', key))
      return
    }
    var rec = resolveImport(imp.name)
    if (rec.state === 'pending') { out.push(importPlaceholder(imp, key)); return }
    if (rec.state === 'failed') { out.push(importFailure(imp, key)); return }
    var props = buildProps(node, scope) || {}
    props.key = key
    // 子节点是组件的内容（幻灯片的 section、外框里的屏幕、动画的舞台内容），交给它自己安置——
    // 不交出去的话它们会退化成正文里的裸标记：看着渲出来了，其实外框/时间线一概没生效。
    if (!node.children.length) { out.push(window.React.createElement(rec.comp, props)); return }
    out.push(window.React.createElement(rec.comp, props, renderNodes(node.children, scope, [])))
  }

  // ==========================================================================
  // 6. helmet
  // ==========================================================================
  // helmet 是模板里唯一允许出现 script / style 的地方，本身不参与渲染。
  // 样式统一收进 head 里一个由运行时持有的 style 元素：P2 热更新时换内容即可，
  // 不会出现"旧规则还挂在 DOM 里和新规则打架"。
  // helmet 里的 script 不由运行时执行——文档路径下浏览器解析时已经跑过一遍了，再跑就是重复副作用。

  function splitHelmet(nodes) {
    var helmet = null
    var body = []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      if (node.type === 'el' && node.tag.toLowerCase() === TAG_HELMET) {
        if (helmet) { warnOnce('helmet:dup', '模板里有多个 helmet，只有第一个生效。'); continue }
        helmet = node
        // helmet 必须在最顶部：它前面只允许空白
        for (var j = 0; j < body.length; j++) {
          var prev = body[j]
          if (prev.type !== 'text' || /\S/.test(prev.value)) {
            warnOnce('helmet:pos', 'helmet 必须写在模板最顶部，否则字体/keyframes 可能晚于首帧生效。')
            break
          }
        }
        continue
      }
      body.push(node)
    }
    return { helmet: helmet, body: body }
  }

  function collectHelmetCss(helmet) {
    var css = ''
    if (!helmet) return css
    for (var i = 0; i < helmet.children.length; i++) {
      var node = helmet.children[i]
      if (node.type !== 'el' || node.tag.toLowerCase() !== 'style') continue
      for (var j = 0; j < node.children.length; j++) {
        if (node.children[j].type === 'text') css += node.children[j].value + '\n'
      }
    }
    return css
  }

  /** helmet 的 link / meta 镜像进 head，按 keyAttr（href / name）去重；没有键的（如 meta charset）跳过 */
  function mirrorHelmetTag(head, entry, node, keyAttr) {
    var keyVal = null
    for (var a = 0; a < node.attrs.length; a++) {
      if (node.attrs[a].name.toLowerCase() === keyAttr) keyVal = node.attrs[a].value
    }
    if (!keyVal) return
    var tag = node.tag.toLowerCase()
    if (head.querySelector(tag + '[data-dc-helmet][' + keyAttr + '="' + keyVal.replace(/"/g, '\\"') + '"]')) return
    var el = document.createElement(tag)
    for (var b = 0; b < node.attrs.length; b++) {
      try { el.setAttribute(node.attrs[b].name, node.attrs[b].value === null ? '' : node.attrs[b].value) } catch (e) {}
    }
    el.setAttribute('data-dc-helmet', entry.name)
    head.appendChild(el)
  }

  // ---- design_doc_mode：画板模式的识别与上报 ----
  // 运行时的职责到"识别 + 上报"为止：灰底、平移、缩放全归宿主（它拿到 __dc_design_mode 后
  // 接管缩放控件与 fit）。运行时唯一多做的一件事是**给画板一个非零的画布盒**——
  // 画板的每个 frame 都是 root 的直接子元素且 position:absolute，绝对定位不撑父级高度，
  // 于是 #dc-root 会塌成 0 高（宿主据此判定"没渲染出来"，缩放也量不到东西）。
  // 这不是样式偏好，是画板模式下挂载点的最小正确尺寸，只能由持有挂载点的一侧给。

  var reportedMode = ''

  function helmetDesignMode(helmet) {
    if (!helmet) return ''
    for (var i = 0; i < helmet.children.length; i++) {
      var node = helmet.children[i]
      if (node.type !== 'el' || node.tag.toLowerCase() !== 'meta') continue
      var name = ''
      var content = ''
      for (var a = 0; a < node.attrs.length; a++) {
        var an = node.attrs[a].name.toLowerCase()
        if (an === 'name') name = (node.attrs[a].value || '').toLowerCase()
        else if (an === 'content') content = (node.attrs[a].value || '').trim()
      }
      if (name === 'design_doc_mode' && content) return content.toLowerCase()
    }
    return ''
  }

  /** 与 __dc_booted 同类：**不带** __openpipal 标记，宿主据此区分运行时原生上报与桥接脚本消息 */
  function reportDesignMode(mode) {
    if (!mode || mode === reportedMode) return
    reportedMode = mode
    if (mode === 'canvas') {
      try { document.documentElement.classList.add(CANVAS_CLASS) } catch (e) {}
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: '__dc_design_mode', mode: mode }, '*')
      }
    } catch (e) {}
  }

  function applyHelmet(entry, helmet) {
    var head = document.head || document.documentElement
    if (!head) return
    var css = collectHelmetCss(helmet)
    if (css) {
      if (!entry.styleEl) {
        entry.styleEl = document.createElement('style')
        entry.styleEl.setAttribute('data-dc-helmet', entry.name)
        head.appendChild(entry.styleEl)
      }
      if (entry.styleEl.textContent !== css) entry.styleEl.textContent = css
    }
    // link / meta 补进 head。原地那份在 x-dc 里，首帧之后会被 parkSource 收进 template——
    // 从那一刻起它既不生效也查不到，而宿主（预览外壳的通用缩放门闩）就是靠
    // document.querySelector('meta[name="design_doc_mode"]') 认画板模式的。
    if (helmet) {
      for (var i = 0; i < helmet.children.length; i++) {
        var node = helmet.children[i]
        if (node.type !== 'el') continue
        var t = node.tag.toLowerCase()
        if (t === 'link') mirrorHelmetTag(head, entry, node, 'href')
        else if (t === 'meta') mirrorHelmetTag(head, entry, node, 'name')
      }
    }
    // 停用 x-dc 里那份原始样式：它和 head 里的副本内容相同，留着只会在 P2 热更新后变成幽灵规则
    if (css && !entry.helmetMuted && entry.xdc) {
      entry.helmetMuted = true
      var inline = entry.xdc.querySelectorAll('style, link[rel~="stylesheet"]')
      for (var k = 0; k < inline.length; k++) {
        try { inline[k].disabled = true } catch (e) {}
      }
    }
  }

  // ==========================================================================
  // 7. 逻辑类 DCLogic
  // ==========================================================================
  // 作者写经典 JS（无 import/export、无 TS）：
  //     class Component extends DCLogic {
  //       state = { n: 0 }
  //       renderVals() { return { n: this.state.n, inc: () => this.setState(s => ({ n: s.n + 1 })) } }
  //     }
  // DCLogic / React 由运行时注入到这段脚本的执行环境（new Function 的形参），不走全局：
  //   a) 逻辑脚本写成 <script type="text/x-dc">，浏览器不执行它，天然由我们接管求值时机——
  //      而这正是必需的：类的基类要绑到"某一个 x-dc 根"上（render 要知道渲染哪棵模板），
  //      全局单例的 DCLogic 做不到（多根文档会互相踩）。同一段源码对每个根各求值一次即可。
  //   b) 形参注入等于零全局污染：作者拿到的是干净的名字，我们也不必往 window 上挂东西。
  //
  // 关键点：**作者的类没有 render()**，render 由基类提供 —— 它是"模板 + renderVals() 的返回值"
  // 这条渲染路径本身。于是模板文本增量到达时不需要动这棵树的结构：React 元素类型没变（还是
  // 作者那个类），实例被复用，state 原样活着，只是 render 这次读到了更长的模板。

  /** 每个 x-dc 根一个基类：闭包持有 entry，render 才知道自己渲染哪棵模板 */
  function makeDCLogic(entry) {
    var React = window.React

    function DCLogic() {
      React.Component.apply(this, arguments)
      // 作者没声明 state 时给个空对象：renderVals() 里 this.state.x 不该炸
      if (!this.state) this.state = {}
    }
    DCLogic.prototype = Object.create(React.Component.prototype)
    DCLogic.prototype.constructor = DCLogic

    DCLogic.prototype.render = function () {
      entry.instance = this
      beginRender(entry)
      var vals
      try {
        if (typeof this.renderVals !== 'function') {
          warnOnce('logic:norendervals', 'Component 没有 renderVals()：模板取不到任何值。' +
            '模板的全部输入（扁平值、数组、handler、ref）都由 renderVals() 按名返回。')
          vals = null
        } else {
          vals = this.renderVals()
        }
      } catch (err) {
        // 流式期间数据半到位，renderVals 抛错是常态——退回上一帧的值，别让整棵树塌掉
        warnOnce('rendervals:' + errMsg(err), 'renderVals() 抛错：' + errMsg(err) + '（本帧沿用上一次的值）')
        vals = entry.lastVals
      }
      if (!vals || typeof vals !== 'object') vals = {}
      entry.lastVals = vals
      try {
        var tree = React.createElement(React.Fragment, null,
          renderNodes(entry.body, createScope(null, vals), []))
        flushPseudo(entry)
        return tree
      } catch (err2) {
        // 抛到 React 手里会整根卸载（白屏）；就地换成错误块，用户至少还看得见其它部分的上下文
        return errorElement('模板渲染失败：' + errMsg(err2))
      }
    }
    return DCLogic
  }

  var ERROR_STYLE = {
    margin: '16px', padding: '12px 14px', border: '1px solid #d66', borderRadius: '8px',
    background: '#fff5f5', color: '#912', whiteSpace: 'pre-wrap',
    font: '13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace'
  }

  function errorElement(message, key) {
    return window.React.createElement('div', { 'data-dc-error': '1', key: key, style: ERROR_STYLE }, LOG + ' ' + message)
  }

  /**
   * 换了一版逻辑类就是换了一个 React 元素类型，实例必然重建、state 归零。热更新时用户正看着的
   * 计数/展开/选中不该被一次代码增量清空——于是把上一版实例的 state 按**同名键**带过来：
   * 新版删掉的键不复活，新版新增的键用新版的初值。
   */
  function seedState(Base, keep) {
    function Seeded() {
      var inst = Reflect.construct(Base, arguments, Seeded)
      if (inst && inst.state && typeof inst.state === 'object') {
        var next = {}
        for (var k in inst.state) {
          if (has(inst.state, k)) next[k] = has(keep, k) ? keep[k] : inst.state[k]
        }
        inst.state = next
      }
      return inst
    }
    Seeded.prototype = Object.create(Base.prototype)
    Seeded.prototype.constructor = Seeded
    try { Object.setPrototypeOf(Seeded, Base) } catch (e) {} // defaultProps 等静态成员照旧可见
    return Seeded
  }

  // 求值后把作者的类交回来。用 new Function 而不是 eval：作用域干净（拿不到运行时的内部变量），
  // 注入的名字就是形参。
  var LOGIC_TAIL = '\n;return typeof Component === "undefined" ? null : Component;'

  /**
   * 逻辑脚本文本 → entry.Component。返回是否真的换了（调用方据此决定要不要重渲染）。
   * 流式期间半截脚本必然语法错——静默保留上一版可用的类，等下一帧补齐；终态才报错（作者要证据）。
   */
  function applyLogic(entry, code, streaming) {
    code = code === null || code === undefined ? '' : String(code)
    if (code === entry.logicSource) return false
    if (!reactReady()) return false // React 缺失由 renderEntry 统一出声；不记源码，供给到位后还能再来一次
    entry.logicSource = code
    if (!/\S/.test(code)) {
      if (!entry.Component) return false
      entry.Component = null
      entry.instance = null
      return true
    }

    var factory
    try {
      factory = new Function('DCLogic', 'React', 'ReactDOM', code + LOGIC_TAIL)
    } catch (err) {
      if (!streaming) { try { console.error(LOG + ' 逻辑脚本语法错误：' + errMsg(err)) } catch (e) {} }
      return false
    }
    var Authored
    try {
      Authored = factory(makeDCLogic(entry), window.React, window.ReactDOM)
    } catch (err2) {
      if (!streaming) { try { console.error(LOG + ' 逻辑脚本执行失败：' + errMsg(err2)) } catch (e) {} }
      return false
    }
    if (typeof Authored !== 'function' || !Authored.prototype) {
      warnOnce('logic:noclass', '逻辑脚本里没找到 Component。类名必须是 Component，且 extends DCLogic。')
      return false
    }
    if (typeof Authored.prototype.render !== 'function') {
      warnOnce('logic:notdclogic', 'Component 必须 extends DCLogic —— props / state / 生命周期与模板渲染都由基类提供。')
      return false
    }
    // 旧实例的引用故意不清：连着来两版逻辑增量时，第二版仍能从"最后一次活着的 state"接力
    var keep = entry.instance && entry.instance.state
    entry.Component = keep && typeof keep === 'object' ? seedState(Authored, keep) : Authored
    return true
  }

  /**
   * 逻辑块的标准写法是 <script type="text/x-dc" data-dc-script>：type 不是 JS，浏览器只当数据，
   * 求值时机归运行时。写成普通 <script> 也认（取它的文本重新求值），只是浏览器已经先跑过一遍
   * 并抛了 ReferenceError（那个执行环境里没有 DCLogic）——给作者提个醒。
   */
  function findLogicEl() {
    return document.querySelector('script[data-dc-script]') ||
      document.querySelector('script[type="text/x-dc"]')
  }

  function findLogicCode(el) {
    if (!el) return null
    var type = (el.getAttribute('type') || '').toLowerCase()
    if (type !== 'text/x-dc') {
      warnOnce('logic:type', '逻辑块要写成 <script type="text/x-dc" data-dc-script>：' +
        '不写 type 浏览器会先执行一遍并抛 ReferenceError（DCLogic 只存在于运行时给它的执行环境里）。')
    }
    return el.textContent || ''
  }

  // ==========================================================================
  // 7b. data-props → propsMeta（参数面板的声明）
  // ==========================================================================
  // 逻辑 script 标签上挂一段 JSON，声明哪些 prop 可调、用什么控件调。宿主据此生成参数面板，
  // 调过的值再经 __dcSetProps 放回来。
  //
  // **只读 data-props 这一个属性**：宿主还会在同一个标签上写 data-prop-overrides（用户调过的
  // 值，供下次开会话时重放），运行时不得因为多了个陌生属性就报错或改变行为——这是硬约束。
  //
  // default 只是控件的种子值，运行时**不**拿它去填 this.props：兜底归作者写在
  // renderVals() 里的 `this.props.x ?? 默认值`，两处都填就会出现"面板显示 A、画面渲染 B"。

  var EDITORS = set(['text', 'color', 'int', 'float', 'boolean', 'enum'])

  /**
   * 单个参数描述子归一化。宿主的面板按 editor 分发控件，editor 认不出来的参数它渲染不出控件，
   * 留在表里只会变成一行空标签——于是这里把它降成 null（不出面板）并留下告警，作者下一轮能自己修。
   */
  function normalizePropMeta(key, raw) {
    if (!raw || typeof raw !== 'object' || isArray(raw)) {
      warnOnce('props:shape:' + key, 'data-props 里 "' + key + '" 的值要写成描述子对象' +
        '（如 { "editor": "text", "default": "hi" }），已忽略。')
      return null
    }
    var editor = raw.editor === undefined ? null : raw.editor
    if (editor !== null && !(typeof editor === 'string' && has(EDITORS, editor))) {
      warnOnce('props:editor:' + key, 'data-props 里 "' + key + '" 的 editor 是 "' + editor +
        '"，不在 text / color / int / float / boolean / enum / null 之内，该参数不出面板。')
      editor = null
    }
    var meta = { editor: editor }
    if (has(raw, 'default')) meta['default'] = raw['default']
    if (typeof raw.tsType === 'string') meta.tsType = raw.tsType
    if (editor === 'enum') {
      if (isArray(raw.options) && raw.options.length) {
        meta.options = raw.options.slice()
      } else {
        warnOnce('props:options:' + key, 'data-props 里 "' + key + '" 是 enum 但没给 options 数组，' +
          '面板上会是个空下拉框，该参数不出面板。')
        meta.editor = null
      }
    }
    if (editor === 'int' || editor === 'float') {
      if (isNum(raw.min)) meta.min = raw.min
      if (isNum(raw.max)) meta.max = raw.max
      if (isNum(raw.step)) meta.step = raw.step
    }
    return meta
  }

  function parseDataProps(el) {
    var out = {}
    if (!el) return out
    var raw = el.getAttribute('data-props')
    if (!raw || !/\S/.test(raw)) return out
    var declared = null
    try {
      declared = JSON.parse(raw)
    } catch (e) {
      // 属性值经 DOM 取出时实体已被浏览器解码；到这儿还解析不了的多半是没经过 HTML 解析的原文
      try { declared = JSON.parse(decodeEntities(raw)) } catch (e2) { declared = null }
    }
    if (!declared || typeof declared !== 'object' || isArray(declared)) {
      warnOnce('props:json', 'data-props 不是合法的 JSON 对象，参数面板为空。' +
        '写法：data-props="{&quot;accent&quot;:{&quot;editor&quot;:&quot;color&quot;,&quot;default&quot;:&quot;#c2603f&quot;}}"')
      return out
    }
    for (var key in declared) {
      if (!has(declared, key)) continue
      if (key.charAt(0) === '$') continue // $preview 之类是预览元数据，不是参数
      var meta = normalizePropMeta(key, declared[key])
      if (meta) out[key] = meta
    }
    return out
  }

  // ==========================================================================
  // 8. React 装载与重渲染
  // ==========================================================================

  var REACT_MISSING = 'React 缺失：本运行时不从任何 CDN 加载依赖（离线可用、不外泄使用行为）。' +
    '宿主必须在本文件之前提供 React 与 ReactDOM 的 UMD 包。'

  function reactReady() {
    return !!(window.React && window.ReactDOM && window.React.createElement)
  }

  function showFatal(entry, message) {
    try {
      entry.host.textContent = ''
      var box = document.createElement('div')
      box.setAttribute('data-dc-error', '1')
      box.style.cssText = 'margin:16px;padding:12px 14px;border:1px solid #d66;border-radius:8px;' +
        'background:#fff5f5;color:#912;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap'
      box.textContent = LOG + ' ' + message
      entry.host.appendChild(box)
    } catch (e) {}
    try { console.error(LOG + ' ' + message) } catch (e) {}
  }

  /**
   * 唯一的重渲染入口。首帧和流式增量帧都走这里，永远渲染进同一个 React root——
   * 换的只是元素树，DOM 由 React reconcile 复用，不重建文档、不闪。
   *
   * 有逻辑类时根元素就是作者那个类（模板渲染在它的 render 里）：模板增量到达时元素类型不变，
   * React 复用同一个实例，**state 原样活着**——这就是"热更新不重置用户正在看的东西"的全部机制。
   */
  function renderEntry(entry) {
    if (!reactReady()) { showFatal(entry, REACT_MISSING); return }
    var React = window.React
    var tree
    if (entry.Component) {
      // props 就是宿主重放的 overrides 本身：data-props 里的 default 只是参数面板的种子值，
      // 运行时兜底归作者（renderVals() 里的 this.props.x ?? 默认值），运行时不越俎代庖往里填。
      tree = React.createElement(entry.Component, entry.propOverrides || null)
    } else {
      beginRender(entry)
      var children
      try {
        // 纯静态文档没有 this.props 这一层，覆盖值直接进模板作用域（盖在 values 之上：
        // 用户刚在面板上拨过的值最有发言权）
        var scope = createScope(null, entry.values)
        if (entry.propOverrides) scope = createScope(scope, entry.propOverrides)
        children = renderNodes(entry.body, scope, [])
      } catch (err) {
        showFatal(entry, '模板渲染失败：' + errMsg(err))
        return
      }
      flushPseudo(entry)
      tree = React.createElement(React.Fragment, null, children)
    }
    try {
      if (entry.reactRoot) entry.reactRoot.render(tree)
      else window.ReactDOM.render(tree, entry.host)
    } catch (err2) {
      showFatal(entry, '模板渲染失败：' + errMsg(err2))
    }
  }

  /**
   * 未闭合插值走"全有全无"：流式尾部的 "{{ user.na" 不能当纯文本上屏，截掉等下一帧补回。
   * 落单的 "{" 同样截掉——它下一帧多半是 "{{" 的前半个，留着就是屏上闪一下的脏字符。
   */
  function truncateUnclosedInterp(text) {
    var i = 0
    while ((i = text.indexOf('{{', i)) !== -1) {
      var close = text.indexOf('}}', i + 2)
      if (close === -1) return text.slice(0, i)
      i = close + 2
    }
    return text.charAt(text.length - 1) === '{' ? text.slice(0, -1) : text
  }

  function setStreamingFlag(entry, streaming) {
    entry.streaming = !!streaming
    // 占位微光的动画由这个状态类驱动：流式结束即停，占位不再假装"马上就来"
    try {
      document.documentElement.classList.toggle(STREAMING_CLASS, !!streaming)
    } catch (e) {}
  }

  /**
   * 模板文本 → AST → 渲染。流式增量就是反复调它：
   * 文本没变就直接返回（流式泵会重发相同前缀），变了才重解析 + 重渲染。
   */
  function setTemplate(entry, text, streaming) {
    var was = entry.streaming
    setStreamingFlag(entry, streaming)
    var src = streaming ? truncateUnclosedInterp(text || '') : (text || '')
    if (src === entry.template) {
      // 文本没变但流收尾了：占位要从"骨架"改口成"这个值就是空的"，得再渲染一帧
      if (was !== entry.streaming) renderEntry(entry)
      return
    }
    entry.template = src
    var split = splitHelmet(parseTemplate(src))
    entry.body = split.body
    applyHelmet(entry, split.helmet)
    // 模式上报排在渲染之前：宿主收到就会接管缩放，越早知道越不会先按普通页面适配一次
    reportDesignMode(helmetDesignMode(split.helmet))
    try {
      document.documentElement.classList.toggle(FILL_CLASS, detectFullBleed(entry.body))
    } catch (e) {}
    renderEntry(entry)
  }

  /** 外部组件到场/超时后的整体重渲染。单一入口 renderEntry 照旧，只是这次由异步事件发起 */
  function rerenderAll() {
    for (var name in registry) {
      if (!has(registry, name)) continue
      try { renderEntry(registry[name]) } catch (e) {}
    }
  }

  // ==========================================================================
  // 9. 引导
  // ==========================================================================

  // 运行时先于 x-dc 被解析而加载：立刻把原始模板藏起来，别让裸标记闪一下。
  // 原始 x-dc 节点保留在 DOM 里（宿主的文本摘要/就地编辑依赖它还在）。
  // 占位微光的样式也在这里给：颜色取 currentColor，深浅背景上都不突兀；动画只在流式状态类下跑，
  // 终态那一帧动画停住、占位随之被如实的空值取代。
  ;(function injectShellStyle() {
    var head = document.head || document.documentElement
    if (!head || head.querySelector('style[data-dc-shell]')) return
    var el = document.createElement('style')
    el.setAttribute('data-dc-shell', '1')
    el.textContent = TAG_ROOT + '{display:none!important}' +
      // 高度链正干：作者写的 height:100% 是相对**上级的指定高度**算的，而挂载点比作者的
      // 模板多插了两层（#dc-root > .sc-host）。这两层只给 min-height 的话，上级的指定高度
      // 仍是 auto——百分比高度一路退化成内容高，满屏设计塌成一行字。给两层都写死 height:100%，
      // 链就接上了：body 有确定高度时逐级传下去，body 是 auto 时两层一起退化成内容高
      // （等于没写，不会凭空撑出滚动条）。内容比视口高时框体停在一屏，内容照常溢出可见、
      // documentElement.scrollHeight 仍是真实高度——滚动与整页截图都不受影响。
      '#dc-root,#dc-root>.' + HOST_CLASS + '{height:100%}' +
      // 画板模式：frame 全是 absolute 的直接子元素，撑不起父级，height:100%（body auto 时退化成
      // 内容高）于是塌成 0。给挂载点一个至少一屏的画布盒——frame 照常溢出可见、文档照常滚动，
      // 平移缩放仍归宿主。选择器与上面那条同域（都只管首个根），特异性高一级压得住。
      'html.' + CANVAS_CLASS + ' #dc-root,html.' + CANVAS_CLASS + ' #dc-root>.' + HOST_CLASS +
      '{height:auto;min-height:100vh}' +
      // 画板灰底：中性偏暖的工作台色，frame 自己的浅底与投影落在上面才有"摆在桌面上"的层次。
      // 挂在 .sc-dc-canvas 这个元素（documentElement）自己身上，**不写任何 body 规则**——
      // 灰底要盖住整块可滚动画布（板宽常有数千像素，只涂 #dc-root 的话往右平移就露出白边），
      // 而画布背景只能由 html / body 供给；写 body 会和作者的 body 背景争同一条声明，写 html
      // 则各归各位：作者的 body 背景照旧生效、照旧盖在板面上，我们只兜住它够不到的画布外围。
      'html.' + CANVAS_CLASS + '{background:#e8e6e2}' +
      // 满屏外部组件（顶层 x-import 的 hint-size 高度写成百分比）：给 height 链一个确定的根，
      // 否则 100% 一路退化成 auto。必须是 height 而非 min-height——百分比子元素只认确定高度。
      'html.' + FILL_CLASS + ' #dc-root{height:100vh}' +
      '.' + PLACEHOLDER_CLASS + '{display:inline-block;min-width:4ch;width:6em;max-width:100%;' +
      'height:1em;vertical-align:-.15em;border-radius:.3em;background:currentColor;opacity:.13}' +
      'html.' + STREAMING_CLASS + ' .' + PLACEHOLDER_CLASS +
      '{animation:sc-dc-shimmer 1.3s ease-in-out infinite}' +
      '@keyframes sc-dc-shimmer{0%,100%{opacity:.08}50%{opacity:.2}}'
    head.appendChild(el)
  })()

  var registry = window.__dcRegistry || (window.__dcRegistry = {})
  var primaryName = null
  // 比根的挂载还早到的调参覆盖值（见第十节 __dcSetProps）。声明放在这里而不是用到它的那一节：
  // 下面的 start() 可能同步就跑起来（运行时被晚注入时 readyState 已不是 loading），
  // boot 要读的东西必须在那之前初始化完。
  var pendingProps = {}

  function mount(xdc, index) {
    var name = xdc.getAttribute('name') || (index === 0 ? 'root' : 'root-' + (index + 1))
    if (registry[name]) return registry[name]

    var container = document.createElement('div')
    container.id = index === 0 ? 'dc-root' : 'dc-root-' + (index + 1)
    container.setAttribute('data-dc-container', name)
    var host = document.createElement('div')
    host.className = HOST_CLASS
    container.appendChild(host)
    if (xdc.parentNode) xdc.parentNode.insertBefore(container, xdc.nextSibling)
    else document.body.appendChild(container)

    var entry = {
      name: name,
      xdc: xdc,
      container: container,
      host: host,
      reactRoot: null,
      template: '',
      body: [],
      /** 没有逻辑类时模板的输入（宿主/测试直接注入）；有逻辑类时由 renderVals() 供给 */
      values: {},
      /** 宿主重放的调参覆盖值（整包替换语义，null = 清除全部覆盖）；宿主 e2e 直接读这个字段 */
      propOverrides: null,
      streaming: false,
      styleEl: null,
      helmetMuted: false,
      /** 伪态样式：本根自己的规则表 + style 元素（按需建，没用到伪态就一直是 null） */
      pseudo: { rules: {}, gen: 0, css: '', styleEl: null },
      /** 逻辑类相关：源码原文 / 作者的类 / 当前挂载的实例 / 上一帧 renderVals 的返回值 */
      logicSource: null,
      Component: null,
      instance: null,
      lastVals: null
    }
    entry.setValues = function (values) {
      entry.values = values || {}
      renderEntry(entry)
    }
    entry.rerender = function () { renderEntry(entry) }

    if (reactReady() && window.ReactDOM.createRoot) {
      entry.reactRoot = window.ReactDOM.createRoot(host)
    }
    registry[name] = entry
    if (!primaryName) primaryName = name
    return entry
  }

  /**
   * 原始模板节点留在 DOM 里，于是每个 id 都有两份，而且藏起来的那份在文档序里更靠前——
   * getElementById / url(#id) / label.control 全部命中它。后果是 SVG 渐变滤镜画不出来、
   * 点标签聚焦到看不见的输入框。给源拷贝的 id 改名，让所有引用只能落到真正渲染出来的那棵树上。
   * （下面 parkSource 之后源拷贝已经查不到了，这一道仍留着：它管的是"挂载到收起"之间那一帧。）
   */
  function muteSourceIds(xdc) {
    var withId = xdc.querySelectorAll('[id]')
    for (var i = 0; i < withId.length; i++) {
      try {
        withId[i].setAttribute('data-dc-src-id', withId[i].getAttribute('id'))
        withId[i].removeAttribute('id')
      } catch (e) {}
    }
  }

  /**
   * 首帧渲染完就把源模板收进 template 里。
   *
   * 源码不能删（导出的单文件产物离线打开时，它就是唯一的模板数据源，下一次 boot 还要读），
   * 但也不该继续摊在 DOM 上：`x-dc{display:none}` 只是不画，节点还在——整份设计因此在文档里存在
   * 两遍，凡是"按文字/选择器找元素"的东西（宿主的摘要与导出、就地编辑、E2E 断言）都会命中两份。
   * template 的内容住在独立的 DocumentFragment 里：查询查不到、不渲染、不进无障碍树，
   * 而 innerHTML 一取仍是原文。
   *
   * 时机在首帧之后：applyHelmet 要先从原节点里把 style/link 抄进 head。
   */
  function parkSource(xdc) {
    if (!xdc.firstChild || xdc.querySelector('template[data-dc-source]')) return
    try {
      var park = document.createElement('template')
      park.setAttribute('data-dc-source', '1')
      while (xdc.firstChild) park.content.appendChild(xdc.firstChild)
      xdc.appendChild(park)
    } catch (e) {}
  }

  /** 写在 x-dc 之外的标记不会有任何绑定——看着像成功了，其实是个静默陷阱，这里给出声音 */
  function checkStrayContent() {
    if (!document.body) return
    var ignore = set(['script', 'style', 'link', 'meta', 'template', 'noscript', 'title', TAG_ROOT])
    var kids = document.body.children
    var stray = []
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i]
      var tag = el.tagName.toLowerCase()
      if (ignore[tag] || el.hasAttribute('data-dc-container')) continue
      if (!/\S/.test(el.textContent || '')) continue
      stray.push(tag)
    }
    if (stray.length) {
      warnOnce('stray', '模板正文之外还有内容（' + stray.join(', ') + '）：它们被浏览器静态渲染，' +
        '空穴和事件全都不会生效。把标记移进 ' + TAG_ROOT + ' 里。')
    }
  }

  /**
   * 宿主拿这条消息当"运行时活了"的唯一信号（不发则流式首帧占位永不撤下），所以无论有没有
   * x-dc、React 在不在、有没有声明参数，boot 走完都要发（没有就发空表）。
   * **不带 __openpipal 标记**——宿主据此区分"运行时原生上报"与"桥接脚本消息"。
   */
  var bootedReported = false

  function reportBooted(propsMeta) {
    if (bootedReported) return
    bootedReported = true
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: '__dc_booted', propsMeta: propsMeta || {} }, '*')
      }
    } catch (e) {}
  }

  function boot() {
    var list = document.getElementsByTagName(TAG_ROOT)
    if (!list.length) {
      try { console.error(LOG + ' 文档里没有 ' + TAG_ROOT + ' 块，没有可渲染的 Design Component。') } catch (e) {}
      reportBooted(null)
      return
    }
    var nodes = []
    for (var i = 0; i < list.length; i++) nodes.push(list[i])
    var logicEl = findLogicEl()
    var code = findLogicCode(logicEl)
    for (var j = 0; j < nodes.length; j++) {
      var entry = mount(nodes[j], j)
      // 逻辑类要先于首帧就位：否则首帧先渲一棵无逻辑的树，逻辑到场时根元素类型一换，
      // React 会把刚挂上的 DOM 整棵卸掉重建（看得见的一次闪）。
      if (code !== null) applyLogic(entry, code, false)
      // 挂载前就到的覆盖值（导出产物的重放脚本在 head 里就开始轮询）在这里补上：
      // 赶在首帧之前落位，用户看不到"先默认值、再跳成调过的值"这一下。
      takePendingProps(entry, j === 0)
      // 首帧模板文本取自 DOM 序列化。属性名大小写在这条路上会被浏览器压平，
      // 由 normalizeAttrName 还原事件名；流式泵送来的原文则原样保真。
      var source = nodes[j].innerHTML
      muteSourceIds(nodes[j])
      setTemplate(entry, source, false)
      parkSource(nodes[j])
    }
    checkStrayContent()
    reportBooted(parseDataProps(logicEl))
  }

  function start() {
    // 宿主可能要先把 x-import 的外部组件注册到全局再放行（依赖门闩由宿主注入）
    var gate = window.__openpipalWaitForDcDependencies
    if (typeof gate === 'function') {
      try {
        Promise.resolve(gate()).then(boot, boot)
        return
      } catch (e) { /* 门闩自己坏了不该拖死渲染 */ }
    }
    boot()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }

  // ==========================================================================
  // 10. 宿主契约（window 全局）
  // ==========================================================================

  window.__dcRootName = function () { return primaryName }

  function resolveEntry(rootName) {
    return registry[rootName] || (primaryName ? registry[primaryName] : null)
  }

  // ---- 调参覆盖：__dcSetProps / __dcUpdate('props') 共用的一条路 ----
  // 覆盖值可能比根的挂载还早到：导出产物的重放脚本写在 head 里，运行时的全局一挂上它就开始调，
  // 而 boot 要等 DOMContentLoaded。这是竞态，不是能力缺失——先收进 pendingProps（声明在第九节），
  // boot 时补上。

  /** 载荷归一化：对象/JSON 串 → 一份浅拷贝；null → 清除全部覆盖；undefined → 载荷不合法 */
  function normalizeOverrides(value) {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') {
      if (!/\S/.test(value)) return null
      try { value = JSON.parse(value) } catch (e) { return undefined }
    }
    if (typeof value !== 'object' || isArray(value)) return undefined
    var out = {}
    for (var k in value) if (has(value, k)) out[k] = value[k]
    return out
  }

  /**
   * 覆盖值落到 entry 上再重渲染。**只换这一个字段**，模板与逻辑类都不动——于是两条热更新路径
   * 天然共存：模板增量走 setTemplate、逻辑换代走 applyLogic，两者重渲染时都会把这里的覆盖值
   * 重新交给组件（renderEntry 每次都读 entry.propOverrides），调过的参数不会被增量冲掉。
   */
  function applyProps(entry, overrides) {
    entry.propOverrides = overrides
    renderEntry(entry)
  }

  function takePendingProps(entry, isFirst) {
    var key = has(pendingProps, entry.name) ? entry.name : (isFirst && has(pendingProps, '*') ? '*' : null)
    if (key === null) return
    entry.propOverrides = pendingProps[key]
    delete pendingProps[key]
  }

  /**
   * 宿主重放用户调过的参数（整包替换：传什么就是全部，null 清除全部覆盖）。
   * 有逻辑类时覆盖值就是组件的 this.props——作者写的 `this.props.x ?? 默认值` 因此生效；
   * 没有逻辑类时直接进模板作用域（见 renderEntry）。
   */
  window.__dcSetProps = function (rootName, overrides) {
    var next = normalizeOverrides(overrides)
    if (next === undefined) {
      try { console.error(LOG + ' __dcSetProps: overrides 要么是对象要么是 null，已忽略。') } catch (e) {}
      return
    }
    var entry = resolveEntry(rootName)
    if (!entry) { pendingProps[rootName || '*'] = next; return }
    applyProps(entry, next)
  }

  /**
   * 流式泵的入口。kind 只认 'html'（模板文本）/ 'js'（逻辑类）/ 'props'（参数）。
   * 未知 kind 必须出声：曾经有过误传 kind 导致增量被静默吞掉、预览冻在首帧的事故。
   */
  window.__dcUpdate = function (rootName, kind, value, streaming) {
    var entry = resolveEntry(rootName)
    if (!entry) {
      try { console.error(LOG + ' __dcUpdate: 找不到根 "' + rootName + '"，运行时尚未挂载。') } catch (e) {}
      return
    }
    var isStreaming = streaming !== false
    if (kind === 'html') { setTemplate(entry, String(value == null ? '' : value), isStreaming); return }
    if (kind === 'js') {
      setStreamingFlag(entry, isStreaming)
      // 逻辑没换（泵会重发相同前缀、半截脚本编不过）就别动树——重渲染会白白丢一次动画/焦点
      if (applyLogic(entry, value, isStreaming)) renderEntry(entry)
      return
    }
    // 参数走流式泵这条路时的入口：与 __dcSetProps 同一个语义（整包替换），差别只在容错——
    // 泵送来的可能是一截还没写完的 JSON 文本，流式期间解析不了就静静等下一帧。
    if (kind === 'props') {
      setStreamingFlag(entry, isStreaming)
      var next = normalizeOverrides(value)
      if (next === undefined) {
        if (!isStreaming) {
          try { console.error(LOG + ' __dcUpdate kind="props": 载荷既不是对象也不是可解析的 JSON，已丢弃。') } catch (e) {}
        }
        return
      }
      applyProps(entry, next)
      return
    }
    // 流式预载（见上方 preloadSibling 的说明）。放在未知 kind 报错之前，别被误伤。
    if (kind === 'preload') { preloadSibling(value); return }
    try {
      console.error(LOG + ' __dcUpdate: 未知 kind "' + kind + '"，只接受 html / js / props / preload。增量已被丢弃。')
    } catch (e) {}
  }
})()
