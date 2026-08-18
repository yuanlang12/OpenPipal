import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Sliders, MessageCircle, Settings, Mic, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'
import { isDcHtml, inlineDcRuntime, inlineDcSiblings, inlineDcArtifactSiblings, inlineKnownScriptSiblings, inlineUploadedImages, editableDcProps, readDcPropOverrides, writeDcPropOverrides, writeDcEdl, scanKnownSiblingPreloads, KNOWN_SIBLING_COUNT, DcPropMeta } from './dcRuntime'
import { DcTweaksPanel } from './DcTweaksPanel'
import { ElementTweakPanel, TweakFields } from './ElementTweakPanel'
import { useLocalSTT } from '../../hooks/useLocalSTT'
import { locateElementInSource, mergeStyleIntoTag, styleKeyToCssProp } from './tweakDirectWrite'
import { PREVIEW_FIT_SOURCE } from './previewFitSource'
import { buildHtmlPreviewBridgeScript, shouldSkipSelfEditEcho } from './htmlPreviewBridge'

interface HtmlPreviewProps {
  content: string
  streaming?: boolean
  /** tweak:set-keys 写入后回调 (已合并后的新完整内容) — ArtifactTab 负责落盘 */
  onContentEdit?: (newContent: string) => void
  /** 工具组（Reload/Tweaks/Comment）的 portal 插槽——ArtifactTab 头行传入，与 分享/预览/源码 同行 */
  toolbarHost?: HTMLElement | null
  /**
   * 兄弟素材版本号。dc 薄壳的画面由「薄壳 + 它 from 引用的场景 jsx」共同决定，模型改 bug
   * 十有八九只动场景——薄壳 content 一个字节不变，只盯 content 的话预览会一直停在旧画面。
   * 调用方（ArtifactTab）把整套渲染输入的指纹传进来，变了就重新装配。
   */
  siblingRev?: string
}

// Comment(画笔)模式的光标：红色铅笔+白描边（明暗底都可见），笔尖热点 (2,22)。
// 系统 crosshair 让用户以为只能点选——看得见的笔才提示"可以画"（真机反馈实案）
const PEN_CURSOR_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" fill="#ef4444" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
)

