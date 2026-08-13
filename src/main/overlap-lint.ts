/**
 * dc 画板文本重叠检测（弱模型排版常见问题：导航行/标签互相堆叠）。
 * 零依赖：只导出一段注入被渲染页面执行的 JS 字符串,供 pi-tools 隐藏窗口自检、
 * e2e 直接在 playwright 页面里 evaluate 复用。
 */

/** 注入被渲染页面执行的文本重叠检测脚本：返回 string[]（每条一个重叠描述，最多 5 条）。 */
export const OVERLAP_LINT_JS = `(function(){
  var MAX_NODES = 300;
  var MAX_HITS = 5;

  function isVisible(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var op = parseFloat(cs.opacity);
    // 动画转场 crossfade 的中间态元素排除,否则动画稿全是假阳
    if (!isNaN(op) && op < 0.95) return false;
    return true;
  }

  function hasOwnText(el) {
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 0) return true;
    }
    return false;
  }

  function isOpaqueBg(cs) {
    var bg = cs.backgroundColor || '';
    var m = bg.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return false;
    var parts = m[1].split(',').map(function (s) { return parseFloat(s); });
    var alpha = parts.length > 3 ? parts[3] : 1;
    return alpha > 0.9;
  }

  function isAncestor(a, b) {
    return a === b || a.contains(b) || b.contains(a);
  }

  var all = document.body ? document.body.querySelectorAll('*') : [];
  var nodes = [];
  for (var i = 0; i < all.length && nodes.length < MAX_NODES; i++) {
    var el = all[i];
    if (!hasOwnText(el)) continue;
    var cs = window.getComputedStyle(el);
    if (!isVisible(el, cs)) continue;
    if (parseFloat(cs.fontSize) < 10) continue;
    var rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    nodes.push({ el: el, rect: rect, cs: cs });
  }

  function ownText(el) {
    var kids = el.childNodes, out = '';
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return out.trim();
  }

  var hits = [];
  for (var a = 0; a < nodes.length && hits.length < MAX_HITS; a++) {
    for (var b = a + 1; b < nodes.length && hits.length < MAX_HITS; b++) {
      var A = nodes[a], B = nodes[b];
      if (isAncestor(A.el, B.el)) continue;
      var ra = A.rect, rb = B.rect;
      var ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      var iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      var interArea = ix * iy;
      if (interArea <= 0) continue;
      var areaA = ra.width * ra.height;
      var areaB = rb.width * rb.height;
      var minArea = Math.min(areaA, areaB);
      if (minArea <= 0 || interArea < minArea * 0.25) continue;
      // 不透明徽章/chip 故意压在卡片上是合法设计
      if (isOpaqueBg(A.cs) || isOpaqueBg(B.cs)) continue;
      var pct = Math.round((interArea / minArea) * 100);
      var ta = ownText(A.el).slice(0, 20);
      var tb = ownText(B.el).slice(0, 20);
      hits.push('文本重叠: "' + ta + '" × "' + tb + '" (重叠 ' + pct + '%)');
    }
  }
  return hits;
})()`
