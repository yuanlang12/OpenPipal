import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVisualizerStore } from '../stores/visualizerStore'

/**
 * 流式内联预览 — 直接嵌入消息流，内容逐步渲染。
 *
 * 防闪烁策略：
 * 1. 加载一个固定的 shell iframe（只加载一次，永不重载）
 * 2. 通过 postMessage 推送 HTML 更新
 * 3. shell 内部用 DOMParser 解析 HTML，然后注入 styles + body 到固定容器
 * 4. 事件监听器永远存活（不像 document.write 会销毁整个文档）
 *
 * 这样每次更新只是 DOM 替换，不触发 iframe 导航，无白屏闪烁。
 */

const IFRAME_SHELL = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}#root{overflow:hidden;max-width:100%;box-sizing:border-box}</style>
<div id="dynamic-head"></div>
</head><body>
<div id="root"></div>
<script>
var lastStyles='';
window.addEventListener('message',function(e){
  if(!e.data||e.data.type!=='visualizer-update')return;
  var parser=new DOMParser();
  var doc=parser.parseFromString(e.data.html,'text/html');
  // 样式:仅在变化时更新,避免每次清空重建导致的 FOUC 闪烁
  var styleHtml='';
  Array.from(doc.head.querySelectorAll('style,link[rel=stylesheet]')).forEach(function(s){styleHtml+=s.outerHTML;});
  var dh=document.getElementById('dynamic-head');
  if(styleHtml!==lastStyles){dh.innerHTML=styleHtml;lastStyles=styleHtml;}
  // 正文:流式预览阶段「不执行 <script>」—— 与最终渲染 VisualizerInline 一致(它 sanitize 时也去脚本)。
  // 这样图表/脚本不会每次重初始化造成闪烁;且因最终态本就是静态,流式不跑脚本零损失。
  var root=document.getElementById('root');
  root.innerHTML=doc.body.innerHTML;
  requestAnimationFrame(function(){
    var h=root.scrollHeight;
    if(h>0)parent.postMessage({type:'visualizer-height',height:h},'*');
  });
});
parent.postMessage({type:'visualizer-ready'},'*');
</script>
</body></html>`

const BUILD_PHRASE_KEYS = [
  'chat.streamingPreview.phases.outline',
  'chat.streamingPreview.phases.color',
  'chat.streamingPreview.phases.layout',
] as const

/**
 * 「搭建中」加载特效(方案 A)—— 可视化流式出内容之前的占位。
 * 呼吸 ✦ + 依次脉冲的骨架条 + 轮换文案,传达"AI 正在认真为你绘制"。
 * 配色走 Tailwind brand-x 与 ink-x 类(运行时主题三元组)→ 跟随「设置 → 外观」自定义强调色 + 深/浅色;
 * 动效在 shimmer.css(sw-spark-breathe / sw-build-bar),已接 reduced-motion 退化。
 */
function VisualizerLoadingSkeleton() {
  const { t } = useTranslation()
  const [phase, setPhase] = useState(0)
  const [textVisible, setTextVisible] = useState(true)
  useEffect(() => {
    const id = setInterval(() => {
      setTextVisible(false)
      setTimeout(() => {
        setPhase(p => (p + 1) % BUILD_PHRASE_KEYS.length)
        setTextVisible(true)
      }, 280)
    }, 1200)
    return () => clearInterval(id)
  }, [])
  return (
    <div
      className="sw-skeleton-shimmer rounded-lg w-full px-4 py-4"
      style={{ minHeight: '120px' }}
      aria-hidden
      data-testid="visualizer-skeleton"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="sw-spark-breathe text-brand-500 text-[15px] leading-none">✦</span>
        <span
          className="text-[13px] font-medium text-ink-primary transition-opacity duration-300"
          style={{ opacity: textVisible ? 1 : 0 }}
        >
          {t(BUILD_PHRASE_KEYS[phase])}
        </span>
      </div>
      <div className="space-y-1.5">
        <div className="sw-build-bar bg-brand-500/30" style={{ width: '64%', animationDelay: '0s' }} />
        <div className="sw-build-bar bg-brand-500/20" style={{ width: '42%', animationDelay: '0.18s' }} />
        <div className="sw-build-bar bg-brand-500/30" style={{ width: '80%', animationDelay: '0.36s' }} />
      </div>
    </div>
  )
}

export function StreamingInlinePreview({ hasAvatar }: { hasAvatar?: boolean }) {
  const { t } = useTranslation()
  const streamingVisualizer = useVisualizerStore(s => s.streamingVisualizer)
  const content = streamingVisualizer?.content || ''

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const pendingRef = useRef<string>('')
  const [iframeHeight, setIframeHeight] = useState(0)
  const [debouncedContent, setDebouncedContent] = useState('')

  const isFirstContent = useRef(true)

  // 首次内容立即渲染（无 debounce），后续 150ms debounce 平衡流畅度与性能
  useEffect(() => {
    if (!content) {
      setDebouncedContent('')
      isFirstContent.current = true
      return
    }
    if (isFirstContent.current) {
      // 首次有内容：立即渲染，不等 debounce
      setDebouncedContent(content)
      isFirstContent.current = false
      return
    }
    // 250ms 节流(原 150)—— 配合"不跑脚本",流式重绘更少、更稳
    const timer = setTimeout(() => setDebouncedContent(content), 250)
    return () => clearTimeout(timer)
  }, [content])

  // 监听 iframe 消息（ready / height）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!e.data) return
      // 只认自己那一帧：沙箱帧是不透明来源（origin 恒为 'null'），只能按 source 认人，
      // 否则页面里任何一个可视化帧都能伪造高度消息互相改尺寸
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data.type === 'visualizer-ready') {
        readyRef.current = true
        if (pendingRef.current && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage(
            { type: 'visualizer-update', html: pendingRef.current }, '*'
          )
          pendingRef.current = ''
        }
      }
      if (e.data.type === 'visualizer-height' && typeof e.data.height === 'number') {
        setIframeHeight(e.data.height)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // 内容变化时推送到 iframe
  useEffect(() => {
    if (!debouncedContent) return
    if (readyRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'visualizer-update', html: debouncedContent }, '*'
      )
    } else {
      pendingRef.current = debouncedContent
    }
  }, [debouncedContent])

  // 主要守卫:没有 streaming visualizer 就不渲染。
  // Phase B:有 streamingVisualizer 但 iframe 还没出来 → skeleton 占位(替代以前直接 return null)
  if (!streamingVisualizer) return null
  const showSkeleton = iframeHeight === 0

  return (
    <div className="flex justify-start mb-msg">
      <div className="w-full relative">
        {showSkeleton && <VisualizerLoadingSkeleton />}
        <iframe
          ref={iframeRef}
          srcDoc={IFRAME_SHELL}
          title={t('chat.streamingPreview.frameTitle')}
          sandbox="allow-scripts allow-modals"
          className="w-full bg-transparent border-0 block rounded-lg"
          scrolling="no"
          style={{
            height: iframeHeight > 0 ? `${iframeHeight}px` : '0px',
            overflow: 'hidden',
            opacity: iframeHeight > 0 ? 1 : 0,
            transition: 'height 0.25s ease-out, opacity 0.15s ease-out'
          }}
        />
      </div>
    </div>
  )
}
