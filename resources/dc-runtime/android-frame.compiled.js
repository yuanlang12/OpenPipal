/**
 * android-frame —— esbuild 预编译版，由 scripts/build-dc-runtime-compiled.mjs 从 android-frame.jsx 生成。
 *
 * 不要手改本文件：改 android-frame.jsx 后重跑 `node scripts/build-dc-runtime-compiled.mjs`。
 */
;(function () {
  function boot() {
    var PALETTE = {
      light: {
        surface: "#f7fafa",
        // N-98
        surfaceVariant: "#d8e5e4",
        // NV-90
        inverseOnSurface: "#eef1f1",
        // N-95
        secondaryContainer: "#cee8e6",
        // S-90
        onSurface: "#191c1c",
        // N-10
        onSurfaceVariant: "#384a49",
        // NV-30
        onSecondaryContainer: "#0a1f1e",
        // S-10
        onPrimaryContainer: "#002020",
        // P-10
        primary: "#006a69",
        // P-40
        onPrimary: "#ffffff",
        // P-100
        primaryFixedDim: "#6ad7d5",
        // P-80
        outline: "#667b7a",
        // NV-50 —— 机身边框描边
        outlineVariant: "#b8cac9",
        // NV-80 —— 发丝级分隔线
        scrim: "#000000",
        // N-0 —— 挖孔摄像头
        shadow: "rgba(0, 20, 20, 0.34)"
        // 落地阴影（N-0 带 alpha）
      },
      dark: {
        surface: "#111414",
        // N-6
        surfaceVariant: "#384a49",
        // NV-30
        inverseOnSurface: "#2c3131",
        // N-20
        secondaryContainer: "#294d4c",
        // S-30
        onSurface: "#dee3e3",
        // N-90
        onSurfaceVariant: "#b8cac9",
        // NV-80
        onSecondaryContainer: "#cee8e6",
        // S-90
        // P-10：与 light 同值不是笔误。这个角色在本文件里只画在 primaryFixedDim 之上，
        // 而 M3 的 fixed 系列在明暗两套 scheme 里同值（P-80），其内容色也必须跟着恒定。
        onPrimaryContainer: "#002020",
        primary: "#6ad7d5",
        // P-80
        onPrimary: "#003736",
        // P-20
        primaryFixedDim: "#6ad7d5",
        // P-80（fixed，不随 scheme 变）
        outline: "#809594",
        // NV-60
        outlineVariant: "#384a49",
        // NV-30
        scrim: "#000000",
        shadow: "rgba(0, 0, 0, 0.62)"
      }
    };
    function schemeVars(dark) {
      var scheme = dark ? PALETTE.dark : PALETTE.light;
      var vars = {};
      for (var name in scheme) vars["--m3-" + name] = scheme[name];
      return vars;
    }
    function role(name) {
      return "var(--m3-" + name + ", " + PALETTE.light[name] + ")";
    }
    var BEZEL = 10;
    var CORNER = 48;
    var STATUS_H = 36;
    var APPBAR_H = 64;
    var NAV_H = 26;
    var TOUCH = 48;
    var KEY_H = 44;
    var KEY_GAP = 6;
    var FONT = '"Roboto", "Roboto Flex", "Noto Sans", "Helvetica Neue", system-ui, -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
    function SignalIcon() {
      return /* @__PURE__ */ React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M14.4 1.4v12.1a.6.6 0 0 1-.6.6H1.7a.6.6 0 0 1-.42-1.02L13.38.98a.6.6 0 0 1 1.02.42z" }));
    }
    function WifiIcon() {
      return /* @__PURE__ */ React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M8 14.2.63 5.86a.55.55 0 0 1 .04-.77A10.8 10.8 0 0 1 8 2.2c2.77 0 5.3 1.04 7.33 2.89a.55.55 0 0 1 .04.77z" }));
    }
    function BatteryIcon() {
      return /* @__PURE__ */ React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("rect", { x: "6.4", y: "1.1", width: "3.2", height: "1.7", rx: "0.7" }), /* @__PURE__ */ React.createElement("path", { d: "M4.6 4.4c0-.72.58-1.3 1.3-1.3h4.2c.72 0 1.3.58 1.3 1.3v9.2c0 .72-.58 1.3-1.3 1.3H5.9c-.72 0-1.3-.58-1.3-1.3z" }), /* @__PURE__ */ React.createElement("rect", { x: "5.9", y: "4.4", width: "4.2", height: "2.6", rx: "0.6", fill: role("surface") }));
    }
    function ShiftIcon() {
      return /* @__PURE__ */ React.createElement("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M12 3.6 21 12.6h-4.6v6.1c0 .6-.5 1.1-1.1 1.1H8.7c-.6 0-1.1-.5-1.1-1.1v-6.1H3z" }));
    }
    function BackspaceIcon() {
      return /* @__PURE__ */ React.createElement("svg", { width: "21", height: "21", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M9 5h11.2c1 0 1.8.8 1.8 1.8v10.4c0 1-.8 1.8-1.8 1.8H9L2 12z", strokeLinejoin: "round" }), /* @__PURE__ */ React.createElement("path", { d: "M12.6 9.4 17.6 14.6M17.6 9.4 12.6 14.6", strokeLinecap: "round" }));
    }
    function EnterIcon() {
      return /* @__PURE__ */ React.createElement("svg", { width: "21", height: "21", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.9", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M20 5.5v6.2c0 1.7-1.4 3.1-3.1 3.1H5.4", strokeLinecap: "round" }), /* @__PURE__ */ React.createElement("path", { d: "M9.4 10.9 5.3 14.8l4.1 3.9", strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function AndroidStatusBar(props) {
      var dark = !!(props && props.dark);
      var time = props && props.time !== void 0 ? props.time : "9:30";
      var barStyle = Object.assign(schemeVars(dark), {
        position: "relative",
        flex: "none",
        height: STATUS_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 18px 0 20px",
        background: role("surface"),
        color: role("onSurface"),
        fontFamily: FONT,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.2px",
        lineHeight: 1
      });
      return /* @__PURE__ */ React.createElement("div", { style: barStyle }, /* @__PURE__ */ React.createElement("span", null, time), /* @__PURE__ */ React.createElement(
        "span",
        {
          style: {
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 11,
            height: 11,
            marginLeft: -5.5,
            marginTop: -5.5,
            borderRadius: "50%",
            background: role("scrim"),
            pointerEvents: "none"
          }
        }
      ), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 5 } }, /* @__PURE__ */ React.createElement(SignalIcon, null), /* @__PURE__ */ React.createElement(WifiIcon, null), /* @__PURE__ */ React.createElement(BatteryIcon, null)));
    }
    function IconSlot() {
      return /* @__PURE__ */ React.createElement(
        "span",
        {
          style: {
            width: TOUCH,
            height: TOUCH,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }
        },
        /* @__PURE__ */ React.createElement(
          "span",
          {
            style: { width: 22, height: 22, borderRadius: "50%", background: role("onSurfaceVariant"), opacity: 0.28 }
          }
        )
      );
    }
    function AndroidAppBar(props) {
      var title = props && props.title !== void 0 ? props.title : "Title";
      var large = !!(props && props.large);
      var shell = {
        flex: "none",
        background: role("surface"),
        color: role("onSurface"),
        fontFamily: FONT
      };
      var row = {
        height: APPBAR_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 4px"
      };
      if (large) {
        return /* @__PURE__ */ React.createElement("div", { style: shell }, /* @__PURE__ */ React.createElement("div", { style: row }, /* @__PURE__ */ React.createElement(IconSlot, null), /* @__PURE__ */ React.createElement(IconSlot, null)), /* @__PURE__ */ React.createElement("div", { style: { padding: "4px 20px 26px", fontSize: 30, lineHeight: "38px", fontWeight: 400 } }, title));
      }
      return /* @__PURE__ */ React.createElement("div", { style: shell }, /* @__PURE__ */ React.createElement("div", { style: row }, /* @__PURE__ */ React.createElement(IconSlot, null), /* @__PURE__ */ React.createElement(
        "span",
        {
          style: {
            flex: 1,
            minWidth: 0,
            marginLeft: 4,
            fontSize: 22,
            fontWeight: 400,
            lineHeight: "28px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }
        },
        title
      ), /* @__PURE__ */ React.createElement(IconSlot, null)));
    }
    function AndroidListItem(props) {
      var p = props || {};
      var supporting = p.supporting;
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: supporting === void 0 || supporting === null ? "14px 16px" : "10px 16px",
            minHeight: supporting === void 0 || supporting === null ? 56 : 72,
            boxSizing: "border-box",
            background: role("surface"),
            color: role("onSurface"),
            fontFamily: FONT
          }
        },
        p.leading ? /* @__PURE__ */ React.createElement(
          "span",
          {
            style: {
              width: 40,
              height: 40,
              flex: "none",
              borderRadius: "50%",
              background: role("primary"),
              color: role("onPrimary"),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              fontWeight: 500,
              lineHeight: 1
            }
          },
          p.leading
        ) : null,
        /* @__PURE__ */ React.createElement("span", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("span", { style: { display: "block", fontSize: 16, lineHeight: "24px", letterSpacing: "0.15px" } }, p.headline), supporting === void 0 || supporting === null ? null : /* @__PURE__ */ React.createElement(
          "span",
          {
            style: {
              display: "block",
              marginTop: 2,
              fontSize: 14,
              lineHeight: "20px",
              letterSpacing: "0.25px",
              color: role("onSurfaceVariant")
            }
          },
          supporting
        ))
      );
    }
    function AndroidNavBar(props) {
      var dark = !!(props && props.dark);
      var barStyle = Object.assign(schemeVars(dark), {
        flex: "none",
        height: NAV_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: role("surface")
      });
      return /* @__PURE__ */ React.createElement("div", { style: barStyle }, /* @__PURE__ */ React.createElement("span", { style: { width: 112, height: 4, borderRadius: 2, background: role("onSurface"), opacity: 0.42 } }));
    }
    var ROW_1 = ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"];
    var ROW_2 = ["a", "s", "d", "f", "g", "h", "j", "k", "l"];
    var ROW_3 = ["z", "x", "c", "v", "b", "n", "m"];
    function keyStyle(extra) {
      return Object.assign(
        {
          height: KEY_H,
          borderRadius: 7,
          background: role("surface"),
          color: role("onSurface"),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 16,
          lineHeight: 1,
          flex: "1 1 0",
          minWidth: 0
        },
        extra || {}
      );
    }
    function Key(props) {
      return /* @__PURE__ */ React.createElement("span", { style: keyStyle(props.style) }, props.children);
    }
    function KeyRow(props) {
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            display: "flex",
            gap: KEY_GAP,
            marginTop: KEY_GAP,
            paddingLeft: props.inset || 0,
            paddingRight: props.inset || 0
          }
        },
        props.children
      );
    }
    function AndroidKeyboard() {
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            flex: "none",
            padding: "0 5px 10px",
            background: role("inverseOnSurface"),
            color: role("onSurface"),
            fontFamily: FONT,
            userSelect: "none"
          }
        },
        /* @__PURE__ */ React.createElement("div", { style: { height: 40 } }),
        /* @__PURE__ */ React.createElement(KeyRow, null, ROW_1.map(function(k) {
          return /* @__PURE__ */ React.createElement(Key, { key: k }, k);
        })),
        /* @__PURE__ */ React.createElement(KeyRow, { inset: 20 }, ROW_2.map(function(k) {
          return /* @__PURE__ */ React.createElement(Key, { key: k }, k);
        })),
        /* @__PURE__ */ React.createElement(KeyRow, null, /* @__PURE__ */ React.createElement(Key, { style: { flex: "1.5 1 0", background: role("surfaceVariant"), color: role("onSurfaceVariant") } }, /* @__PURE__ */ React.createElement(ShiftIcon, null)), ROW_3.map(function(k) {
          return /* @__PURE__ */ React.createElement(Key, { key: k }, k);
        }), /* @__PURE__ */ React.createElement(Key, { style: { flex: "1.5 1 0", background: role("surfaceVariant"), color: role("onSurfaceVariant") } }, /* @__PURE__ */ React.createElement(BackspaceIcon, null))),
        /* @__PURE__ */ React.createElement(KeyRow, null, /* @__PURE__ */ React.createElement(
          Key,
          {
            style: {
              flex: "1.7 1 0",
              borderRadius: KEY_H / 2,
              background: role("secondaryContainer"),
              color: role("onSecondaryContainer"),
              fontSize: 14,
              letterSpacing: "0.3px"
            }
          },
          "?123"
        ), /* @__PURE__ */ React.createElement(Key, { style: { flex: "0.9 1 0" } }, ","), /* @__PURE__ */ React.createElement(Key, { style: { flex: "5 1 0" } }), /* @__PURE__ */ React.createElement(Key, { style: { flex: "0.9 1 0" } }, "."), /* @__PURE__ */ React.createElement(
          Key,
          {
            style: {
              flex: "1.7 1 0",
              borderRadius: KEY_H / 2,
              background: role("primaryFixedDim"),
              color: role("onPrimaryContainer")
            }
          },
          /* @__PURE__ */ React.createElement(EnterIcon, null)
        ))
      );
    }
    function AndroidDevice(props) {
      var p = props || {};
      var width = p.width === void 0 ? 412 : p.width;
      var height = p.height === void 0 ? 892 : p.height;
      var dark = !!p.dark;
      var hasAppBar = p.title !== void 0;
      var frameStyle = Object.assign(schemeVars(dark), {
        // C4：外框真渲染了的探针在根元素上（见下方 data-openpipal-frame）
        position: "relative",
        boxSizing: "border-box",
        // width/height 含机身边框
        width,
        height,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        border: BEZEL + "px solid " + role("outline"),
        borderRadius: CORNER,
        background: role("surface"),
        color: role("onSurface"),
        fontFamily: FONT,
        // C5：阴影只是增强，拿掉后机身边框与底色本身仍撑得住可读性
        boxShadow: "0 2px 4px " + role("shadow") + ", 0 26px 52px -18px " + role("shadow")
      });
      return /* @__PURE__ */ React.createElement("div", { "data-openpipal-frame": "android", style: frameStyle }, /* @__PURE__ */ React.createElement(AndroidStatusBar, { dark }), hasAppBar ? /* @__PURE__ */ React.createElement(AndroidAppBar, { title: p.title, large: !!p.large }) : null, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto", position: "relative", background: role("surface") } }, p.children), p.keyboard ? /* @__PURE__ */ React.createElement(AndroidKeyboard, null) : null, /* @__PURE__ */ React.createElement(AndroidNavBar, { dark }));
    }
    Object.assign(window, {
      AndroidDevice,
      AndroidStatusBar,
      AndroidAppBar,
      AndroidListItem,
      AndroidNavBar,
      AndroidKeyboard
    });
  }

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
        console.error('[OpenPipal] android-frame 预制件等不到 React/ReactDOM，设备外框未挂载。')
      }
    }, 30)
  }
})()
