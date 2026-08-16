/**
 * dc 页面文本摘要提取（弱模型截图核对链路全断的核心兜底）。
 * "渲染干净"只代表无 console 错误，不代表品牌名/文案/数据符合要求——弱模型看不到
 * 截图（photon resize 在主进程恒断 + 纯文本模型图片进不了上下文），只能靠文本核对。
 *
 * 零依赖：只导出一段注入被渲染页面执行的 JS 字符串，供 pi-tools 隐藏窗口自检、
 * e2e 直接在 playwright 页面里 evaluate 复用（同 overlap-lint.ts 的做法）。
 */

/** 跳过页（data-deck-skip）在摘要里的标注前缀——模型据此区分"这页被有意跳过"与"我漏写了" */
export const SKIP_MARK = '[跳过页·不进导出]'

/**
 * 注入被渲染页面执行的文本摘要脚本：返回 { frames: Array<{ label: string | null; text: string }> }。
 * - 有 [data-screen-label] 结构（canvas 多方向 / deck 多页）→ 按 frame 分组，一个 frame 一条。
 * - 否则 → 单条，label 为 null（调用方按 body 兜底截取更长的正文）。
 * - deck（幻灯舞台）走组件的 readPages 作用域，让**每一页**都有正文（见下方注释）。
 * 范围锁定 #dc-root（support.js 渲染挂载点）：自研运行时首帧后会把原始 <x-dc> 源子树
 * 收进 <template data-dc-source>（查询不到、不渲染），锁定范围因此不再是硬性必需——
 * 但保留它兜住"挂载到收起之间"那一帧与任何异常路径，宁可双保险。
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

  function collect() {
    var screens = scopeRoot.querySelectorAll('[data-screen-label]');
    var frames = [];
    for (var i = 0; i < screens.length && frames.length < MAX_FRAMES; i++) {
      var el = screens[i];
      var label = el.getAttribute('data-screen-label') || ('#' + (i + 1));
      var text = elText(el);
      // 跳过页（data-deck-skip）：不进翻页、不进打印、不进任何导出。它的正文允许是空的，
      // 但必须**标出来**——不标的话模型会把"这一屏没内容"当成自己漏写了，回头去补一页
      // 根本不该存在的稿。标记进 text 不进 label：label 是交接包对账 reference/ 文件名的键。
      if (el.hasAttribute('data-deck-skip')) text = '${SKIP_MARK}' + (text ? ' ' + text : '');
      frames.push({ label: label, text: text });
    }
    return frames;
  }

  if (scopeRoot.querySelectorAll('[data-screen-label]').length > 0) {
    // deck 特例：幻灯舞台用 visibility 隐藏非当前页，而 innerText 对隐藏元素恒返回空串——
    // 摘要于是"屏名齐全、只有当前页有正文"，模型自检只看得见第一页（"弱模型单次生成即可
    // 交付"的直接障碍）。组件为此提供 readPages(fn)：同步放开可见性门跑一遍 fn 再收回，
    // 不翻页、无帧边界所以不闪。没有这个方法（老产物内联的是老组件）就照旧走，不回退。
    var deck = scopeRoot.querySelector('deck-stage');
    return { frames: deck && typeof deck.readPages === 'function' ? deck.readPages(collect) : collect() };
  }

  return { frames: [{ label: null, text: elText(scopeRoot) }] };
})()`
