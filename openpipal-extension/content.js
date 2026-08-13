// OpenPipal Content Script
// 职责：提取页面内容、选中文本、视频字幕

(function () {
  'use strict'

  // inject.js 通过 manifest world:"MAIN" 声明式注入，不再用内联脚本
  // 存储从 MAIN world 收到的数据（inject.js 通过 postMessage 发送）
  let pageData = {}
  window.addEventListener('message', (e) => {
    if (e.data?.type === '__OPENPIPAL_PAGE_DATA__' && e.source === window) {
      pageData = e.data.data || {}
    }
  })

  // ============================================================
  // 页面内容提取（增强版）
  // ============================================================
  function getSelectedText() {
    return window.getSelection()?.toString() || ''
  }

  function extractPageContent() {
    // 策略1：使用语义化标签
    const candidates = [
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.querySelector('#content'),
      document.querySelector('.content'),
      document.querySelector('#mw-content-text'), // Wikipedia
      document.querySelector('.post-content'),    // 博客
      document.querySelector('.article-content')   // 新闻
    ].filter(Boolean)

    if (candidates.length > 0) {
      // 取文本最长的候选
      const best = candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0]
      return cleanText(best.innerText).substring(0, 5000)
    }

    // 策略2：遍历 body，跳过噪声元素
    const clone = document.body.cloneNode(true)
    const noise = 'script, style, nav, header, footer, aside, [role="navigation"], [role="banner"], .sidebar, .nav, .menu, .ads, .comment, .comments, iframe, svg'
    clone.querySelectorAll(noise).forEach(el => el.remove())

    // 找最大的文本块
    const blocks = Array.from(clone.querySelectorAll('p, div, section, li, td, dd'))
      .filter(el => {
        const text = el.innerText?.trim() || ''
        return text.length > 50 && !el.querySelector('p, div, section') // 叶子节点
      })
      .sort((a, b) => b.innerText.length - a.innerText.length)

    if (blocks.length > 0) {
      return cleanText(blocks.map(b => b.innerText).join('\n\n')).substring(0, 5000)
    }

    return cleanText(clone.innerText).substring(0, 5000)
  }

  function cleanText(text) {
    return text
      .replace(/\s*\n\s*\n\s*\n+/g, '\n\n') // 多个空行合并
      .replace(/[ \t]+/g, ' ')               // 多空格合并
      .trim()
  }

  // 提取页面元信息
  function extractMeta() {
    const meta = {}
    const ogDesc = document.querySelector('meta[property="og:description"]')?.content
    const desc = document.querySelector('meta[name="description"]')?.content
    meta.description = ogDesc || desc || ''

    const ogTitle = document.querySelector('meta[property="og:title"]')?.content
    meta.ogTitle = ogTitle || ''

    // 视频页面的额外信息
    const keywords = document.querySelector('meta[name="keywords"]')?.content
    if (keywords) meta.keywords = keywords

    return meta
  }

  // ============================================================
  // YouTube 字幕获取（字幕由 inject.js 在 MAIN world 中 fetch，避免 CORS）
  // ============================================================
  function extractYouTubeSubtitles() {
    if (!location.hostname.includes('youtube.com')) return null

    // inject.js 已在 MAIN world 中完成 fetch，直接取结果
    if (pageData.ytSubtitleText) {
      console.log(`[OpenPipal] YouTube: 使用 inject.js 提取的字幕 ${pageData.ytSubtitleText.length} 字 (${pageData.ytSelectedLang})`)
      return pageData.ytSubtitleText
    }

    if (pageData.ytTrackCount) {
      console.log(`[OpenPipal] YouTube: 发现 ${pageData.ytTrackCount} 轨道但字幕内容未就绪`)
    } else {
      console.log('[OpenPipal] YouTube: 无字幕数据（inject.js 可能还未执行）')
    }
    return null
  }

  // ============================================================
  // B站字幕获取
  // ============================================================
  async function extractBilibiliSubtitles() {
    if (!location.hostname.includes('bilibili.com')) return null

    // 策略1：从 MAIN world 获取的数据
    const subtitles = pageData.biliSubtitles
    if (subtitles?.length) {
      const sub = subtitles.find(s => s.lan === 'ai-zh' || s.lan === 'zh-CN' || s.lan === 'zh')
        || subtitles[0]
      const subUrl = sub?.subtitle_url || sub?.subtitleUrl
      if (subUrl) {
        try {
          const url = subUrl.startsWith('//') ? 'https:' + subUrl : subUrl
          const res = await fetch(url)
          const data = await res.json()
          if (data.body?.length) {
            const text = data.body.map(item => item.content).join(' ').substring(0, 8000)
            console.log(`[OpenPipal] B站: 提取字幕 ${text.length} 字 (${sub.lan || sub.lan_doc})`)
            return text
          }
        } catch (e) {
          console.log('[OpenPipal] B站字幕下载失败:', e.message)
        }
      }
    }

    // 策略2：通过 player API 获取（需要 Cookie）
    const bvid = pageData.bvid || location.pathname.match(/\/video\/(BV\w+)/)?.[1]
    const cid = pageData.cid
    if (bvid && cid) {
      try {
        const res = await fetch(
          `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`,
          { credentials: 'include' }
        )
        const json = await res.json()
        const subs = json?.data?.subtitle?.subtitles
        if (subs?.length) {
          const sub = subs.find(s => s.lan === 'ai-zh') || subs.find(s => s.lan === 'zh-CN') || subs[0]
          if (sub?.subtitle_url) {
            const url = sub.subtitle_url.startsWith('//') ? 'https:' + sub.subtitle_url : sub.subtitle_url
            const subRes = await fetch(url)
            const subData = await subRes.json()
            if (subData.body?.length) {
              const text = subData.body.map(item => item.content).join(' ').substring(0, 8000)
              console.log(`[OpenPipal] B站: API 提取字幕 ${text.length} 字`)
              return text
            }
          }
        }
      } catch (e) {
        console.log('[OpenPipal] B站 API 字幕失败:', e.message)
      }
    }

    // 策略3：DOM 字幕覆盖层
    const el = document.querySelector('.bpx-player-subtitle-panel-text')
    if (el?.innerText) return el.innerText

    return null
  }

  // ============================================================
  // 消息处理
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_CONTEXT') {
      ;(async () => {
        const selectedText = getSelectedText()
        const pageContent = extractPageContent()
        const meta = extractMeta()
        let subtitles = null

        if (location.hostname.includes('youtube.com')) {
          subtitles = await extractYouTubeSubtitles()
        } else if (location.hostname.includes('bilibili.com')) {
          subtitles = await extractBilibiliSubtitles()
        }

        sendResponse({
          url: location.href,
          title: document.title,
          selectedText,
          pageContent,
          subtitles,
          meta
        })
      })()
      return true
    }
  })
})()
