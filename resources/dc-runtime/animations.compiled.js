/**
 * animations —— OpenPipal 自研的动画时间线舞台（单文件普通 JS：非 module、无 JSX、无 Babel、无 CDN）。
 *
 * 模型只声明「什么东西在第几秒到第几秒之间、长什么样」，rAF 循环、播放器控件、逐帧导出协议
 * 全部由本件兜住。同一份声明同时喂两种消费：
 *   1. 应用内交互预览 —— 自适应缩放画布 + 播放条 + 拖拽擦洗 + 键盘。
 *   2. 宿主驱动的确定性逐帧导出 —— 主进程把播放头钉到 t=i/fps、截图、交 ffmpeg 合成 mp4；
 *      另有交接包 6 帧采样与 render_artifact 三帧自检两条支路。
 *
 * **确定性是本件的主线条款：给定时刻 t，渲染结果只是 t 的函数。**
 *   · 无路径依赖 —— 顺放到 t / 倒擦洗到 t / 冷启动直接落在 t，三者像素一致。故：不读挂钟、
 *     不用未播种随机、不靠 CSS transition/animation 的自走时钟（相位由挂载时刻决定，不由 t 决定）、
 *     不留任何按增量累积的视觉状态。播放推进用累积增量、定位用绝对赋值，两条路径最终共用
 *     同一个「由 t 求画面」的纯渲染。
 *   · 同步落地 —— 收到定位指令后两次 rAF 之内完成提交与绘制（宿主就等这么久然后截图）。
 *   · 定位即暂停 —— 否则播放循环会在定位与截图之间把播放头推走。
 *   · 冷启动定格 —— 首帧就渲在 localStorage 恢复出来的时刻，不先渲一帧 t=0 再跳过去。
 *
 * 宿主契约（改动前先读 src/main/dc-video-export.ts、dc-handoff-export.ts、openpipal-product-tools.ts）：
 *   C1 引用名 './animations.jsx'（'./animations.js' 同）解析到本件；磁盘实物就是本文件。
 *   C2 零构建、非 module，整份源码被原样内联进一个 script 标签，不经任何转译。
 *   C3 求值时机自持：本件被注入到 head 顶部，早于 React 就绪 —— 自行轮询等 React/ReactDOM。
 *   C4 画布元素带 width/height 数字属性与 data-openpipal-video-duration-secs（已求值秒数）。
 *   C5 该元素自身监听 openpipal:seek-to-time（detail.time 秒，事件不冒泡）：暂停并钉住时刻。
 *   C6 字体就绪后在该元素上置 data-openpipal-fonts-ready='true'（没有可做的事时也必须置位）。
 *   C7 初始播放头读自 localStorage，键以 ':t' 结尾，只经 getItem，且必须容错（自检会注入替身对象）。
 *   C8 视口被仿真成 舞台宽 x (舞台高+60) 时，画布实测边界必须收敛到舞台原生尺寸（±2px）——
 *      故播放条占高 ≤60px，且**自适应缩放封顶为 1**（不放大）。
 *   C9 截图只 clip 画布的边界矩形：播放条、letterbox 底色都是画布的兄弟节点，落在矩形之外。
 *   C10 全局暴露必须是一条原子语句且含 Stage（宿主以 window.Stage 在场作为整条链在场的证据）。
 *
 * 时间轴编辑（docs/claude/design-rewrite/animations-timeline-addendum.md）：播放条同时是剪辑台。
 * 顶层 Sprite 自注册成「幕」，画成剪辑轨上的 clip，选中即可改倍速 / 删掉该段。编辑表（EDL）是一张
 * [{s,e,speed}] 的规范表，把**输出时刻**映射回**源时刻**：
 *   · 场景（TimelineContext.time / useTime / useSprite / Sprite 可见性）永远拿到**源时刻**；
 *   · 播放头、播放条、ATTR_DURATION、EVT_SEEK、持久化播放头一律是**输出时刻/输出时长**。
 *   · 编辑后在画布元素上派 openpipal:edl-changed（detail: {edl, duration, outDuration}，不冒泡），
 *     宿主据此把编辑表写回产物 html，让导出也吃到编辑。宿主可用 window.__openpipalEdl 反向注入。
 *   · **空编辑表与没有本能力时逐字节等价**：恒等表下所有映射走短路分支直接返回入参。
 *   · 形状是「控制行 44px + 剪辑轨道行 40px」：一个幕都没登记时只剩控制行，与没有本能力时
 *     逐像素一致；有幕时默认展开，展开态由 persistKey + ':lane' 记住。
 *   · 文案按 documentElement.lang 在 zh/en 两行字典里二选一（运行时够不到 app 的 i18n）。
 *
 * 命名：属性一律 data-openpipal-*，事件一律 openpipal:*，全套是我们自己的命名空间
 * （2026-08-16 完成迁移，宿主四个文件与契约 harness 同批换名）。画布之外的锚点（clip、
 * 操作区、切换按钮）同前缀，都不入画。persistKey 的默认前缀同理。
 *
 * 已知降级：VideoSprite 的播放位置由舞台播放头驱动，但**逐帧导出下视频帧不保证与 t 严格对齐**
 * ——解码器 seek 未必在两次 rAF 内落地。要求逐帧精确的画面请用图片序列或矢量绘制。
 * Stage 的 fps 属性是保留字段：收下并强转，运行时不使用（导出帧率来自宿主参数）。
 */
