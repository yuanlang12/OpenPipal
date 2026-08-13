import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toDisplayError } from '../utils/mainError'

/**
 * 本地 STT 录音 Hook（Phase 3/4）
 *
 * 流程：
 *   start() 点击录音 → getUserMedia 16kHz mono → ScriptProcessorNode 捕获 Float32 PCM
 *   stop()  → 拼接 PCM → Float32 转 Int16 → 编成 WAV 字节 → IPC 发给 main whisper.cpp 转写
 *
 * 设计选择：
 *   - 不用 MediaRecorder（产出 webm/opus，whisper-cli 不吃，需 ffmpeg 转换；多一个依赖）
 *   - 用 WebAudio 裸 PCM：16kHz mono 直写 WAV header，whisper-cli 直接吃，零转换
 *   - ScriptProcessorNode 虽然 deprecated，但 Electron 仍完全支持；AudioWorklet 更正但 setup 复杂
 */

export type STTState = 'idle' | 'recording' | 'transcribing' | 'error'

export function useLocalSTT(onTranscript: (text: string) => void) {
  // 这些错误文案会经 OrbView 的 title 直接显示给用户，必须本地化——
  // 本文件是 .ts，落在只扫 .tsx 的 i18n 回归测试盲区里，改动时留意
  const { t } = useTranslation()
  const [state, setState] = useState<STTState>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    ctxRef.current?.close().catch(() => {})
    processorRef.current = null
    sourceRef.current = null
    streamRef.current = null
    ctxRef.current = null
  }, [])

  const start = useCallback(async () => {
    if (state === 'recording' || state === 'transcribing') return
    setErrorMsg(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      streamRef.current = stream
      // AudioContext 如果实际设备采样率不是 16000，会自动重采样
      const ctx = new AudioContext({ sampleRate: 16000 })
      ctxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      processor.onaudioprocess = (e) => {
        // 复制一份 — 原 buffer 会被 WebAudio 重用
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(ctx.destination)
      processorRef.current = processor
      setState('recording')
    } catch (err: any) {
      console.error('[STT] 录音启动失败', err)
      setErrorMsg(err.message || t('speech.errors.startFailed'))
      setState('error')
      cleanup()
    }
  }, [state, cleanup])

  const stop = useCallback(async () => {
    if (state !== 'recording') return
    setState('transcribing')

    // 拼接所有 chunk 成一个 Float32Array
    const chunks = chunksRef.current
    chunksRef.current = []
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
    const pcm32 = new Float32Array(totalLen)
    {
      let off = 0
      for (const c of chunks) {
        pcm32.set(c, off)
        off += c.length
      }
    }

    cleanup()

    if (totalLen === 0) {
      setErrorMsg(t('speech.errors.noAudio'))
      setState('error')
      return
    }

    // Float32 [-1,1] → Int16 PCM
    const pcm16 = new Int16Array(totalLen)
    for (let i = 0; i < totalLen; i++) {
      const s = Math.max(-1, Math.min(1, pcm32[i]))
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    // 构造 WAV（44-byte header + data）
    const wav = encodeWAV(pcm16, 16000)

    try {
      const result = await window.api.transcribeAudio(wav)
      if (result.text) {
        onTranscript(result.text)
        setState('idle')
      } else {
        const failure = toDisplayError(result, 'speech.errors.transcribeFailed')
        setErrorMsg(failure.key ? t(failure.key, failure.values) : failure.raw || t('speech.errors.transcribeFailed'))
        setState('error')
      }
    } catch (err: any) {
      setErrorMsg(err.message || t('speech.errors.ipcFailed'))
      setState('error')
    }
  }, [state, cleanup, onTranscript])

  const toggle = useCallback(() => {
    if (state === 'idle' || state === 'error') start()
    else if (state === 'recording') stop()
  }, [state, start, stop])

  return { state, errorMsg, start, stop, toggle }
}

/**
 * 把 Int16 PCM 样本编码成 WAV 字节流
 * 规格：RIFF / WAVE / fmt(PCM, mono, sampleRate, 16-bit) / data
 */
function encodeWAV(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)              // fmt chunk size
  view.setUint16(20, 1, true)               // PCM format
  view.setUint16(22, 1, true)               // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)  // byte rate
  view.setUint16(32, 2, true)               // block align
  view.setUint16(34, 16, true)              // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(off, samples[i], true)
    off += 2
  }
  return buffer
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
