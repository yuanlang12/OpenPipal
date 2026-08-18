/**
 * ios-frame —— OpenPipal 自研的 iOS 手机外框预制件（单文件 JSX、零 import，React 由宿主注入全局后从作用域直接取）。
 * exports（末尾挂 window，x-import 按名取）：IOSDevice / IOSStatusBar / IOSNavBar / IOSGlassPill / IOSList / IOSListRow / IOSKeyboard。
 * 用法：<x-import component-from-global-scope="IOSDevice" from="./ios-frame.jsx" title="Settings" hint-size="402px,874px">…屏幕内容…</x-import>
 */

// ---- 几何常量：观感调参只改这一处，组件内部不再散落数字 ----
// 逻辑分辨率 402×874 是 props 默认值（技能里 hint-size 按它写，改了要同步改技能）。
var IOS_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, "PingFang SC", "Hiragino Sans GB", sans-serif'
var IOS_RADIUS = 56 // 无可见边框厚度：整块就是屏，所以圆角要压到接近机身圆角的量级
var IOS_STATUS_H = 54 // 顶部安全区高度：状态栏与灵动岛共用这一条
var IOS_ISLAND_W = 122
var IOS_ISLAND_H = 37
var IOS_ISLAND_TOP = 11
var IOS_ROW_H = 48
var IOS_ROW_PAD = 16
var IOS_ICON_BOX = 30
var IOS_ICON_GAP = 12
var IOS_KEY_H = 42

/** 明暗两套色板。组件一律引用角色名，不写十六进制字面量。 */
function iosTone(dark) {
  return dark
    ? {
        screen: '#000000',
        card: '#1c1c1e',
        text: '#f5f5f7',
        dim: 'rgba(235,235,245,0.62)',
        faint: 'rgba(235,235,245,0.32)',
        sep: 'rgba(235,235,245,0.18)',
        accent: '#0a84ff',
        edge: 'rgba(255,255,255,0.14)',
        indicator: 'rgba(255,255,255,0.86)',
        cardDrop: '0 1px 2px rgba(0,0,0,0.45)',
        glassBg: 'rgba(46,46,52,0.72)',
        glassTop: 'rgba(255,255,255,0.22)',
        glassBottom: 'rgba(0,0,0,0.32)',
        glassRing: 'rgba(255,255,255,0.16)',
        glassDrop: '0 1px 2px rgba(0,0,0,0.5), 0 8px 22px rgba(0,0,0,0.45)',
        keyBg: 'rgba(108,108,118,0.62)',
        keyAlt: 'rgba(58,58,64,0.78)',
        keyDrop: '0 1px 0.5px rgba(0,0,0,0.55)'
      }
    : {
        screen: '#f2f2f7',
        card: '#ffffff',
        text: '#101014',
        dim: 'rgba(60,60,67,0.60)',
        faint: 'rgba(60,60,67,0.34)',
        sep: 'rgba(60,60,67,0.22)',
        accent: '#007aff',
        edge: 'rgba(16,18,22,0.16)',
        indicator: 'rgba(16,18,22,0.82)',
        cardDrop: '0 1px 2px rgba(16,18,22,0.05)',
        glassBg: 'rgba(252,252,254,0.72)',
        glassTop: 'rgba(255,255,255,0.9)',
        glassBottom: 'rgba(16,18,22,0.08)',
        glassRing: 'rgba(255,255,255,0.62)',
        glassDrop: '0 1px 2px rgba(16,18,22,0.10), 0 8px 22px rgba(16,18,22,0.12)',
        keyBg: 'rgba(255,255,255,0.94)',
        keyAlt: 'rgba(174,179,190,0.58)',
        keyDrop: '0 1px 0.5px rgba(16,18,22,0.28)'
      }
}

/**
 * 玻璃配方（胶囊与键盘共用同一套，别抄成两份）：
 * base 是半透明底 + backdrop-filter，ring 是左上高光 / 右下暗边 / 0.5px 描边的 inset 层。
 * 导出路径（headless 截图 / PDF）可能不合成 backdrop-filter——底色本身已经是能看清的浅/深色，
 * 模糊只是叠上去的增强，掉了不影响可读性。
 */