// 注入到 iframe 顶部的桥代码：定义 window.openpipal.complete()
// 通过 postMessage 和父窗口通信，父窗口再走 IPC/HTTP 到 main 进程的 simpleComplete
const BRIDGE_SCRIPT_TEMPLATE = `<script>(function(){
  var _swCopy = __OPENPIPAL_PREVIEW_COPY__;
  var pending = Object.create(null);
  var seq = 0;
  function rid(){ return 's' + Date.now().toString(36) + (++seq).toString(36); }
  function extractPrompt(arg){
    if (typeof arg === 'string') return { prompt: arg };
    if (!arg || typeof arg !== 'object') return null;
    // 支持的 object 形式（AI 可能按不同习惯调用）：
    //   { messages: [{role, content}, ...] } — Anthropic/OpenAI chat 式
    //   { prompt: "..." }                     — 最常见
    //   { text: "..." } / { content: "..." } / { input: "..." } / { user: "..." }
    var sys = arg.systemPrompt || arg.system || undefined;
    if (Array.isArray(arg.messages)) {
      return {
        prompt: arg.messages.map(function(m){ return (m.role||'user') + ': ' + (m.content||''); }).join('\\n\\n'),
        systemPrompt: sys
      };
    }
    var p = arg.prompt || arg.text || arg.content || arg.input || arg.user || arg.message;
    if (typeof p === 'string') return { prompt: p, systemPrompt: sys };
    return null;
  }
  function complete(arg, sysOrOpts){
    var parsed = extractPrompt(arg);
    if (!parsed) {
      var shape;
      try { shape = typeof arg + (arg && typeof arg === 'object' ? ' {' + Object.keys(arg).join(',') + '}' : ''); }
      catch(_) { shape = 'unknown'; }
      return Promise.reject(new Error('openpipal.complete: 接受 string, {prompt}, {text}, {content}, {input}, {messages} — 实际收到: ' + shape));
    }
    // 第二个参数：string 当 systemPrompt；object 取其 systemPrompt
    var systemPrompt = parsed.systemPrompt;
    if (typeof sysOrOpts === 'string') systemPrompt = systemPrompt || sysOrOpts;
    else if (sysOrOpts && typeof sysOrOpts === 'object') systemPrompt = systemPrompt || sysOrOpts.systemPrompt || sysOrOpts.system;
    var id = rid();
    return new Promise(function(resolve, reject){
      pending[id] = { resolve: resolve, reject: reject, t: setTimeout(function(){
        delete pending[id]; reject(new Error('openpipal.complete timed out after 60s'));
      }, 60000) };
      parent.postMessage({ __openpipal: true, type: 'complete:request', requestId: id, prompt: parsed.prompt, systemPrompt: systemPrompt }, '*');
    });
  }
  // 流式预载的排队与冲刷（见下方 dc:preload 分支）
  var _preQ = [];
  var _preTimer = null;
  function _flushPreload(){
    if (typeof window.__dcUpdate !== 'function' || typeof window.__dcRootName !== 'function') return false;
    while (_preQ.length) {
      var p = _preQ.shift();
      try { window.__dcUpdate(window.__dcRootName(), 'preload', p, true); } catch(_) {}
    }
    return true;
  }
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || !d.__openpipal) return;
    // complete 响应
    if (d.type === 'complete:response') {
      var p = pending[d.requestId]; if (!p) return;
      clearTimeout(p.t); delete pending[d.requestId];
      if (d.ok) p.resolve(d.content); else p.reject(new Error(d.error || 'completion failed'));
      return;
    }
    // tweaks activate/deactivate — 转发给注册的 handler
    if ((d.type === 'tweak:activate' || d.type === 'tweak:deactivate') && _tweakHandler) {
      try { _tweakHandler({ active: d.type === 'tweak:activate' }); } catch(_) {}
      return;
    }
    // dc: 父窗口写回 props（sandbox 无 allow-same-origin，父窗口摸不到 contentWindow 函数，经此中转）
    if (d.type === 'dc:set-props') {
      try {
        if (typeof window.__dcSetProps === 'function' && typeof window.__dcRootName === 'function') {
          window.__dcSetProps(window.__dcRootName(), d.overrides || null);
        }
      } catch(_) {}
      return;
    }
    // dc: 流式模板泵——外壳只建一次，增量模板经官方 __dcUpdate 热更新（零文档重建）。
    // kind 必须是 'html'：support.js dcUpdate 只认 html/js/props，模板内容走 updateHtml
    // （对照 adoptParsed: parsed.template → updateHtml）。曾误传 'template' → 无分支命中，
    // 增量被静默吞、预览冻在建壳快照直到流结束——dc-stream-pump.spec P2 锁住此契约。
    if (d.type === 'dc:stream-template') {
      try {
        if (typeof window.__dcUpdate === 'function' && typeof window.__dcRootName === 'function') {
          window.__dcUpdate(window.__dcRootName(), 'html', d.template || '', d.streaming !== false);
        }
      } catch(_) {}
      _genericFitSchedule(); // 流入内容会加宽布局，resize 不触发——跟拍一次通用适配
      return;
    }
    // dc: 流式预载——把已知运行时预制件在**流中**送进活文档（壳先起、内容依次进）。
    // 兄弟件脚本原本只有挂载帧与终稿重建两个进文档的时机，deck 的 x-import 行几乎必然错过
    // 挂载帧，整场生成只剩占位骨架。__dcUpdate 按 key 去重、以 script 形态注入执行。
    // 排队重试：泵可能早于 support.js 就绪，而每个 key 父侧只送一次，丢了就永远补不回来。
    if (d.type === 'dc:preload') {
      _preQ.push({ key: d.key, code: d.code });
      if (!_flushPreload() && !_preTimer) {
        var _preDeadline = Date.now() + 15000;
        _preTimer = setInterval(function(){
          if (_flushPreload() || Date.now() > _preDeadline) { clearInterval(_preTimer); _preTimer = null; }
        }, 32);
      }
      return;
    }
    // dc canvas: 适配/手动缩放——补上"宿主接管 canvas 画板平移缩放"契约的宿主侧（技能承诺、
    // support.js 只做了灰底+模式上报）。sandbox 无 allow-same-origin，测量必须在 iframe 内做。
    // canvas 协议一旦出现，通用宽度适配永久让位（两套 zoom 写同一根元素，必须单主）。
    if (d.type === 'dc:set-zoom') { _genericFitDisabled = true; _applyZoom(typeof d.zoom === 'number' && d.zoom > 0 ? d.zoom : 1); return; }
    if (d.type === 'dc:fit') { _genericFitDisabled = true; _fitCanvas(); return; }
    // sidecar 写回执——resolve 组件手里的 Promise(image-slot 靠它串行化连续写)
    if (d.type === 'sidecar:written') {
      var sp = _scPending[d.requestId]; if (!sp) return;
      clearTimeout(sp.t); delete _scPending[d.requestId];
      if (d.ok) sp.resolve(true); else sp.reject(new Error('sidecar write rejected'));
      return;
    }
    // comment activate/deactivate
    if (d.type === 'comment:activate') { _enableCommentMode(); return; }
    if (d.type === 'comment:deactivate') { _disableCommentMode(); return; }
    // 圈画笔迹清除（评论已提交/取消——宿主截完图后通知移除；无 ref = 清全部）
    if (d.type === 'comment:stroke-remove') { _removeStroke(d.ref); return; }
    // 圈画撤销上一笔
    if (d.type === 'comment:stroke-undo') { _undoStroke(); return; }
    // 元素微调面板（P1）：宿主侧 live 预览/还原——只对"当前锚定元素"(_tweakTargetEl，
    // 由 _onCommentClick 维护)操作，不按 dom 路径字符串重新查询（该路径本就是有损展示用途，
    // 不保证可逆定位）
    if (d.type === 'tweak:preview') { _applyTweakPreview(d.dom, d.style, d.text); return; }
    if (d.type === 'tweak:revert') { _revertTweak(d.dom); return; }
    if (d.type === 'tweak:commit') { _commitTweak(d.dom); return; }
  });

  // ---- dc canvas 缩放协议 ----
  // 用 CSS zoom（项目已有先例 tokens.css sw-ui-zoom）：参与布局，comment 模式的
  // getBoundingClientRect 覆盖框不会错位；offset* 量的是元素自身坐标系，不受当前 zoom 影响，
  // 因此 fit 无需先复位再量（不闪）。
  function _canvasIntrinsicWidth(){
    var host = document.querySelector('#dc-root>.sc-host') || document.querySelector('#dc-root') || document.body;
    var w = 0;
    var kids = host ? host.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!el || !el.offsetWidth) continue;
      var right = el.offsetLeft + el.offsetWidth;
      if (right > w) w = right;
    }
    return w > 0 ? w : (document.documentElement.scrollWidth || 0);
  }
  // 单帧宽度：host 直接子元素里绝对定位（并排摆放的画板惯用手法）的最大 offsetWidth；
  // 没有绝对定位子元素时退化为全部子元素里最大的一个
  function _maxFrameWidth(){
    var host = document.querySelector('#dc-root>.sc-host') || document.querySelector('#dc-root') || document.body;
    var kids = host ? host.children : [];
    var absMax = 0, anyMax = 0;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!el || !el.offsetWidth) continue;
      if (el.offsetWidth > anyMax) anyMax = el.offsetWidth;
      if (window.getComputedStyle(el).position === 'absolute' && el.offsetWidth > absMax) absMax = el.offsetWidth;
    }
    return absMax > 0 ? absMax : anyMax;
  }
  function _applyZoom(z){
    document.documentElement.style.zoom = String(z);
    parent.postMessage({ __openpipal: true, type: 'dc:zoom-applied', zoom: z }, '*');
  }
  // 画板智能适配：整板 fit 在多帧横向并排（如三方向对比稿，总宽 ~4000px+）时会把 zoom 压到
  // ~0.15，字都看不清——两个极端（改造前 1:1 只见左上角，改造后又太小）都不可读。
  // 折中：整板 fit 仍够读（>=FIT_FULL_THRESHOLD）就用它；太小则改成"单帧 fit"，
  // 一帧完整可读，其余帧靠横向滚动逐一比较。三个常量取舍：
  //   FIT_FULL_THRESHOLD=0.4 —— 低于此整板文字基本不可辨认
  //   FIT_FRAME_MIN=0.25     —— 单帧适配的下限，避免帧本身也过大时缩太狠
  //   FRAME_PAD=80           —— 单帧左右呼吸边，比整板的 40 宽一些（单帧独占视口更需要留白）
  function _fitCanvas(){
    var w = _canvasIntrinsicWidth();
    if (!w) { _applyZoom(1); return; }
    var FIT_FULL_THRESHOLD = 0.4;
    var FIT_FRAME_MIN = 0.25;
    var FRAME_PAD = 80;
    // window.innerWidth 是视口 CSS 像素，不随根元素 zoom 变；+40px 整板呼吸边
    var zFull = Math.min(1, window.innerWidth / (w + 40));
    if (zFull >= FIT_FULL_THRESHOLD) { _applyZoom(zFull); return; }
    var frameW = _maxFrameWidth() || w;
    var zFrame = Math.min(1, window.innerWidth / (frameW + FRAME_PAD));
    _applyZoom(Math.max(FIT_FRAME_MIN, zFrame));
  }

  // ---- 产物 sidecar(*.state.json)通道:image-slot / design-canvas 这类可编辑预制件的持久化契约 ----
  // 读:组件 fetch('<name>.state.json') 相对路径在 srcdoc(null origin)必败——垫片从宿主
  // 注入的 __openpipalSidecarData 供给;无数据回 404(组件按空槽处理)。
  // 写:window.openpipal.writeFile → postMessage 宿主落盘;resolve 等真实回执——
  // 组件靠该 Promise 串行化连续写,提前 resolve 会破坏它的写序。
  // 注意:定义放在下面的 window.openpipal 单一赋值里,别在这里提前挂——那句是整体赋值,
  // 提前挂上去会被它覆盖掉。
  var _scPending = Object.create(null);
  var _origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function(input, init){
    try {
      var u = typeof input === 'string' ? input : ((input && input.url) || '');
      if (/^[A-Za-z0-9._-]+\\.state\\.json$/.test(u)) {
        var d = (window.__openpipalSidecarData || {})[u];
        return Promise.resolve(new Response(d != null ? d : '', { status: d != null ? 200 : 404, headers: { 'Content-Type': 'application/json' } }));
      }
    } catch(_) {}
    return _origFetch ? _origFetch(input, init) : Promise.reject(new TypeError('fetch unavailable'));
  };
  function sidecarWriteFile(name, content){
    return new Promise(function(resolve, reject){
      var id = rid();
      _scPending[id] = { resolve: resolve, reject: reject, t: setTimeout(function(){
        delete _scPending[id]; reject(new Error('sidecar write timed out'));
      }, 15000) };
      parent.postMessage({ __openpipal: true, type: 'sidecar:write', requestId: id, name: String(name || ''), content: String(content == null ? '' : content) }, '*');
    });
  }

  // ---- 通用宽度适配（canvas 之外的一切 html）----
  // 固定宽内容（如 width:1280px 的原型/单页 dc 文档纸卡）在 480px 面板里只能看到左上角——
  // "尽量 100%，放不下等比缩宽"（高度保持原生滚动，文档类竖向滚动是正常阅读方式）。
  // 响应式页面 scrollWidth≈innerWidth → zoom 恒 1，天然零影响；deck/3D/动画各自内部
  // 已自适配容器，同样测不出横向溢出。幂等：scrollWidth 量元素自身坐标系、innerWidth 量
  // 视口 CSS 像素，都不随根 zoom 变（同 _fitCanvas 的注释），反复计算收敛同值。
  var _genericFitDisabled = false;
  var _genericFitTimer = null;
  var _genericFitApplied = false;
  ${PREVIEW_FIT_SOURCE}
  function _genericFit(){
    if (_genericFitDisabled) return;
    // canvas meta 可能晚于宽内容流入(流式 chunk 顺序)——发现 meta 时若此前误设过通用 zoom,
    // 立即撤销归零,不给 dc:fit 到达前留一个错误缩放窗口。
    if (document.querySelector('meta[name="design_doc_mode"][content="canvas"]')) {
      if (_genericFitApplied) { document.documentElement.style.zoom = ''; _genericFitApplied = false; }
      return;
    }
    var sw = Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth : 0);
    var cur = parseFloat(document.documentElement.style.zoom || '1') || 1;
    var z = __computeFitZoom(sw, window.innerWidth, cur);
    if (z !== cur) { document.documentElement.style.zoom = String(z); _genericFitApplied = z !== 1; }
  }
  function _genericFitSchedule(){
    if (_genericFitDisabled) return;
    if (_genericFitTimer) clearTimeout(_genericFitTimer);
    _genericFitTimer = setTimeout(_genericFit, 120);
  }
  window.addEventListener('resize', _genericFitSchedule);
  // load 后再补两拍：晚到的图片/字体会改变布局宽度
  window.addEventListener('load', function(){ _genericFit(); setTimeout(_genericFit, 800); setTimeout(_genericFit, 2500); });
  if (document.readyState !== 'loading') setTimeout(_genericFit, 0);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(_genericFit, 0); });

  // ---- 时间轴编辑落盘 ----
  // 动画运行时在画布元素上派 openpipal:edl-changed（不冒泡，与 seek 事件同款约定）。
  // 捕获阶段的 document 监听照样收得到（bubbles 只影响冒泡阶段），转交宿主写回产物——
  // 只留在 iframe 里的话，重载和导出都吃不到这次剪辑。
  document.addEventListener('openpipal:edl-changed', function(e){
    try {
      var edl = e && e.detail && e.detail.edl;
      if (Object.prototype.toString.call(edl) === '[object Array]') {
        parent.postMessage({ __openpipal: true, type: 'edl:changed', edl: edl }, '*');
      }
    } catch (err) { /* 事件形状不对就当没发生 */ }
  }, true);

  // ---- Tweaks 协议 ----
  var _tweakHandler = null;
  function registerTweaks(handler){
    _tweakHandler = handler;
    parent.postMessage({ __openpipal: true, type: 'tweak:available' }, '*');
  }
  function setTweakKeys(edits){
    if (!edits || typeof edits !== 'object') return;
    parent.postMessage({ __openpipal: true, type: 'tweak:set-keys', edits: edits }, '*');
  }

  // ---- Comment 点选协议 ----
  var _commentMode = false;
  var _cseq = 0;
  var _commentOverlay = null;
  var _commentHover = null;     // 跟着鼠标的红框 outline
  var _commentFlash = null;     // 选中后 200ms 闪烁确认
  var _commentSelected = null;  // 持续显示的选中态高亮框——随 live 预览几何变化跟随重定位（P2）
  // ---- P1/P2 元素微调面板：live 预览/还原，锚定"当前选中元素"引用（非 dom 路径重查）----
  var _tweakTargetEl = null;    // comment 点选后气泡/面板对应的元素
  var _tweakTargetKey = null;   // 当前元素的 dom 路径 key（与 host 侧 commentAnchor.dom 同一份字符串）
  // P2：快照按 dom 路径 Map 化（原先是单例）——即使宿主侧漏发 revert，A/B 两元素的快照也不会
  // 互相覆盖。每条 { el, style, html }：el 是真实引用，revert 直接对它操作，不按 dom 路径重新查询
  // DOM（该路径本就是有损展示用途，不保证可逆定位）。
  var _tweakSnapshots = Object.create(null);
  function _tweakSnapshotTake(key, el){
    if (_tweakSnapshots[key]) return; // 已有快照（同一元素多次 preview 复用首次快照）
    _tweakSnapshots[key] = { el: el, style: el.getAttribute('style') || '', html: el.innerHTML };
  }
  // 重测元素几何并同步：①持续选中高亮框 ②postMessage 通知宿主更新气泡/面板锚点位置
  function _reportRectChange(key, el){
    var rect = el.getBoundingClientRect();
    if (_commentSelected) { _commentSelected.style.display = 'block'; _positionBox(_commentSelected, rect); }
    parent.postMessage({ __openpipal: true, type: 'comment:rect-changed', dom: key, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } }, '*');
  }
  function _applyTweakPreview(dom, style, text){
    var el = _tweakTargetEl;
    if (!el) return;
    var key = dom || _tweakTargetKey;
    _tweakSnapshotTake(key, el);
    if (style && typeof style === 'object') {
      for (var k in style) { if (Object.prototype.hasOwnProperty.call(style, k) && style[k] != null) el.style[k] = style[k]; }
    }
    if (typeof text === 'string') el.innerText = text;
    // 字号/边距等预览可能改变元素几何——重测并同步（节流：每次 preview 触发一次即可，不需要 ResizeObserver）
    _reportRectChange(key, el);
  }
  function _revertTweak(dom){
    var key = dom || _tweakTargetKey;
    var snap = key ? _tweakSnapshots[key] : null;
    if (!snap) return;
    var el = snap.el;
    if (snap.style) el.setAttribute('style', snap.style); else el.removeAttribute('style');
    el.innerHTML = snap.html;
    delete _tweakSnapshots[key];
    _reportRectChange(key, el);
  }
  // 确认（非取消）：live 预览留在 DOM 上作为新基线——只清快照条目，不还原、不影响元素几何。
  // 不清的话，下次切换元素时 _onCommentClick 的自检会把"已确认"误当"未确认"，把刚确认的改动revert掉。
  function _commitTweak(dom){
    var key = dom || _tweakTargetKey;
    if (key) delete _tweakSnapshots[key];
  }
  function _buildDomPath(el){
    var parts = [];
    var cur = el;
    for (var i = 0; i < 5 && cur && cur !== document.body; i++) {
      var tag = (cur.tagName || '').toLowerCase();
      var cls = cur.className && typeof cur.className === 'string' ? '.' + cur.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      var id = cur.id ? '#' + cur.id : '';
      parts.unshift(tag + id + cls);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function _positionBox(box, rect){
    // canvas 缩放补偿：gBCR 返回的是 zoom 后的视觉坐标，而 box 自身的 px 样式也会再被
    // documentElement.zoom 放大一次——不除回去会双重缩放（zoom=0.15 时红框飘到左上角）
    var z = parseFloat(document.documentElement.style.zoom) || 1;
    box.style.top = (rect.top + window.scrollY) / z + 'px';
    box.style.left = (rect.left + window.scrollX) / z + 'px';
    box.style.width = rect.width / z + 'px';
    box.style.height = rect.height / z + 'px';
  }
  // ---- 圈画（Comment 模式默认即画笔：拖拽=手绘圈选，未超阈值的点击=点选元素）----
  var _strokeSvg = null;
  var _strokePaths = Object.create(null);
  var _strokeOrder = []; // 本组笔迹的先后顺序——撤销按此弹最后一笔
  var _sseq = 0;
  var _strokeActive = false, _strokeDragging = false, _strokeSuppressClick = false;
  var _strokeStartCX = 0, _strokeStartCY = 0, _strokePts = null, _strokeBBox = null, _strokeEl = null, _strokeZ = 1;
  function _strokeEnsureSvg(){
    if (_strokeSvg && _strokeSvg.parentNode) return;
    _strokeSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    _strokeSvg.id = 'sw-stroke-layer';
    // 0 尺寸 + overflow:visible：SVG 只当坐标原点用，路径画到文档任意位置都可见；
    // 挂 body + absolute（同高亮框），点坐标带 scroll 补偿 → 笔迹随内容滚动
    _strokeSvg.style.cssText = 'position:absolute;top:0;left:0;width:2px;height:2px;overflow:visible;pointer-events:none;z-index:2147483643';
    document.body.appendChild(_strokeSvg);
  }
  function _onStrokeDown(e){
    if (!_commentMode || e.button !== 0) return;
    _strokeActive = true; _strokeDragging = false;
    _strokeStartCX = e.clientX; _strokeStartCY = e.clientY;
    _strokePts = []; _strokeBBox = null;
  }
  function _onStrokeMove(e){
    if (!_strokeActive) return;
    if (!_strokeDragging) {
      var dx = e.clientX - _strokeStartCX, dy = e.clientY - _strokeStartCY;
      if (dx*dx + dy*dy < 36) return; // 6px 阈值内仍视为潜在点选，交给 click
      _strokeDragging = true;
      _strokeZ = parseFloat(document.documentElement.style.zoom) || 1;
      _strokeEnsureSvg();
      _strokeEl = document.createElementNS('http://www.w3.org/2000/svg','path');
      _strokeEl.setAttribute('fill','none');
      _strokeEl.setAttribute('stroke','#ef4444');
      _strokeEl.setAttribute('stroke-width', String(3 / _strokeZ)); // 视觉恒 ~3px（zoom 会再放大）
      _strokeEl.setAttribute('stroke-linecap','round');
      _strokeEl.setAttribute('stroke-linejoin','round');
      _strokeEl.setAttribute('opacity','0.9');
      _strokeSvg.appendChild(_strokeEl);
      _strokePts.push([(_strokeStartCX + window.scrollX) / _strokeZ, (_strokeStartCY + window.scrollY) / _strokeZ]);
      _strokeBBox = { minX: _strokeStartCX, minY: _strokeStartCY, maxX: _strokeStartCX, maxY: _strokeStartCY };
      if (_commentHover) _commentHover.style.display = 'none';
    }
    e.preventDefault(); e.stopPropagation();
    _strokePts.push([(e.clientX + window.scrollX) / _strokeZ, (e.clientY + window.scrollY) / _strokeZ]);
    if (e.clientX < _strokeBBox.minX) _strokeBBox.minX = e.clientX;
    if (e.clientY < _strokeBBox.minY) _strokeBBox.minY = e.clientY;
    if (e.clientX > _strokeBBox.maxX) _strokeBBox.maxX = e.clientX;
    if (e.clientY > _strokeBBox.maxY) _strokeBBox.maxY = e.clientY;
    var dd = 'M';
    for (var i = 0; i < _strokePts.length; i++) {
      dd += _strokePts[i][0].toFixed(1) + ' ' + _strokePts[i][1].toFixed(1);
      if (i < _strokePts.length - 1) dd += 'L';
    }
    _strokeEl.setAttribute('d', dd);
  }
  function _onStrokeUp(e){
    if (!_strokeActive) return;
    _strokeActive = false;
    if (!_strokeDragging) return; // 纯点击 → 放行给 _onCommentClick 点选
    _strokeDragging = false;
    e.preventDefault(); e.stopPropagation();
    // mouseup 后浏览器会紧跟派发一次 click——吞掉它，圈画收笔不能被误当点选
    _strokeSuppressClick = true;
    setTimeout(function(){ _strokeSuppressClick = false; }, 0);
    var ref = 'st-' + (++_sseq);
    // 一条评论可画多笔（圈几个位置一起说）——笔迹累积，撤销/取消/提交时统一清理
    _strokePaths[ref] = _strokeEl;
    _strokeOrder.push(ref);
    _strokeEl = null;
    var b = _strokeBBox;
    parent.postMessage({ __openpipal: true, type: 'comment:stroke', ref: ref, rect: { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY } }, '*');
  }
  function _removeStroke(ref){
    if (ref) {
      var p = _strokePaths[ref];
      if (p && p.parentNode) p.parentNode.removeChild(p);
      delete _strokePaths[ref];
      _strokeOrder = _strokeOrder.filter(function(r){ return r !== ref; });
      return;
    }
    for (var k in _strokePaths) { var q = _strokePaths[k]; if (q && q.parentNode) q.parentNode.removeChild(q); }
    _strokePaths = Object.create(null);
    _strokeOrder = [];
  }
  function _undoStroke(){
    var last = _strokeOrder[_strokeOrder.length - 1];
    if (last) _removeStroke(last);
  }
  function _onCommentMove(e){
    if (_strokeDragging) { if (_commentHover) _commentHover.style.display = 'none'; return; }
    if (!_commentMode || !_commentHover) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === _commentOverlay) {
      _commentHover.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { _commentHover.style.display = 'none'; return; }
    _commentHover.style.display = 'block';
    _positionBox(_commentHover, rect);
  }
  function _onCommentClick(e){
    if (!_commentMode) return;
    if (_strokeSuppressClick) { e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === _commentOverlay) return;
    var rect = el.getBoundingClientRect();
    var dom = _buildDomPath(el);

    // 切换到新元素前，若旧元素有未确认的样式预览，先还原——避免残留内联样式被误当"已确认"
    // （双保险之一：注入侧自检，即使宿主侧漏发 tweak:revert 也不会遗留；已确认的预览快照条目
    // 已被 tweak:commit 清掉，不会被这里误伤而回滚掉刚确认的改动）
    if (_tweakTargetKey && _tweakTargetKey !== dom && _tweakSnapshots[_tweakTargetKey]) _revertTweak(_tweakTargetKey);
    _tweakTargetEl = el;
    _tweakTargetKey = dom;

    // 闪烁确认——绿色边框 240ms；随后交给持续显示的选中高亮框跟随
    if (_commentFlash) {
      _commentFlash.style.display = 'block';
      _positionBox(_commentFlash, rect);
      setTimeout(function(){ if (_commentFlash) _commentFlash.style.display = 'none'; }, 240);
    }
    if (_commentSelected) { _commentSelected.style.display = 'block'; _positionBox(_commentSelected, rect); }

    var computed = window.getComputedStyle(el);
    // 样式直写定位阶梯 (a)(b) 用的开标签快照：outerHTML 从头截到首个 '>'（覆盖绝大多数场景；
    // 引号内含 '>' 的极端属性值不在此保守范围内），再封顶 300 字符防止超长属性把消息体撑爆
    var _outerHtml = el.outerHTML || '';
    var _gtIdx = _outerHtml.indexOf('>');
    var outerHead = _gtIdx !== -1 ? _outerHtml.slice(0, _gtIdx + 1) : _outerHtml;
    if (outerHead.length > 300) outerHead = outerHead.slice(0, 300);
    parent.postMessage({
      __openpipal: true,
      type: 'comment:clicked',
      ref: 'cc-' + (++_cseq),
      dom: dom,
      tagName: (el.tagName || '').toLowerCase(),
      text: (el.innerText || el.value || '').slice(0, 80),
      fullText: (el.innerText || el.value || '').slice(0, 2000),
      outerHead: outerHead,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      computed: {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        opacity: computed.opacity,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        borderRadius: computed.borderRadius,
        borderColor: computed.borderColor,
        borderWidth: computed.borderWidth,
        width: computed.width,
        height: computed.height,
        paddingTop: computed.paddingTop,
        paddingRight: computed.paddingRight,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        marginTop: computed.marginTop,
        marginRight: computed.marginRight,
        marginBottom: computed.marginBottom,
        marginLeft: computed.marginLeft
      }
    }, '*');
  }
  var _penCursorStyle = null;
  function _enableCommentMode(){
    if (_commentMode) return;
    _commentMode = true;
    // 铅笔光标全局强制（!important 压过内容自带的 pointer/text 等）——看得见笔才知道能画
    _penCursorStyle = document.createElement('style');
    _penCursorStyle.textContent = '*{cursor:url("data:image/svg+xml,${PEN_CURSOR_SVG}") 2 22,crosshair !important}';
    document.head.appendChild(_penCursorStyle);
    // 顶栏提示
    _commentOverlay = document.createElement('div');
    _commentOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:8px 12px;background:#1f2937;color:#fff;font:12px -apple-system,sans-serif;z-index:2147483647;text-align:center;pointer-events:none';
    _commentOverlay.textContent = _swCopy.commentOverlay;
    document.body.appendChild(_commentOverlay);
    // hover 红框
    _commentHover = document.createElement('div');
    _commentHover.style.cssText = 'position:absolute;border:2px solid #ef4444;background:rgba(239,68,68,0.08);pointer-events:none;z-index:2147483646;display:none;transition:all 60ms ease-out;border-radius:2px';
    document.body.appendChild(_commentHover);
    // 选中后绿色闪烁
    _commentFlash = document.createElement('div');
    _commentFlash.style.cssText = 'position:absolute;border:3px solid #10b981;background:rgba(16,185,129,0.15);pointer-events:none;z-index:2147483645;display:none;border-radius:2px';
    document.body.appendChild(_commentFlash);
    // 持续显示的选中高亮框——面板/气泡锚定期间跟随元素几何变化（comment:rect-changed 协议）
    _commentSelected = document.createElement('div');
    _commentSelected.id = 'sw-tweak-selected-box';
    _commentSelected.style.cssText = 'position:absolute;border:2px solid #3b82f6;pointer-events:none;z-index:2147483644;display:none;border-radius:2px;transition:top 80ms ease-out,left 80ms ease-out,width 80ms ease-out,height 80ms ease-out';
    document.body.appendChild(_commentSelected);

    document.addEventListener('mousemove', _onCommentMove, true);
    document.addEventListener('click', _onCommentClick, true);
    // 画笔（默认）：mousedown/mousemove/mouseup 捕获段接管——拖拽成笔迹，未超阈值放行为点选
    document.addEventListener('mousedown', _onStrokeDown, true);
    document.addEventListener('mousemove', _onStrokeMove, true);
    document.addEventListener('mouseup', _onStrokeUp, true);
  }
  function _disableCommentMode(){
    if (!_commentMode) return;
    _commentMode = false;
    if (_penCursorStyle && _penCursorStyle.parentNode) _penCursorStyle.parentNode.removeChild(_penCursorStyle);
    _penCursorStyle = null;
    [_commentOverlay, _commentHover, _commentFlash, _commentSelected].forEach(function(el){
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    _commentOverlay = null; _commentHover = null; _commentFlash = null; _commentSelected = null;
    document.removeEventListener('mousemove', _onCommentMove, true);
    document.removeEventListener('click', _onCommentClick, true);
    document.removeEventListener('mousedown', _onStrokeDown, true);
    document.removeEventListener('mousemove', _onStrokeMove, true);
    document.removeEventListener('mouseup', _onStrokeUp, true);
    // 退出评论模式：笔迹层整体清除
    _removeStroke();
    if (_strokeSvg && _strokeSvg.parentNode) _strokeSvg.parentNode.removeChild(_strokeSvg);
    _strokeSvg = null;
    _strokeActive = false; _strokeDragging = false;
    // 退出评论模式：未确认的样式预览一并还原，避免遗留内联样式
    if (_tweakTargetKey && _tweakSnapshots[_tweakTargetKey]) _revertTweak(_tweakTargetKey);
    _tweakTargetEl = null;
    _tweakTargetKey = null;
  }

  // ---- 交互上报（宿主 Reload 门闩的信号源）：滚动/滚轮/按下/触摸/按键 → 节流告知宿主 ----
  var _uiLastSent = 0;
  function _reportInteract(){
    var now = Date.now();
    if (now - _uiLastSent < 800) return;
    _uiLastSent = now;
    parent.postMessage({ __openpipal: true, type: 'ui:interact' }, '*');
  }
  ['scroll','wheel','mousedown','touchstart','keydown'].forEach(function(evt){
    document.addEventListener(evt, _reportInteract, { capture: true, passive: true });
  });

  // iframe 内产物能用的全部宿主能力，就这一个命名空间、一处赋值。
  // writeFile 供可编辑预制件（image-slot 等）持久化 sidecar，实现在上面的 sidecar 通道段。
  window.openpipal = {
    complete: complete,
    tweaks: { register: registerTweaks, setKeys: setTweakKeys },
    writeFile: sidecarWriteFile
  };
})();</script>`

