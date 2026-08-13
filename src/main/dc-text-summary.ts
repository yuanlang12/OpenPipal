/**
 * dc 页面文本摘要提取（弱模型截图核对链路全断的核心兜底）。
 * "渲染干净"只代表无 console 错误，不代表品牌名/文案/数据符合要求——弱模型看不到
 * 截图（photon resize 在主进程恒断 + 纯文本模型图片进不了上下文），只能靠文本核对。
 *
 * 零依赖：只导出一段注入被渲染页面执行的 JS 字符串，供 pi-tools 隐藏窗口自检、
 * e2e 直接在 playwright 页面里 evaluate 复用（同 overlap-lint.ts 的做法）。
 */

/**
 * 注入被渲染页面执行的文本摘要脚本：返回 { frames: Array<{ label: string | null; text: string }> }。
 * - 有 [data-screen-label] 结构（canvas 多方向 / deck 多页）→ 按 frame 分组，一个 frame 一条。
 * - 否则 → 单条，label 为 null（调用方按 body 兜底截取更长的正文）。
 * 范围锁定 #dc-root（support.js 渲染挂载点）：原始 <x-dc> 源码仍留在 DOM 里（只是被
 * `x-dc{display:none!important}` 隐藏），不锁定范围会连隐藏的原始拷贝也一起选中，
 * 造成重复 frame / 重复正文。
 */
export const PAGE_TEXT_SUMMARY_JS = `(function(){
  var MAX_FRAMES = 60;

  function collapse(s) {
    return (s || '').replace(/\\s+/g, ' ').trim();
  }

  // 穿 shadowRoot 取文本：优先 .sheet（doc-page 等文档类预制件的排版容器），
  // 没有就退回整个 shadowRoot 的 textContent（通用兜底）。
  function shadowText(root) {
    if (!root) return '';
    var target = root.querySelector('.sheet') || root;
    return collapse(target.textContent);
  }

  // innerText 走不进 shadow DOM——手动遍历子树里所有 shadowRoot 补取。
  function elText(el) {
    if (!el) return '';
    var base = collapse(el.innerText !== undefined ? el.innerText : el.textContent);
    var shadowParts = [];
    var all = el.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) shadowParts.push(shadowText(all[i].shadowRoot));
    }
    var extra = shadowParts.filter(Boolean).join(' ');
    return collapse(extra ? base + ' ' + extra : base);
  }

  var dcRoot = document.getElementById('dc-root');
  var scopeRoot = dcRoot || document.body;
  if (!scopeRoot) return { frames: [] };

  var screens = scopeRoot.querySelectorAll('[data-screen-label]');
  if (screens.length > 0) {
    var frames = [];
    for (var i = 0; i < screens.length && frames.length < MAX_FRAMES; i++) {
      var el = screens[i];
      var label = el.getAttribute('data-screen-label') || ('#' + (i + 1));
      frames.push({ label: label, text: elText(el) });
    }
    return { frames: frames };
  }

  return { frames: [{ label: null, text: elText(scopeRoot) }] };
})()`