function iosGlass(t, radius) {
  var blur = 'blur(20px) saturate(180%)'
  return {
    base: {
      position: 'relative',
      borderRadius: radius,
      background: t.glassBg,
      backdropFilter: blur,
      WebkitBackdropFilter: blur,
      boxShadow: t.glassDrop
    },
    ring: {
      position: 'absolute',
      inset: 0,
      borderRadius: 'inherit',
      pointerEvents: 'none',
      boxShadow:
        'inset 0 1px 0.5px ' +
        t.glassTop +
        ', inset 0 -1px 0.5px ' +
        t.glassBottom +
        ', inset 0 0 0 0.5px ' +
        t.glassRing
    }
  }
}

// ---- 内联 SVG 图形（零外部资源：不取网络字体、不引图标包，全部自绘并吃 currentColor）----

/** 信号：四根由矮到高的圆角竖条 */
function IosSignalGlyph() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
      <rect x="0" y="8.2" width="3.2" height="3.8" rx="1.1" />
      <rect x="4.9" y="5.9" width="3.2" height="6.1" rx="1.1" />
      <rect x="9.8" y="3.2" width="3.2" height="8.8" rx="1.1" />
      <rect x="14.7" y="0" width="3.2" height="12" rx="1.1" />
    </svg>
  )
}

/** Wi-Fi：两道同心弧 + 底部圆点（弧心在 (8,11)，端点取 ±45°） */
function IosWifiGlyph() {
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 16 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M1.35 4.35A9.4 9.4 0 0 1 14.65 4.35" />
      <path d="M3.83 6.83A5.9 5.9 0 0 1 12.17 6.83" />
      <circle cx="8" cy="10.4" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 电池：圆角外框 + 内部填充块 + 右侧小凸点 */
function IosBatteryGlyph() {
  return (
    <svg width="27" height="13" viewBox="0 0 27 13" fill="none" aria-hidden="true">
      <rect
        x="0.6"
        y="0.6"
        width="21.8"
        height="11.8"
        rx="3.6"
        stroke="currentColor"
        strokeOpacity="0.38"
        strokeWidth="1.2"
      />
      <rect x="2.3" y="2.3" width="13.2" height="8.4" rx="2.1" fill="currentColor" />
      <path d="M24.3 4.5c1.1.6 1.7 1.5 1.7 2.5s-.6 1.9-1.7 2.5z" fill="currentColor" fillOpacity="0.38" />
    </svg>
  )
}

/** 右向小尖角（列表行尾） */
function IosChevronGlyph(props) {
  return (
    <svg
      width="8"
      height="13"
      viewBox="0 0 8 13"
      fill="none"
      stroke={props.color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ marginLeft: 8, flex: 'none' }}
      aria-hidden="true"
    >
      <path d="M1.3 1.3 6.5 6.5l-5.2 5.2" />
    </svg>
  )
}

/** 左向尖角（导航返回） */
function IosBackGlyph(props) {
  return (
    <svg
      width="9"
      height="15"
      viewBox="0 0 9 15"
      fill="none"
      stroke={props.color}
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.4 1.4 1.6 7.5l5.8 6.1" />
    </svg>
  )
}

function IosShiftGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 3.1 3.2 10.3h3.4v5.2c0 .6.5 1.1 1.1 1.1h4.6c.6 0 1.1-.5 1.1-1.1v-5.2h3.4z" />
    </svg>
  )
}

function IosBackspaceGlyph() {
  return (
    <svg
      width="21"
      height="16"
      viewBox="0 0 22 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.5 1.9h11c1 0 1.7.8 1.7 1.7v8.8c0 1-.7 1.7-1.7 1.7h-11c-.5 0-.9-.2-1.2-.6L1.7 8.6a.9.9 0 0 1 0-1.2l4.6-4.9c.3-.4.7-.6 1.2-.6z" />
      <path d="M10.8 6.1 15 10.3M15 6.1l-4.2 4.2" />
    </svg>
  )
}