function injectBridge(html: string, bridgeScript: string): string {
  if (!html) return html
  // 优先插到 <head> 后面；没有 <head> 就插到最前
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + bridgeScript)
  }
  return bridgeScript + html
}

/**
 * 同步装配（流式外壳 + 终稿首帧）：./support.js 内联 + 单路径已知兄弟预制件预载 + bridge。
 * 链式 from（含会话 sidecar 的 ./artifact-<id>.jsx）不在此解析——由 assembleDoc 异步升级。
 * 未闭合 <script> 截断只在流式路径先行处理（见 buildFullDoc）。
 */
function assembleDocSync(src: string, bridgeScript: string): string {
  const base = isDcHtml(src) ? inlineDcSiblings(inlineDcRuntime(src)) : inlineKnownScriptSiblings(src)
  return injectBridge(base, bridgeScript)
}

/**
 * 终稿异步装配：完整 from 引擎（已知运行时 + 会话 sidecar 场景经 IPC 取 <id>.compiled.js），
 * 删 from + 按链序预载全局 → 内联 support → bridge。from 引擎在原始 src 上跑（先于 support 内联，
 * 避免扫到 support.js 内联体里的 src="…" 字面量）。
 */
async function assembleDoc(src: string, bridgeScript: string, conversationId?: string | null): Promise<string> {
  // uploads/ 内联对非 dc 同样必需——srcdoc 沙箱里相对路径对一切 html 都是裂图
  if (!isDcHtml(src)) {
    const bare = await inlineUploadedImages(inlineKnownScriptSiblings(src), conversationId)
    return injectBridge(await injectSidecarData(bare, conversationId), bridgeScript)
  }
  let out = await inlineDcArtifactSiblings(src, conversationId)
  out = inlineDcRuntime(out)
  out = await injectSidecarData(out, conversationId)
  return injectBridge(out, bridgeScript)
}

/**
 * 产物 sidecar(*.state.json)水合:扫描(内联后)文档里引用的 sidecar 基名,经 IPC 读会话目录里的
 * 状态文件,注入 __openpipalSidecarData 供 BRIDGE_SCRIPT 的 fetch 垫片供给(srcdoc 相对 fetch 必败)。
 * 只在终态整页装配时做——流式期组件读到 404 按空槽渲染,终稿接管后自然水合。
 */
const SIDECAR_REF_RE = /[A-Za-z0-9._-]+\.state\.json/g
async function injectSidecarData(html: string, conversationId?: string | null): Promise<string> {
  if (!conversationId) return html
  const names = Array.from(new Set(html.match(SIDECAR_REF_RE) || [])).slice(0, 4)
  if (!names.length) return html
  const data: Record<string, string> = {}
  await Promise.all(names.map(async (name) => {
    try {
      const txt = await (window as any).api?.readArtifactSidecar?.(conversationId, name)
      if (typeof txt === 'string') data[name] = txt
    } catch { return /* 缺失=空槽,非错误 */ }
  }))
  if (!Object.keys(data).length) return html
  const tag = `<script>window.__openpipalSidecarData=${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html
}

/**
 * 把 edits 合并进 artifact 源码里的 /*TWEAKS-BEGIN*\/{...}\/*TWEAKS-END*\/ JSON 块
 * 如果没有这个块，说明 artifact 没设计成可 tweak，直接返回原内容
 */
function mergeTweakEdits(content: string, edits: Record<string, any>): string {
  const re = /\/\*TWEAKS-BEGIN\*\/([\s\S]*?)\/\*TWEAKS-END\*\//
  const m = content.match(re)
  if (!m) return content
  let obj: Record<string, any>
  try { obj = JSON.parse(m[1].trim()) } catch { obj = {} }
  const merged = { ...obj, ...edits }
  return content.replace(re, `/*TWEAKS-BEGIN*/${JSON.stringify(merged, null, 2)}/*TWEAKS-END*/`)
}

/**
 * P0 直改文字回写用：sanitize iframe 传回的 newHtml，白名单只留 <br>/<br/>，其余标签全部剥成纯文本
 * ——防止用户在可编辑区里敲入的结构（如粘贴带标签的富文本）被当结构注入回源码。
 * 用纯字符串处理（不经 DOM parser），避免宿主侧解析潜在恶意标签触发副作用。
 */
function sanitizeInlineEditHtml(html: string): string {
  if (!html) return ''
  const BR = 'SW_BR'
  let s = html.replace(/<br\s*\/?>/gi, BR)
  s = s.replace(/<[^>]*>/g, '') // 剥离其余标签本身，保留标签间的文本内容
  // 先把可能存在的实体解码回原字符，避免与下面的重新转义产生双重转义
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return s.split(BR).join('<br>')
}

type LadderResult =
  | { kind: 'direct'; next: string }
  | { kind: 'mention'; snippet: string }
  | { kind: 'noop' }

/**
 * P0 直改文字的确定性阶梯（提取为可复用函数——P0 的 ✎ 按钮 contentEditable 流程与 P1 面板的
 * 文本字段都要用）：oldHtml/oldText 在源码里唯一出现就直写替换；都不唯一命中则降级为
 * AI 精确改写的 mention 请求。匹配对象是源码字符串本身（作者文案在其中逐字存在），不是
 * DOM 序列化——dc 产物运行时会给 DOM 加壳，只有字符串匹配能定位到未加壳前的原文。
 */
function ladderTextReplace(src: string, oldText: string, newText: string, oldHtml: string, newHtml: string, dom: string): LadderResult {
  const htmlIdx = oldHtml ? src.indexOf(oldHtml) : -1
  if (oldHtml && htmlIdx !== -1 && htmlIdx === src.lastIndexOf(oldHtml)) {
    const safeHtml = sanitizeInlineEditHtml(newHtml || newText)
    const next = src.slice(0, htmlIdx) + safeHtml + src.slice(htmlIdx + oldHtml.length)
    return next !== src ? { kind: 'direct', next } : { kind: 'noop' }
  }
  const textIdx = oldText ? src.indexOf(oldText) : -1
  if (oldText && textIdx !== -1 && textIdx === src.lastIndexOf(oldText)) {
    const next = src.slice(0, textIdx) + newText + src.slice(textIdx + oldText.length)
    return next !== src ? { kind: 'direct', next } : { kind: 'noop' }
  }
  const mentionText = oldText || oldHtml || ''
  const snippet = `<mentioned-element ref="edit-${Date.now().toString(36)}" dom="${dom || ''}">${mentionText}</mentioned-element>\n请把该元素文本改为：「${newText}」`
  return { kind: 'mention', snippet }
}

/** getComputedStyle 返回的 rgb(a)(...) 归一化成 <input type=color> 认识的 #rrggbb（丢 alpha，Opacity 是独立字段）*/
function rgbToHex(rgb: string): string {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgb || '')
  if (!m) return /^#[0-9a-fA-F]{6}$/.test(rgb || '') ? rgb : '#000000'
  const toHex = (n: string): string => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`
}

