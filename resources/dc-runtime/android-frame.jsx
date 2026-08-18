/**
 * android-frame —— OpenPipal 自研的 Android(Material 3) 设备外框预制件：把一段屏幕内容装进一台带机身边框的安卓手机里（纯 JSX 单文件，零 import，React 从全局取）。
 * exports（末尾挂到 window，供 x-import 的 component-from-global-scope 按名取用）：AndroidDevice / AndroidStatusBar / AndroidAppBar / AndroidListItem / AndroidNavBar / AndroidKeyboard。
 * 用法：<x-import component-from-global-scope="AndroidDevice" from="./android-frame.jsx" title="收件箱" hint-size="412px,892px"> …屏幕内容… </x-import>
 *
 * 配色来源：Material 3 公开规范（m3.material.io，Apache-2.0）的**色彩角色**体系——组件内部只引用角色名，
 * 色值由本文件自带的一套 tonal palette 生成（见 PALETTE 上方注释），不取自任何既有实现。
 */

// ---------------------------------------------------------------------------
// 色彩：M3 角色 → 色值
// ---------------------------------------------------------------------------
// 色板由单一源色相（CIE Lab 195°，一支深青 teal）按 M3 的 tone 刻度自行生成：
// tone 即 CIE L*，chroma 在明暗两端收敛，落到 sRGB 色域外时降 chroma 内收。
// 四支 palette 与 M3 同构：P=primary(峰值 chroma 42)、S=secondary(15)、N=neutral(3)、NV=neutral-variant(8)。
// 角色 → tone 的映射照 M3 规范的明/暗两套 scheme。
var PALETTE = {
  light: {
    surface: '#f7fafa',              // N-98
    surfaceVariant: '#d8e5e4',       // NV-90
    inverseOnSurface: '#eef1f1',     // N-95
    secondaryContainer: '#cee8e6',   // S-90
    onSurface: '#191c1c',            // N-10
    onSurfaceVariant: '#384a49',     // NV-30
    onSecondaryContainer: '#0a1f1e', // S-10
    onPrimaryContainer: '#002020',   // P-10
    primary: '#006a69',              // P-40
    onPrimary: '#ffffff',            // P-100
    primaryFixedDim: '#6ad7d5',      // P-80
    outline: '#667b7a',              // NV-50 —— 机身边框描边
    outlineVariant: '#b8cac9',       // NV-80 —— 发丝级分隔线
    scrim: '#000000',                // N-0 —— 挖孔摄像头
    shadow: 'rgba(0, 20, 20, 0.34)'  // 落地阴影（N-0 带 alpha）
  },
  dark: {
    surface: '#111414',              // N-6
    surfaceVariant: '#384a49',       // NV-30
    inverseOnSurface: '#2c3131',     // N-20
    secondaryContainer: '#294d4c',   // S-30
    onSurface: '#dee3e3',            // N-90
    onSurfaceVariant: '#b8cac9',     // NV-80
    onSecondaryContainer: '#cee8e6', // S-90
    // P-10：与 light 同值不是笔误。这个角色在本文件里只画在 primaryFixedDim 之上，
    // 而 M3 的 fixed 系列在明暗两套 scheme 里同值（P-80），其内容色也必须跟着恒定。
    onPrimaryContainer: '#002020',
    primary: '#6ad7d5',              // P-80
    onPrimary: '#003736',            // P-20
    primaryFixedDim: '#6ad7d5',      // P-80（fixed，不随 scheme 变）
    outline: '#809594',              // NV-60
    outlineVariant: '#384a49',       // NV-30
    scrim: '#000000',
    shadow: 'rgba(0, 0, 0, 0.62)'
  }
}

// 角色以 CSS 自定义属性下发：AndroidDevice 在根节点写一套，子件不必逐层收 dark prop
// （规格里 AppBar / ListItem / Keyboard 本来就没有 dark 形参）。
// 单独拿出去用的子件走 var() 的 light 兜底值，不写死十六进制。
function schemeVars(dark) {
  var scheme = dark ? PALETTE.dark : PALETTE.light
  var vars = {}
  for (var name in scheme) vars['--m3-' + name] = scheme[name]
  return vars
}