function IosReturnGlyph() {
  return (
    <svg
      width="19"
      height="16"
      viewBox="0 0 20 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.2 2.4v6.1c0 1.4-1.1 2.5-2.5 2.5H4.3" />
      <path d="M7.6 7.7 4 11l3.6 3.3" />
    </svg>
  )
}

// ---- 系统件 ----

/**
 * 顶部系统状态栏。左右两组用等分 flex 推开，中间留出灵动岛的宽度。
 * time 默认 '9:41'（公开的行业惯例值，技能与 E2E 都按它断言）。
 */
function IOSStatusBar(props) {
  var t = iosTone(props.dark)
  var time = props.time === undefined ? '9:41' : props.time
  return (
    <div
      style={{
        boxSizing: 'border-box',
        height: IOS_STATUS_H,
        display: 'flex',
        alignItems: 'center',
        padding: '5px 26px 0',
        color: t.text,
        fontFamily: IOS_FONT,
        flex: 'none'
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.1, whiteSpace: 'nowrap' }}>{time}</span>
      </div>
      <div style={{ flex: 'none', width: IOS_ISLAND_W + 10 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
        <IosSignalGlyph />
        <IosWifiGlyph />
        <IosBatteryGlyph />
      </div>
    </div>
  )
}

/** 毛玻璃胶囊：导航控件的底座，也是键盘玻璃层的同一套配方。 */
function IOSGlassPill(props) {
  var t = iosTone(props.dark)
  var g = iosGlass(t, 999)
  return (
    <div
      style={Object.assign(
        {},
        g.base,
        {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          color: t.text
        },
        props.style || {}
      )}
    >
      <span style={g.ring} />
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0
        }}
      >
        {props.children}
      </span>
    </div>
  )
}

/** 大标题导航区：上行两枚玻璃胶囊（顶部让出状态栏高度），下行大标题。 */
function IOSNavBar(props) {
  var t = iosTone(props.dark)
  var title = props.title === undefined ? 'Title' : props.title
  var pill = { width: 38, height: 38 }
  return (
    <div style={{ flex: 'none', paddingTop: IOS_STATUS_H }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '2px 14px 0'
        }}
      >
        <IOSGlassPill dark={props.dark} style={pill}>
          <IosBackGlyph color={t.accent} />
        </IOSGlassPill>
        {props.trailingIcon === false ? (
          <span style={{ width: pill.width, height: pill.height }} />
        ) : (
          <IOSGlassPill dark={props.dark} style={pill}>
            <svg width="18" height="5" viewBox="0 0 18 5" fill={t.accent} aria-hidden="true">
              <circle cx="2.3" cy="2.5" r="1.8" />
              <circle cx="9" cy="2.5" r="1.8" />
              <circle cx="15.7" cy="2.5" r="1.8" />
            </svg>
          </IOSGlassPill>
        )}
      </div>
      <div
        style={{
          padding: '8px 20px 10px',
          fontSize: 32,
          lineHeight: 1.15,
          fontWeight: 700,
          letterSpacing: -0.6,
          color: t.text
        }}
      >
        {title}
      </div>
    </div>
  )
}

/** 列表行：可选色块 → 标题 → 可选次要文本 → 可选尖角；非末行底部一道 0.5px 分隔线。 */
function IOSListRow(props) {
  var t = iosTone(props.dark)
  var hasIcon = !!props.icon
  var hasDetail = props.detail !== undefined && props.detail !== null && props.detail !== ''
  return (
    <div
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        minHeight: IOS_ROW_H,
        padding: '0 ' + IOS_ROW_PAD + 'px',
        color: t.text,
        fontSize: 16.5,
        letterSpacing: -0.2
      }}
    >
      {hasIcon ? (
        <span
          style={{
            flex: 'none',
            width: IOS_ICON_BOX,
            height: IOS_ICON_BOX,
            marginRight: IOS_ICON_GAP,
            borderRadius: 8,
            background: props.icon
          }}
        />
      ) : null}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {props.title}
      </span>
      {hasDetail ? (
        <span style={{ flex: 'none', marginLeft: 10, fontSize: 16, color: t.dim }}>{props.detail}</span>
      ) : null}
      {props.chevron === false ? null : <IosChevronGlyph color={t.faint} />}
      {/* 经典细节：有左侧色块时分隔线从内容起点起画，没有时从行内边距起画 */}
      {props.isLast ? null : (
        <span
          style={{
            position: 'absolute',
            left: hasIcon ? IOS_ROW_PAD + IOS_ICON_BOX + IOS_ICON_GAP : IOS_ROW_PAD,
            right: 0,
            bottom: 0,
            height: 0.5,
            background: t.sep
          }}
        />
      )}
    </div>
  )
}