;(function () {
  'use strict'

  if (typeof window === 'undefined') return
  // 幂等守卫：流式预载通道与终稿内联可能双路进场，同一份源码会被求值两次。
  if (window.__openpipalAnimations) return
  var RT = (window.__openpipalAnimations = { state: 'pending' })

  // ---- 协议常量（宿主硬编码，改名要同步四个宿主文件）----
  var ATTR_DURATION = 'data-openpipal-video-duration-secs'
  var ATTR_FONTS = 'data-openpipal-fonts-ready'
  var EVT_SEEK = 'openpipal:seek-to-time'
  var PERSIST_SUFFIX = ':t' // 键名后缀是契约，前缀不是
  var DEFAULT_PERSIST_KEY = 'openpipal-stage'

  // ---- 时间轴编辑（本件自己的协议，不属于上面那组导出契约）----
  var EVT_EDL = 'openpipal:edl-changed' // 编辑后派到画布元素上，宿主据此把编辑表写回产物
  var EDL_SUFFIX = ':edl' // 与 :t 同前缀，复用同一套持久化包装
  var LANE_SUFFIX = ':lane' // 剪辑轨展开/收起，同上
  var ATTR_BAND = 'data-openpipal-band' // clip 锚点（画布之外，不入画）
  var ATTR_BAND_SPEED = 'data-openpipal-band-speed' // clip 右上角的倍速角标
  // 选中段操作区的锚点。v1 的浮层已整体删除，锚点名沿用：它是契约 harness 的抓手，
  // 换名只会让一整批既有断言重写一遍，换不来任何语义。
  var ATTR_EDITOR = 'data-openpipal-editor'
  var ATTR_LANE = 'data-openpipal-lane' // 展开/收起切换按钮
  var MIN_OUT = 0.2 // 保底闸：编辑不许把片子删到比这更短——ATTR_DURATION 变成 0 会被导出链当成坏产物

  var BAR_HEIGHT = 44 // 控制行；1px 上边框走 border-box 含在里面，整条实测就是 44
  var LANE_HEIGHT = 40 // 剪辑轨道行，只在展开态渲染（44 + 40 = 84，落在宿主 160px 预算内）
  var LANE_GUTTER = 12 // 轨道行顶部这一条留给播放头 knob 与倍速角标，clip 本体从这里往下
  var LANE_FOOT = 5 // clip 底下留一条：轨道行的下沿就是窗口下沿，贴死了像被裁掉半截
  var DEFAULT_WIDTH = 1280
  var DEFAULT_HEIGHT = 720
  var DEFAULT_DURATION = 8
  var CANVAS_BG = '#ffffff' // 画布默认底色：作者不给 background 时也要能读清深色文字
  var BACKDROP = '#14161a' // letterbox 底色，落在截图 clip 之外
  var STEP_SMALL = 0.1
  var STEP_LARGE = 1

  // ==========================================================================
  // 1. 纯工具（不依赖 React，可在门闩之前定义）
  // ==========================================================================

  function clamp(v, min, max) {
    var n = Number(v)
    if (n !== n) return min // NaN 收到下界；±Infinity 照常被下面两条夹住
    return n < min ? min : n > max ? max : n
  }

  /** 作者给的 style 只有真是对象时才合并——字符串被 Object.assign 展开会变成一堆下标键 */
  function mergeStyle(base, extra) {
    return extra && typeof extra === 'object' ? Object.assign(base, extra) : base
  }

  /**
   * x-import 挂载路径下**所有属性都是 HTML 字符串**（<x-import width='1280'> 到手是 "1280"），
   * 而场景 jsx 直传的是真数字。数字属性必须强转，否则 style 会拿到字符串而排版错乱。
   */
  function num(v, fallback) {
    if (v == null || v === '') return fallback
    var n = typeof v === 'number' ? v : parseFloat(v)
    return isFinite(n) ? n : fallback
  }

  /** 布尔属性：字符串 'false' 当假，其余非空字符串当真（HTML 里 loop='false' 必须是关） */
  function bool(v, fallback) {
    if (v == null || v === '') return fallback
    if (typeof v === 'boolean') return v
    var s = String(v).trim().toLowerCase()
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
    return true
  }

  function fn(v, fallback) {
    return typeof v === 'function' ? v : fallback
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  }

  /** 秒数写进属性：宿主 parseFloat 读回，小数照留（时长语义是精确截取，不取整） */
  function secsAttr(v) {
    return String(Math.round(v * 1e6) / 1e6)
  }

  function fmtTime(v) {
    return (Math.round(v * 10) / 10).toFixed(1) + 's'
  }

  function fmtSpeed(v) {
    return String(Math.round(v * 100) / 100) + '×'
  }

  // ---- 文案：运行时够不到 app 的 i18n（它是被内联进产物 html 的单文件），也不该为五个词引依赖。
  // 一张两行的字典 + 按文档语言前缀二选一，就够了。判据取 documentElement.lang，没有再退到浏览器语言。
  var I18N_ZH = { del: '删除这段', reset: '重置全部编辑', clip: '片段 ', lane: '显示/隐藏分段', close: '关闭' }
  var I18N_EN = { del: 'Delete', reset: 'Reset all', clip: 'Clip ', lane: 'Show/hide clips', close: 'Close' }

  function i18nFor(lang) {
    return String(lang == null ? '' : lang).toLowerCase().indexOf('zh') === 0 ? I18N_ZH : I18N_EN
  }

  /** 产物页面通常带 <html lang>；没有就退到浏览器语言。两处都读不到（沙箱/替身）时按英文。 */
  function docLang() {
    try {
      var el = document.documentElement
      if (el && el.lang) return el.lang
      return (typeof navigator !== 'undefined' && navigator.language) || ''
    } catch (e) {
      return ''
    }
  }

  RT.i18n = { pick: i18nFor, lang: docLang, zh: I18N_ZH, en: I18N_EN }

  // ==========================================================================
  // 1.5 时间轴编辑表（EDL）—— 纯函数：不读时钟、不碰 DOM，同一 (edl, t) 恒得同一结果
  // ==========================================================================
  //
  //   edl = [ { s: 源起点秒, e: 源终点秒, speed: 倍速 }, … ]
  //
  // 规范形（内部始终维持）：按 s 升序、首尾相接、无缝无叠、铺满 [0, duration]；
  // speed > 0 表示以该倍速播放，speed === 0 表示这段被删掉。恒等表 = [{s:0,e:duration,speed:1}]。
  //
  // **不做任何编辑时必须与没有本节时逐字节等价。** 所有映射在恒等表下走短路分支直接返回入参——
  // 不是怕 t*1.0 真会漂（IEEE754 上不会），而是让「等价」成为结构事实而不是一句需要论证的话。
  // 这条一破，导出链读到的时长与逐帧定位就全线错位。

  function edlIdentity(duration) {
    return [{ s: 0, e: duration, speed: 1 }]
  }

  /** 恒等判定：规范形下「全速 1」就等价于没有编辑（空表同理） */
  function edlIsIdentity(edl) {
    if (!edl || !edl.length) return true
    for (var i = 0; i < edl.length; i++) {
      if (edl[i].speed !== 1) return false
    }
    return true
  }

  /**
   * 归一到规范形。任意形状进来都要能落成一张可用的表：非法条目丢掉、重叠按先到先得截断、
   * 缝隙按原速补齐、相邻同速合并。合并不是洁癖——不合并的话表会随编辑次数无限增长。
   */
  function edlNormalize(list, duration) {
    var total = num(duration, 0)
    if (!(total > 0)) return []
    var raw = []
    var i, it, s, e, sp
    if (list && list.length) {
      for (i = 0; i < list.length; i++) {
        it = list[i]
        if (!it || typeof it !== 'object') continue
        s = num(it.s, NaN)
        e = num(it.e, NaN)
        sp = num(it.speed, NaN)
        if (!isFinite(s) || !isFinite(e) || !isFinite(sp) || sp < 0) continue
        s = clamp(s, 0, total)
        e = clamp(e, 0, total)
        if (!(e > s)) continue
        raw.push({ s: s, e: e, speed: sp })
      }
    }
    raw.sort(function (a, b) { return a.s - b.s || a.e - b.e })
    var laid = []
    var cursor = 0
    for (i = 0; i < raw.length; i++) {
      if (raw[i].e <= cursor) continue // 被前一条完全吃掉
      var st = raw[i].s > cursor ? raw[i].s : cursor
      if (st > cursor) laid.push({ s: cursor, e: st, speed: 1 })
      laid.push({ s: st, e: raw[i].e, speed: raw[i].speed })
      cursor = raw[i].e
    }
    if (cursor < total) laid.push({ s: cursor, e: total, speed: 1 })
    var merged = []
    for (i = 0; i < laid.length; i++) {
      var last = merged.length ? merged[merged.length - 1] : null
      if (last && last.speed === laid[i].speed) last.e = laid[i].e
      else merged.push({ s: laid[i].s, e: laid[i].e, speed: laid[i].speed })
    }
    return merged
  }

  /** 输出时长 = Σ (e-s)/speed，只累加可播片段。恒等表短路返回源时长本身。 */
  function edlOutDuration(edl, duration) {
    if (edlIsIdentity(edl)) return duration
    var total = 0
    for (var i = 0; i < edl.length; i++) {
      if (edl[i].speed > 0) total += (edl[i].e - edl[i].s) / edl[i].speed
    }
    return total
  }

  /**
   * 唯一的写入原语：在 s、e 处切开，把覆盖区间的 speed 全设为给定值，再合并相邻同速片段。
   * 幂等。s>=e、区间越出 [0,duration]、或编辑后输出时长不足 MIN_OUT 时**原样返回入参那个引用**
   * ——调用方据此判断「这次编辑没发生」，不提示、不抛错。
   * 改倍速 / 删除（speed=0）/ 重置（整段设回 1）全走这一个函数，不为删除单开代码路径。
   */
  function edlApplyRange(edl, s, e, speed) {
    if (!edl || !edl.length) return edl // 没有底表就没有 duration 可依据
    var total = edl[edl.length - 1].e
    var a = num(s, NaN)
    var b = num(e, NaN)
    var v = num(speed, NaN)
    if (!isFinite(a) || !isFinite(b) || !isFinite(v) || v < 0) return edl
    if (!(b > a) || a < 0 || b > total) return edl
    var cut = []
    for (var i = 0; i < edl.length; i++) {
      var seg = edl[i]
      if (seg.e <= a || seg.s >= b) {
        cut.push({ s: seg.s, e: seg.e, speed: seg.speed })
        continue
      }
      if (seg.s < a) cut.push({ s: seg.s, e: a, speed: seg.speed })
      cut.push({ s: seg.s > a ? seg.s : a, e: seg.e < b ? seg.e : b, speed: v })
      if (seg.e > b) cut.push({ s: b, e: seg.e, speed: seg.speed })
    }
    var next = edlNormalize(cut, total)
    if (!(edlOutDuration(next, total) >= MIN_OUT)) return edl
    return next
  }

  /** 输出时刻 -> 源时刻。恒等表短路。越界钳到最后一个可播片段的末尾。 */
  function edlToSource(edl, duration, outT) {
    if (edlIsIdentity(edl)) return outT
    var acc = 0
    var lastEnd = 0
    for (var i = 0; i < edl.length; i++) {
      var seg = edl[i]
      if (!(seg.speed > 0)) continue
      var len = (seg.e - seg.s) / seg.speed
      if (outT < acc + len) return seg.s + (outT > acc ? outT - acc : 0) * seg.speed
      acc += len
      lastEnd = seg.e
    }
    return lastEnd
  }

  /** 源时刻 -> 输出时刻。落在被删片段里 -> 取该片段起点对应的输出时刻。 */
  function edlToOutput(edl, duration, srcT) {
    if (edlIsIdentity(edl)) return srcT
    if (!(srcT > 0)) return 0
    var acc = 0
    for (var i = 0; i < edl.length; i++) {
      var seg = edl[i]
      if (srcT < seg.e) {
        if (!(seg.speed > 0)) return acc
        return acc + (srcT > seg.s ? srcT - seg.s : 0) / seg.speed
      }
      if (seg.speed > 0) acc += (seg.e - seg.s) / seg.speed
    }
    return acc
  }

  /** 一段源区间上的公共倍速；跨了不同倍速返回 NaN（操作区拿它决定哪个倍速按钮高亮） */
  function edlSpeedOver(edl, s, e) {
    if (edlIsIdentity(edl)) return 1
    var v = NaN
    for (var i = 0; i < edl.length; i++) {
      var seg = edl[i]
      if (seg.e <= s || seg.s >= e) continue
      if (v !== v) v = seg.speed
      else if (v !== seg.speed) return NaN
    }
    return v !== v ? 1 : v
  }

  /**
   * 外来编辑表（宿主注入的全局 / localStorage 读回）的入口校验。
   * 形状非法——不是数组、元素缺字段、归一后输出时长不足保底闸——一律当作没有（返回 null），
   * 绝不半信半疑地用一半：坏表算出来的 ATTR_DURATION 会直接毒到导出链。
   */
  function edlParse(raw, duration) {
    if (!Array.isArray(raw) || !raw.length) return null
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i]
      if (!it || typeof it !== 'object') return null
      if (!isFinite(num(it.s, NaN)) || !isFinite(num(it.e, NaN)) || !isFinite(num(it.speed, NaN))) return null
    }
    var norm = edlNormalize(raw, duration)
    if (!norm.length) return null
    if (!(edlOutDuration(norm, duration) >= MIN_OUT)) return null
    return norm
  }

  // 编辑表的纯函数挂在**既有的**内部命名空间上，不进 §2.1 那 16 名 ABI 的原子暴露：
  // 单测直接对它们下断言，宿主也可以拿去校验自己要写回产物的表。
  RT.edl = {
    identity: edlIdentity,
    isIdentity: edlIsIdentity,
    normalize: edlNormalize,
    parse: edlParse,
    applyRange: edlApplyRange,
    outDuration: edlOutDuration,
    toSource: edlToSource,
    toOutput: edlToOutput,
    speedOver: edlSpeedOver,
    minOut: MIN_OUT
  }

  // ---- 缓动表：键名是接口的一部分，一个都不能少；曲线常数自选，Back/Elastic 允许过冲 ----
  var BACK_C1 = 1.70158
  var BACK_C2 = BACK_C1 * 1.525
  var BACK_C3 = BACK_C1 + 1
  var ELASTIC_C = (2 * Math.PI) / 3

  var Easing = {
    linear: function (t) { return t },
    easeInQuad: function (t) { return t * t },
    easeOutQuad: function (t) { return 1 - (1 - t) * (1 - t) },
    easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 },
    easeInCubic: function (t) { return t * t * t },
    easeOutCubic: function (t) { return 1 - Math.pow(1 - t, 3) },
    easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 },
    easeInQuart: function (t) { return t * t * t * t },
    easeOutQuart: function (t) { return 1 - Math.pow(1 - t, 4) },
    easeInOutQuart: function (t) { return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2 },
    easeInExpo: function (t) { return t <= 0 ? 0 : Math.pow(2, 10 * t - 10) },
    easeOutExpo: function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t) },
    easeInOutExpo: function (t) {
      if (t <= 0) return 0
      if (t >= 1) return 1
      return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
    },
    easeInSine: function (t) { return 1 - Math.cos((t * Math.PI) / 2) },
    easeOutSine: function (t) { return Math.sin((t * Math.PI) / 2) },
    easeInOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2 },
    easeInBack: function (t) { return BACK_C3 * t * t * t - BACK_C1 * t * t },
    easeOutBack: function (t) { return 1 + BACK_C3 * Math.pow(t - 1, 3) + BACK_C1 * Math.pow(t - 1, 2) },
    easeInOutBack: function (t) {
      return t < 0.5
        ? (Math.pow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
        : (Math.pow(2 * t - 2, 2) * ((BACK_C2 + 1) * (t * 2 - 2) + BACK_C2) + 2) / 2
    },
    easeOutElastic: function (t) {
      if (t <= 0) return 0
      if (t >= 1) return 1
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C) + 1
    }
  }

  /** 数值线性插值；端点不是有限数（颜色/字符串）时退化为阶跃，不产出 NaN */
  function mix(a, b, p) {
    var x = typeof a === 'number' ? a : parseFloat(a)
    var y = typeof b === 'number' ? b : parseFloat(b)
    if (!isFinite(x) || !isFinite(y)) return p >= 1 ? b : a
    return x + (y - x) * p
  }

  /**
   * interpolate([0,1,2], [0,100,50], ease) -> (t) => value
   * 超出首/末关键点取端点值（不外推）；段长为 0 不除零；ease 可以是单函数或与段数对应的数组。
   */
  function interpolate(input, output, ease) {
    var xs = []
    var i
    for (i = 0; input && i < input.length; i++) xs.push(num(input[i], 0))
    var ys = output || []
    var eases = Array.isArray(ease) ? ease : null
    var single = eases ? null : fn(ease, null)
    return function (t) {
      if (!xs.length) return undefined
      var v = num(t, xs[0])
      if (v <= xs[0]) return ys[0]
      if (v >= xs[xs.length - 1]) return ys[ys.length - 1]
      for (var k = 0; k < xs.length - 1; k++) {
        if (v < xs[k] || v > xs[k + 1]) continue
        var span = xs[k + 1] - xs[k]
        var p = span > 0 ? (v - xs[k]) / span : 1
        var e = eases ? fn(eases[k], null) : single
        return mix(ys[k], ys[k + 1], e ? e(p) : p)
      }
      return ys[ys.length - 1]
    }
  }

  /** animate({from,to,start,end,ease}) -> (t) => value。start 之前恒为 from，end 之后恒为 to。 */
  function animate(spec) {
    var s = spec || {}
    var from = s.from
    var to = s.to
    var start = num(s.start, 0)
    var end = num(s.end, start)
    var ease = fn(s.ease, null)
    return function (t) {
      var v = num(t, start)
      if (v <= start) return from
      if (v >= end) return to
      var span = end - start
      var p = span > 0 ? (v - start) / span : 1
      return mix(from, to, ease ? ease(p) : p)
    }
  }

  /**
   * 进/退场相位：局部时间 -> { enter, exit, alpha }（enter/exit 都已过缓动）。
   * 退场从「时间片末尾往前推 exitDur」处起算。时间片短于进+退场时两段重叠，
   * alpha = enter * (1 - exit) 仍然连续（会在中段压低，但不跳变）。
   */
  function phaseOf(localTime, spriteDur, entryDur, exitDur, entryEase, exitEase) {
    var enterRaw = entryDur > 0 ? clamp(localTime / entryDur, 0, 1) : 1
    var exitRaw = 0
    if (exitDur > 0 && isFinite(spriteDur) && spriteDur > 0) {
      exitRaw = clamp((localTime - (spriteDur - exitDur)) / exitDur, 0, 1)
    }
    var enter = entryEase ? entryEase(enterRaw) : enterRaw
    var exit = exitEase ? exitEase(exitRaw) : exitRaw
    return { enter: enter, exit: exit, alpha: clamp(enterRaw, 0, 1) * (1 - clamp(exitRaw, 0, 1)) }
  }

  /** 保持段进度（进场结束 -> 退场开始），Ken Burns 这类匀速缓推用它 */
  function holdProgress(localTime, spriteDur, entryDur, exitDur) {
    var a = entryDur
    var b = isFinite(spriteDur) && spriteDur > 0 ? spriteDur - exitDur : localTime + 1
    if (!(b > a)) return 0
    return clamp((localTime - a) / (b - a), 0, 1)
  }

  // ---- localStorage：只用 getItem/setItem 读写这一个键 ----
  // 自检会在 data: 源下注入替身对象（key() 恒 null、length 恒 0），遍历式访问一律读不到东西；
  // 不透明源下连属性访问本身都可能抛，所以每一次都包 try。
  function readPersistedRaw(key) {
    try {
      return window.localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }

  function readPersisted(key) {
    var raw = readPersistedRaw(key)
    if (raw == null) return NaN
    var n = parseFloat(raw)
    return isFinite(n) ? n : NaN
  }

  /**
   * 初始编辑表。优先级：宿主注入的全局 > localStorage > 没有（恒等）。
   * 宿主是权威：window.__openpipalEdl 命中时**不读** localStorage，否则「产物里钉死的编辑」
   * 会被上一次预览时的手动编辑盖掉。
   */
  function readInitialEdl(duration, edlKey) {
    var injected = null
    try {
      injected = edlParse(window.__openpipalEdl, duration)
    } catch (e) {
      injected = null
    }
    if (injected) return injected
    var raw = readPersistedRaw(edlKey)
    if (raw == null) return null
    var parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return null
    }
    return edlParse(parsed, duration)
  }

  function writePersisted(key, value) {
    try {
      window.localStorage.setItem(key, String(value))
    } catch (e) {
      /* 不可用就算了：播放头记忆是便利，不是功能前置 */
    }
  }

  /**
   * 剪辑轨的展开/收起。存 '1'/'0' 而不是 JSON：一个布尔值不值得 parse，而且读不出来时要能
   * 干净地退回默认（有幕默认展开），JSON.parse 的异常路径在这里只会添乱。
   */
  function readLane(key, fallback) {
    var raw = readPersistedRaw(key)
    if (raw === '1') return true
    if (raw === '0') return false
    return fallback
  }

  function writeLane(key, open) {
    writePersisted(key, open ? '1' : '0')
  }

  RT.lane = { suffix: LANE_SUFFIX, read: readLane, write: writeLane }

  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.isContentEditable) return true
    var tag = String(el.tagName || '').toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select'
  }

  // ==========================================================================
  // 2. React 侧（门闩通过后才定义）
  // ==========================================================================

  function boot() {
    if (RT.state === 'ready') return
    RT.state = 'ready'

    var React = window.React
    var ReactDOM = window.ReactDOM
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useLayoutEffect = React.useLayoutEffect || React.useEffect
    var useRef = React.useRef
    var useContext = React.useContext
    var useCallback = React.useCallback

    /**
     * 定位要在两次 rAF 之内落地，所以走同步提交：flushSync 让 setState 当场 commit，
     * 播放循环的 effect 清理（cancelAnimationFrame）也在同一拍完成，不会有"已经定位、
     * 但上一帧的 rAF 还排着队"的窗口。没有 flushSync（旧 React）就退回普通批处理——
     * 微任务同样早于下一次 rAF，只是少了一层保险。
     */
    var flush = typeof ReactDOM.flushSync === 'function'
      ? function (f) { try { ReactDOM.flushSync(f) } catch (e) { f() } }
      : function (f) { f() }

    // 文案在页面生命周期内不会变（lang 是产物 html 写死的），boot 时取一次即可
    var T = i18nFor(docLang())

    var IDLE_TIMELINE = {
      time: 0,
      duration: 0,
      playing: false,
      setTime: function () {},
      setPlaying: function () {}
    }

    var TimelineContext = React.createContext(IDLE_TIMELINE)
    var SpriteContext = React.createContext(null)
    // 播放条要的擦洗/悬停预览接口不是作者 API，单独走内部上下文，不污染 useTimeline() 的形状
    var ControlContext = React.createContext(null)
    // 幕登记通道：顶层 Sprite 往这里报自己的时间窗。同样是内部上下文，不进 ABI。
    var BandContext = React.createContext(null)

    function useTimeline() {
      return useContext(TimelineContext)
    }

    function useTime() {
      return useContext(TimelineContext).time
    }

    /**
     * 时间片上下文。不在 Sprite 里时退回舞台级：TextSprite 这类图元直接挂在 Stage 下也能用，
     * 而不是静默不动（作者最常见的困惑来源）。
     */
    function useSprite() {
      var sprite = useContext(SpriteContext)
      var tl = useContext(TimelineContext)
      if (sprite) return sprite
      var d = tl.duration
      var lt = Math.max(0, tl.time)
      return {
        localTime: lt,
        duration: d,
        progress: isFinite(d) && d > 0 ? clamp(lt / d, 0, 1) : 0,
        visible: true
      }
    }

    // 同页多个 Stage（对比板三块画布）时，空格不该同时切三个：只有页面上唯一一个 Stage，
    // 或指针悬停/焦点落在自己身上，才吃键盘事件。
    var stages = []

    // ----------------------------------------------------------------------
    // 幕登记表 —— 「幕」= 顶层 Sprite 的时间窗，剪辑轨照它画 clip
    // ----------------------------------------------------------------------

    var NO_BANDS = []

    /**
     * 登记表**只增不删**：条件渲染（{t>3 && <Sprite/>}）会让 Sprite 随播放头卸载，真去注销的话
     * clip 就跟着播放头闪。舞台重建（iframe 重载）自然清空，不需要别的回收路径。
     * 每个 Sprite 实例拿一个 token，props 变化时改自己那条而不是新增一条（否则动 start 会留下残影）。
     * 出表按 start 升序、同 start 按 end 升序，并按 start|end 去重；**重叠照实保留**——crossfade
     * 就是靠相邻幕重叠 ~0.4s 做的，合并掉就看不见了。
     */
    function makeRegistry(publish) {
      var entries = []
      var seq = 0
      function rebuild() {
        var list = entries.slice()
        list.sort(function (a, b) { return a.start - b.start || a.end - b.end })
        var out = []
        var seen = {}
        for (var i = 0; i < list.length; i++) {
          var k = list[i].start + '|' + list[i].end
          if (seen['#' + k]) continue
          seen['#' + k] = 1
          // 默认名按**出表序号**给，于是编号与用户从左到右看到的 clip 顺序一致
          out.push({
            key: k,
            s: list[i].start,
            e: list[i].end,
            label: list[i].label || T.clip + (out.length + 1)
          })
        }
        return out
      }
      function same(a, b) {
        if (a.length !== b.length) return false
        for (var i = 0; i < a.length; i++) {
          if (a[i].key !== b[i].key || a[i].label !== b[i].label) return false
        }
        return true
      }
      return {
        next: function () { return ++seq },
        put: function (token, start, end, label) {
          if (!isFinite(start) || !isFinite(end) || !(end > start)) return
          var hit = null
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].token === token) { hit = entries[i]; break }
          }
          if (hit) {
            if (hit.start === start && hit.end === end && hit.label === label) return
            hit.start = start
            hit.end = end
            hit.label = label
          } else {
            entries.push({ token: token, start: start, end: end, label: label })
          }
          var next = rebuild()
          publish(function (prev) { return same(prev, next) ? prev : next })
        }
      }
    }

    // ----------------------------------------------------------------------
    // Sprite —— 时间窗
    // ----------------------------------------------------------------------

    function Sprite(props) {
      var tl = useTimeline()
      var reg = useContext(BandContext)
      var parent = useContext(SpriteContext)
      var start = num(props.start, 0)
      var end = props.end == null || props.end === '' ? tl.duration : num(props.end, tl.duration)
      var label = props.label == null || props.label === '' ? '' : String(props.label)
      var isTop = !parent
      var tokenRef = useRef(0)
      if (!tokenRef.current && reg) tokenRef.current = reg.next()
      // 只登记顶层 Sprite：嵌在幕内部的 Sprite 是幕的内部结构，不是幕。
      // 无清理函数是故意的（见 makeRegistry 的粘性说明）。
      useEffect(function () {
        if (!reg || !isTop) return
        reg.put(tokenRef.current, start, end, label)
      }, [reg, isTop, start, end, label])
      var spriteDur = end - start
      var t = tl.time
      var visible = t >= start && t <= end
      var localTime = Math.max(0, t - start)
      var ctx = {
        localTime: localTime,
        duration: spriteDur,
        progress: isFinite(spriteDur) && spriteDur > 0 ? clamp(localTime / spriteDur, 0, 1) : 0,
        visible: visible
      }
      if (!visible && !bool(props.keepMounted, false)) return null
      var kids = typeof props.children === 'function' ? props.children(ctx) : props.children
      return h(SpriteContext.Provider, { value: ctx }, kids)
    }

    // ----------------------------------------------------------------------
    // 现成图元
    // ----------------------------------------------------------------------

    var TEXT_RISE = 18 // 进场上浮/退场上移的位移，纯审美取值
    var ALIGN_SHIFT = { left: '0', center: '-50%', right: '-100%' }

    function TextSprite(props) {
      var sp = useSprite()
      var entryDur = num(props.entryDur, 0.5)
      var exitDur = num(props.exitDur, 0.4)
      var ph = phaseOf(
        sp.localTime, sp.duration, entryDur, exitDur,
        fn(props.entryEase, Easing.easeOutCubic), fn(props.exitEase, Easing.easeInCubic)
      )
      var align = String(props.align || 'left').toLowerCase()
      var shift = ALIGN_SHIFT[align] || ALIGN_SHIFT.left
      var dy = (1 - ph.enter) * TEXT_RISE - ph.exit * TEXT_RISE
      var style = {
        position: 'absolute',
        left: num(props.x, 0) + 'px',
        top: num(props.y, 0) + 'px',
        margin: 0,
        opacity: ph.alpha,
        transform: 'translate(' + shift + ', ' + (Math.round(dy * 1000) / 1000) + 'px)',
        color: props.color || '#111318',
        fontSize: num(props.size, 48) + 'px',
        fontFamily: props.font || 'inherit',
        fontWeight: props.weight == null || props.weight === '' ? 600 : props.weight,
        letterSpacing: props.letterSpacing == null || props.letterSpacing === ''
          ? 'normal'
          : (typeof props.letterSpacing === 'number' ? props.letterSpacing + 'px' : props.letterSpacing),
        lineHeight: 1.15,
        whiteSpace: 'pre',
        textAlign: align,
        pointerEvents: 'none'
      }
      style = mergeStyle(style, props.style)
      return h('div', { style: style }, props.text == null ? props.children : props.text)
    }

    function ImageSprite(props) {
      var sp = useSprite()
      var entryDur = num(props.entryDur, 0.6)
      var exitDur = num(props.exitDur, 0.4)
      var ph = phaseOf(
        sp.localTime, sp.duration, entryDur, exitDur,
        fn(props.entryEase, Easing.easeOutCubic), fn(props.exitEase, Easing.easeInCubic)
      )
      // 进场：淡入 + 从略小放大到 1。保持段：kenBurns 匀速缓推到 kenBurnsScale。
      var scale = 0.96 + 0.04 * ph.enter
      if (bool(props.kenBurns, false)) {
        var target = num(props.kenBurnsScale, 1.08)
        scale = scale * (1 + (target - 1) * holdProgress(sp.localTime, sp.duration, entryDur, exitDur))
      }
      var box = {
        position: 'absolute',
        left: num(props.x, 0) + 'px',
        top: num(props.y, 0) + 'px',
        width: num(props.width, 400) + 'px',
        height: num(props.height, 300) + 'px',
        opacity: ph.alpha,
        transform: 'scale(' + (Math.round(scale * 1e4) / 1e4) + ')',
        transformOrigin: 'center center',
        borderRadius: num(props.radius, 0) + 'px',
        overflow: 'hidden',
        pointerEvents: 'none'
      }
      box = mergeStyle(box, props.style)
      var placeholder = props.placeholder
      if (placeholder) {
        // 模型的常见节奏是先排版后配图：给一块带纹理的占位，别去加载 src。
        return h('div', {
          style: Object.assign({}, box, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(20,22,26,.55)',
            fontSize: '15px',
            letterSpacing: '.04em',
            background:
              'repeating-linear-gradient(135deg, rgba(20,22,26,.06) 0 10px, rgba(20,22,26,.02) 10px 20px)',
            boxShadow: 'inset 0 0 0 1px rgba(20,22,26,.12)'
          })
        }, placeholder.label == null ? '' : String(placeholder.label))
      }
      return h('div', { style: box }, h('img', {
        src: props.src,
        alt: props.alt || '',
        draggable: false,
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: props.fit || 'cover'
        }
      }))
    }

    function RectSprite(props) {
      var sp = useSprite()
      var entryDur = num(props.entryDur, 0.45)
      var exitDur = num(props.exitDur, 0.35)
      var ph = phaseOf(
        sp.localTime, sp.duration, entryDur, exitDur,
        fn(props.entryEase, Easing.easeOutCubic), fn(props.exitEase, Easing.easeInCubic)
      )
      var style = {
        position: 'absolute',
        left: num(props.x, 0) + 'px',
        top: num(props.y, 0) + 'px',
        width: num(props.width, 200) + 'px',
        height: num(props.height, 120) + 'px',
        background: props.color || '#111318',
        borderRadius: num(props.radius, 0) + 'px',
        opacity: ph.alpha,
        transform: 'translateY(' + (Math.round((1 - ph.enter) * 12 * 1000) / 1000) + 'px)',
        pointerEvents: 'none'
      }
      style = mergeStyle(style, props.style)
      // 逃生舱口：图元不够用时不必从零写 Sprite，给个函数直接覆盖算出来的样式。
      var override = fn(props.render, null)
      if (override) {
        var extra = override(sp)
        if (extra && typeof extra === 'object') style = Object.assign(style, extra)
      }
      return h('div', { style: style }, props.children)
    }

    /**
     * VideoSprite —— 播放位置由舞台播放头驱动，不用视频自身的时钟。
     * 舞台时间按 speed 缩放后在 [start, end] 内取模循环，换算成源片时间戳写回；已经足够接近
     * 就不写（每帧 seek 会抖）。逐帧导出下**不保证**视频帧与 t 严格对齐（见文件头降级说明）。
     */
    function VideoSprite(props) {
      var tl = useTimeline()
      var ref = useRef(null)
      var src = props.src
      var start = num(props.start, 0)
      var end = num(props.end, NaN)
      var speed = num(props.speed, 1)
      var scaled = tl.time * speed
      var target = start
      if (isFinite(end) && end > start) {
        var span = end - start
        var into = scaled % span
        if (into < 0) into += span
        target = start + into
      } else {
        target = start + Math.max(0, scaled)
      }
      useLayoutEffect(function () {
        var el = ref.current
        if (!el) return
        try {
          if (!isFinite(el.currentTime) || Math.abs(el.currentTime - target) > 0.04) el.currentTime = target
        } catch (e) {
          /* 未就绪的解码器会抛，下一帧再试 */
        }
      }, [target])
      var rest = {}
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue
        if (k === 'src' || k === 'start' || k === 'end' || k === 'speed' || k === 'style' || k === 'children') continue
        rest[k] = props[k]
      }
      return h('video', Object.assign(rest, {
        ref: ref,
        src: src,
        muted: true,
        playsInline: true,
        preload: 'auto',
        style: mergeStyle({ display: 'block', pointerEvents: 'none' }, props.style)
      }))
    }

    // ----------------------------------------------------------------------
    // PlaybackBar —— 播放条
    // ----------------------------------------------------------------------

    function icon(paths, size) {
      var kids = []
      for (var i = 0; i < paths.length; i++) {
        kids.push(h('path', { key: 'p' + i, d: paths[i], fill: 'currentColor' }))
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true',
        style: { display: 'block' }
      }, kids)
    }

    var ICON_PLAY = ['M8 5.5v13l11-6.5z']
    var ICON_PAUSE = ['M7.5 5h3.2v14H7.5z', 'M13.3 5h3.2v14h-3.2z']
    var ICON_HOME = ['M7 5h2.6v14H7z', 'M19 5.5v13L10 12z']

    var BTN_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '30px',
      height: '30px',
      padding: 0,
      border: 0,
      borderRadius: '8px',
      background: 'transparent',
      color: 'rgba(255,255,255,.86)',
      cursor: 'pointer',
      flex: 'none'
    }

    // ----------------------------------------------------------------------
    // 剪辑轨（v2）——「控制行 + 轨道行」。v1 的「点色块弹浮层」已整体删除。
    // ----------------------------------------------------------------------

    var SPEED_CHOICES = [0.5, 1, 1.5, 2]

    // 高亮态与常态必须**声明同一组键**：React 的 style 差分对「上一次有、这一次没有」的键是
    // 直接写空串，而空串会把 border-color 打回初始值（黑色），于是按钮取消高亮后描一圈黑边。
    // 边框用长手写，不用 border 简写——简写与长手混着写，差分顺序会咬人。
    var ACT_BTN = {
      appearance: 'none',
      flex: 'none',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'rgba(255,255,255,.18)',
      background: 'transparent',
      color: 'rgba(255,255,255,.84)',
      fontWeight: 400,
      borderRadius: '6px',
      padding: '3px 7px',
      margin: 0,
      fontFamily: 'inherit',
      fontSize: '11px',
      lineHeight: '14px',
      cursor: 'pointer',
      fontVariantNumeric: 'tabular-nums'
    }
    var ACT_BTN_ON = {
      background: 'rgba(255,255,255,.92)',
      color: '#16181d',
      borderColor: 'transparent',
      fontWeight: 600
    }
    var ACT_BTN_X = Object.assign({}, ACT_BTN, { borderWidth: 0, padding: '1px 6px', fontSize: '13px' })

    // 切换按钮：三条长短不一的横杠，读起来就是「一条轨上排着几段」
    var ICON_LANE = ['M3.5 5.4h17v3.6h-17z', 'M3.5 10.2h10v3.6h-10z', 'M3.5 15h14v3.6h-14z']
    var LANE_BTN_ON = Object.assign({}, BTN_STYLE, { background: 'rgba(255,255,255,.14)', color: '#fff' })

    function speedBtn(v, mark, onSpeed) {
      return h('button', {
        key: 'sp' + v,
        type: 'button',
        'data-openpipal-speed': String(v),
        style: mark.speed === v ? Object.assign({}, ACT_BTN, ACT_BTN_ON) : ACT_BTN,
        onClick: function () { onSpeed(mark, v) }
      }, fmtSpeed(v))
    }

    /**
     * 选中段的操作区，平铺在**控制行**的中段。它是普通流内子节点：没有定位、没有 z-index、
     * 盖不住画布，于是既不需要 v1 那套「量 clip 中心 + 钳在舞台内」的布局 effect，
     * 也不存在「导出截图里混进浮层」这种需要靠时序去躲的风险面。
     * 宽度不够时先挤标题（ellipsis），按钮一律 flex:none —— 操作永远点得到。
     */
    function opsArea(ctl) {
      var mark = ctl.selectedMark
      var kids = [h('span', {
        key: 'title',
        style: {
          flex: '0 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          color: 'rgba(255,255,255,.88)'
        }
      }, mark.label + ' · ' + fmtTime(mark.s) + ' – ' + fmtTime(mark.e))]
      for (var i = 0; i < SPEED_CHOICES.length; i++) kids.push(speedBtn(SPEED_CHOICES[i], mark, ctl.onSpeed))
      kids.push(h('button', {
        key: 'del',
        type: 'button',
        'data-openpipal-delete': 'true',
        style: ACT_BTN,
        onClick: function () { ctl.onDelete(mark) }
      }, T.del))
      // 「重置全部编辑」只在 edl 非恒等时出现：没有编辑时它是个空动作，白占宽度还挤标题
      if (ctl.canReset) {
        kids.push(h('button', {
          key: 'rst',
          type: 'button',
          'data-openpipal-reset': 'true',
          style: ACT_BTN,
          onClick: ctl.onReset
        }, T.reset))
      }
      kids.push(h('button', {
        key: 'x',
        type: 'button',
        'aria-label': T.close,
        'data-openpipal-close': 'true',
        style: ACT_BTN_X,
        onClick: ctl.onClose
      }, '✕'))
      var box = {
        key: 'ops',
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          // 面板很窄时（OpenPipal 是贴边停靠的侧栏）标题会先被挤没，再窄就轮到按钮。
          // 让它横向可滚，最后一个按钮至少还够得着，而不是被 hidden 直接吞掉。
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none'
        }
      }
      box[ATTR_EDITOR] = mark.key
      return h('div', box, kids)
    }

    /**
     * 轨道行的 clip 层。位置一律按**输出时刻**换算——被删的幕在输出轴上宽度为 0，于是直接不画：
     * 不需要「删除态」的墓碑视觉，这是「映射放在输出轴」的直接好处。
     * clip 本体从 LANE_GUTTER 往下：顶上那一条留给播放头 knob 与倍速角标，两者都不去压 clip 里的名字。
     */
    function clipLayer(marks, selectedKey) {
      var out = []
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i]
        if (!m.live) continue
        var on = m.key === selectedKey
        var body = { key: 'c' + m.key, style: {
          position: 'absolute',
          top: LANE_GUTTER + 'px',
          bottom: LANE_FOOT + 'px',
          left: m.leftPct + '%',
          width: m.widthPct + '%',
          boxSizing: 'border-box',
          borderRadius: '3px',
          padding: '0 5px',
          lineHeight: (LANE_HEIGHT - LANE_GUTTER - LANE_FOOT) + 'px',
          fontSize: '11px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: on ? 'rgba(255,255,255,.96)' : 'rgba(255,255,255,.76)',
          // 重叠区（crossfade）照实叠加，半透明白自然叠出深浅，不做斑马纹
          background: on ? 'rgba(255,255,255,.44)' : 'rgba(255,255,255,.20)',
          // 连拍的 Beat 首尾相接铺满整条轴，不给左右各一道暗缝就是一整条灰带、看不出分段。
          // 缝画在 clip 内侧，不改几何，重叠区照样能读出两层。
          boxShadow: on
            ? 'inset 0 0 0 1px rgba(255,255,255,.95)'
            : 'inset 1px 0 0 rgba(16,18,22,.6), inset -1px 0 0 rgba(16,18,22,.6)',
          pointerEvents: 'none' // 指针事件归轨道，clip 只负责画
        } }
        body[ATTR_BAND] = m.key
        out.push(h('div', body, m.label))
        if (m.speed === m.speed && m.speed !== 1) {
          // 角标贴在 clip 右上角那条留白里。压进 clip 本体会跟名字抢位置，压到轨中间会被 knob 吃掉
          // ——v1 实测「0.5×」被 knob 啃成「0 ×」，这条留白就是那次截图验收留下的。
          var tag = { key: 'v' + m.key, style: {
            position: 'absolute',
            top: 0,
            left: m.leftPct + '%',
            width: m.widthPct + '%',
            height: LANE_GUTTER + 'px',
            lineHeight: LANE_GUTTER + 'px',
            textAlign: 'right',
            fontSize: '10px',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            color: 'rgba(255,255,255,.92)',
            textShadow: '0 0 3px rgba(16,18,22,.95)', // knob 扫过来时仍然读得出
            pointerEvents: 'none'
          } }
          tag[ATTR_BAND_SPEED] = m.key
          out.push(h('span', tag, fmtSpeed(m.speed)))
        }
      }
      return out
    }

    /** 贯穿轨道行的播放头 + 已播放区提亮（NLE 惯例）。画在 clip 层之上，视觉层级与 v1 一致。 */
    function laneHead(pct) {
      return [
        h('div', {
          key: 'played',
          style: {
            position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%',
            background: 'rgba(255,255,255,.10)', pointerEvents: 'none'
          }
        }),
        h('div', {
          key: 'head',
          style: {
            position: 'absolute', left: pct + '%', top: 0, bottom: 0, width: '1px',
            marginLeft: '-0.5px', background: 'rgba(255,255,255,.92)', pointerEvents: 'none'
          }
        }),
        h('div', {
          key: 'knob',
          style: {
            position: 'absolute', left: pct + '%', top: '1px', width: '9px', height: '9px',
            marginLeft: '-4.5px', borderRadius: '50%', background: '#fff', pointerEvents: 'none'
          }
        })
      ]
    }

    function PlaybackBar() {
      var tl = useTimeline()
      var ctl = useContext(ControlContext)
      // 舞台外单独摆一条没有意义（没有可控的时间轴），静默不渲染。
      if (!ctl) return null
      // 播放条整条都在**输出轴**上：进度、clip、时间读数、擦洗都用输出时长换算。
      // tl.duration 是源时长（给场景用的），在这里用它就会与被编辑过的时间轴对不上。
      var duration = ctl.outDuration
      var shown = ctl.displayTime
      var pct = duration > 0 ? clamp(shown / duration, 0, 1) * 100 : 0
      var marks = ctl.marks
      // 一个幕都没登记 → 不出切换按钮、永远收起态，与没有本能力时逐像素一致
      var hasBands = marks.length > 0
      var lane = hasBands && ctl.laneOpen

      var scrub = {
        onPointerDown: ctl.onPointerDown,
        onPointerMove: ctl.onPointerMove,
        onPointerUp: ctl.onPointerUp,
        onPointerCancel: ctl.onPointerUp,
        onPointerLeave: ctl.onPointerLeave
      }

      // 控制行中段是一个可变槽：收起态放今天那条 4px 细轨（擦洗面），展开态放选中段的操作区。
      // **两态都只有一个擦洗面**：展开时擦洗归轨道行，这里就不再画第二条轨。
      var middle
      if (lane) {
        middle = ctl.selectedMark
          ? opsArea(ctl)
          : h('div', { key: 'ops', style: { flex: '1 1 auto', minWidth: 0 } })
      } else {
        middle = h('div', Object.assign({
          key: 'track',
          ref: ctl.trackRef,
          style: {
            flex: '1 1 auto',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            touchAction: 'none'
          }
        }, scrub), h('div', {
          style: {
            position: 'relative',
            width: '100%',
            height: '4px',
            borderRadius: '999px',
            background: 'rgba(255,255,255,.16)'
          }
        }, [
          h('div', {
            key: 'fill',
            style: {
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: pct + '%',
              borderRadius: '999px',
              background: 'rgba(255,255,255,.72)'
            }
          }),
          h('div', {
            key: 'knob',
            style: {
              position: 'absolute',
              left: pct + '%',
              top: '50%',
              width: '11px',
              height: '11px',
              marginLeft: '-5.5px',
              marginTop: '-5.5px',
              borderRadius: '50%',
              background: '#fff'
            }
          })
        ]))
      }

      var laneBtn = null
      if (hasBands) {
        var btn = {
          key: 'lane-btn',
          type: 'button',
          style: lane ? LANE_BTN_ON : BTN_STYLE,
          'aria-label': T.lane,
          onClick: ctl.toggleLane
        }
        btn[ATTR_LANE] = lane ? '1' : '0'
        laneBtn = h('button', btn, icon(ICON_LANE, 15))
      }

      var row = h('div', {
        key: 'row',
        style: {
          height: BAR_HEIGHT + 'px',
          boxSizing: 'border-box',
          borderTop: '1px solid rgba(255,255,255,.10)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '0 12px'
        }
      }, [
        h('button', {
          key: 'play',
          type: 'button',
          style: BTN_STYLE,
          'aria-label': tl.playing ? 'Pause' : 'Play',
          onClick: ctl.toggle
        }, icon(tl.playing ? ICON_PAUSE : ICON_PLAY, 18)),
        h('button', {
          key: 'home',
          type: 'button',
          style: BTN_STYLE,
          'aria-label': 'Restart',
          onClick: ctl.restart
        }, icon(ICON_HOME, 16)),
        middle,
        h('div', {
          key: 'time',
          style: { flex: 'none', fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }
        }, fmtTime(shown) + ' / ' + fmtTime(duration)),
        laneBtn
      ])

      // 轨道行：clip 长在条上，选中即操作。擦洗面在这里，指针语义与收起态那条细轨同源。
      var laneRow = lane
        ? h('div', {
            key: 'lane',
            style: {
              height: LANE_HEIGHT + 'px',
              boxSizing: 'border-box',
              padding: '0 12px',
              display: 'flex',
              alignItems: 'stretch'
            }
          }, h('div', Object.assign({
            ref: ctl.trackRef,
            style: {
              position: 'relative',
              flex: '1 1 auto',
              minWidth: 0,
              cursor: 'pointer',
              touchAction: 'none'
            }
          }, scrub), clipLayer(marks, ctl.selectedKey).concat(laneHead(pct))))
        : null

      // 整条是一个 flex 列：收起态只有控制行（实测 44，与今天逐像素一致），展开态 44 + 40 = 84。
      return h('div', {
        style: {
          flex: 'none',
          background: '#191b20',
          fontFamily: 'ui-sans-serif, -apple-system, system-ui, sans-serif',
          fontSize: '12px',
          color: 'rgba(255,255,255,.72)',
          userSelect: 'none'
        }
      }, [row, laneRow])
    }

    /** 命中测试：重叠处取 start 更大的那个——用户看到的「当前这一幕」总是后进场的那个 */
    function bandAt(marks, outT) {
      var best = null
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i]
        if (!m.live || outT < m.outS || outT > m.outE) continue
        if (!best || m.s > best.s) best = m
      }
      return best
    }

    // ----------------------------------------------------------------------
    // Stage —— 舞台
    // ----------------------------------------------------------------------

    function Stage(props) {
      var width = Math.max(1, Math.round(num(props.width, DEFAULT_WIDTH)))
      var height = Math.max(1, Math.round(num(props.height, DEFAULT_HEIGHT)))
      var duration = num(props.duration, DEFAULT_DURATION)
      if (!(duration > 0)) duration = DEFAULT_DURATION
      var loop = bool(props.loop, true)
      var autoplay = bool(props.autoplay, true)
      var background = props.background == null || props.background === '' ? CANVAS_BG : props.background
      var persistPrefix = props.persistKey == null || props.persistKey === ''
        ? DEFAULT_PERSIST_KEY
        : String(props.persistKey)
      var storageKey = persistPrefix + PERSIST_SUFFIX
      var edlKey = persistPrefix + EDL_SUFFIX
      var laneKey = persistPrefix + LANE_SUFFIX
      num(props.fps, 30) // 保留字段：收下、强转、不使用（导出帧率来自宿主参数）

      var rootRef = useRef(null)
      var viewportRef = useRef(null)
      var canvasRef = useRef(null)
      var trackRef = useRef(null)
      var timeRef = useRef(0)
      var durationRef = useRef(duration) // 源时长（props.duration），场景看到的那个
      var outDurRef = useRef(duration) // 输出时长（吃过编辑表），播放头与播放条活在这条轴上
      var loopRef = useRef(loop)
      var hoveredRef = useRef(false)
      var draggingRef = useRef(false)
      var lastWriteRef = useRef(0)
      var edlRef = useRef(null)
      var marksRef = useRef(NO_BANDS)
      var laneOpenRef = useRef(true)
      durationRef.current = duration
      loopRef.current = loop

      // ---- 编辑表：宿主注入 > localStorage > 恒等。恒等时下面一切映射走短路，与没有本能力等价。----
      var edlState = useState(function () { return readInitialEdl(duration, edlKey) })
      var edl = edlState[0]
      var setEdl = edlState[1]
      var outDuration = edlOutDuration(edl, duration)
      edlRef.current = edl
      outDurRef.current = outDuration

      // 幕登记表：顶层 Sprite 自注册（见 makeRegistry）
      var bandsState = useState(NO_BANDS)
      var bands = bandsState[0]
      var setBands = bandsState[1]
      var regRef = useRef(null)
      if (!regRef.current) regRef.current = makeRegistry(setBands)

      // 冷启动定格：初值直接读回持久化的播放头，**首帧就渲在那个时刻**，
      // 不先渲一帧 t=0 再由 effect 跳过去（自检链路整条依赖这一点）。
      // 存的是**输出时刻**，编辑后旧值可能越界，照常钳进 [0, outDuration]。
      var timeState = useState(function () {
        var restored = readPersisted(storageKey)
        var t0 = isFinite(restored) ? clamp(restored, 0, outDuration) : 0
        timeRef.current = t0
        return t0
      })
      var time = timeState[0]
      var setTimeState = timeState[1]

      var playState = useState(function () { return autoplay })
      var playing = playState[0]
      var setPlaying = playState[1]

      // 悬停预览：只改显示的时刻，不动播放头
      var hoverState = useState(null)
      var hoverTime = hoverState[0]
      var setHoverTime = hoverState[1]

      var scaleState = useState(1)
      var scale = scaleState[0]
      var setScale = scaleState[1]

      // 选中的幕（存 key 而不是对象：幕是**源时间**窗，编辑不会改它，key 因此天然稳定）
      var selState = useState(null)
      var selectedKey = selState[0]
      var setSelected = selState[1]

      // 剪辑轨展开/收起。**有幕时默认展开**——不点也能看见分段，这正是 v2 的目的。
      // 一个幕都没登记时这个状态渲染不出任何东西（PlaybackBar 自己判 marks.length）。
      var laneState = useState(function () { return readLane(laneKey, true) })
      var laneOpen = laneState[0]
      var setLaneOpen = laneState[1]
      laneOpenRef.current = laneOpen

      var persist = useCallback(function (v, force) {
        var n = now()
        if (!force && n - lastWriteRef.current < 250) return
        lastWriteRef.current = n
        writePersisted(storageKey, v)
      }, [storageKey])

      /** 绝对赋值：导出定位、擦洗、键盘步进共用同一条路径。**输出轴**上的时刻。 */
      var applyTime = useCallback(function (v) {
        var t = clamp(v, 0, outDurRef.current)
        timeRef.current = t
        setTimeState(t)
        persist(t, true)
      }, [persist])

      // ---- 播放推进：按真实经过时间累积（预览路径），画面仍然只由 t 决定 ----
      useEffect(function () {
        if (!playing || !(outDuration > 0)) return
        var raf = 0
        var last = now()
        function step() {
          var n = now()
          // 单帧步长封顶：窗口被切走后回来不该一次跳过半段时间轴
          var dt = Math.min(0.25, Math.max(0, (n - last) / 1000))
          last = n
          var next = timeRef.current + dt
          // 推进走**输出轴**：被删片段在这条轴上不占长度，于是「推进时落进被删区间」不可能发生，
          // 不需要任何跳段逻辑。这正是把映射放在输出轴的收益。
          var total = outDurRef.current
          if (next >= total) {
            if (loopRef.current && total > 0) {
              next = next % total
            } else {
              timeRef.current = total
              setTimeState(total)
              persist(total, true)
              setPlaying(false)
              return
            }
          }
          timeRef.current = next
          setTimeState(next)
          persist(next)
          raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
        return function () { cancelAnimationFrame(raf) }
      }, [playing, outDuration, persist])

      // 开始播放即清除选中（§3.3 的关闭时机之一，v2 语义改成「清选中」）。
      // 没选中时 setState 同值，React 当场 bail out。
      useEffect(function () {
        if (playing) setSelected(null)
      }, [playing])

      // ---- C4/C5：标记属性与定位监听都挂在画布元素自身 ----
      // 属性用 setAttribute 直写：宿主按 HTML 属性读尺寸（getAttribute('width')），
      // 不受 React 各版本对非常规属性的处理差异影响。
      var seekRef = useRef(null)
      seekRef.current = function (t) {
        // 定位即暂停：否则播放循环会在定位与截图之间把播放头推走，导出出现相位漂移。
        flush(function () {
          setPlaying(false)
          setHoverTime(null)
          setSelected(null) // 宿主定位 = 导出/自检正在跑，操作区必须让路
          applyTime(t)
        })
      }

      // ATTR_DURATION 报的是**输出时长**：宿主按它决定导出多少帧，编辑必须体现在这里。
      useLayoutEffect(function () {
        var el = canvasRef.current
        if (!el) return
        el.setAttribute('width', String(width))
        el.setAttribute('height', String(height))
        el.setAttribute(ATTR_DURATION, secsAttr(outDuration))
      }, [width, height, outDuration])

      useLayoutEffect(function () {
        var el = canvasRef.current
        if (!el) return
        function onSeek(e) {
          var detail = e && e.detail
          var t = detail && detail.time
          if (t == null || !isFinite(Number(t))) return
          seekRef.current(Number(t))
        }
        // 事件不冒泡，宿主直接派发到这个元素上；监听器也必须挂在它自己身上。
        el.addEventListener(EVT_SEEK, onSeek)
        return function () { el.removeEventListener(EVT_SEEK, onSeek) }
      }, [])

      // ---- C6：字体就绪即置位。没有可做的事时也必须置位，不能永不置位。 ----
      useEffect(function () {
        var done = false
        function mark() {
          if (done) return
          done = true
          var el = canvasRef.current
          if (el) el.setAttribute(ATTR_FONTS, 'true')
        }
        var timer = setTimeout(mark, 1200)
        try {
          var fonts = document.fonts
          if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(mark, mark)
          else mark()
        } catch (e) {
          mark()
        }
        return function () { clearTimeout(timer) }
      }, [])

      // ---- 自适应缩放：**封顶为 1**（不放大）。宿主把视口仿真成 宽 x (高+60) 后
      //      断言画布实测尺寸等于原生尺寸（±2px），超采样放大会直接失配中止导出。----
      useLayoutEffect(function () {
        var box = viewportRef.current
        if (!box) return
        function measure() {
          var w = box.clientWidth
          var hgt = box.clientHeight
          // 量不到（还没排版 / 父级高度为 auto）就当这一维不构成约束，别把 scale 算成 0
          var rw = w > 0 ? w / width : Infinity
          var rh = hgt > 0 ? hgt / height : Infinity
          var s = Math.min(1, rw, rh)
          if (!(s > 0) || !isFinite(s)) s = 1
          setScale(function (prev) { return Math.abs(prev - s) < 0.0005 ? prev : s })
        }
        measure()
        var ro = null
        if (typeof window.ResizeObserver === 'function') {
          ro = new window.ResizeObserver(measure)
          ro.observe(box)
        }
        window.addEventListener('resize', measure)
        return function () {
          if (ro) ro.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [width, height])

      // ---- 键盘 ----
      var toggle = useCallback(function () {
        setPlaying(function (p) {
          if (!p && timeRef.current >= outDurRef.current - 1e-4 && !loopRef.current) {
            applyTime(0) // 停在末尾再按播放：从头来
          }
          return !p
        })
      }, [applyTime])

      var stepBy = useCallback(function (delta) {
        setPlaying(false)
        applyTime(timeRef.current + delta)
      }, [applyTime])

      useEffect(function () {
        var self = { root: rootRef }
        stages.push(self)
        function owns() {
          if (stages.length === 1) return true
          if (hoveredRef.current) return true
          var root = rootRef.current
          return !!(root && document.activeElement && root.contains(document.activeElement))
        }
        function onKey(e) {
          if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
          if (isTypingTarget(e.target)) return // 不吞用户打字
          if (!owns()) return
          var key = e.key
          if (key === ' ' || key === 'Spacebar') { e.preventDefault(); toggle(); return }
          if (key === 'ArrowLeft') { e.preventDefault(); stepBy(-(e.shiftKey ? STEP_LARGE : STEP_SMALL)); return }
          if (key === 'ArrowRight') { e.preventDefault(); stepBy(e.shiftKey ? STEP_LARGE : STEP_SMALL); return }
          if (key === '0' || key === 'Home') { e.preventDefault(); setPlaying(false); applyTime(0); return }
          // Escape 只清选中，不是新增的播放快捷键：不 preventDefault，宿主的 Esc 语义照走
          if (key === 'Escape') setSelected(null)
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
          var i = stages.indexOf(self)
          if (i >= 0) stages.splice(i, 1)
        }
      }, [toggle, stepBy, applyTime])

      // ---- 轨道擦洗（全程输出轴）----
      var timeFromEvent = useCallback(function (e) {
        var el = trackRef.current
        if (!el) return 0
        var r = el.getBoundingClientRect()
        if (!(r.width > 0)) return 0
        return clamp((e.clientX - r.left) / r.width, 0, 1) * outDurRef.current
      }, [])

      var onPointerDown = useCallback(function (e) {
        draggingRef.current = true
        setHoverTime(null)
        setPlaying(false)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* 捕获不到就退回普通跟随 */ }
        var t = timeFromEvent(e)
        applyTime(t)
        // 定位 + 暂停 + 开始擦洗的既有语义原样保留，在此之上顺手选中按下点所在的幕；
        // 落在空白处就清除选中（这是「关闭操作区」的时机之一）。
        var hit = bandAt(marksRef.current, t)
        // 收起态没有操作区可显示，选中就成了一个看不见的状态：定位/暂停/擦洗照旧，只是不选。
        setSelected(laneOpenRef.current && hit ? hit.key : null)
      }, [applyTime, timeFromEvent])

      var onPointerMove = useCallback(function (e) {
        if (draggingRef.current) { applyTime(timeFromEvent(e)); return }
        setHoverTime(timeFromEvent(e)) // 悬停只改预览显示的时刻，不动播放头
      }, [applyTime, timeFromEvent])

      var onPointerUp = useCallback(function (e) {
        if (!draggingRef.current) return
        draggingRef.current = false
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (err) { /* 同上 */ }
      }, [])

      var onPointerLeave = useCallback(function () {
        if (!draggingRef.current) setHoverTime(null)
      }, [])

      var restart = useCallback(function () {
        applyTime(0)
      }, [applyTime])

      // ---- 编辑动作：全部落在 edlApplyRange 这一个写入原语上 ----
      var baseEdl = useCallback(function () {
        var cur = edlRef.current
        return cur && cur.length ? cur : edlIdentity(durationRef.current)
      }, [])

      var commitEdl = useCallback(function (next) {
        // 原语被保底闸挡下时原样返回入参那个引用：什么也没发生，不写、不派事件、不提示
        if (next === edlRef.current || !next || !next.length) return
        var srcNow = edlToSource(edlRef.current, durationRef.current, timeRef.current)
        var nextOut = edlOutDuration(next, durationRef.current)
        edlRef.current = next
        outDurRef.current = nextOut
        setEdl(next)
        // 播放头按「源时刻不变」重新落到新输出轴上，于是编辑前后看到的画面不跳
        applyTime(edlToOutput(next, durationRef.current, srcNow))
        writePersisted(edlKey, JSON.stringify(next))
        // 宿主据此把编辑表写回产物 html，让导出也吃到编辑——那一步是宿主的活，本件只管派事件。
        var el = canvasRef.current
        if (el) {
          el.dispatchEvent(new CustomEvent(EVT_EDL, {
            bubbles: false,
            detail: { edl: next, duration: durationRef.current, outDuration: nextOut }
          }))
        }
      }, [applyTime, edlKey])

      var setBandSpeed = useCallback(function (mark, v) {
        commitEdl(edlApplyRange(baseEdl(), mark.s, mark.e, v))
      }, [commitEdl, baseEdl])

      var deleteBand = useCallback(function (mark) {
        commitEdl(edlApplyRange(baseEdl(), mark.s, mark.e, 0)) // 删除不单开代码路径：speed=0 而已
      }, [commitEdl, baseEdl])

      var resetEdits = useCallback(function () {
        commitEdl(edlApplyRange(baseEdl(), 0, durationRef.current, 1))
      }, [commitEdl, baseEdl])

      var closeEditor = useCallback(function () { setSelected(null) }, [])

      // 收起时顺手清选中：操作区跟着轨道走，留一个渲染不出来的选中态只会让下次展开时莫名其妙。
      var toggleLane = useCallback(function () {
        var next = !laneOpenRef.current
        laneOpenRef.current = next
        setLaneOpen(next)
        if (!next) setSelected(null)
        writeLane(laneKey, next)
      }, [laneKey])

      // 作者把 duration 改掉时旧表铺不满新时间轴，算出来的 ATTR_DURATION 就是错的。
      // 就地重铺一次并落盘（顺带让宿主收到新表）。恒等表下 edlRef 是 null，这条走不到。
      useEffect(function () {
        var cur = edlRef.current
        if (!cur || !cur.length || cur[cur.length - 1].e === duration) return
        commitEdl(edlNormalize(cur, duration))
      }, [duration, commitEdl])

      // ---- 渲染：画面只是 displayTime 的函数 ----
      // displayTime 是**输出时刻**；下发给场景的是 toSource(displayTime)。恒等表下两者逐位相同。
      var displayTime = clamp(hoverTime == null ? time : hoverTime, 0, outDuration)
      var sourceTime = edlToSource(edl, duration, displayTime)

      // 幕在输出轴上的位置。被删的幕宽度为 0（live=false），不画也点不中。
      var marks = []
      var mi
      for (mi = 0; mi < bands.length; mi++) {
        var bd = bands[mi]
        var bs = clamp(bd.s, 0, duration)
        var be = clamp(bd.e, 0, duration)
        var oS = edlToOutput(edl, duration, bs)
        var oE = edlToOutput(edl, duration, be)
        marks.push({
          key: bd.key,
          label: bd.label,
          s: bs,
          e: be,
          outS: oS,
          outE: oE,
          live: oE - oS > 1e-6,
          speed: edlSpeedOver(edl, bs, be),
          leftPct: outDuration > 0 ? (oS / outDuration) * 100 : 0,
          widthPct: outDuration > 0 ? ((oE - oS) / outDuration) * 100 : 0
        })
      }
      marksRef.current = marks

      var selectedMark = null
      if (selectedKey != null) {
        for (mi = 0; mi < marks.length; mi++) {
          if (marks[mi].key === selectedKey) { selectedMark = marks[mi]; break }
        }
      }

      var timeline = {
        time: sourceTime,
        duration: duration,
        playing: playing,
        setTime: function (v) { setPlaying(false); applyTime(v) },
        setPlaying: function (v) { setPlaying(!!v) }
      }
      var control = {
        displayTime: displayTime,
        outDuration: outDuration,
        marks: marks,
        selectedKey: selectedKey,
        selectedMark: selectedMark,
        canReset: !edlIsIdentity(edl),
        laneOpen: laneOpen,
        toggle: toggle,
        restart: restart,
        trackRef: trackRef,
        toggleLane: toggleLane,
        onSpeed: setBandSpeed,
        onDelete: deleteBand,
        onReset: resetEdits,
        onClose: closeEditor,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerLeave: onPointerLeave
      }

      var rootStyle = mergeStyle({
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: BACKDROP
      }, props.style)

      // 画布是被截图的那个元素：它内部只有作者的画面，播放条与 letterbox 都是它的兄弟/祖先，
      // 落在 clip 矩形之外（C9）。缩放用 transform + 外层等比盒，量到的边界就是缩放后的真实尺寸。
      var canvas = h('div', {
        ref: canvasRef,
        style: {
          position: 'relative',
          width: width + 'px',
          height: height + 'px',
          transform: 'scale(' + scale + ')',
          transformOrigin: '0 0',
          background: background,
          overflow: 'hidden'
        }
      }, props.children)

      var fitter = h('div', {
        style: {
          position: 'relative',
          flex: 'none',
          width: width * scale + 'px',
          height: height * scale + 'px'
        }
      }, canvas)

      var viewport = h('div', {
        key: 'vp',
        ref: viewportRef,
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }
      }, fitter)

      // 根永远只有两个子节点：画布视口 + 播放条。v2 没有浮层，于是也没有「盖在画布上的第三层」
      // ——操作区是控制行里的普通流内节点，几何上就不可能进到截图矩形里（C9）。
      return h('div', {
        ref: rootRef,
        className: props.className,
        style: rootStyle,
        onMouseEnter: function () { hoveredRef.current = true },
        onMouseLeave: function () { hoveredRef.current = false }
      }, h(TimelineContext.Provider, { value: timeline },
        h(BandContext.Provider, { value: regRef.current },
          h(ControlContext.Provider, { value: control }, [viewport, h(PlaybackBar, { key: 'bar' })])
        )
      ))
    }

    // ----------------------------------------------------------------------
    // 全局暴露：**一条原子语句**，且必须含 Stage。
    // artifact-store.ts 的场景编译门闩只轮询 window.Stage，并以「Stage 在场 => 整条链在场」
    // 为前提放行场景求值；分次赋值会让场景在 Sprite/useTime 还没挂上时开跑。
    // ----------------------------------------------------------------------
    Object.assign(window, {
      Stage: Stage,
      Sprite: Sprite,
      PlaybackBar: PlaybackBar,
      TimelineContext: TimelineContext,
      SpriteContext: SpriteContext,
      useTime: useTime,
      useTimeline: useTimeline,
      useSprite: useSprite,
      TextSprite: TextSprite,
      ImageSprite: ImageSprite,
      RectSprite: RectSprite,
      VideoSprite: VideoSprite,
      Easing: Easing,
      interpolate: interpolate,
      animate: animate,
      clamp: clamp
    })
  }

  // ==========================================================================
  // 3. 启动门闩（C3）：本件被注入到 head 顶部，早于 React。自己等齐再跑。
  // ==========================================================================

  function reactReady() {
    return !!(window.React && window.ReactDOM)
  }

  if (reactReady()) {
    boot()
  } else {
    var tries = 0
    var timer = setInterval(function () {
      if (reactReady()) {
        clearInterval(timer)
        boot()
        return
      }
      if (++tries > 500) { // 约 15s
        clearInterval(timer)
        console.error('[OpenPipal] animations 运行时等不到 React/ReactDOM，动画舞台未启动。')
      }
    }, 30)
  }
})()
