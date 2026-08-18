/**
 * three-d-stage —— OpenPipal 自研的 3D 物体舞台（自注册 Web Component，零我方外部资源、无 React、无构建步骤）。
 * 把作者交进来的 THREE.Object3D 变成「能转、能看、能下载」的产品渲染图：摄影棚三点布光 + 半球环境光、
 * 地面软阴影与接触暗部、按包围盒自动取景、轨道控制与转台，右上角 OBJ+MTL / GLB 下载工具栏。
 *
 * 作者接口只有三样：属性 name（导出文件基名，默认 model）/ background（画布底色）/ autorotate（慢速转台，
 * 用户一拖即永久停）；`await stage.ready` 拿到 { THREE }（与舞台同一份实例，instanceof 与材质系统才对得上），
 * 再 `stage.setObject(group)` 把模型交出来——相机、灯、地面、导出全归舞台，作者只写建模。
 *
 * three.js 由页面的 importmap 提供（钉版本 + SRI，不 vendor），本件只用裸说明符 import，不写 URL / 版本 / SRI。
 * 且 three 走**动态** import：解析不到（离线、无 importmap）时元素仍要注册成功并挂上 shadowRoot——
 * 宿主对这一件的确定性断言就落在「已注册 + 有 shadowRoot」上，不能被一次外网抖动带走。
 */