/**
 * 分组列表卡片。dark 与 isLast 只在子行**没自己写**时下发——作者显式给的值永远优先，
 * 且只认 IOSListRow 类型的子元素（往任意子节点上塞 dark/isLast 会变成非法 DOM 属性）。
 */
function IOSList(props) {
  var t = iosTone(props.dark)
  var kids = React.Children.toArray(props.children)
  var last = kids.length - 1
  var rows = kids.map(function (child, i) {
    if (!React.isValidElement(child) || child.type !== IOSListRow) return child
    var patch = {}
    if (child.props.dark === undefined) patch.dark = props.dark
    if (child.props.isLast === undefined) patch.isLast = i === last
    return React.cloneElement(child, patch)
  })
  var hasHeader = props.header !== undefined && props.header !== null && props.header !== ''
  return (
    <div style={{ marginTop: 18 }}>
      {hasHeader ? (
        <div
          style={{
            padding: '0 18px 7px',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.7,
            textTransform: 'uppercase',
            color: t.dim
          }}
        >
          {props.header}
        </div>
      ) : null}
      <div
        style={{
          margin: '0 16px',
          background: t.card,
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: t.cardDrop
        }}
      >
        {rows}
      </div>
    </div>
  )
}

// ---- 键盘（静态外观件，不接交互）----

function IosKeyCap(props) {
  var t = props.t
  return (
    <span
      style={{
        flex: props.flex === undefined ? 1 : props.flex,
        minWidth: 0,
        height: IOS_KEY_H,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        background: props.bg || t.keyBg,
        color: props.fg || t.text,
        boxShadow: t.keyDrop,
        fontSize: props.fontSize === undefined ? 21 : props.fontSize,
        lineHeight: 1
      }}
    >
      {props.children}
    </span>
  )
}

function IosKeyRow(props) {
  return (
    <div style={Object.assign({ display: 'flex', gap: 6, marginBottom: 9 }, props.style || {})}>{props.children}</div>
  )
}

function iosLetters(t, letters) {
  return letters.split('').map(function (c) {
    return (
      <IosKeyCap key={c} t={t}>
        {c}
      </IosKeyCap>
    )
  })
}

