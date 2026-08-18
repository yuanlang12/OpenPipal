/**
 * ios-frame —— esbuild 预编译版，由 scripts/build-dc-runtime-compiled.mjs 从 ios-frame.jsx 生成。
 *
 * 不要手改本文件：改 ios-frame.jsx 后重跑 `node scripts/build-dc-runtime-compiled.mjs`。
 */
;(function () {
  function boot() {
    var IOS_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, "PingFang SC", "Hiragino Sans GB", sans-serif';
    var IOS_RADIUS = 56;
    var IOS_STATUS_H = 54;
    var IOS_ISLAND_W = 122;
    var IOS_ISLAND_H = 37;
    var IOS_ISLAND_TOP = 11;
    var IOS_ROW_H = 48;
    var IOS_ROW_PAD = 16;
    var IOS_ICON_BOX = 30;
    var IOS_ICON_GAP = 12;
    var IOS_KEY_H = 42;
    function iosTone(dark) {
      return dark ? {
        screen: "#000000",
        card: "#1c1c1e",
        text: "#f5f5f7",
        dim: "rgba(235,235,245,0.62)",
        faint: "rgba(235,235,245,0.32)",
        sep: "rgba(235,235,245,0.18)",
        accent: "#0a84ff",
        edge: "rgba(255,255,255,0.14)",
        indicator: "rgba(255,255,255,0.86)",
        cardDrop: "0 1px 2px rgba(0,0,0,0.45)",
        glassBg: "rgba(46,46,52,0.72)",
        glassTop: "rgba(255,255,255,0.22)",
        glassBottom: "rgba(0,0,0,0.32)",
        glassRing: "rgba(255,255,255,0.16)",
        glassDrop: "0 1px 2px rgba(0,0,0,0.5), 0 8px 22px rgba(0,0,0,0.45)",
        keyBg: "rgba(108,108,118,0.62)",
        keyAlt: "rgba(58,58,64,0.78)",
        keyDrop: "0 1px 0.5px rgba(0,0,0,0.55)"
      } : {
        screen: "#f2f2f7",
        card: "#ffffff",
        text: "#101014",
        dim: "rgba(60,60,67,0.60)",
        faint: "rgba(60,60,67,0.34)",
        sep: "rgba(60,60,67,0.22)",
        accent: "#007aff",
        edge: "rgba(16,18,22,0.16)",
        indicator: "rgba(16,18,22,0.82)",
        cardDrop: "0 1px 2px rgba(16,18,22,0.05)",
        glassBg: "rgba(252,252,254,0.72)",
        glassTop: "rgba(255,255,255,0.9)",
        glassBottom: "rgba(16,18,22,0.08)",
        glassRing: "rgba(255,255,255,0.62)",
        glassDrop: "0 1px 2px rgba(16,18,22,0.10), 0 8px 22px rgba(16,18,22,0.12)",
        keyBg: "rgba(255,255,255,0.94)",
        keyAlt: "rgba(174,179,190,0.58)",
        keyDrop: "0 1px 0.5px rgba(16,18,22,0.28)"
      };
    }
    function iosGlass(t, radius) {
      var blur = "blur(20px) saturate(180%)";
      return {
        base: {
          position: "relative",
          borderRadius: radius,
          background: t.glassBg,
          backdropFilter: blur,
          WebkitBackdropFilter: blur,
          boxShadow: t.glassDrop
        },
        ring: {
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          pointerEvents: "none",
          boxShadow: "inset 0 1px 0.5px " + t.glassTop + ", inset 0 -1px 0.5px " + t.glassBottom + ", inset 0 0 0 0.5px " + t.glassRing
        }
      };
    }
    function IosSignalGlyph() {
      return /* @__PURE__ */ React.createElement("svg", { width: "18", height: "12", viewBox: "0 0 18 12", fill: "currentColor", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("rect", { x: "0", y: "8.2", width: "3.2", height: "3.8", rx: "1.1" }), /* @__PURE__ */ React.createElement("rect", { x: "4.9", y: "5.9", width: "3.2", height: "6.1", rx: "1.1" }), /* @__PURE__ */ React.createElement("rect", { x: "9.8", y: "3.2", width: "3.2", height: "8.8", rx: "1.1" }), /* @__PURE__ */ React.createElement("rect", { x: "14.7", y: "0", width: "3.2", height: "12", rx: "1.1" }));
    }
    function IosWifiGlyph() {
      return /* @__PURE__ */ React.createElement(
        "svg",
        {
          width: "16",
          height: "12",
          viewBox: "0 0 16 12",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.6",
          strokeLinecap: "round",
          "aria-hidden": "true"
        },
        /* @__PURE__ */ React.createElement("path", { d: "M1.35 4.35A9.4 9.4 0 0 1 14.65 4.35" }),
        /* @__PURE__ */ React.createElement("path", { d: "M3.83 6.83A5.9 5.9 0 0 1 12.17 6.83" }),
        /* @__PURE__ */ React.createElement("circle", { cx: "8", cy: "10.4", r: "1.25", fill: "currentColor", stroke: "none" })
      );
    }
    function IosBatteryGlyph() {
      return /* @__PURE__ */ React.createElement("svg", { width: "27", height: "13", viewBox: "0 0 27 13", fill: "none", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement(
        "rect",
        {
          x: "0.6",
          y: "0.6",
          width: "21.8",
          height: "11.8",
          rx: "3.6",
          stroke: "currentColor",
          strokeOpacity: "0.38",
          strokeWidth: "1.2"
        }
      ), /* @__PURE__ */ React.createElement("rect", { x: "2.3", y: "2.3", width: "13.2", height: "8.4", rx: "2.1", fill: "currentColor" }), /* @__PURE__ */ React.createElement("path", { d: "M24.3 4.5c1.1.6 1.7 1.5 1.7 2.5s-.6 1.9-1.7 2.5z", fill: "currentColor", fillOpacity: "0.38" }));
    }
    function IosChevronGlyph(props) {
      return /* @__PURE__ */ React.createElement(
        "svg",
        {
          width: "8",
          height: "13",
          viewBox: "0 0 8 13",
          fill: "none",
          stroke: props.color,
          strokeWidth: "2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          style: { marginLeft: 8, flex: "none" },
          "aria-hidden": "true"
        },
        /* @__PURE__ */ React.createElement("path", { d: "M1.3 1.3 6.5 6.5l-5.2 5.2" })
      );
    }
    function IosBackGlyph(props) {
      return /* @__PURE__ */ React.createElement(
        "svg",
        {
          width: "9",
          height: "15",
          viewBox: "0 0 9 15",
          fill: "none",
          stroke: props.color,
          strokeWidth: "2.1",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true"
        },
        /* @__PURE__ */ React.createElement("path", { d: "M7.4 1.4 1.6 7.5l5.8 6.1" })
      );
    }
    function IosShiftGlyph() {
      return /* @__PURE__ */ React.createElement("svg", { width: "19", height: "19", viewBox: "0 0 20 20", fill: "currentColor", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M10 3.1 3.2 10.3h3.4v5.2c0 .6.5 1.1 1.1 1.1h4.6c.6 0 1.1-.5 1.1-1.1v-5.2h3.4z" }));
    }
    function IosBackspaceGlyph() {
      return /* @__PURE__ */ React.createElement(
        "svg",
        {
          width: "21",
          height: "16",
          viewBox: "0 0 22 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.5",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true"
        },
        /* @__PURE__ */ React.createElement("path", { d: "M7.5 1.9h11c1 0 1.7.8 1.7 1.7v8.8c0 1-.7 1.7-1.7 1.7h-11c-.5 0-.9-.2-1.2-.6L1.7 8.6a.9.9 0 0 1 0-1.2l4.6-4.9c.3-.4.7-.6 1.2-.6z" }),
        /* @__PURE__ */ React.createElement("path", { d: "M10.8 6.1 15 10.3M15 6.1l-4.2 4.2" })
      );
    }
    function IosReturnGlyph() {
      return /* @__PURE__ */ React.createElement(
        "svg",
        {
          width: "19",
          height: "16",
          viewBox: "0 0 20 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.7",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true"
        },
        /* @__PURE__ */ React.createElement("path", { d: "M17.2 2.4v6.1c0 1.4-1.1 2.5-2.5 2.5H4.3" }),
        /* @__PURE__ */ React.createElement("path", { d: "M7.6 7.7 4 11l3.6 3.3" })
      );
    }
    function IOSStatusBar(props) {
      var t = iosTone(props.dark);
      var time = props.time === void 0 ? "9:41" : props.time;
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            boxSizing: "border-box",
            height: IOS_STATUS_H,
            display: "flex",
            alignItems: "center",
            padding: "5px 26px 0",
            color: t.text,
            fontFamily: IOS_FONT,
            flex: "none"
          }
        },
        /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 15, fontWeight: 600, letterSpacing: 0.1, whiteSpace: "nowrap" } }, time)),
        /* @__PURE__ */ React.createElement("div", { style: { flex: "none", width: IOS_ISLAND_W + 10 } }),
        /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 } }, /* @__PURE__ */ React.createElement(IosSignalGlyph, null), /* @__PURE__ */ React.createElement(IosWifiGlyph, null), /* @__PURE__ */ React.createElement(IosBatteryGlyph, null))
      );
    }
    function IOSGlassPill(props) {
      var t = iosTone(props.dark);
      var g = iosGlass(t, 999);
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: Object.assign(
            {},
            g.base,
            {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              color: t.text
            },
            props.style || {}
          )
        },
        /* @__PURE__ */ React.createElement("span", { style: g.ring }),
        /* @__PURE__ */ React.createElement(
          "span",
          {
            style: {
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 0
            }
          },
          props.children
        )
      );
    }
    function IOSNavBar(props) {
      var t = iosTone(props.dark);
      var title = props.title === void 0 ? "Title" : props.title;
      var pill = { width: 38, height: 38 };
      return /* @__PURE__ */ React.createElement("div", { style: { flex: "none", paddingTop: IOS_STATUS_H } }, /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "2px 14px 0"
          }
        },
        /* @__PURE__ */ React.createElement(IOSGlassPill, { dark: props.dark, style: pill }, /* @__PURE__ */ React.createElement(IosBackGlyph, { color: t.accent })),
        props.trailingIcon === false ? /* @__PURE__ */ React.createElement("span", { style: { width: pill.width, height: pill.height } }) : /* @__PURE__ */ React.createElement(IOSGlassPill, { dark: props.dark, style: pill }, /* @__PURE__ */ React.createElement("svg", { width: "18", height: "5", viewBox: "0 0 18 5", fill: t.accent, "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("circle", { cx: "2.3", cy: "2.5", r: "1.8" }), /* @__PURE__ */ React.createElement("circle", { cx: "9", cy: "2.5", r: "1.8" }), /* @__PURE__ */ React.createElement("circle", { cx: "15.7", cy: "2.5", r: "1.8" })))
      ), /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            padding: "8px 20px 10px",
            fontSize: 32,
            lineHeight: 1.15,
            fontWeight: 700,
            letterSpacing: -0.6,
            color: t.text
          }
        },
        title
      ));
    }
    function IOSListRow(props) {
      var t = iosTone(props.dark);
      var hasIcon = !!props.icon;
      var hasDetail = props.detail !== void 0 && props.detail !== null && props.detail !== "";
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            position: "relative",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            minHeight: IOS_ROW_H,
            padding: "0 " + IOS_ROW_PAD + "px",
            color: t.text,
            fontSize: 16.5,
            letterSpacing: -0.2
          }
        },
        hasIcon ? /* @__PURE__ */ React.createElement(
          "span",
          {
            style: {
              flex: "none",
              width: IOS_ICON_BOX,
              height: IOS_ICON_BOX,
              marginRight: IOS_ICON_GAP,
              borderRadius: 8,
              background: props.icon
            }
          }
        ) : null,
        /* @__PURE__ */ React.createElement("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.title),
        hasDetail ? /* @__PURE__ */ React.createElement("span", { style: { flex: "none", marginLeft: 10, fontSize: 16, color: t.dim } }, props.detail) : null,
        props.chevron === false ? null : /* @__PURE__ */ React.createElement(IosChevronGlyph, { color: t.faint }),
        props.isLast ? null : /* @__PURE__ */ React.createElement(
          "span",
          {
            style: {
              position: "absolute",
              left: hasIcon ? IOS_ROW_PAD + IOS_ICON_BOX + IOS_ICON_GAP : IOS_ROW_PAD,
              right: 0,
              bottom: 0,
              height: 0.5,
              background: t.sep
            }
          }
        )
      );
    }
    function IOSList(props) {
      var t = iosTone(props.dark);
      var kids = React.Children.toArray(props.children);
      var last = kids.length - 1;
      var rows = kids.map(function(child, i) {
        if (!React.isValidElement(child) || child.type !== IOSListRow) return child;
        var patch = {};
        if (child.props.dark === void 0) patch.dark = props.dark;
        if (child.props.isLast === void 0) patch.isLast = i === last;
        return React.cloneElement(child, patch);
      });
      var hasHeader = props.header !== void 0 && props.header !== null && props.header !== "";
      return /* @__PURE__ */ React.createElement("div", { style: { marginTop: 18 } }, hasHeader ? /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            padding: "0 18px 7px",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.7,
            textTransform: "uppercase",
            color: t.dim
          }
        },
        props.header
      ) : null, /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            margin: "0 16px",
            background: t.card,
            borderRadius: 18,
            overflow: "hidden",
            boxShadow: t.cardDrop
          }
        },
        rows
      ));
    }
    function IosKeyCap(props) {
      var t = props.t;
      return /* @__PURE__ */ React.createElement(
        "span",
        {
          style: {
            flex: props.flex === void 0 ? 1 : props.flex,
            minWidth: 0,
            height: IOS_KEY_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            background: props.bg || t.keyBg,
            color: props.fg || t.text,
            boxShadow: t.keyDrop,
            fontSize: props.fontSize === void 0 ? 21 : props.fontSize,
            lineHeight: 1
          }
        },
        props.children
      );
    }
    function IosKeyRow(props) {
      return /* @__PURE__ */ React.createElement("div", { style: Object.assign({ display: "flex", gap: 6, marginBottom: 9 }, props.style || {}) }, props.children);
    }
    function iosLetters(t, letters) {
      return letters.split("").map(function(c) {
        return /* @__PURE__ */ React.createElement(IosKeyCap, { key: c, t }, c);
      });
    }
    function IOSKeyboard(props) {
      var t = iosTone(props.dark);
      var g = iosGlass(t, "18px 18px 0 0");
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          style: Object.assign({}, g.base, {
            flex: "none",
            boxSizing: "border-box",
            // 键盘从下往上浮：投影方向与胶囊相反
            boxShadow: props.dark ? "0 -1px 14px rgba(0,0,0,0.5)" : "0 -1px 14px rgba(16,18,22,0.12)",
            color: t.text,
            fontFamily: IOS_FONT
          })
        },
        /* @__PURE__ */ React.createElement("span", { style: g.ring }),
        /* @__PURE__ */ React.createElement("div", { style: { position: "relative", padding: "0 4px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", height: 44 } }, ["The", "design", "studio"].map(function(word, i) {
          return /* @__PURE__ */ React.createElement(
            "span",
            {
              key: word,
              style: {
                position: "relative",
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                color: t.text
              }
            },
            i === 0 ? null : /* @__PURE__ */ React.createElement(
              "span",
              {
                style: { position: "absolute", left: 0, top: "50%", marginTop: -9, width: 0.5, height: 18, background: t.sep }
              }
            ),
            word
          );
        })), /* @__PURE__ */ React.createElement(IosKeyRow, null, iosLetters(t, "qwertyuiop")), /* @__PURE__ */ React.createElement(IosKeyRow, { style: { padding: "0 21px" } }, iosLetters(t, "asdfghjkl")), /* @__PURE__ */ React.createElement(IosKeyRow, null, /* @__PURE__ */ React.createElement(IosKeyCap, { t, flex: 1.5, bg: t.keyAlt }, /* @__PURE__ */ React.createElement(IosShiftGlyph, null)), iosLetters(t, "zxcvbnm"), /* @__PURE__ */ React.createElement(IosKeyCap, { t, flex: 1.5, bg: t.keyAlt }, /* @__PURE__ */ React.createElement(IosBackspaceGlyph, null))), /* @__PURE__ */ React.createElement(IosKeyRow, { style: { marginBottom: 0 } }, /* @__PURE__ */ React.createElement(IosKeyCap, { t, flex: 1.7, bg: t.keyAlt, fontSize: 15 }, "123"), /* @__PURE__ */ React.createElement(IosKeyCap, { t, flex: 5.6, fontSize: 15 }, "space"), /* @__PURE__ */ React.createElement(IosKeyCap, { t, flex: 2.7, bg: t.accent, fg: "#ffffff" }, /* @__PURE__ */ React.createElement(IosReturnGlyph, null))), /* @__PURE__ */ React.createElement("div", { style: { height: 30 } }))
      );
    }
    function IOSDevice(props) {
      var dark = !!props.dark;
      var t = iosTone(dark);
      var width = props.width === void 0 ? 402 : props.width;
      var height = props.height === void 0 ? 874 : props.height;
      var hasNav = props.title !== void 0;
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          "data-openpipal-frame": "ios",
          style: {
            position: "relative",
            boxSizing: "border-box",
            width,
            height,
            display: "flex",
            flexDirection: "column",
            borderRadius: IOS_RADIUS,
            overflow: "hidden",
            isolation: "isolate",
            background: t.screen,
            color: t.text,
            fontFamily: IOS_FONT,
            fontSize: 16,
            lineHeight: 1.4,
            // 描边走 inset 阴影而不是 border：不占布局，width/height 就是屏幕本身的尺寸
            boxShadow: "0 2px 6px rgba(16,18,22,0.14), 0 26px 60px rgba(16,18,22,0.26), inset 0 0 0 1px " + t.edge
          }
        },
        /* @__PURE__ */ React.createElement(
          "div",
          {
            "aria-hidden": "true",
            style: {
              position: "absolute",
              top: IOS_ISLAND_TOP,
              left: "50%",
              transform: "translateX(-50%)",
              width: IOS_ISLAND_W,
              height: IOS_ISLAND_H,
              borderRadius: 999,
              background: "#000000",
              pointerEvents: "none",
              zIndex: 30
            }
          }
        ),
        /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 20 } }, /* @__PURE__ */ React.createElement(IOSStatusBar, { dark })),
        hasNav ? /* @__PURE__ */ React.createElement(IOSNavBar, { dark, title: props.title }) : null,
        /* @__PURE__ */ React.createElement(
          "div",
          {
            style: {
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              WebkitOverflowScrolling: "touch",
              paddingTop: hasNav ? 0 : IOS_STATUS_H,
              paddingBottom: props.keyboard ? 0 : 28
            }
          },
          props.children
        ),
        props.keyboard ? /* @__PURE__ */ React.createElement(IOSKeyboard, { dark }) : null,
        /* @__PURE__ */ React.createElement(
          "div",
          {
            "aria-hidden": "true",
            style: {
              position: "absolute",
              left: "50%",
              bottom: 8,
              transform: "translateX(-50%)",
              width: 140,
              height: 5,
              borderRadius: 999,
              background: t.indicator,
              pointerEvents: "none",
              zIndex: 40
            }
          }
        )
      );
    }
    Object.assign(window, { IOSDevice, IOSStatusBar, IOSNavBar, IOSGlassPill, IOSList, IOSListRow, IOSKeyboard });
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
        console.error('[OpenPipal] ios-frame 预制件等不到 React/ReactDOM，设备外框未挂载。')
      }
    }, 30)
  }
})()