/** getComputedStyle 的 px 长度值（如 "16px"）剥成纯数字字符串（"16"），供数字输入框展示 */
function stripPx(v: string): string {
  const m = /^(-?[\d.]+)px$/.exec((v || '').trim())
  return m ? m[1] : (v || '0')
}

/** getComputedStyle 的 font-weight 归一化成数字字符串（浏览器可能报 "normal"/"bold" 而非数值）*/
function normalizeFontWeight(v: string): string {
  const s = (v || '').trim().toLowerCase()
  if (s === 'normal') return '400'
  if (s === 'bold') return '700'
  return /^\d+$/.test(s) ? s : '400'
}

/**
 * 样式字段配置表：面板字段 key → { CSS 属性名(diff 展示用) / 内联 style key / 是否需要补 px 单位 }
 * live 预览与确认时的 change-spec 共用同一份映射——避免两处各写一套字段列表导致漂移。
 */
const TWEAK_STYLE_FIELDS: Array<{ key: keyof TweakFields; cssProp: string; styleKey: string; px?: boolean }> = [
  { key: 'color', cssProp: 'color', styleKey: 'color' },
  { key: 'backgroundColor', cssProp: 'background', styleKey: 'backgroundColor' },
  { key: 'opacity', cssProp: 'opacity', styleKey: 'opacity' },
  { key: 'fontFamily', cssProp: 'font-family', styleKey: 'fontFamily' },
  { key: 'fontSize', cssProp: 'font-size', styleKey: 'fontSize', px: true },
  { key: 'fontWeight', cssProp: 'font-weight', styleKey: 'fontWeight' },
  { key: 'borderRadius', cssProp: 'border-radius', styleKey: 'borderRadius', px: true },
  { key: 'borderColor', cssProp: 'border-color', styleKey: 'borderColor' },
  { key: 'borderWidth', cssProp: 'border-width', styleKey: 'borderWidth' },
  { key: 'width', cssProp: 'width', styleKey: 'width', px: true },
  { key: 'height', cssProp: 'height', styleKey: 'height', px: true },
  { key: 'paddingTop', cssProp: 'padding-top', styleKey: 'paddingTop', px: true },
  { key: 'paddingRight', cssProp: 'padding-right', styleKey: 'paddingRight', px: true },
  { key: 'paddingBottom', cssProp: 'padding-bottom', styleKey: 'paddingBottom', px: true },
  { key: 'paddingLeft', cssProp: 'padding-left', styleKey: 'paddingLeft', px: true },
  { key: 'marginTop', cssProp: 'margin-top', styleKey: 'marginTop', px: true },
  { key: 'marginRight', cssProp: 'margin-right', styleKey: 'marginRight', px: true },
  { key: 'marginBottom', cssProp: 'margin-bottom', styleKey: 'marginBottom', px: true },
  { key: 'marginLeft', cssProp: 'margin-left', styleKey: 'marginLeft', px: true }
]

/** 只收集实际变化的字段：live 预览用的内联 style 补丁 + 确认时 change-spec 用的 'prop: 旧 → 新' 描述行 */
function computeTweakStyleDiff(fields: TweakFields, initial: TweakFields): { style: Record<string, string>; diffs: string[] } {
  const style: Record<string, string> = {}
  const diffs: string[] = []
  for (const f of TWEAK_STYLE_FIELDS) {
    if (fields[f.key] === initial[f.key]) continue
    const nextVal = f.px ? `${fields[f.key]}px` : fields[f.key]
    const oldVal = f.px ? `${initial[f.key]}px` : initial[f.key]
    style[f.styleKey] = nextVal
    diffs.push(`${f.cssProp}: ${oldVal} → ${nextVal}`)
  }
  return { style, diffs }
}

/**
 * 气泡评论 Enter 提交：把评论文本 append 到主 InputBar 草稿并聚焦。
 * 硬约束：InputBar.tsx/chatStore.ts 本任务不可改（已有 addPendingMention 等多选 API 直接复用），
 * 而主输入框的草稿文本是 InputBar 组件内部 useState，没有 store 出口——只能走"原生 setter +
 * 派发 input 事件"的经典受控输入外部写值手法，用 InputBar 里唯一的输入框 placeholder 定位。
 */
function appendToMainInputAndFocus(text: string): void {
  if (!text) return
  // 前缀匹配：placeholder 全文随功能提示演化（现为"输入问题...（@ 唤起技能）"），精确匹配会静默失联
  const ta = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入问题"]')
  if (!ta) return
  const proto = Object.getPrototypeOf(ta)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const next = ta.value ? `${ta.value}\n${text}` : text
  if (setter) setter.call(ta, next)
  else ta.value = next
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.focus()
}

interface CommentAnchor {
  /** element = 点选元素（可微调）；stroke = 圈画笔迹（无 DOM 语义，评论+截图走 pendingAnnotations） */
  kind: 'element' | 'stroke'
  ref: string
  dom: string
  tagName: string
  rect: { x: number; y: number; w: number; h: number }
  /** 面板字段初值——已归一化(颜色→hex)，同时也是确认时的 diff 基线，避免格式转换导致假阳性 */
  initialFields: TweakFields
  /** 拾取时快照的开标签串（outerHTML 从头到首个 >，截断 300 字符）——样式直写定位阶梯 (a)(b) 用 */
  outerHead: string
}

/** stroke 锚点用的占位字段（不进微调面板，仅满足类型；⚙ 按钮对 stroke 隐藏） */
const EMPTY_TWEAK_FIELDS: TweakFields = {
  text: '', color: '#000000', backgroundColor: '#000000', opacity: '1', fontFamily: '',
  fontSize: '0', fontWeight: '400', borderRadius: '0', borderColor: '#000000', borderWidth: '0px',
  width: '0', height: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0',
  marginTop: '0', marginRight: '0', marginBottom: '0', marginLeft: '0'
}

// ── 流式期防护/取证 ──────────────────────────────────────────────────────────
// 未闭合 {{ 截断：support.js walkText 对没有配对 }} 的 {{ 走"全有全无" split——流式半截
// 空穴会把裸 {{ 语法当纯文本上屏（半截 tag 本身浏览器 parser 会安全丢弃，实验证实不泄漏）。
// 只作用于流式期写入；终稿走 docHtml 整页路径，不经此截断。
function truncateUnclosedInterp(s: string): string {
  // 按序配对扫描:截在**第一个**没有配对 }} 的 {{ 处(只查最后一个会漏掉
  // "前面未闭合 + 后面恰有闭合对"的组合,评审实锤)。截掉其后一切——流式尾部下轮泵会补回。
  let i = 0
  while ((i = s.indexOf('{{', i)) !== -1) {
    const close = s.indexOf('}}', i + 2)
    if (close === -1) return s.slice(0, i)
    i = close + 2
  }
  return s
}

// dev-only 取证：流式期"顶部裸属性文本"残片尚未逐字节归因——复现时从 window.__dcStreamDebug
// 导出每次写入前的尾部快照定位确切成因（定罪后此钩子随修复移除，日落条件登记 mechanism-registry）。
// key = 该产物全文头 40 字符指纹——多产物并发流式时按 key 区分归属，避免混流误导归因（评审实锤）。
const dcStreamDebug: Array<{ at: number; kind: string; key: string; tail: string }> = []
function recordStreamDebug(kind: string, tailSource: string, keySource: string): void {
  if (!(import.meta as any).env?.DEV) return
  dcStreamDebug.push({ at: Date.now(), kind, key: keySource.slice(0, 40), tail: tailSource.slice(-200) })
  if (dcStreamDebug.length > 80) dcStreamDebug.shift()
  ;(window as any).__dcStreamDebug = dcStreamDebug
}

