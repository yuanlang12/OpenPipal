/**
 * 通用宽度适配的纯计算——以 JS 源码字符串形态存在：BRIDGE_SCRIPT（srcdoc iframe 注入脚本）
 * 原样拼接它，单测经 new Function 求值同一份源码。算法只此一份，宿主与测试不漂移
 * （评审：新增算法不该继续塞进不可测的 BRIDGE_SCRIPT 字符串黑洞）。
 * 契约：__computeFitZoom(scrollWidth, innerWidth, currentZoom) → 应当应用的 zoom；
 * 返回值 === currentZoom 表示无需改写（含 ±0.01 迟滞，防抖动往复写样式）。
 */
export const PREVIEW_FIT_SOURCE = `function __computeFitZoom(sw, iw, cur){
  if (!sw || !iw) return cur;
  var z = sw > iw + 8 ? Math.max(0.25, Math.min(1, iw / sw)) : 1;
  return Math.abs(z - cur) > 0.01 ? z : cur;
}`