function role(name) {
  return 'var(--m3-' + name + ', ' + PALETTE.light[name] + ')'
}

// ---------------------------------------------------------------------------
// 几何常量（dp 当 px 用，逻辑分辨率下两者等价）
// ---------------------------------------------------------------------------
var BEZEL = 10          // 机身边框厚度——安卓外框与 iOS 外框观感上的分野就在这一圈
var CORNER = 48         // 机身外圆角；屏幕内圆角由 border-radius 自动减去 BEZEL
var STATUS_H = 36
var APPBAR_H = 64
var NAV_H = 26
var TOUCH = 48          // M3 最小触控目标
var KEY_H = 44
var KEY_GAP = 6

var FONT =
  '"Roboto", "Roboto Flex", "Noto Sans", "Helvetica Neue", system-ui, -apple-system, ' +
  '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'

// ---------------------------------------------------------------------------
// 状态栏图标：一律内联 SVG 自绘（C3 零外部资源；不写 xmlns，React 建的就是 SVG 命名空间）
// ---------------------------------------------------------------------------
function SignalIcon() {
  // 移动信号：实心直角三角，斜边朝左上
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M14.4 1.4v12.1a.6.6 0 0 1-.6.6H1.7a.6.6 0 0 1-.42-1.02L13.38.98a.6.6 0 0 1 1.02.42z" />
    </svg>
  )
}

function WifiIcon() {
  // Wi-Fi：实心扇形，底部收成一点
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 14.2.63 5.86a.55.55 0 0 1 .04-.77A10.8 10.8 0 0 1 8 2.2c2.77 0 5.3 1.04 7.33 2.89a.55.55 0 0 1 .04.77z" />
    </svg>
  )
}

function BatteryIcon() {
  // 电池：竖置圆角长条 + 顶部小凸点，内部留一格未充满的空隙
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="6.4" y="1.1" width="3.2" height="1.7" rx="0.7" />
      <path d="M4.6 4.4c0-.72.58-1.3 1.3-1.3h4.2c.72 0 1.3.58 1.3 1.3v9.2c0 .72-.58 1.3-1.3 1.3H5.9c-.72 0-1.3-.58-1.3-1.3z" />
      <rect x="5.9" y="4.4" width="4.2" height="2.6" rx="0.6" fill={role('surface')} />
    </svg>
  )
}

function ShiftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3.6 21 12.6h-4.6v6.1c0 .6-.5 1.1-1.1 1.1H8.7c-.6 0-1.1-.5-1.1-1.1v-6.1H3z" />
    </svg>
  )
}

function BackspaceIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M9 5h11.2c1 0 1.8.8 1.8 1.8v10.4c0 1-.8 1.8-1.8 1.8H9L2 12z" strokeLinejoin="round" />
      <path d="M12.6 9.4 17.6 14.6M17.6 9.4 12.6 14.6" strokeLinecap="round" />
    </svg>
  )
}

function EnterIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M20 5.5v6.2c0 1.7-1.4 3.1-3.1 3.1H5.4" strokeLinecap="round" />
      <path d="M9.4 10.9 5.3 14.8l4.1 3.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// AndroidStatusBar —— 定高一行：左时间 / 中挖孔 / 右状态图标