export function HtmlPreview({ content, streaming, onContentEdit, toolbarHost, siblingRev }: HtmlPreviewProps) {
  const { t } = useTranslation()
  const bridgeScript = useMemo(
    () => buildHtmlPreviewBridgeScript(BRIDGE_SCRIPT_TEMPLATE, {
      commentOverlay: t('artifacts.canvas.bridge.commentOverlay')
    }),
    [t]
  )
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // 流式首帧占位：内容尚不可渲染时不给用户白屏（高内聚——"能画了没"由本组件已有信号判定：
  // dc 走 __dc_booted 上报、非 dc 按内容量阈值、5s 兜底必消失；tab 该不该开不归这里管）
  const [streamFirstPaint, setStreamFirstPaint] = useState(false)
  // 会话 sidecar 场景（./artifact-<id>.jsx）解析需知当前会话 id
  const conversationId = useChatStore((s) => s.activeConversationId)
  // 跟踪 artifact 是否声明了 tweak 能力（子窗广播 tweak:available 后置 true）
  const [tweakAvailable, setTweakAvailable] = useState(false)
  const [tweakActive, setTweakActive] = useState(false)
  const [commentActive, setCommentActive] = useState(false)
  // P0 直改文字：轻量成功/降级提示，预览区角落 2s 自动淡出
  const [editToast, setEditToast] = useState<string | null>(null)
  const editToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashEditToast = useCallback((msg: string, durationMs = 2000): void => {
    setEditToast(msg)
    if (editToastTimerRef.current) clearTimeout(editToastTimerRef.current)
    editToastTimerRef.current = setTimeout(() => setEditToast(null), durationMs)
  }, [])
  // ---- P1 元素微调面板：comment 点选后的悬浮气泡 + ⚙ 展开的属性面板 ----
  const [commentAnchor, setCommentAnchor] = useState<CommentAnchor | null>(null)
  const [elementPanelOpen, setElementPanelOpen] = useState(false)
  const [bubbleInput, setBubbleInput] = useState('')
  const [bubblePos, setBubblePos] = useState<{ top: number; left: number; width: number } | null>(null)
  // 面板垂直空间自适应位置：top(下方展开) 与 bottom(翻转到锚点上方) 二选一携带；maxHeight
  // 是容器实际剩余空间(封顶 60vh)算出的面板整体高度上限，传给 ElementTweakPanel 的 maxHeight prop
  const [panelPos, setPanelPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number; flipped: boolean } | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const hasLivePreviewRef = useRef(false) // 面板打开期间是否已发过至少一次 tweak:preview——关闭时据此决定要不要发 revert
  // onMsg 是闭包（effect deps 不含 commentAnchor），读不到最新值——切换元素前宿主侧兜底 revert 用
  const commentAnchorRef = useRef<CommentAnchor | null>(null)
  useEffect(() => { commentAnchorRef.current = commentAnchor }, [commentAnchor])
  // dc canvas 画板（design_doc_mode=canvas，Directions 方案确认稿）：宿主侧适配缩放
  const [canvasMode, setCanvasMode] = useState(false)
  const [canvasZoom, setCanvasZoom] = useState<number | null>(null) // dc:zoom-applied 回报，显示用
  const canvasZoomRef = useRef<number | null>(null) // onMsg 闭包读不到最新 state——重载恢复用
  useEffect(() => { canvasZoomRef.current = canvasZoom }, [canvasZoom])
  const zoomModeRef = useRef<'auto' | 'manual'>('auto') // auto = 跟随容器自动 fit；用户手动 ± 后转 manual
  const canvasModeRef = useRef(false)
  useEffect(() => { canvasModeRef.current = canvasMode }, [canvasMode])
  const wrapperRef = useRef<HTMLDivElement>(null)
  // 在 ref 里维护 content，避免 tweak 写入触发 re-render 导致 iframe 闪
  const contentRef = useRef(content)
  useEffect(() => { contentRef.current = content }, [content])
  // onMsg 闭包读不到最新 conversationId(effect 依赖不含它)——sidecar 落盘按 ref 取
  const conversationIdRef = useRef<string | null>(null)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])

  // ---- Reload 门闩：用户操作画布期间不自动刷新，暂存新内容亮提示 ----
  const commentActiveRef = useRef(false)
  useEffect(() => { commentActiveRef.current = commentActive }, [commentActive])
  const elementPanelOpenRef = useRef(false)
  useEffect(() => { elementPanelOpenRef.current = elementPanelOpen }, [elementPanelOpen])
  const lastInteractAtRef = useRef(0) // iframe ui:interact 上报 + 宿主侧缩放/调参动作共同刷新
  const pendingDocRef = useRef<string | null>(null)
  const [reloadPending, setReloadPending] = useState(false)
  const strokeCountRef = useRef(0) // 当前圈画组的笔数——撤到 0 关气泡
  const idleFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (idleFlushTimerRef.current) clearTimeout(idleFlushTimerRef.current) }, [])

  // ---- dc artifact（<x-dc>）参数面板 ----
  const isDc = useMemo(() => isDcHtml(content), [content])
  const [dcMeta, setDcMeta] = useState<Record<string, DcPropMeta> | null>(null)
  const [dcOverrides, setDcOverrides] = useState<Record<string, any>>({})
  const [dcPanelOpen, setDcPanelOpen] = useState(false)
  // 有可调参数的产物 boot 后停靠条默认展开；用户在同一产物内手动收起过则尊重收起
  const dcPanelUserClosedRef = useRef(false)
  const dcOverridesRef = useRef<Record<string, any>>({})
  const dcPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 自己写回（overrides 持久化）产生的 content 回声——跳过 srcdoc 重载，保住 iframe 运行时状态
  const selfEditRef = useRef<string | null>(null)
  const bridgeScriptRef = useRef(bridgeScript)
  const siblingRevRef = useRef(siblingRev)
  const [docHtml, setDocHtml] = useState(() => (streaming ? '' : assembleDocSync(content, bridgeScript)))

  // 「用户正在操作画布」判定：评论/圈画/微调等显式模式中，或 3s 内有过滚动缩放调参类交互
  const isCanvasBusy = useCallback((): boolean => {
    if (commentActiveRef.current || commentAnchorRef.current || elementPanelOpenRef.current) return true
    return Date.now() - lastInteractAtRef.current < 3000
  }, [])
  // 应用暂存的新内容（Reload 点击 / 闲置自动收口）
  const applyPendingDoc = useCallback((): void => {
    const c = pendingDocRef.current
    if (c == null) return
    pendingDocRef.current = null
    setReloadPending(false)
    setDocHtml(assembleDocSync(c, bridgeScript))
    void assembleDoc(c, bridgeScript, conversationIdRef.current).then((full) => {
      // 应用期间没有更新的内容进来才提交异步终稿
      if (pendingDocRef.current == null && contentRef.current === c) setDocHtml(full)
    })
  }, [bridgeScript])
  // 闲置收口轮询：有暂存内容时每秒查一次忙态，闲下来自动应用（评论模式等显式忙态会一直挡住，
  // 直到用户退出模式或点 Reload——与"没有操作画布时正常自动更新"的语义一致）
  const scheduleIdleFlush = useCallback((): void => {
    if (idleFlushTimerRef.current) clearTimeout(idleFlushTimerRef.current)
    const tick = (): void => {
      if (pendingDocRef.current == null) return
      if (isCanvasBusy()) { idleFlushTimerRef.current = setTimeout(tick, 1000); return }
      applyPendingDoc()
    }
    idleFlushTimerRef.current = setTimeout(tick, 1000)
  }, [isCanvasBusy, applyPendingDoc])
  // Reload 提醒只有小蓝点不够醒目（真机反馈）——待加载出现时补一条文案 toast
  useEffect(() => {
    if (!reloadPending) return
    flashEditToast(t('artifacts.canvas.reload.pendingToast'), 3500)
  }, [reloadPending, flashEditToast, t])

  // Reload 按钮：有暂存内容就应用；没有则整页重装当前内容（手动刷新画布）
  const reloadNow = useCallback((): void => {
    lastInteractAtRef.current = 0
    if (pendingDocRef.current != null) { applyPendingDoc(); return }
    const c = contentRef.current
    setDocHtml(assembleDocSync(c, bridgeScript))
    void assembleDoc(c, bridgeScript, conversationIdRef.current).then((full) => {
      if (contentRef.current === c && pendingDocRef.current == null) setDocHtml(full)
    })
  }, [applyPendingDoc, bridgeScript])

  useEffect(() => {
    const bridgeChanged = bridgeScriptRef.current !== bridgeScript
    bridgeScriptRef.current = bridgeScript
    // 兄弟素材换版同样要重装：content 没变，但画面的另一半输入变了
    const siblingChanged = siblingRevRef.current !== siblingRev
    siblingRevRef.current = siblingRev
    if (streaming) return // 流式走下方节流直写，不动 docHtml（srcDoc 此时也是 undefined）
    if (shouldSkipSelfEditEcho(selfEditRef.current, content, bridgeChanged || siblingChanged)) {
      selfEditRef.current = null
      return
    }
    selfEditRef.current = null
    // Reload 门闩：用户正在操作画布 → 不打断，暂存新内容亮 Reload 提示，闲置后自动应用
    if (isCanvasBusy()) {
      pendingDocRef.current = content
      setReloadPending(true)
      scheduleIdleFlush()
      return
    }
    pendingDocRef.current = null
    setReloadPending(false)
    // 先同步铺已知兄弟版本（避免空白闪 + 保住非 sidecar 场景终态），再异步解析会话 sidecar 场景升级
    setDocHtml(assembleDocSync(content, bridgeScript))
    let cancelled = false
    void (async () => {
      const full = await assembleDoc(content, bridgeScript, conversationId)
      if (!cancelled) setDocHtml(full)
    })()
    return () => { cancelled = true }
  }, [content, siblingRev, streaming, conversationId, bridgeScript, isCanvasBusy, scheduleIdleFlush])

  const addPendingMention = useChatStore(s => s.addPendingMention)
  const removePendingMention = useChatStore(s => s.removePendingMention)
  // chatStore.addPendingMention 按 dom 去重且命中即整体丢弃（不替换）——同一元素在 comment
  // 点选时已经进了一条 mention chip，P1 面板确认样式改动时若原样再 addPendingMention 一条
  // 携带同一 dom 的"更完整"的 change-spec，会被那条去重逻辑静默吞掉。用已有的
  // remove+add 组合出"同一元素只保留最新一条"的替换语义，不改 chatStore 本身。
  const upsertPendingMention = useCallback((dom: string, snippet: string): void => {
    const current = useChatStore.getState().pendingMentions
    const idx = current.findIndex(m => m.match(/dom="([^"]*)"/)?.[1] === dom)
    if (idx !== -1) removePendingMention(idx)
    addPendingMention(snippet)
  }, [addPendingMention, removePendingMention])

  // comment:clicked 点选时已无条件塞了一条"元素引用"chip（供用户手动追加消息用）；若这次 confirm
  // 文本/样式全部直写落盘、完全不需要 AI 介入，那条 chip 就该跟着清掉——否则用户会看到一个自己
  // 没写过话术、莫名其妙悬着的 mention（且违背"零 Agent 参与"就该零 chat 侧留痕的直觉）
  const clearPendingMention = useCallback((dom: string): void => {
    const current = useChatStore.getState().pendingMentions
    const idx = current.findIndex(m => m.match(/dom="([^"]*)"/)?.[1] === dom)
    if (idx !== -1) removePendingMention(idx)
  }, [removePendingMention])

  // content 重置时，清 tweak 状态（换了个 artifact）
  useEffect(() => {
    setTweakAvailable(false)
    setTweakActive(false)
    setCommentActive(false)
    setDcMeta(null)
    setDcOverrides({})
    dcOverridesRef.current = {}
    setDcPanelOpen(false)
    dcPanelUserClosedRef.current = false
    setCanvasMode(false)
    setCanvasZoom(null)
    zoomModeRef.current = 'auto'
    setCommentAnchor(null)
    setElementPanelOpen(false)
    setBubbleInput('')
    hasLivePreviewRef.current = false
  }, [content.length > 0 ? content.slice(0, 50) : ''])  // 粗略：按前 50 字符判定是否换了 artifact

  // canvas 画板：容器尺寸变化（侧栏拖宽/窗口变化）时自动重新适配（仅 auto 模式）——
  // 解决"每次都要手动调整"：画板宽 ~2800px+，侧栏默认 480px，不缩放只能看到左上角
  useEffect(() => {
    if (!canvasMode) return
    const el = wrapperRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (zoomModeRef.current !== 'auto') return
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        // debounce 期间用户可能已手动缩放——发射前再查一次，别用延迟的 fit 覆盖手动值
        if (zoomModeRef.current !== 'auto') return
        iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'dc:fit' }, '*')
      }, 150)
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (t) clearTimeout(t) }
  }, [canvasMode])

  // 流式模式：真·免重载（兑现"外壳隔离热更新"架构）。
  // - <x-dc> 一旦出现：整页建壳**一次**（内联运行时+当前模板快照），此后每个增量只把
  //   模板文本经 postMessage 泵给 support.js 官方 __dcUpdate（kind='template'，streaming=true）
  //   ——运行时原生热更新，零文档重建，零闪烁；逻辑类/完整编译由流式结束后的整页终稿接管。
  // - <x-dc> 尚未到达（前几 KB 头部）：600ms 节流照片模式，内容小无感。
  // - 换流检测（门闩拒绝后重试）：头部指纹变了 → 重建外壳。
  const shellRef = useRef<{ head: string; bridge: string; loaded: boolean }>({ head: '', bridge: '', loaded: false })
  const streamThrottleAtRef = useRef(0)
  const streamTrailingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWrittenRef = useRef('')
  // 本流已预载过的运行时兄弟件 key（每流每 key 只送一次；新流/换壳时重置）
  const preloadSentRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!streaming) {
      // 流式结束 → 复位外壳与节流状态，终稿由 docHtml 整页接管（带完整逻辑类）
      shellRef.current = { head: '', bridge: '', loaded: false }
      lastWrittenRef.current = ''
      streamThrottleAtRef.current = 0
      preloadSentRef.current = new Set()
      return
    }
    if (!content) return
    const buildFullDoc = (raw: string): string => {
      // 截掉未闭合的 <script>（逻辑类流入中）——半截 JS 会被浏览器抛 SyntaxError 弹红条。
      // 用大小写不敏的 regex 定位最后一个 <script，避免对整段（180KB 级）做 toLowerCase 拷贝。
      let src = raw
      let lastOpen = -1
      const openRe = /<script/gi
      let om: RegExpExecArray | null
      while ((om = openRe.exec(src)) !== null) lastOpen = om.index
      if (lastOpen !== -1) {
        const closeRe = /<\/script/gi
        closeRe.lastIndex = lastOpen
        if (!closeRe.test(src)) src = src.slice(0, lastOpen)
      }
      return assembleDocSync(truncateUnclosedInterp(src), bridgeScript)
    }
    // 前沿/后沿节流：距上次写入 >= interval 立即跑，否则补一个尾随定时器
    const schedule = (fn: () => void, interval: number): (() => void) | undefined => {
      const since = Date.now() - streamThrottleAtRef.current
      if (since >= interval) { fn(); return }
      if (streamTrailingRef.current) clearTimeout(streamTrailingRef.current)
      streamTrailingRef.current = setTimeout(fn, interval - since)
      return () => { if (streamTrailingRef.current) clearTimeout(streamTrailingRef.current) }
    }
    const head = content.slice(0, 160)

    // dc 模板容器已在场：外壳一次 + 模板泵
    if (isDc) {
      if (!shellRef.current.loaded || shellRef.current.head !== head || shellRef.current.bridge !== bridgeScript) {
        recordStreamDebug('shell', content, content)
        const html = buildFullDoc(content)
        lastWrittenRef.current = html
        if (iframeRef.current) iframeRef.current.srcdoc = html
        shellRef.current = { head, bridge: bridgeScript, loaded: true }
        streamThrottleAtRef.current = Date.now()
        // 建壳这一刻已流到的引用，assembleDocSync→inlineDcSiblings 已经内联进文档了：
        // 记成"已送"，别再经预载通道把同一份源码重放一遍。
        preloadSentRef.current = new Set(scanKnownSiblingPreloads(content).map((p) => p.key))
        return
      }
      const pump = (): void => {
        streamThrottleAtRef.current = Date.now()
        // 取 <x-dc ...> 与首个 </x-dc>（或结尾）之间的模板文本——定位后 slice，避免惰性 [\s\S]*? 逐字符回溯
        const src = contentRef.current
        const om = /<x-dc[^>]*>/i.exec(src)
        let template = ''
        if (om) {
          const innerStart = om.index + om[0].length
          const closeRe = /<\/x-dc>/gi
          closeRe.lastIndex = innerStart
          const cm = closeRe.exec(src)
          template = src.slice(innerStart, cm ? cm.index : undefined)
        }
        recordStreamDebug('pump', template, contentRef.current)
        iframeRef.current?.contentWindow?.postMessage(
          { __openpipal: true, type: 'dc:stream-template', template: truncateUnclosedInterp(template), streaming: true }, '*'
        )
        // 流式预载：累积文本里刚刚出现完整引用的运行时预制件，当场把源码送进活文档。
        // 不这么做的话，x-import 行晚于建壳帧的产物（deck 几乎必然如此——前面隔着整段 helmet）
        // 会一路只有占位骨架，直到生成结束终稿重建才"大爆炸"式出现。
        // 全部 key 送完即彻底停止扫描（早退，别每帧白跑正则）。
        if (preloadSentRef.current.size < KNOWN_SIBLING_COUNT) {
          for (const p of scanKnownSiblingPreloads(src, preloadSentRef.current)) {
            preloadSentRef.current.add(p.key)
            iframeRef.current?.contentWindow?.postMessage(
              { __openpipal: true, type: 'dc:preload', key: p.key, code: p.code }, '*'
            )
          }
        }
        // canvas 画板流入中：新 frame 到达会加宽画板，auto 模式下顺手重 fit（在 iframe 内测量，廉价）
        if (canvasModeRef.current && zoomModeRef.current === 'auto') {
          iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'dc:fit' }, '*')
        }
      }
      return schedule(pump, 200)
    }

    // 非 dc / 模板未到：节流照片模式（600ms + 未变跳过）
    const write = (): void => {
      streamThrottleAtRef.current = Date.now()
      // 操作画布期间不整页重写（srcdoc 重载会打断滚动/交互）；闲下来后由后续增量/终稿追上
      // （lastWrittenRef 差异比对保证不漏帧；终稿另走 docHtml 路径的同款门闩）
      if (isCanvasBusy()) { setReloadPending(true); return }
      setReloadPending(false)
      recordStreamDebug('write', contentRef.current, contentRef.current)
      const html = buildFullDoc(contentRef.current)
      if (html === lastWrittenRef.current) return
      lastWrittenRef.current = html
      if (iframeRef.current) iframeRef.current.srcdoc = html
      // 非 dc 没有 __dc_booted 信号：内容量过阈值即认为有东西可看，撤占位
      if (contentRef.current.length > 800) setStreamFirstPaint(true)
    }
    return schedule(write, 600)
  }, [content, streaming, isDc, isCanvasBusy, bridgeScript])

  // 流式首帧占位的生命周期：新一轮流式开始时复位；5s 兜底必消失（占位绝不能变成第二种白屏）
  useEffect(() => {
    if (!streaming) return
    setStreamFirstPaint(false)
    const t = window.setTimeout(() => setStreamFirstPaint(true), 5000)
    return () => window.clearTimeout(t)
  }, [streaming])

  // 父侧：监听 iframe 发来的 complete 请求，转发到 main 进程，把结果 postMessage 回去
  useEffect(() => {
    const onMsg = async (e: MessageEvent): Promise<void> => {
      const d = e.data
      if (!d) return
      const iframe = iframeRef.current
      if (!iframe || e.source !== iframe.contentWindow) return  // 只接受自己 iframe 的消息

      // __dc_design_mode —— support.js 上报画板模式（无 __openpipal 标记）。canvas = Directions
      // 方案确认画板（固定像素 frame 并排，总宽 ~2800px+）：首次收到即自动 fit-to-width
      if (d.type === '__dc_design_mode') {
        const isCanvas = d.mode === 'canvas'
        setCanvasMode(isCanvas)
        if (isCanvas) {
          if (zoomModeRef.current === 'auto') {
            iframe.contentWindow?.postMessage({ __openpipal: true, type: 'dc:fit' }, '*')
          } else if (canvasZoomRef.current) {
            // iframe 重载（流式终稿接管/内容修订）后新文档 zoom 归 1，但 CSS zoom 不跨文档——
            // manual 模式下把用户的手动值重新应用，否则工具条显示 80% 实际却是 100%
            iframe.contentWindow?.postMessage({ __openpipal: true, type: 'dc:set-zoom', zoom: canvasZoomRef.current }, '*')
          }
        }
        return
      }

      // __dc_booted —— support.js 运行时原生上报（无 __openpipal 标记）：propsMeta 驱动参数面板
      if (d.type === '__dc_booted') {
        setStreamFirstPaint(true) // dc 运行时起来了 → 撤下流式首帧占位
        const bootedMeta = editableDcProps(d.propsMeta)
        setDcMeta(bootedMeta)
        // 有可调参数 → Tweaks 停靠条默认展开（用户本产物内手动收起过则尊重收起）
        if (bootedMeta && Object.keys(bootedMeta).length > 0 && !dcPanelUserClosedRef.current) {
          setDcPanelOpen(true)
        }
        // 重放持久化的 overrides（重开会话 / iframe 重载后恢复用户调整）
        const persisted = readDcPropOverrides(contentRef.current)
        if (persisted) {
          dcOverridesRef.current = persisted
          setDcOverrides(persisted)
          iframe.contentWindow?.postMessage({ __openpipal: true, type: 'dc:set-props', overrides: persisted }, '*')
        }
        return
      }

      if (d.__openpipal !== true) return

      // ui:interact —— iframe 内滚动/拖拽等交互的节流上报（Reload 门闩信号）
      if (d.type === 'ui:interact') {
        lastInteractAtRef.current = Date.now()
        return
      }

      // comment:stroke —— 圈画落笔：挂起评论气泡。stroke 锚点无 DOM 语义——不进 pendingMentions、
      // 不开微调面板；评论提交走 submitStrokeComment（截图 + pendingAnnotations）。
      // 气泡开着继续画 = 同一条评论的第二笔（笔迹累积，输入文字保留）
      if (d.type === 'comment:stroke') {
        hasLivePreviewRef.current = false
        setElementPanelOpen(false)
        const prev = commentAnchorRef.current
        if (prev?.kind === 'stroke') {
          strokeCountRef.current += 1
        } else {
          strokeCountRef.current = 1
          setBubbleInput('')
        }
        setCommentAnchor({
          kind: 'stroke',
          ref: typeof d.ref === 'string' ? d.ref : 'st',
          dom: '',
          tagName: '',
          rect: d.rect || { x: 0, y: 0, w: 0, h: 0 },
          initialFields: EMPTY_TWEAK_FIELDS,
          outerHead: ''
        })
        return
      }

      // sidecar:write —— image-slot 等官方组件的 *.state.json 落盘请求;守卫在主进程模块内,
      // 这里只转发并回真实回执(组件靠该 Promise 串行化写序,不能提前 resolve)
      if (d.type === 'sidecar:write') {
        const requestId = d.requestId
        void (async () => {
          let ok = false
          try {
            ok = !!(await (window as any).api?.writeArtifactSidecar?.(conversationIdRef.current, d.name, d.content))
          } catch { /* 落盘失败按 ok:false 回执,组件侧自行重试/放弃 */ }
          iframe.contentWindow?.postMessage({ __openpipal: true, type: 'sidecar:written', requestId, ok }, '*')
        })()
        return
      }

      // complete:request —— 已有逻辑
      if (d.type === 'complete:request') {
        const api = (window as any).api
        const fn = api?.completeInArtifact
        if (typeof fn !== 'function') {
          iframe.contentWindow?.postMessage(
            { __openpipal: true, type: 'complete:response', requestId: d.requestId, ok: false, error: 'API not available' },
            '*'
          )
          return
        }
        try {
          const result = await fn(d.prompt, d.systemPrompt)
          iframe.contentWindow?.postMessage(
            { __openpipal: true, type: 'complete:response', requestId: d.requestId, ok: !!result?.ok, content: result?.content, error: result?.error },
            '*'
          )
        } catch (err: any) {
          iframe.contentWindow?.postMessage(
            { __openpipal: true, type: 'complete:response', requestId: d.requestId, ok: false, error: err?.message || 'bridge error' },
            '*'
          )
        }
        return
      }

      // tweak:available —— artifact 声明了可调参，激活按钮
      if (d.type === 'tweak:available') {
        setTweakAvailable(true)
        return
      }

      // dc:zoom-applied —— iframe 内应用缩放后的回报（显示百分比）
      if (d.type === 'dc:zoom-applied') {
        setCanvasZoom(typeof d.zoom === 'number' ? d.zoom : null)
        return
      }

      // comment:rect-changed —— live 预览（字号/边距等）改变了元素几何，注入侧重测后上报；
      // 更新 commentAnchor.rect 让气泡/面板跟着重新定位（bubblePos 的 effect 依赖 commentAnchor）
      if (d.type === 'comment:rect-changed') {
        setCommentAnchor((prev) => (prev && prev.dom === d.dom && d.rect ? { ...prev, rect: d.rect } : prev))
        return
      }

      // edl:changed —— 播放条上的剪辑（倍速 / 删除段）写回产物内容本身，
      // 这样重载、逐帧导出、隐藏窗口自检看到的都是同一份剪辑（iframe 里存不住：origin 是 null）
      if (d.type === 'edl:changed' && onContentEdit) {
        const next = writeDcEdl(contentRef.current, Array.isArray(d.edl) ? d.edl : null)
        if (next !== contentRef.current) {
          contentRef.current = next
          selfEditRef.current = next // 自己写的回声不该重载 srcDoc——iframe 里已经是这个状态了
          onContentEdit(next)
        }
        return
      }

      // tweak:set-keys —— 把 edits merge 进 TWEAKS 块，回写
      if (d.type === 'tweak:set-keys' && d.edits && onContentEdit) {
        const next = mergeTweakEdits(contentRef.current, d.edits)
        if (next !== contentRef.current) {
          contentRef.current = next
          onContentEdit(next)
        }
        return
      }

      // comment:clicked —— 把选中元素信息塞到输入框作为 pending mention，同时（P1）在宿主侧
      // 挂起悬浮气泡锚点：坐标沿用同一条消息里的 rect（iframe 内 gBCR 视觉坐标，宿主侧不在
      // zoom 子树内，直接叠加 iframe 自身在宿主里的偏移即可，无需再除以 zoom）
      if (d.type === 'comment:clicked') {
        const ref = d.ref || 'cc'
        const dom = d.dom || ''
        const text = d.text || ''
        const snippet = `<mentioned-element ref="${ref}" dom="${dom}">${text}</mentioned-element>`
        addPendingMention(snippet)

        // 切换到新元素前：若旧锚点还有未确认的 live 预览，宿主侧兜底发 revert 还原旧 dom
        // （双保险之一——注入侧 _onCommentClick 自身也有等效自检；这里参照 closeCommentAnchor
        // 既有的回滚模式，防止注入侧自检因未来改动失效时残留内联样式）
        const prevAnchor = commentAnchorRef.current
        if (prevAnchor && hasLivePreviewRef.current) {
          iframe.contentWindow?.postMessage({ __openpipal: true, type: 'tweak:revert', dom: prevAnchor.dom }, '*')
        }

        const computed = d.computed || {}
        const initialFields: TweakFields = {
          text: typeof d.fullText === 'string' ? d.fullText : text,
          color: rgbToHex(computed.color || ''),
          backgroundColor: rgbToHex(computed.backgroundColor || ''),
          opacity: computed.opacity != null ? String(computed.opacity) : '1',
          fontFamily: computed.fontFamily || '',
          fontSize: stripPx(computed.fontSize || ''),
          fontWeight: normalizeFontWeight(computed.fontWeight || ''),
          borderRadius: stripPx(computed.borderRadius || ''),
          borderColor: rgbToHex(computed.borderColor || ''),
          borderWidth: computed.borderWidth || '0px',
          width: stripPx(computed.width || ''),
          height: stripPx(computed.height || ''),
          paddingTop: stripPx(computed.paddingTop || ''),
          paddingRight: stripPx(computed.paddingRight || ''),
          paddingBottom: stripPx(computed.paddingBottom || ''),
          paddingLeft: stripPx(computed.paddingLeft || ''),
          marginTop: stripPx(computed.marginTop || ''),
          marginRight: stripPx(computed.marginRight || ''),
          marginBottom: stripPx(computed.marginBottom || ''),
          marginLeft: stripPx(computed.marginLeft || '')
        }
        hasLivePreviewRef.current = false
        setElementPanelOpen(false)
        setBubbleInput('')
        setCommentAnchor({
          kind: 'element',
          ref,
          dom,
          tagName: d.tagName || '',
          rect: d.rect || { x: 0, y: 0, w: 0, h: 0 },
          initialFields,
          outerHead: typeof d.outerHead === 'string' ? d.outerHead : ''
        })
        return
      }

    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onContentEdit, addPendingMention, upsertPendingMention, flashEditToast])

  // 气泡定位：iframe 元素自身的 gBCR 相对 wrapperRef 的偏移 + comment:clicked 携带的 rect
  // （rect 已是 iframe 视口内的视觉像素坐标——host 不在 iframe 内部的 zoom 子树里，直接叠加
  // 偏移即可，无需再除以 zoom；zoom 补偿只在 iframe 内部给同样处于 zoom 子树下的元素做）。
  // 默认放元素下方——iframe 内注入的 "✎ 改文字" 按钮固定悬浮在元素上方(rect.top-22)，
  // 宿主气泡若也抢占上方会在视觉上重叠、盖住 ✎ 按钮吞掉它的点击；下方放不下才退回上方。
  // 超出容器边界 clamp。
  useEffect(() => {
    if (!commentAnchor) { setBubblePos(null); return }
    const recompute = (): void => {
      const iframe = iframeRef.current
      const wrapper = wrapperRef.current
      if (!iframe || !wrapper) return
      const iframeRectHost = iframe.getBoundingClientRect()
      const wrapperRectHost = wrapper.getBoundingClientRect()
      const BUBBLE_H = 30
      if (wrapperRectHost.width <= 8 || wrapperRectHost.height <= BUBBLE_H + 8) {
        setBubblePos(null)
        return
      }
      const offsetX = iframeRectHost.left - wrapperRectHost.left
      const offsetY = iframeRectHost.top - wrapperRectHost.top
      const targetWidth = commentAnchor.kind === 'stroke' ? 400 : 244
      const bubbleWidth = Math.min(targetWidth, wrapperRectHost.width - 8)
      // 圈画气泡不跟笔迹跑——固定停靠画布底部居中（用户靠位置习惯找输入框，不该满画布找气泡）
      if (commentAnchor.kind === 'stroke') {
        setBubblePos({
          top: Math.max(4, wrapperRectHost.height - BUBBLE_H - 12),
          left: Math.max(4, (wrapperRectHost.width - bubbleWidth) / 2),
          width: bubbleWidth,
        })
        return
      }
      let left = offsetX + commentAnchor.rect.x
      let top = offsetY + commentAnchor.rect.y + commentAnchor.rect.h + 6 // 默认下方，避让 ✎ 按钮
      const maxTop = wrapperRectHost.height - BUBBLE_H - 4
      if (top > maxTop) top = offsetY + commentAnchor.rect.y - BUBBLE_H - 6 // 下方放不下 → 退回上方
      const maxLeft = wrapperRectHost.width - bubbleWidth - 4
      left = Math.min(Math.max(4, left), Math.max(4, maxLeft))
      top = Math.min(Math.max(4, top), Math.max(4, maxTop))
      setBubblePos({ top, left, width: bubbleWidth })
    }
    recompute()
    window.addEventListener('resize', recompute)
    const wrapper = wrapperRef.current
    const ro = wrapper ? new ResizeObserver(recompute) : null
    if (wrapper && ro) ro.observe(wrapper)
    return () => {
      window.removeEventListener('resize', recompute)
      ro?.disconnect()
    }
  }, [commentAnchor])

  // P1 面板垂直空间自适应：气泡下方放不下面板最小可用高度(约 260px:段头+2-3 行字段+底栏)时，
  // 翻转到锚点(元素本身，非气泡)上方；无论上下，面板整体 max-height 都收着"容器实际剩余空间"
  // (封顶 60vh)——内部内容区滚动吸收收缩，底栏(取消/✓)固定在 flex 尾部恒可见（ElementTweakPanel
  // 侧配合）。依赖 bubblePos 是关键：comment:rect-changed 更新 commentAnchor.rect → bubblePos
  // 重算 → 本 effect 跟着重算，天然覆盖"跟随机制"（要求 3）；resize 另挂监听（要求 4）。
  useEffect(() => {
    if (!commentAnchor || !elementPanelOpen || !bubblePos) { setPanelPos(null); return }
    const recompute = (): void => {
      const iframe = iframeRef.current
      const wrapper = wrapperRef.current
      if (!iframe || !wrapper) return
      const iframeRectHost = iframe.getBoundingClientRect()
      const wrapperRectHost = wrapper.getBoundingClientRect()
      const offsetY = iframeRectHost.top - wrapperRectHost.top
      const wrapperH = wrapperRectHost.height
      const wrapperW = wrapperRectHost.width
      const PANEL_GAP = 6 // 翻转后面板底与锚点顶的间距
      const MARGIN = 8
      if (wrapperW <= MARGIN * 2 || wrapperH <= MARGIN * 2) {
        setPanelPos(null)
        return
      }
      const panelWidth = Math.min(340, wrapperW - (MARGIN * 2))
      const MIN_PANEL_H = 260 // 面板最小可用高度：段头+2-3 行字段+底栏

      const belowTop = bubblePos.top + 34 // 沿用气泡下方既有偏移（气泡高度+间距），即"气泡底"
      const anchorTop = offsetY + commentAnchor.rect.y // 锚点(元素)本身的顶——翻转时对齐到它上方
      const spaceBelow = wrapperH - belowTop - MARGIN
      const spaceAbove = anchorTop - PANEL_GAP - MARGIN
      const flipped = spaceBelow < MIN_PANEL_H && spaceAbove > spaceBelow
      const available = flipped ? spaceAbove : spaceBelow
      const maxHeight = Math.max(120, Math.min(window.innerHeight * 0.6, available))

      const maxLeft = wrapperW - panelWidth - MARGIN
      const left = Math.min(Math.max(MARGIN, bubblePos.left), Math.max(MARGIN, maxLeft))

      setPanelPos(
        flipped
          ? { left, bottom: wrapperH - anchorTop + PANEL_GAP, width: panelWidth, maxHeight, flipped: true }
          : { left, top: belowTop, width: panelWidth, maxHeight, flipped: false }
      )
    }
    recompute()
    window.addEventListener('resize', recompute)
    const wrapper = wrapperRef.current
    const ro = wrapper ? new ResizeObserver(recompute) : null
    if (wrapper && ro) ro.observe(wrapper)
    return () => {
      window.removeEventListener('resize', recompute)
      if (ro) ro.disconnect()
    }
  }, [commentAnchor, elementPanelOpen, bubblePos])

  // 关闭气泡/面板：若面板打开期间发过 live 预览且未经 Confirm，先还原 iframe 内联样式再关闭
  // （Esc / 点气泡外宿主区域 走这条；Confirm 走各自分支——故意保留预览态在 DOM 上）
  const closeCommentAnchor = useCallback((): void => {
    if (commentAnchor?.kind === 'stroke') {
      // 取消圈画（取消按钮/Esc/点外部）：本组笔迹全部清除
      strokeCountRef.current = 0
      iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'comment:stroke-remove' }, '*')
    }
    if (elementPanelOpen && hasLivePreviewRef.current && commentAnchor) {
      iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'tweak:revert', dom: commentAnchor.dom }, '*')
    }
    hasLivePreviewRef.current = false
    setElementPanelOpen(false)
    setCommentAnchor(null)
    setBubbleInput('')
  }, [elementPanelOpen, commentAnchor])

  // Esc 关闭 / 点气泡与面板之外的宿主区域关闭——iframe 内部的点击走 postMessage 通道
  // (sandbox 无 allow-same-origin，不会以 DOM 事件冒泡到宿主 document)，天然不会误触发本监听
  useEffect(() => {
    if (!commentAnchor) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeCommentAnchor()
    }
    const onDocMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (bubbleRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      closeCommentAnchor()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDocMouseDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDocMouseDown, true)
    }
  }, [commentAnchor, closeCommentAnchor])

  // 面板任意字段变化 → 全量当前字段 postMessage 给 iframe 做 live 预览（首次预览前 iframe 侧自动快照原样）
  // 只发生变化的属性才下发——不能无脑全量下发：无背景色的元素其"背景色"初值是
  // rgbToHex(transparent) 归一化出来的 #000000 兜底显示值，若照单全下发会把从未设置过
  // 背景的元素强行刷成黑底，与用户实际只改了文字颜色的意图完全不符。
  const handleTweakLivePreview = (fields: TweakFields): void => {
    if (!commentAnchor) return
    hasLivePreviewRef.current = true
    const initial = commentAnchor.initialFields
    const { style } = computeTweakStyleDiff(fields, initial)
    const textChanged = fields.text !== initial.text
    iframeRef.current?.contentWindow?.postMessage(
      { __openpipal: true, type: 'tweak:preview', dom: commentAnchor.dom, style, text: textChanged ? fields.text : undefined },
      '*'
    )
  }

  // 取消：还原 live 预览 + 只关面板（气泡本身保留，允许继续对同一元素操作）
  const handleTweakCancel = (): void => {
    if (commentAnchor) {
      iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'tweak:revert', dom: commentAnchor.dom }, '*')
    }
    hasLivePreviewRef.current = false
    setElementPanelOpen(false)
  }

  // 确认：确定性归代码，判断力归模型——文本与样式独立各走各自的确定性阶梯，命中就直写落盘；
  // 任何一边定位失败（.dc.html 模板插值/歧义等）才降级成精确 change-spec 交给 AI 兜底，合并进
  // 同一条 mention（同一 dom 只留一条，见 upsertPendingMention）。两者都变时串行应用在同一份
  // contentRef 上（先文本后样式）——样式定位在文本落盘之后重新扫描，天然吃到文本改动后的最新源码。
  // live 预览留在 DOM 上作为临时态，不发 revert（下次真实重渲染自然消失）。
  const handleTweakConfirm = (fields: TweakFields, description: string): void => {
    if (!commentAnchor) return
    const initial = commentAnchor.initialFields
    const textChanged = fields.text !== initial.text
    const { style, diffs } = computeTweakStyleDiff(fields, initial)
    const styleChanged = diffs.length > 0

    const instructionLines: string[] = []
    let textDirectWritten = false
    let styleDirectWritten = false

    if (textChanged) {
      const result = ladderTextReplace(contentRef.current, initial.text, fields.text, '', '', commentAnchor.dom)
      if (result.kind === 'direct' && onContentEdit) {
        contentRef.current = result.next
        textDirectWritten = true
      } else if (result.kind === 'mention') {
        instructionLines.push(`请把该元素文本改为：「${fields.text}」`)
      }
    }

    if (styleChanged) {
      // 阶梯 (c) 文本回溯要用"此刻源码里实际存在的文本"——若文本已在上面直写落盘，源码里的旧文本
      // 已被替换成新文本，回溯基线必须跟着换成新文本，否则会在明明刚成功过的路径上假性定位失败
      const textForLocate = textDirectWritten ? fields.text : initial.text
      const located = onContentEdit
        ? locateElementInSource(contentRef.current, {
            tagName: commentAnchor.tagName,
            outerHead: commentAnchor.outerHead,
            text: textForLocate
          })
        : null
      if (located) {
        const cssStyle: Record<string, string> = {}
        for (const [k, v] of Object.entries(style)) cssStyle[styleKeyToCssProp(k)] = v
        const next = mergeStyleIntoTag(contentRef.current, located.tagStart, located.tagEnd, cssStyle)
        if (next !== contentRef.current) {
          contentRef.current = next
          styleDirectWritten = true
        }
      }
      if (!styleDirectWritten) {
        instructionLines.push(`请把该元素样式调整为: ${diffs.join('; ')}`)
      }
    }

    // 文本+样式同一次 commit 都直写时只在这里落一次盘——分两次调用 onContentEdit 会触发两次
    // 异步保存(handleTweakEdit→saveArtifact IPC)，无法保证后发先至，可能被旧的文本单独态覆盖新的
    // 合并态。selfEditRef 同步记录这次自己写回的内容，content prop 回声时跳过 srcDoc 重载
    // （参照 applyDcOverride 的 dc props 持久化套路）。
    if ((textDirectWritten || styleDirectWritten) && onContentEdit) {
      selfEditRef.current = contentRef.current
      onContentEdit(contentRef.current)
    }

    if (instructionLines.length > 0) {
      const textSummary = (initial.text || '').slice(0, 40)
      const descSuffix = description.trim() ? `\n${description.trim()}` : ''
      const snippet = `<mentioned-element ref="${commentAnchor.ref}" dom="${commentAnchor.dom}" tag="${commentAnchor.tagName}">${textSummary}</mentioned-element>\n${instructionLines.join('\n')}${descSuffix}`
      upsertPendingMention(commentAnchor.dom, snippet)
      flashEditToast(styleChanged && !styleDirectWritten ? t('artifacts.canvas.feedback.styleQueued') : t('artifacts.canvas.feedback.sourceFallback'))
    } else if (styleDirectWritten || textDirectWritten) {
      // 全部确定性直写、零 AI 介入——清掉点选时留下的"元素引用"chip，不留痕
      clearPendingMention(commentAnchor.dom)
      flashEditToast(styleDirectWritten ? t('artifacts.canvas.feedback.styleSaved') : t('artifacts.canvas.feedback.changesSaved'))
    }

    // 确认 = 新基线：live 预览留在 DOM 上，通知注入侧清掉快照条目——否则下次切换元素时，
    // 注入侧的自检会把"已确认"误当"未确认的预览"而回滚掉刚确认的改动（见 Task A/B）
    if (hasLivePreviewRef.current) {
      iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'tweak:commit', dom: commentAnchor.dom }, '*')
    }

    hasLivePreviewRef.current = false
    setElementPanelOpen(false)
  }

  // 气泡「添加评论…」输入的麦克风听写：转写结果 append 到已有文本（不覆盖）
  const bubbleStt = useLocalSTT(useCallback((t: string) => {
    setBubbleInput((prev) => (prev ? `${prev} ${t}` : t))
  }, []))

  // 圈画评论提交：先等气泡卸载（别把输入气泡拍进图）→ 截画布可见区（本组全部笔迹随图入镜）
  // → 进 pendingAnnotations 待发区 → 通知 iframe 清空本组笔迹
  const submitStrokeComment = useCallback(async (ref: string, text: string): Promise<void> => {
    await new Promise((r) => setTimeout(r, 80))
    let image: string | undefined
    try {
      const r = iframeRef.current?.getBoundingClientRect()
      if (r && r.width > 4 && r.height > 4) {
        const shot = await (window as any).api?.captureRegion?.({
          x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)
        })
        if (shot?.base64) image = shot.base64
      }
    } catch { /* 截图能力缺失（浏览器模式）→ 纯文字评论 */ }
    useChatStore.getState().addPendingAnnotation({ ref, text, image })
    iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'comment:stroke-remove' }, '*')
  }, [])

  // 撤销上一笔：撤到 0 笔时关气泡（等同取消）
  const undoStroke = (): void => {
    iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'comment:stroke-undo' }, '*')
    strokeCountRef.current -= 1
    if (strokeCountRef.current <= 0) {
      strokeCountRef.current = 0
      setCommentAnchor(null)
      setBubbleInput('')
    }
  }

  // 气泡「添加评论…」Enter/发送：element 锚点 append 文本到主输入框草稿（mention 已在点选时入
  // chips）；stroke 锚点走截图+待发区，没写字也允许发（圈本身就是表达，配默认文案）
  const handleBubbleCommentSubmit = (): void => {
    const text = bubbleInput.trim()
    const anchor = commentAnchor
    if (anchor?.kind === 'stroke') {
      strokeCountRef.current = 0
      void submitStrokeComment(anchor.ref, text || '请看圈选截图里红笔圈出的部位')
    } else if (text) {
      appendToMainInputAndFocus(text)
    }
    setBubbleInput('')
    setCommentAnchor(null)
    setElementPanelOpen(false)
  }

  const toggleTweak = (): void => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    const next = !tweakActive
    setTweakActive(next)
    iframe.contentWindow.postMessage(
      { __openpipal: true, type: next ? 'tweak:activate' : 'tweak:deactivate' },
      '*'
    )
  }

  // dc: 单个 prop 变更 → 全量 overrides 写回运行时（setProps 是整包替换）+ debounce 持久化
  const applyDcOverride = (key: string, value: any): void => {
    lastInteractAtRef.current = Date.now() // 调参也是"正在操作画布"（Reload 门闩信号）
    const next = { ...dcOverridesRef.current, [key]: value }
    dcOverridesRef.current = next
    setDcOverrides(next)
    iframeRef.current?.contentWindow?.postMessage(
      { __openpipal: true, type: 'dc:set-props', overrides: next },
      '*'
    )
    if (dcPersistTimer.current) clearTimeout(dcPersistTimer.current)
    dcPersistTimer.current = setTimeout(() => {
      if (!onContentEdit) return
      const merged = writeDcPropOverrides(contentRef.current, dcOverridesRef.current)
      if (merged !== contentRef.current) {
        contentRef.current = merged
        selfEditRef.current = merged
        onContentEdit(merged)
      }
    }, 800)
  }

  const tweakBtnEnabled = isDc ? !!dcMeta : tweakAvailable
  const tweakBtnActive = isDc ? dcPanelOpen : tweakActive

  const toggleComment = (): void => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    const next = !commentActive
    setCommentActive(next)
    // 关闭 comment 模式：气泡/面板一并收起（iframe 侧 _disableCommentMode 会自行 revert 未确认的样式预览）
    if (!next) {
      setCommentAnchor(null)
      setElementPanelOpen(false)
      setBubbleInput('')
      hasLivePreviewRef.current = false
    }
    iframe.contentWindow.postMessage(
      { __openpipal: true, type: next ? 'comment:activate' : 'comment:deactivate' },
      '*'
    )
  }

  // canvas 画板缩放控制：适配（回 auto 模式）/ 手动 ±（转 manual，容器变化不再自动重 fit）
  const fitCanvas = (): void => {
    zoomModeRef.current = 'auto'
    lastInteractAtRef.current = Date.now()
    iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'dc:fit' }, '*')
  }
  const setManualZoom = (z: number): void => {
    zoomModeRef.current = 'manual'
    lastInteractAtRef.current = Date.now()
    iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'dc:set-zoom', zoom: z }, '*')
  }
  const nudgeZoom = (factor: number): void => {
    setManualZoom(Math.min(3, Math.max(0.1, (canvasZoom ?? 1) * factor)))
  }
  const zoomBtnCls = 'h-5 min-w-5 px-1.5 rounded flex items-center justify-center text-[11px] transition-colors text-surface-600 hover:bg-surface-100'

  // 工具组内容（Reload/Tweaks/Comment/画板缩放）——有宿主插槽（ArtifactTab 头行）就 portal
  // 上去与 分享/预览/源码 合并成一行（省一行高度）；无插槽（场景合成等其它挂载点）退回自带行
  const toolbarContent = (
    <>
          <button
            onClick={reloadNow}
            title={reloadPending ? t('artifacts.canvas.reload.pendingTitle') : t('artifacts.canvas.reload.title')}
            data-testid="preview-reload"
            className={[
              'relative h-5 w-6 rounded flex items-center justify-center transition-colors hover:bg-surface-100',
              reloadPending
                ? 'text-brand-600 dark:text-brand-400'
                : 'text-surface-400'
            ].join(' ')}
          >
            <RotateCw size={11} />
            {reloadPending && <span className="absolute top-0 right-0.5 w-1.5 h-1.5 rounded-full bg-brand-500" />}
          </button>
          <div className="w-px h-3.5 bg-surface-200 mx-0.5" />
          <button
            onClick={() => {
              if (isDc) {
                // 记住"用户主动收起"（o=当前展开态；收起后 boot 不再自动弹开）
                setDcPanelOpen((o) => { dcPanelUserClosedRef.current = o; return !o })
              } else toggleTweak()
            }}
            disabled={!tweakBtnEnabled}
            title={tweakBtnEnabled ? t('artifacts.canvas.toolbar.tweaksTitle') : t('artifacts.canvas.toolbar.tweaksUnavailable')}
            className={[
              'h-5 px-2 rounded flex items-center gap-1 text-[11px] transition-colors',
              tweakBtnActive
                ? 'bg-brand-500 text-ink-on-accent'
                : tweakBtnEnabled
                  ? 'text-surface-600 hover:bg-surface-100'
                  : 'text-surface-300 cursor-not-allowed'
            ].join(' ')}
          >
            <Sliders size={11} /> {t('artifacts.canvas.toolbar.tweaks')}
          </button>
          <button
            onClick={toggleComment}
            title={commentActive ? t('artifacts.canvas.toolbar.commentOnTitle') : t('artifacts.canvas.toolbar.commentOffTitle')}
            className={[
              'h-5 px-2 rounded flex items-center gap-1 text-[11px] transition-colors',
              commentActive
                ? 'bg-brand-500 text-ink-on-accent'
                : 'text-surface-600 hover:bg-surface-100'
            ].join(' ')}
          >
            <MessageCircle size={11} /> {t('artifacts.canvas.toolbar.comment')}
          </button>
          {canvasMode && (
            <>
              <div className="w-px h-3.5 bg-surface-200 mx-0.5" />
              <button onClick={fitCanvas} title={t('artifacts.canvas.toolbar.fitTitle')} data-testid="canvas-fit" className={zoomBtnCls}>
                {t('artifacts.canvas.toolbar.fit')}
              </button>
              <button onClick={() => nudgeZoom(0.8)} title={t('artifacts.canvas.toolbar.zoomOut')} data-testid="canvas-zoom-out" className={zoomBtnCls}>
                −
              </button>
              <button onClick={() => setManualZoom(1)} title={t('artifacts.canvas.toolbar.resetZoom')} data-testid="canvas-zoom-pct" className={zoomBtnCls}>
                {canvasZoom !== null ? `${Math.round(canvasZoom * 100)}%` : '100%'}
              </button>
              <button onClick={() => nudgeZoom(1.25)} title={t('artifacts.canvas.toolbar.zoomIn')} data-testid="canvas-zoom-in" className={zoomBtnCls}>
                +
              </button>
            </>
          )}
          {commentActive && (
            <span className="min-w-0 text-[10px] text-brand-500 dark:text-brand-400 truncate">{t('artifacts.canvas.toolbar.drawingHint')}</span>
          )}
    </>
  )

  return (
    <div ref={wrapperRef} data-testid="html-preview-wrapper" className="relative flex-1 flex flex-col min-h-0 min-w-0">
      {/* 工具组：portal 到 ArtifactTab 头行；无插槽时退回自带工具条行 */}
      {!streaming && (toolbarHost
        ? createPortal(
            <div data-testid="preview-toolbar" className="flex items-center gap-1.5 min-w-0 overflow-hidden">{toolbarContent}</div>,
            toolbarHost
          )
        : (
          <div data-testid="preview-toolbar" className="h-7 shrink-0 flex items-center gap-1.5 px-2 border-b border-surface-100 bg-surface-50/60">
            {toolbarContent}
          </div>
        ))}
      {/* dc 参数条（画布顶部停靠，有参数默认展开、Tweaks 按钮收起）*/}
      {!streaming && dcPanelOpen && dcMeta && Object.keys(dcMeta).length > 0 && (
        <DcTweaksPanel meta={dcMeta} values={dcOverrides} onChange={applyDcOverride} />
      )}
      <iframe
        ref={iframeRef}
        srcDoc={streaming ? undefined : docHtml}
        sandbox="allow-scripts allow-modals allow-downloads"
        className="w-full flex-1 bg-white border-0"
        style={{ minHeight: 0 }}
        onLoad={() => {
          // 文档重载（Reload/内容更新）后新 doc 的 comment 模式归零——宿主按钮还亮着就补一次激活，
          // 避免"按钮开着但画布点不动"的状态劈叉
          if (commentActiveRef.current) {
            iframeRef.current?.contentWindow?.postMessage({ __openpipal: true, type: 'comment:activate' }, '*')
          }
        }}
      />
      {/* 流式首帧占位：内容可画之前盖住白屏（dc 收到 __dc_booted / 非 dc 内容过阈 / 5s 兜底后淡出） */}
      <div
        className={`absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 bg-[#FAF9F5] dark:bg-surface-0 pointer-events-none transition-opacity duration-500 ${
          streaming && !streamFirstPaint ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex gap-1.5">
          {[0, 1, 2].map(i => (
            <span key={i} className="w-2 h-2 rounded-full bg-[#A8BB87] animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <span className="px-4 text-center text-[12px] text-ink-tertiary dark:text-surface-400">{t('artifacts.canvas.draft')}</span>
      </div>
      {/* P0 直改文字：轻量提示条，角落 2s 自动淡出，不引入 toast 依赖 */}
      {editToast && (
        <div className="absolute bottom-2 right-2 z-10 px-2.5 py-1 rounded text-[11px] text-white bg-surface-800/90 dark:bg-surface-200/90 shadow-lg pointer-events-none transition-opacity duration-300">
          {editToast}
        </div>
      )}
      {/* P1 元素微调：comment 点选后的悬浮气泡（⚙ 展开 + 单行「添加评论…」输入） */}
      {!streaming && commentAnchor && bubblePos && (
        <div
          ref={bubbleRef}
          data-testid="comment-bubble"
          className="absolute z-30 flex items-center gap-1 rounded-full border border-surface-200 bg-white dark:bg-surface-0 shadow-lg px-1.5 py-1"
          style={{ top: bubblePos.top, left: bubblePos.left, width: bubblePos.width }}
        >
          {commentAnchor.kind !== 'stroke' && (
            <button
              type="button"
              data-testid="comment-bubble-expand"
              onClick={() => setElementPanelOpen((o) => !o)}
              title={t('artifacts.canvas.feedback.openAdjustments')}
              className={[
                'h-5 w-5 shrink-0 rounded-full flex items-center justify-center transition-colors',
                elementPanelOpen
                  ? 'bg-brand-500 text-ink-on-accent'
                  : 'text-surface-500 hover:bg-surface-100'
              ].join(' ')}
            >
              <Settings size={12} />
            </button>
          )}
          <input
            data-testid="comment-bubble-input"
            autoFocus
            value={bubbleInput}
            onChange={(e) => setBubbleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleBubbleCommentSubmit() }
              else if (e.key === 'Escape') { e.preventDefault(); closeCommentAnchor() }
            }}
            placeholder={commentAnchor.kind === 'stroke' ? t('artifacts.canvas.feedback.strokePlaceholder') : t('artifacts.canvas.feedback.commentPlaceholder')}
            className="flex-1 min-w-0 h-5 px-1.5 text-[11px] bg-transparent outline-none text-surface-700 placeholder:text-surface-300"
          />
          <button
            type="button"
            data-testid="comment-bubble-mic"
            onClick={bubbleStt.toggle}
            title={bubbleStt.state === 'recording' ? t('artifacts.canvas.feedback.stopRecording') : bubbleStt.state === 'transcribing' ? t('artifacts.canvas.feedback.transcribing') : t('artifacts.canvas.feedback.voiceInput')}
            className={[
              'h-5 w-5 shrink-0 rounded-full flex items-center justify-center transition-colors',
              bubbleStt.state === 'recording'
                ? 'bg-red-500 text-white animate-pulse'
                : 'text-surface-500 hover:bg-surface-100'
            ].join(' ')}
          >
            <Mic size={11} />
          </button>
          {commentAnchor.kind === 'stroke' && (
            <>
              <button
                type="button"
                data-testid="stroke-undo"
                onClick={undoStroke}
                title={t('artifacts.canvas.feedback.undoStroke')}
                className="h-5 px-1.5 shrink-0 rounded-full text-[11px] text-surface-500 hover:bg-surface-100 transition-colors"
              >
                {t('artifacts.canvas.feedback.undo')}
              </button>
              <button
                type="button"
                data-testid="stroke-cancel"
                onClick={closeCommentAnchor}
                title={t('artifacts.canvas.feedback.cancelDrawing')}
                className="h-5 px-1.5 shrink-0 rounded-full text-[11px] text-surface-500 hover:bg-surface-100 transition-colors"
              >
                {t('artifacts.canvas.feedback.cancel')}
              </button>
              <button
                type="button"
                data-testid="stroke-send"
                onClick={handleBubbleCommentSubmit}
                title={t('artifacts.canvas.feedback.sendWithScreenshot')}
                className="h-5 px-2 shrink-0 rounded-full text-[11px] bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors"
              >
                {t('artifacts.canvas.feedback.send')}
              </button>
            </>
          )}
        </div>
      )}
      {/* P1 元素微调面板：⚙ 展开后出现，默认锚定在气泡下方；容器剩余空间不足时翻转到锚点上方
          (panelPos.bottom 而非 top)，并把算好的 maxHeight 传给面板做整体高度收缩 */}
      {!streaming && commentAnchor && elementPanelOpen && panelPos && (
        <div
          ref={panelRef}
          data-testid="element-tweak-panel-wrap"
          className="absolute z-30"
          style={{
            left: panelPos.left,
            width: panelPos.width,
            ...(panelPos.top !== undefined ? { top: panelPos.top } : {}),
            ...(panelPos.bottom !== undefined ? { bottom: panelPos.bottom } : {})
          }}
        >
          <ElementTweakPanel
            tagName={commentAnchor.tagName}
            initial={commentAnchor.initialFields}
            maxHeight={panelPos.maxHeight}
            onLivePreview={handleTweakLivePreview}
            onCancel={handleTweakCancel}
            onConfirm={handleTweakConfirm}
          />
        </div>
      )}
    </div>
  )
}
