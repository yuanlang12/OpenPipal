// OpenPipal Inject Script — MAIN world
// 策略：不自己 fetch 字幕（会被 CORS/Trusted Types/POT token 拦截）
// 而是让播放器加载字幕，然后从 DOM 中收集渲染出来的字幕文本

(function () {
  'use strict'

  // ============================================================
  // YouTube：收集播放器渲染的字幕
  // ============================================================

  // 确保字幕开启
  function ensureYouTubeCCEnabled() {
    const ccBtn = document.querySelector('.ytp-subtitles-button')
    if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') {
      ccBtn.click()
      console.log('[OpenPipal-inject] YouTube: 自动开启字幕')
      return true
    }
    return ccBtn?.getAttribute('aria-pressed') === 'true'
  }

  // 从 DOM 中收集已渲染的字幕文本
  function collectRenderedSubtitles() {
    const segments = document.querySelectorAll('.ytp-caption-segment')
    if (segments.length === 0) return null
    const texts = Array.from(segments).map(s => s.textContent?.trim()).filter(Boolean)
    return texts.length > 0 ? texts : null
  }

  // 持续收集字幕（视频播放过程中字幕不断更新）
  let collectedSubtitles = []
  let subtitleObserver = null

  function startSubtitleCollection() {
    if (subtitleObserver) return

    const container = document.querySelector('.caption-window') ||
                      document.querySelector('.ytp-caption-window-container')
    if (!container) return

    const seen = new Set()
    subtitleObserver = new MutationObserver(() => {
      const segments = document.querySelectorAll('.ytp-caption-segment')
      segments.forEach(seg => {
        const text = seg.textContent?.trim()
        if (text && !seen.has(text)) {
          seen.add(text)
          collectedSubtitles.push(text)
        }
      })
    })

    subtitleObserver.observe(container, { childList: true, subtree: true, characterData: true })
    console.log('[OpenPipal-inject] YouTube: 字幕收集器已启动')
  }

  // 获取字幕信息用于发送
  function getYouTubeSubtitleData() {
    // 优先返回已收集的完整字幕
    if (collectedSubtitles.length > 0) {
      return collectedSubtitles.join(' ').substring(0, 8000)
    }
    // 回退：当前屏幕上的字幕
    const current = collectRenderedSubtitles()
    if (current) return current.join(' ')
    return null
  }

  // YouTube 初始化
  function initYouTube() {
    if (!location.hostname.includes('youtube.com') || location.pathname !== '/watch') return

    // 先检查字幕轨道数量（供调试）
    let trackCount = 0
    try {
      const pr = window.ytInitialPlayerResponse
      trackCount = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0
    } catch {}
    try {
      if (!trackCount) {
        const mp = document.getElementById('movie_player')
        trackCount = mp?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0
      }
    } catch {}

    console.log(`[OpenPipal-inject] YouTube: ${trackCount} 个字幕轨道可用`)

    if (trackCount > 0) {
      ensureYouTubeCCEnabled()
      // 延迟启动收集器（等字幕 DOM 出现）
      setTimeout(() => startSubtitleCollection(), 2000)
      setTimeout(() => startSubtitleCollection(), 5000)
    }
  }

  // ============================================================
  // B站
  // ============================================================
  function getBilibiliData() {
    try {
      const state = window.__INITIAL_STATE__
      if (state?.videoData?.subtitle?.list?.length) {
        return { subtitles: state.videoData.subtitle.list, bvid: state.videoData.bvid, cid: state.videoData.cid }
      }
    } catch {}
    try {
      const pi = window.__playinfo__
      if (pi?.data?.subtitle?.subtitles?.length) {
        return { subtitles: pi.data.subtitle.subtitles }
      }
    } catch {}
    return null
  }

  // ============================================================
  // 数据发送
  // ============================================================
  function send() {
    const data = {}

    if (location.hostname.includes('youtube.com') && location.pathname === '/watch') {
      const subtitleText = getYouTubeSubtitleData()
      if (subtitleText) {
        data.ytSubtitleText = subtitleText
        console.log(`[OpenPipal-inject] YouTube 字幕就绪: ${subtitleText.length} 字`)
      }
    }

    if (location.hostname.includes('bilibili.com')) {
      const bili = getBilibiliData()
      if (bili) {
        data.biliSubtitles = bili.subtitles
        data.bvid = bili.bvid
        data.cid = bili.cid
      }
    }

    window.postMessage({ type: '__OPENPIPAL_PAGE_DATA__', data }, '*')
  }

  // 初始化
  setTimeout(() => { initYouTube(); send() }, 2000)
  setTimeout(send, 5000)
  setTimeout(send, 10000)
  // 持续更新（字幕在不断积累）
  setInterval(send, 15000)

  // YouTube SPA 导航
  if (location.hostname.includes('youtube.com')) {
    let lastUrl = location.href
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        collectedSubtitles = []
        if (subtitleObserver) { subtitleObserver.disconnect(); subtitleObserver = null }
        setTimeout(() => { initYouTube(); send() }, 3000)
      }
    }, 1000)
  }
})()