// ---------------------------------------------------------------------------
function AndroidStatusBar(props) {
  var dark = !!(props && props.dark)
  var time = props && props.time !== undefined ? props.time : '9:30'
  var barStyle = Object.assign(schemeVars(dark), {
    position: 'relative',
    flex: 'none',
    height: STATUS_H,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 18px 0 20px',
    background: role('surface'),
    color: role('onSurface'),
    fontFamily: FONT,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.2px',
    lineHeight: 1
  })
  return (
    <div style={barStyle}>
      <span>{time}</span>
      {/* 挖孔摄像头：绝对定位，不参与左右两组的 flex 布局 */}
      <span
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 11,
          height: 11,
          marginLeft: -5.5,
          marginTop: -5.5,
          borderRadius: '50%',
          background: role('scrim'),
          pointerEvents: 'none'
        }}
      />
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <SignalIcon />
        <WifiIcon />
        <BatteryIcon />
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AndroidAppBar —— M3 顶部应用栏，small / large 两态
// ---------------------------------------------------------------------------
function IconSlot() {
  // 图标位：48×48 触控区里一枚半透明圆点占位（不画真图标，避免与具体图标库沾边）
  return (
    <span
      style={{
        width: TOUCH,
        height: TOUCH,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <span
        style={{ width: 22, height: 22, borderRadius: '50%', background: role('onSurfaceVariant'), opacity: 0.28 }}
      />
    </span>
  )
}

function AndroidAppBar(props) {
  var title = props && props.title !== undefined ? props.title : 'Title'
  var large = !!(props && props.large)
  var shell = {
    flex: 'none',
    background: role('surface'),
    color: role('onSurface'),
    fontFamily: FONT
  }
  var row = {
    height: APPBAR_H,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 4px'
  }
  if (large) {
    // large：首行让出标题，只剩左右图标位；标题下沉成独立一行，headline-large 量级
    return (
      <div style={shell}>
        <div style={row}>
          <IconSlot />
          <IconSlot />
        </div>
        <div style={{ padding: '4px 20px 26px', fontSize: 30, lineHeight: '38px', fontWeight: 400 }}>{title}</div>
      </div>
    )
  }
  // small：左图标位 · 标题 · 右图标位，标题 title-large 量级、常规字重
  return (
    <div style={shell}>
      <div style={row}>
        <IconSlot />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            marginLeft: 4,
            fontSize: 22,
            fontWeight: 400,
            lineHeight: '28px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {title}
        </span>
        <IconSlot />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AndroidListItem —— M3 列表项：可选圆形头像位 + 一到两行文字
// ---------------------------------------------------------------------------
function AndroidListItem(props) {
  var p = props || {}
  var supporting = p.supporting
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: supporting === undefined || supporting === null ? '14px 16px' : '10px 16px',
        minHeight: supporting === undefined || supporting === null ? 56 : 72,
        boxSizing: 'border-box',
        background: role('surface'),
        color: role('onSurface'),
        fontFamily: FONT
      }}
    >
      {p.leading ? (
        <span
          style={{
            width: 40,
            height: 40,
            flex: 'none',
            borderRadius: '50%',
            background: role('primary'),
            color: role('onPrimary'),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            fontWeight: 500,
            lineHeight: 1
          }}
        >
          {p.leading}
        </span>
      ) : null}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 16, lineHeight: '24px', letterSpacing: '0.15px' }}>
          {p.headline}
        </span>
        {supporting === undefined || supporting === null ? null : (
          <span
            style={{
              display: 'block',
              marginTop: 2,
              fontSize: 14,
              lineHeight: '20px',
              letterSpacing: '0.25px',
              color: role('onSurfaceVariant')
            }}
          >
            {supporting}
          </span>
        )}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AndroidNavBar —— 手势导航把手
// ---------------------------------------------------------------------------
function AndroidNavBar(props) {
  var dark = !!(props && props.dark)
  var barStyle = Object.assign(schemeVars(dark), {
    flex: 'none',
    height: NAV_H,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: role('surface')
  })
  return (
    <div style={barStyle}>
      <span style={{ width: 112, height: 4, borderRadius: 2, background: role('onSurface'), opacity: 0.42 }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// AndroidKeyboard —— Gboard 观感的静态外观件（不可交互）
// ---------------------------------------------------------------------------
var ROW_1 = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']
var ROW_2 = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l']
var ROW_3 = ['z', 'x', 'c', 'v', 'b', 'n', 'm']

function keyStyle(extra) {
  return Object.assign(
    {
      height: KEY_H,
      borderRadius: 7,
      background: role('surface'),
      color: role('onSurface'),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 16,
      lineHeight: 1,
      flex: '1 1 0',
      minWidth: 0
    },
    extra || {}
  )
}

function Key(props) {
  return <span style={keyStyle(props.style)}>{props.children}</span>
}

function KeyRow(props) {
  return (
    <div
      style={{
        display: 'flex',
        gap: KEY_GAP,
        marginTop: KEY_GAP,
        paddingLeft: props.inset || 0,
        paddingRight: props.inset || 0
      }}
    >
      {props.children}
    </div>
  )
}

function AndroidKeyboard() {
  return (
    <div
      style={{
        flex: 'none',
        padding: '0 5px 10px',
        background: role('inverseOnSurface'),
        color: role('onSurface'),
        fontFamily: FONT,
        userSelect: 'none'
      }}
    >
      {/* 顶部工具栏空白带（建议条/剪贴板等，图标省略） */}
      <div style={{ height: 40 }} />
      <KeyRow>
        {ROW_1.map(function (k) {
          return <Key key={k}>{k}</Key>
        })}
      </KeyRow>
      <KeyRow inset={20}>
        {ROW_2.map(function (k) {
          return <Key key={k}>{k}</Key>
        })}
      </KeyRow>
      <KeyRow>
        <Key style={{ flex: '1.5 1 0', background: role('surfaceVariant'), color: role('onSurfaceVariant') }}>
          <ShiftIcon />
        </Key>
        {ROW_3.map(function (k) {
          return <Key key={k}>{k}</Key>
        })}
        <Key style={{ flex: '1.5 1 0', background: role('surfaceVariant'), color: role('onSurfaceVariant') }}>
          <BackspaceIcon />
        </Key>
      </KeyRow>
      <KeyRow>
        <Key
          style={{
            flex: '1.7 1 0',
            borderRadius: KEY_H / 2,
            background: role('secondaryContainer'),
            color: role('onSecondaryContainer'),
            fontSize: 14,
            letterSpacing: '0.3px'
          }}
        >
          ?123
        </Key>
        <Key style={{ flex: '0.9 1 0' }}>,</Key>
        <Key style={{ flex: '5 1 0' }} />
        <Key style={{ flex: '0.9 1 0' }}>.</Key>
        <Key
          style={{
            flex: '1.7 1 0',
            borderRadius: KEY_H / 2,
            background: role('primaryFixedDim'),
            color: role('onPrimaryContainer')
          }}
        >
          <EnterIcon />
        </Key>
      </KeyRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AndroidDevice —— 外框主体：纵向 flex 组装状态栏 / 应用栏 / 内容区 / 键盘 / 导航条
// ---------------------------------------------------------------------------
function AndroidDevice(props) {
  var p = props || {}
  var width = p.width === undefined ? 412 : p.width
  var height = p.height === undefined ? 892 : p.height
  var dark = !!p.dark
  // 不传 title 就不出应用栏；传空串要出（空标题的应用栏是合法用法）
  var hasAppBar = p.title !== undefined

  var frameStyle = Object.assign(schemeVars(dark), {
    // C4：外框真渲染了的探针在根元素上（见下方 data-openpipal-frame）
    position: 'relative',
    boxSizing: 'border-box', // width/height 含机身边框
    width: width,
    height: height,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    border: BEZEL + 'px solid ' + role('outline'),
    borderRadius: CORNER,
    background: role('surface'),
    color: role('onSurface'),
    fontFamily: FONT,
    // C5：阴影只是增强，拿掉后机身边框与底色本身仍撑得住可读性
    boxShadow: '0 2px 4px ' + role('shadow') + ', 0 26px 52px -18px ' + role('shadow')
  })

  return (
    <div data-openpipal-frame="android" style={frameStyle}>
      <AndroidStatusBar dark={dark} />
      {hasAppBar ? <AndroidAppBar title={p.title} large={!!p.large} /> : null}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', background: role('surface') }}>
        {p.children}
      </div>
      {p.keyboard ? <AndroidKeyboard /> : null}
      <AndroidNavBar dark={dark} />
    </div>
  )
}

// C2：末尾把全部组件挂上 window —— x-import 的 component-from-global-scope 按这些名字取
Object.assign(window, {
  AndroidDevice: AndroidDevice,
  AndroidStatusBar: AndroidStatusBar,
  AndroidAppBar: AndroidAppBar,
  AndroidListItem: AndroidListItem,
  AndroidNavBar: AndroidNavBar,
  AndroidKeyboard: AndroidKeyboard
})