/** 屏幕键盘：整块走玻璃配方、圆角在上方；候选词条 + 四行键 + 底部空白带。 */
function IOSKeyboard(props) {
  var t = iosTone(props.dark)
  var g = iosGlass(t, '18px 18px 0 0')
  return (
    <div
      style={Object.assign({}, g.base, {
        flex: 'none',
        boxSizing: 'border-box',
        // 键盘从下往上浮：投影方向与胶囊相反
        boxShadow: props.dark ? '0 -1px 14px rgba(0,0,0,0.5)' : '0 -1px 14px rgba(16,18,22,0.12)',
        color: t.text,
        fontFamily: IOS_FONT
      })}
    >
      <span style={g.ring} />
      <div style={{ position: 'relative', padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', height: 44 }}>
          {['The', 'design', 'studio'].map(function (word, i) {
            return (
              <span
                key={word}
                style={{
                  position: 'relative',
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                  color: t.text
                }}
              >
                {i === 0 ? null : (
                  <span
                    style={{ position: 'absolute', left: 0, top: '50%', marginTop: -9, width: 0.5, height: 18, background: t.sep }}
                  />
                )}
                {word}
              </span>
            )
          })}
        </div>
        <IosKeyRow>{iosLetters(t, 'qwertyuiop')}</IosKeyRow>
        {/* 第二行左右各内缩半个键位，让它比上一行短 */}
        <IosKeyRow style={{ padding: '0 21px' }}>{iosLetters(t, 'asdfghjkl')}</IosKeyRow>
        <IosKeyRow>
          <IosKeyCap t={t} flex={1.5} bg={t.keyAlt}>
            <IosShiftGlyph />
          </IosKeyCap>
          {iosLetters(t, 'zxcvbnm')}
          <IosKeyCap t={t} flex={1.5} bg={t.keyAlt}>
            <IosBackspaceGlyph />
          </IosKeyCap>
        </IosKeyRow>
        <IosKeyRow style={{ marginBottom: 0 }}>
          <IosKeyCap t={t} flex={1.7} bg={t.keyAlt} fontSize={15}>
            123
          </IosKeyCap>
          <IosKeyCap t={t} flex={5.6} fontSize={15}>
            space
          </IosKeyCap>
          <IosKeyCap t={t} flex={2.7} bg={t.accent} fg="#ffffff">
            <IosReturnGlyph />
          </IosKeyCap>
        </IosKeyRow>
        {/* 表情/麦克风带：留白即可，图标省掉 */}
        <div style={{ height: 30 }} />
      </div>
    </div>
  )
}

// ---- 外框主体 ----

/**
 * 一台正面朝上的现代直板手机：大圆角、内容裁在圆角内、落地阴影 + 一道极细描边，
 * 没有可见边框厚度（屏幕就是整块）。自上而下叠：灵动岛 / 状态栏 / 导航区 / 内容区 / 键盘 / Home Indicator。
 * title 用 title !== undefined 判定——不传就不出导航区，传空串照出（空标题导航区是合法用法）。
 */
function IOSDevice(props) {
  var dark = !!props.dark
  var t = iosTone(dark)
  var width = props.width === undefined ? 402 : props.width
  var height = props.height === undefined ? 874 : props.height
  var hasNav = props.title !== undefined
  return (
    <div
      data-openpipal-frame="ios"
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        width: width,
        height: height,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: IOS_RADIUS,
        overflow: 'hidden',
        isolation: 'isolate',
        background: t.screen,
        color: t.text,
        fontFamily: IOS_FONT,
        fontSize: 16,
        lineHeight: 1.4,
        // 描边走 inset 阴影而不是 border：不占布局，width/height 就是屏幕本身的尺寸
        boxShadow:
          '0 2px 6px rgba(16,18,22,0.14), 0 26px 60px rgba(16,18,22,0.26), inset 0 0 0 1px ' + t.edge
      }}
    >
      {/* 灵动岛：纯装饰，浮在所有内容之上且不吃事件 */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: IOS_ISLAND_TOP,
          left: '50%',
          transform: 'translateX(-50%)',
          width: IOS_ISLAND_W,
          height: IOS_ISLAND_H,
          borderRadius: 999,
          background: '#000000',
          pointerEvents: 'none',
          zIndex: 30
        }}
      />
      {/* 状态栏压在页面内容之上、灵动岛之下 */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20 }}>
        <IOSStatusBar dark={dark} />
      </div>
      {hasNav ? <IOSNavBar dark={dark} title={props.title} /> : null}
      {/* 内容区：作者写屏幕内容的地方。没有导航区时自己让出状态栏高度，内容滚动时从状态栏下穿过 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          WebkitOverflowScrolling: 'touch',
          paddingTop: hasNav ? 0 : IOS_STATUS_H,
          paddingBottom: props.keyboard ? 0 : 28
        }}
      >
        {props.children}
      </div>
      {props.keyboard ? <IOSKeyboard dark={dark} /> : null}
      {/* Home Indicator 始终在最上层，但 pointer-events:none——它盖住内容区底部却不能吃掉点击 */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 8,
          transform: 'translateX(-50%)',
          width: 140,
          height: 5,
          borderRadius: 999,
          background: t.indicator,
          pointerEvents: 'none',
          zIndex: 40
        }}
      />
    </div>
  )
}

Object.assign(window, { IOSDevice, IOSStatusBar, IOSNavBar, IOSGlassPill, IOSList, IOSListRow, IOSKeyboard });