(function () {
  'use strict'

  if (typeof window === 'undefined' || !window.customElements) return
  // 幂等自注册：同一份源码可能被内联两次（流式预载 + 终稿），重复 define 会抛 NotSupportedError 并带走整段脚本
  if (window.customElements.get('three-d-stage')) return

  // ---- 摄影棚布光：无环境贴图，体积感全靠光比与色温，所以主/补/轮廓三盏缺一不可 ----
  // dir 是「相对物体中心的方向」，灯位 = 中心 + normalize(dir) x 包围球半径 x LIGHT_SPAN，
  // 这样 1cm 的螺丝和 10m 的房子用同一套布光都成立。只有主光投影——一个影子才像棚拍，多影子像会议室。
  var RIG = [
    { id: 'key', dir: [-0.72, 0.88, 0.62], color: 0xfff3e4, intensity: 3.4, shadow: true },
    { id: 'fill', dir: [0.95, 0.20, 0.78], color: 0xdce7ff, intensity: 0.95, shadow: false },
    { id: 'rim', dir: [0.20, 0.66, -1.0], color: 0xffffff, intensity: 2.1, shadow: false }
  ]
  var LIGHT_SPAN = 3.4
  var HEMI_INTENSITY = 0.75 // 半球光把底色掀起来：metalness 上限 0.4 的材质没有反射可依，全靠它托底

  // 阴影：主光一张 2048 图，正交框在光空间里按「物体 + 它落在地上的影子」实测紧贴——
  // 贴得越紧每个 texel 越小，同样的 radius 才能糊出干净的半影而不是马赛克
  var SHADOW_MAP = 2048
  var SHADOW_PAD = 0.06 // 正交框四周留白，占半对角线的比例
  var SHADOW_SOFTNESS = 20 // 这就是软硬旋钮：PCF 按 radius x texel 撒 Vogel 盘采样
  var SHADOW_OPACITY = 0.3 // ShadowMaterial 只画影子不画平面，平面边界天然不存在
  var AO_OPACITY = 0.38 // 叠一层径向渐变的接触暗部，把物体「压」在地上——硬投影单独用会飘

  // 取景：偏长焦的视角，透视畸变小，产品图的常规选择
  var FOV = 32
  var FIT_MARGIN = 1.08 // 有效视场角按此收窄换来的画幅留白
  var VIEW_DIR = [0.78, 0.42, 1.0] // 四分之三视角、略高于视平线：轮廓信息量最大的机位
  var ZOOM_IN = 0.5 // minDistance = 半径 x 此值
  var ZOOM_OUT = 12 // maxDistance = 半径 x 此值

  var AUTOROTATE_SPEED = 0.9 // OrbitControls 的 2.0 约 30s 一圈，这里约 65s：转台是背景音，不是动效
  var DAMPING = 0.075
  var MAX_DPR = 2
  var DEFAULT_BG = '#f0eee6'
  var NOTE_MS = 5200
  var SECOND_FILE_DELAY = 400 // OBJ 与 MTL 是两个下载，挨太近浏览器会吞掉第二个

  var MSG = {
    noThree: 'three.js 没能加载 —— 这个 3D 物体需要联网 / three.js failed to load (this page needs network)',
    noGl: 'WebGL 不可用，无法渲染 / WebGL unavailable',
    lost: 'WebGL 上下文丢失，刷新页面重试 / WebGL context lost — reload the page',
    empty: '还没有模型可导出 / nothing to export yet',
    failed: '导出失败 / export failed'
  }

  function warn(msg) {
    try { console.warn('[three-d-stage] ' + msg) } catch (e) {}
  }

  function num(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(v)
    return isFinite(n) ? n : d
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

  // ---- 颜色：用 2D 画布当 CSS 颜色解析器（同一个字符串喂两个不同底色，都被改写才算解析成功）----
  var probe = null
  function cssColor(v) {
    if (v == null || v === '') return null
    try {
      if (!probe) probe = document.createElement('canvas').getContext('2d')
      if (!probe) return null
      probe.fillStyle = '#000000'
      probe.fillStyle = v
      var a = probe.fillStyle
      probe.fillStyle = '#ffffff'
      probe.fillStyle = v
      return a === probe.fillStyle ? a : null
    } catch (e) { return null }
  }

  /** 相对亮度（sRGB 转线性后加权），只用来决定工具栏走浅色还是深色 */
  function luminance(css) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(css || ''))
    if (!m) return 1
    var n = parseInt(m[1], 16)
    function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  }

  /** name 属性 -> 安全文件基名（去掉路径分隔符、空白与我们自己会补的后缀） */
  function fileBase(v) {
    var s = String(v == null ? '' : v).trim()
      .replace(/\.(obj|mtl|glb|gltf)$/i, '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 80)
    return s || 'model'
  }

  /** OBJ 的 o / usemtl 记号不能含空白与注释符；非 ASCII 保留（Blender 按 UTF-8 读） */
  function objName(v, fallback) {
    var s = String(v == null ? '' : v).replace(/#/g, '').trim().replace(/\s+/g, '_')
    return s || fallback
  }

  function unique(base, table) {
    var n = base, i = 2
    while (table[n]) n = base + '_' + i++
    table[n] = 1
    return n
  }

  // ---- 下载：iframe 的 sandbox 没有 allow-same-origin，storage 一律不可用，但 blob + <a download> 可以 ----
  function download(host, blob, filename) {
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    host.appendChild(a)
    a.click()
    // 撤销太早会把还在写盘的下载掐断，给一分钟宽限
    setTimeout(function () {
      try { a.remove(); URL.revokeObjectURL(url) } catch (e) {}
    }, 60000)
  }

  var ICON =
    '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 2.2v8"/><path d="M4.7 7.3 8 10.6l3.3-3.3"/>' +
    '<path d="M2.7 12.3v.5a1.2 1.2 0 0 0 1.2 1.2h8.2a1.2 1.2 0 0 0 1.2-1.2v-.5"/></svg>'

  var CSS = [
    ':host{display:block;position:relative;width:100%;height:100%;min-height:320px;overflow:hidden;',
    '--ui-bg:rgba(255,255,255,.78);--ui-fg:#1c1b19;--ui-line:rgba(0,0,0,.10);',
    '--ui-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 22px rgba(0,0,0,.11);--ui-ring:rgba(0,0,0,.42)}',
    '.stage{position:absolute;inset:0}',
    '.stage.dark{--ui-bg:rgba(28,28,30,.72);--ui-fg:#f4f3f1;--ui-line:rgba(255,255,255,.16);',
    '--ui-shadow:0 1px 2px rgba(0,0,0,.30),0 8px 22px rgba(0,0,0,.38);--ui-ring:rgba(255,255,255,.62)}',
    'canvas{display:block}',
    '.bar{position:absolute;top:12px;right:12px;display:flex;gap:6px;z-index:2}',
    '.bar[hidden],.note[hidden]{display:none}',
    '.btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;margin:0;',
    'border:1px solid var(--ui-line);border-radius:999px;background:var(--ui-bg);color:var(--ui-fg);',
    'font:500 12px/1 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    'letter-spacing:.01em;white-space:nowrap;cursor:pointer;box-shadow:var(--ui-shadow);',
    '-webkit-backdrop-filter:blur(10px) saturate(150%);backdrop-filter:blur(10px) saturate(150%);',
    'transition:transform .12s ease,opacity .12s ease}',
    '.btn:hover{transform:translateY(-1px)}',
    '.btn:active{transform:translateY(0)}',
    '.btn:focus-visible{outline:2px solid var(--ui-ring);outline-offset:2px}',
    '.btn[disabled]{cursor:progress;opacity:.6}',
    '.btn .ico{width:13px;height:13px;flex:none}',
    '.btn[disabled] .ico{animation:tds-pulse 1s ease-in-out infinite}',
    '@keyframes tds-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
    '.note{position:absolute;top:52px;right:12px;max-width:min(360px,74%);padding:8px 12px;',
    'border:1px solid var(--ui-line);border-radius:10px;background:var(--ui-bg);color:var(--ui-fg);',
    'box-shadow:var(--ui-shadow);z-index:2;',
    '-webkit-backdrop-filter:blur(10px) saturate(150%);backdrop-filter:blur(10px) saturate(150%);',
    'font:400 12px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
    '.note.fatal{top:50%;right:auto;left:50%;transform:translate(-50%,-50%);text-align:center;',
    'max-width:min(420px,84%)}',
    '@media (prefers-reduced-motion:reduce){.btn{transition:none}.btn[disabled] .ico{animation:none}}'
  ].join('')

  var SHELL =
    '<style>' + CSS + '</style>' +
    '<div class="stage" part="stage">' +
    '<div class="bar" part="toolbar" hidden>' +
    '<button class="btn" type="button" data-kind="obj" title="下载 OBJ + MTL">' +
    ICON + '<span>OBJ + MTL</span></button>' +
    '<button class="btn" type="button" data-kind="glb" title="下载 GLB">' +
    ICON + '<span>GLB</span></button>' +
    '</div>' +
    '<div class="note" part="note" role="status" hidden></div>' +
    '</div>'

  class ThreeDStage extends HTMLElement {
    static get observedAttributes() { return ['background', 'name', 'autorotate'] }

    constructor() {
      super()
      var root = this.attachShadow({ mode: 'open' })
      root.innerHTML = SHELL
      this._wrap = root.querySelector('.stage')
      this._bar = root.querySelector('.bar')
      this._noteEl = root.querySelector('.note')
      this._noteTimer = 0

      this._THREE = null
      this._renderer = null
      this._scene = null
      this._camera = null
      this._controls = null
      this._lights = null
      this._ground = null
      this._contact = null
      this._object = null
      this._pending = null

      this._w = 0
      this._h = 0
      this._dirty = true
      this._raf = 0
      this._last = 0
      this._touched = false // 用户动过相机——转台从此永久让位
      this._busy = false
      this._ro = null

      var self = this
      this._onResize = function () { self._measure() }
      this._onTick = function (t) { self._tick(t) }

      // ready 由作者 await；这里额外挂一个空 catch，只为不产生未捕获拒绝的噪声——
      // catch 返回的是新 promise，作者侧 `await stage.ready` 该抛还是抛
      this.ready = this._boot()
      this.ready.catch(function () {})

      root.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.btn') : null
        if (btn) self._export(btn.getAttribute('data-kind'), btn)
      })
    }

    connectedCallback() {
      if (!this._ro && typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(this._onResize)
      }
      if (this._ro) this._ro.observe(this)
      window.addEventListener('resize', this._onResize)
      this._measure()
      this._resume()
    }

    disconnectedCallback() {
      if (this._ro) this._ro.unobserve(this)
      window.removeEventListener('resize', this._onResize)
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
    }

    attributeChangedCallback(attr, prev, next) {
      if (prev === next) return
      if (attr === 'background') this._applyBackground()
      else if (attr === 'autorotate' && this._controls) {
        this._controls.autoRotate = next !== null && !this._touched
        this._dirty = true
      }
      // name 只在点下载那一刻读，不需要响应
    }

    /** 作者接口：把一个 THREE.Object3D（通常是具名 Group）交给舞台 */
    setObject(obj) {
      if (!obj || !obj.isObject3D) {
        warn('setObject 需要一个 THREE.Object3D')
        return
      }
      this._pending = obj
      if (this._scene) this._mount(obj)
    }

    // ---- 启动：three 走动态 import，解析失败也只是这一件不出画，元素本身照常注册 ----
    async _boot() {
      var THREE, OrbitControls
      try {
        var mods = await Promise.all([
          import('three'),
          import('three/addons/controls/OrbitControls.js')
        ])
        THREE = mods[0]
        OrbitControls = mods[1].OrbitControls
      } catch (err) {
        this._fatal(MSG.noThree)
        warn('three.js 模块解析失败：' + (err && err.message ? err.message : err))
        throw err
      }

      this._THREE = THREE
      try {
        this._build(THREE, OrbitControls)
      } catch (err) {
        this._fatal(MSG.noGl)
        warn('渲染器初始化失败：' + (err && err.message ? err.message : err))
        throw err
      }

      this._measure()
      this._applyBackground()
      if (this._pending) this._mount(this._pending)
      this._resume()
      return { THREE: THREE }
    }

    _build(THREE, OrbitControls) {
      var renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        // 硬要求，不是可选优化：宿主的自检截图与作者的迭代循环都靠它，否则拍到黑帧
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance'
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR))
      if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace
      // 中性色调映射只压高光、不动色相；ACES 会把作者调好的材质色整体拉偏，产品图不合适
      renderer.toneMapping = THREE.NeutralToneMapping || THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1
      renderer.shadowMap.enabled = true
      // PCF：软硬由每盏灯的 shadow.radius 决定（PCFSoftShadowMap 已被 three 废弃，会回落到这里并刷警告）
      renderer.shadowMap.type = THREE.PCFShadowMap
      this._renderer = renderer

      var canvas = renderer.domElement
      canvas.style.display = 'block'
      canvas.setAttribute('aria-label', '3D 物体预览')
      this._wrap.insertBefore(canvas, this._bar)

      var self = this
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault()
        self._fatal(MSG.lost)
      })

      var scene = new THREE.Scene()
      this._scene = scene

      var camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200)
      camera.position.set(2.4, 1.6, 3.2)
      this._camera = camera

      var controls = new OrbitControls(camera, canvas)
      controls.enableDamping = true
      controls.dampingFactor = DAMPING
      controls.screenSpacePanning = true
      controls.autoRotateSpeed = AUTOROTATE_SPEED
      controls.autoRotate = false
      controls.addEventListener('change', function () { self._dirty = true })
      // 'start' 覆盖拖拽、滚轮与触摸：只要用户碰了方向盘，转台就永久退出，不再抢回来
      controls.addEventListener('start', function () {
        self._touched = true
        controls.autoRotate = false
      })
      this._controls = controls

      // 三点光 + 半球环境。灯位在 _frame 里按包围球定，这里只把节点建好
      var hemi = new THREE.HemisphereLight(0xffffff, 0x8a8578, HEMI_INTENSITY)
      scene.add(hemi)
      var lights = { hemi: hemi, list: [] }
      for (var i = 0; i < RIG.length; i++) {
        var spec = RIG[i]
        var light = new THREE.DirectionalLight(spec.color, spec.intensity)
        light.name = 'tds-' + spec.id
        if (spec.shadow) {
          light.castShadow = true
          light.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP)
          light.shadow.bias = -0.0002
          light.shadow.radius = SHADOW_SOFTNESS
        }
        scene.add(light)
        scene.add(light.target)
        lights.list.push({ spec: spec, light: light })
      }
      this._lights = lights

      // 地面：ShadowMaterial 只在有影子的地方着色，别处完全透明——所以「只看见影子、看不见平面」
      var ground = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.ShadowMaterial({ color: 0x000000, opacity: SHADOW_OPACITY, depthWrite: false })
      )
      ground.name = 'tds-ground'
      ground.rotation.x = -Math.PI / 2
      ground.receiveShadow = true
      ground.renderOrder = 0
      scene.add(ground)
      this._ground = ground

      // 接触暗部：一张径向渐变贴图铺在地面上方，把硬投影缺的那点「贴地感」补回来
      var contact = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: this._contactTexture(THREE),
          transparent: true,
          depthWrite: false,
          opacity: AO_OPACITY,
          toneMapped: false
        })
      )
      contact.name = 'tds-contact'
      contact.rotation.x = -Math.PI / 2
      contact.renderOrder = 1
      scene.add(contact)
      this._contact = contact
    }

    _contactTexture(THREE) {
      var size = 256
      var canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      var ctx = canvas.getContext('2d')
      var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
      g.addColorStop(0, 'rgba(0,0,0,0.62)')
      g.addColorStop(0.38, 'rgba(0,0,0,0.32)')
      g.addColorStop(0.72, 'rgba(0,0,0,0.08)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
      var tex = new THREE.CanvasTexture(canvas)
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace
      return tex
    }

    _applyBackground() {
      var css = cssColor(this.getAttribute('background')) || DEFAULT_BG
      // 工具栏跟着底色翻面：浅底走白色玻璃，深底走深色玻璃，两边都不会糊成一片
      this._wrap.classList.toggle('dark', luminance(css) < 0.42)
      var THREE = this._THREE
      if (!THREE || !this._renderer) return
      var color
      try { color = new THREE.Color(css) } catch (e) { color = new THREE.Color(DEFAULT_BG) }
      // 走 clearColor 而不是 scene.background：清屏色不过色调映射，作者给什么色就是什么色
      this._renderer.setClearColor(color, 1)
      var hemi = this._lights.hemi
      hemi.color.copy(color).lerp(new THREE.Color(0xffffff), 0.55)
      hemi.groundColor.copy(color).lerp(new THREE.Color(0x000000), 0.5)
      // 影子留一点底色的色相：纯黑压在暖米底上会发灰发脏，像贴上去的
      this._ground.material.color.copy(color).lerp(new THREE.Color(0x000000), 0.86)
      this._dirty = true
    }

    // ---- 挂模型 ----
    _mount(obj) {
      if (this._object && this._object !== obj) this._scene.remove(this._object)
      var THREE = this._THREE
      obj.traverse(function (node) {
        if (!node.isMesh && !node.isSkinnedMesh) return
        node.castShadow = true
        node.receiveShadow = true
        // three 默认拿背面写深度图来防痤疮，可 Lathe / Extrude / openEnded 这类单层开放面
        // 从光的方向压根没有可用的背面——影子会**静默消失**（正是本件推荐的建模手法）。
        // 统一改成双面写深度，痤疮交给下面按尺度算的 normalBias 兜。作者显式指定过就不动。
        var mats = Array.isArray(node.material) ? node.material : [node.material]
        for (var i = 0; i < mats.length; i++) {
          if (mats[i] && mats[i].shadowSide == null) mats[i].shadowSide = THREE.DoubleSide
        }
      })
      this._scene.add(obj)
      obj.updateMatrixWorld(true)
      this._object = obj
      this._pending = null
      this._frame()
      this._bar.hidden = false
      if (this.hasAttribute('autorotate') && !this._touched) this._controls.autoRotate = true
      this._dirty = true
      // 提前把导出器暖上：作者按下按钮时不该再等一次网络往返（失败无所谓，点的时候还会再试）
      import('three/addons/exporters/OBJExporter.js').catch(function () {})
      import('three/addons/exporters/GLTFExporter.js').catch(function () {})
    }

    /**
     * 按包围盒取景。不用「包围球恰好入画」那种算法——细高的物体外接球远大于它本身，
     * 算出来的机位会把物体缩成画面中间一小根。这里直接要求 8 个角点全部落进视锥，
     * 对每个角点解出所需最小距离取最大值：瘦长件贴着画幅，方正件也不会挤边。
     */
    _frame() {
      var THREE = this._THREE
      var obj = this._object
      if (!THREE || !obj || !this._camera) return

      var box = new THREE.Box3().setFromObject(obj)
      if (box.isEmpty()) {
        box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))
      }
      var center = box.getCenter(new THREE.Vector3())
      var size = box.getSize(new THREE.Vector3())
      var radius = Math.max(size.length() / 2, 1e-4) // 半对角线：本件所有尺度参数的统一基准

      var corners = []
      for (var c = 0; c < 8; c++) {
        corners.push(new THREE.Vector3(
          c & 1 ? box.max.x : box.min.x,
          c & 2 ? box.max.y : box.min.y,
          c & 4 ? box.max.z : box.min.z
        ))
      }

      // 相机正交基：dir 是视线（由物体指向相机），right/camUp 张成画幅平面
      var camera = this._camera
      var dir = new THREE.Vector3(VIEW_DIR[0], VIEW_DIR[1], VIEW_DIR[2]).normalize()
      var worldUp = new THREE.Vector3(0, 1, 0)
      var right = new THREE.Vector3().crossVectors(worldUp, dir).normalize()
      var camUp = new THREE.Vector3().crossVectors(dir, right).normalize()

      // 收窄有效视场角来留白，比事后乘系数更准（留白与距离是非线性关系）
      var vTan = Math.tan((camera.fov * Math.PI) / 360) / FIT_MARGIN
      var hTan = vTan * Math.max(camera.aspect, 1e-3)
      var dist = radius * 0.5
      var v = new THREE.Vector3()
      for (var i = 0; i < corners.length; i++) {
        v.copy(corners[i]).sub(center)
        var z = v.dot(dir) // 朝相机为正：这个角点比中心近多少
        dist = Math.max(dist, z + Math.abs(v.dot(right)) / hTan, z + Math.abs(v.dot(camUp)) / vTan)
      }

      // 缩放上下限都要把默认机位夹在中间，否则一进来就顶在限位上、滚轮像坏了
      var minDist = Math.min(radius * ZOOM_IN, dist * 0.5)
      var maxDist = Math.max(radius * ZOOM_OUT, dist * 2.5)

      camera.position.copy(center).addScaledVector(dir, dist)
      camera.near = Math.max(minDist * 0.04, 1e-4)
      camera.far = maxDist + radius * 8
      camera.updateProjectionMatrix()

      var controls = this._controls
      controls.target.copy(center)
      controls.minDistance = minDist
      controls.maxDistance = maxDist
      controls.update()

      // 地面贴在物体最低点略下方；两张平面错开一丝，避免与模型底面、彼此 z-fighting
      var floor = box.min.y - radius * 0.002
      var span = Math.max(size.x, size.z, radius * 0.5)
      this._ground.position.set(center.x, floor, center.z)
      this._ground.scale.set(radius * 24, radius * 24, 1)
      this._contact.position.set(center.x, floor + radius * 0.0015, center.z)
      this._contact.scale.set(span * 2.4, span * 2.4, 1)

      var lightDist = radius * LIGHT_SPAN
      for (var j = 0; j < this._lights.list.length; j++) {
        var entry = this._lights.list[j]
        var d = new THREE.Vector3(entry.spec.dir[0], entry.spec.dir[1], entry.spec.dir[2]).normalize()
        entry.light.position.copy(center).addScaledVector(d, lightDist)
        entry.light.target.position.copy(center)
        entry.light.target.updateMatrixWorld()
        if (entry.spec.shadow) this._fitShadow(entry.light, corners, center, floor, radius)
      }

      this._dirty = true
    }

    /**
     * 阴影正交框：把 8 个角点、以及它们沿光线落到地面的落点，一起换算到光空间取包围矩形。
     * 只按物体本身裁的话，斜光下影子的尾巴会被切掉一截——那是最扎眼的一类穿帮。
     */
    _fitShadow(light, corners, center, floorY, radius) {
      var THREE = this._THREE
      var shadow = light.shadow
      var cam = shadow.camera
      var ray = new THREE.Vector3().subVectors(center, light.position).normalize()
      // 与阴影相机自己的 up 保持一致，否则算出来的 left/right/top/bottom 对不上它的实际朝向
      var up = Math.abs(ray.y) > 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
      cam.up.copy(up)

      var view = new THREE.Matrix4().lookAt(light.position, center, up)
      view.setPosition(light.position)
      view.invert()

      var pts = corners.slice()
      if (ray.y < -1e-4) {
        for (var i = 0; i < corners.length; i++) {
          var t = (floorY - corners[i].y) / ray.y
          if (t > 0) pts.push(new THREE.Vector3().copy(corners[i]).addScaledVector(ray, t))
        }
      }

      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      var minZ = Infinity, maxZ = -Infinity
      var p = new THREE.Vector3()
      for (var k = 0; k < pts.length; k++) {
        p.copy(pts[k]).applyMatrix4(view)
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
        if (p.z < minZ) minZ = p.z
        if (p.z > maxZ) maxZ = p.z
      }

      var pad = radius * SHADOW_PAD
      cam.left = minX - pad
      cam.right = maxX + pad
      cam.bottom = minY - pad
      cam.top = maxY + pad
      // 正交相机看向 -z，所以近远面是 z 的相反数
      cam.near = Math.max(-maxZ - pad, radius * 0.005)
      cam.far = -minZ + pad
      cam.updateProjectionMatrix()
      // normalBias 按物体尺度走，否则大模型漏光、小模型阴影脱开
      shadow.normalBias = radius * 0.015
      shadow.radius = SHADOW_SOFTNESS
    }

    // ---- 尺寸：跟挂载盒而不是窗口，盒子变了不一定伴随 window.resize ----
    _measure() {
      if (!this._renderer) return
      var rect = this.getBoundingClientRect()
      var w = Math.max(1, Math.round(rect.width))
      var h = Math.max(1, Math.round(rect.height))
      if (w === this._w && h === this._h) return
      this._w = w
      this._h = h
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR))
      this._renderer.setSize(w, h, true)
      this._camera.aspect = w / h
      this._camera.updateProjectionMatrix()
      // 用户还没碰过相机时，容器变形要重新取景——首帧常常发生在盒子尺寸尚未定下来的时候
      if (this._object && !this._touched) this._frame()
      this._dirty = true
    }

    _resume() {
      if (this._raf || !this._renderer || !this.isConnected) return
      this._last = 0
      this._raf = requestAnimationFrame(this._onTick)
    }

    _tick(now) {
      this._raf = requestAnimationFrame(this._onTick)
      var dt = this._last ? Math.min((now - this._last) / 1000, 0.1) : 0
      this._last = now
      var controls = this._controls
      if (controls && (controls.autoRotate || controls.enableDamping)) controls.update(dt)
      if (!this._dirty) return
      this._dirty = false
      this._renderer.render(this._scene, this._camera)
    }

    // ---- 提示 ----
    _say(text, fatal) {
      if (this._noteTimer) { clearTimeout(this._noteTimer); this._noteTimer = 0 }
      if (!text) { this._noteEl.hidden = true; return }
      this._noteEl.textContent = text
      this._noteEl.classList.toggle('fatal', !!fatal)
      this._noteEl.hidden = false
      if (fatal) return
      var self = this
      this._noteTimer = setTimeout(function () { self._noteEl.hidden = true }, NOTE_MS)
    }

    _fatal(text) { this._say(text, true) }

    // ---- 导出 ----
    async _export(kind, btn) {
      if (this._busy) return
      if (!this._object || !this._THREE) { this._say(MSG.empty); return }
      this._busy = true
      btn.disabled = true
      var base = fileBase(this.getAttribute('name'))
      try {
        if (kind === 'glb') await this._exportGlb(base)
        else await this._exportObj(base)
        this._say('')
      } catch (err) {
        warn('导出失败：' + (err && err.message ? err.message : err))
        this._say(MSG.failed)
      } finally {
        this._busy = false
        btn.disabled = false
      }
    }

    async _exportObj(base) {
      var mod = await import('three/addons/exporters/OBJExporter.js')
      // three 的 OBJExporter 只写几何，usemtl 取自 material.name，且完全不产出 MTL——
      // 所以命名和整份 MTL 都得我们自己来，导完再把作者的原名还回去
      var naming = this._prepareNames(this._object)
      var objText, mtlText
      try {
        objText = 'mtllib ' + base + '.mtl\n' + new mod.OBJExporter().parse(this._object)
        mtlText = this._buildMtl(naming.materials, base)
      } finally {
        naming.undo()
      }
      download(this._wrap, new Blob([objText], { type: 'text/plain' }), base + '.obj')
      var wrap = this._wrap
      // 两个文件是两次下载；挨得太近浏览器会当成连发而吞掉后一个
      await new Promise(function (resolve) {
        setTimeout(function () {
          download(wrap, new Blob([mtlText], { type: 'text/plain' }), base + '.mtl')
          resolve()
        }, SECOND_FILE_DELAY)
      })
    }

    async _exportGlb(base) {
      var mod = await import('three/addons/exporters/GLTFExporter.js')
      var exporter = new mod.GLTFExporter()
      var opts = { binary: true, onlyVisible: true }
      var buffer
      if (typeof exporter.parseAsync === 'function') {
        buffer = await exporter.parseAsync(this._object, opts)
      } else {
        var target = this._object
        buffer = await new Promise(function (resolve, reject) {
          exporter.parse(target, resolve, reject, opts)
        })
      }
      download(this._wrap, new Blob([buffer], { type: 'model/gltf-binary' }), base + '.glb')
    }

    /**
     * 导出前的命名整备：给每个 mesh 与每个 material 一个 OBJ 安全且唯一的名字（作者没给名字就补一个），
     * 返回收集到的材质表与一个还原函数——舞台不该在作者的场景里留下副作用。
     */
    _prepareNames(root) {
      var undo = []
      var meshNames = Object.create(null)
      var matNames = Object.create(null)
      var materials = []
      var seen = new Map()
      var partIndex = 0
      var matIndex = 0

      function rename(target, value) {
        var had = Object.prototype.hasOwnProperty.call(target, 'name') || target.name !== undefined
        undo.push({ target: target, had: had, prev: target.name })
        target.name = value
      }

      function register(mat) {
        if (!mat) return undefined
        if (seen.has(mat)) return seen.get(mat)
        var name = unique(objName(mat.name, 'material_' + ++matIndex), matNames)
        seen.set(mat, name)
        if (mat.name !== name) rename(mat, name)
        materials.push({ name: name, material: mat })
        return name
      }

      root.traverse(function (node) {
        if (!node.isMesh && !node.isLine && !node.isPoints) return
        var name = unique(objName(node.name, 'part_' + ++partIndex), meshNames)
        if (node.name !== name) rename(node, name)
        var mat = node.material
        if (!mat) return
        if (Array.isArray(mat)) {
          for (var i = 0; i < mat.length; i++) register(mat[i])
          // 多材质 mesh：导出器只读 material.name，给数组挂一个同名属性，至少让 usemtl 落到首材质
          if (mat.length) rename(mat, seen.get(mat[0]))
        } else {
          register(mat)
        }
      })

      return {
        materials: materials,
        undo: function () {
          for (var i = undo.length - 1; i >= 0; i--) {
            var e = undo[i]
            if (e.had) e.target.name = e.prev
            else { try { delete e.target.name } catch (err) { e.target.name = e.prev } }
          }
        }
      }
    }

    /**
     * MeshStandardMaterial -> Wavefront MTL：Kd 取基色，Ks 按 F0 在 0.04 与基色之间随 metalness 插值，
     * Ns 由 roughness 反推。没有贴图条目——这条管线本来就不带纹理。
     */
    _buildMtl(materials, base) {
      var THREE = this._THREE
      var out = ['# ' + base + '.mtl', '# generated by three-d-stage', '']
      function srgb(color) {
        var t = { r: 0, g: 0, b: 0 }
        if (!color) return t
        t.r = color.r; t.g = color.g; t.b = color.b
        if (typeof color.getRGB === 'function' && THREE.SRGBColorSpace) {
          try { color.getRGB(t, THREE.SRGBColorSpace) } catch (e) {}
        }
        return t
      }
      function fmt(v) { return clamp(num(v, 0), 0, 1).toFixed(4) }

      for (var i = 0; i < materials.length; i++) {
        var mat = materials[i].material
        var kd = srgb(mat.color)
        var rough = clamp(num(mat.roughness, 0.7), 0, 1)
        var metal = clamp(num(mat.metalness, 0), 0, 1)
        var f0 = 0.04
        var ks = {
          r: f0 + (kd.r - f0) * metal,
          g: f0 + (kd.g - f0) * metal,
          b: f0 + (kd.b - f0) * metal
        }
        var ns = clamp(Math.round(Math.pow(1 - rough, 2) * 900) + 2, 2, 900)
        var opacity = clamp(num(mat.opacity, 1), 0, 1)
        out.push('newmtl ' + materials[i].name)
        out.push('Ka ' + fmt(kd.r * 0.12) + ' ' + fmt(kd.g * 0.12) + ' ' + fmt(kd.b * 0.12))
        out.push('Kd ' + fmt(kd.r) + ' ' + fmt(kd.g) + ' ' + fmt(kd.b))
        out.push('Ks ' + fmt(ks.r) + ' ' + fmt(ks.g) + ' ' + fmt(ks.b))
        if (mat.emissive) {
          var ke = srgb(mat.emissive)
          var gain = num(mat.emissiveIntensity, 1)
          if (ke.r + ke.g + ke.b > 0) {
            out.push('Ke ' + fmt(ke.r * gain) + ' ' + fmt(ke.g * gain) + ' ' + fmt(ke.b * gain))
          }
        }
        out.push('Ns ' + ns)
        out.push('d ' + fmt(mat.transparent ? opacity : 1))
        out.push('illum 2')
        out.push('')
      }
      return out.join('\n')
    }
  }

  window.customElements.define('three-d-stage', ThreeDStage)
})()
