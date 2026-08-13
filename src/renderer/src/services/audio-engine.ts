/**
 * 音频引擎：麦克风采集（PCM16 24kHz）+ 扬声器播放
 * 用于 OpenAI Realtime API 的音频 I/O
 */

const DEFAULT_SAMPLE_RATE = 24000 // OpenAI Realtime API 要求 24kHz;豆包同传走 16000

export class AudioEngine {
  /** 采集采样率(麦克风降采样目标)。OpenAI=24000,豆包同传=16000,豆包全双工=16000。 */
  private readonly rate: number
  /** 播放采样率。多数 = rate;豆包全双工入 16k 出 24k 不对称,故播放 context/buffer 用 outRate。 */
  private readonly outRate: number
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processorNode: ScriptProcessorNode | null = null

  // 播放队列
  private playbackQueue: Float32Array[] = []
  private isPlaying = false
  private playbackContext: AudioContext | null = null

  // Barge-in 支持：追踪当前正在播放的 source + 本轮已播放 ms（用于 conversation.item.truncate）
  private currentSource: AudioBufferSourceNode | null = null
  private playedMs = 0           // 当前这段 AI 回复已实际播放的毫秒数
  private receivedMs = 0         // 当前这段 AI 回复已入队的音频总时长(用于把转录揭示节流到音频时钟)
  private chunkStartCtxTime = 0  // 当前 chunk 在 playbackContext 时间轴上的起播时刻

  // 音量级别
  private _inputLevel = 0
  private _outputLevel = 0

  // 思考中提示音（轻短促"咔哒"循环，AI 处理中告诉用户系统在工作）
  private indicatorSource: AudioBufferSourceNode | null = null
  private indicatorGain: GainNode | null = null
  private indicatorBuffer: AudioBuffer | null = null

  /** 麦克风音频数据回调（base64 PCM16，采样率 = this.rate） */
  onAudioData: ((pcm16Base64: string) => void) | null = null

  constructor(opts?: { sampleRate?: number; outputSampleRate?: number }) {
    this.rate = opts?.sampleRate ?? DEFAULT_SAMPLE_RATE
    this.outRate = opts?.outputSampleRate ?? this.rate
  }

  get inputLevel(): number {
    return this._inputLevel
  }

  get outputLevel(): number {
    return this._outputLevel
  }

  /**
   * 开始麦克风采集
   * 使用浏览器原生采样率采集，然后降采样到 24kHz
   */
  async startCapture(): Promise<void> {
    try {
      // 不指定 sampleRate，让浏览器用默认值（通常 48kHz）
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })

      console.log('[AudioEngine] Microphone access granted')

      // 用浏览器原生采样率创建 AudioContext
      this.audioContext = new AudioContext()
      const nativeSampleRate = this.audioContext.sampleRate
      console.log(`[AudioEngine] Native sample rate: ${nativeSampleRate}, target: ${this.rate}`)

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream)

      // ScriptProcessorNode 捕获原始 PCM
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1)

      this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        const inputData = event.inputBuffer.getChannelData(0)

        // 计算输入音量
        let sum = 0
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i]
        }
        this._inputLevel = Math.sqrt(sum / inputData.length)

        // 降采样到 24kHz（如果原生采样率不同）
        const resampled = nativeSampleRate === this.rate
          ? inputData
          : downsample(inputData, nativeSampleRate, this.rate)

        // Float32 → PCM16 → base64
        const pcm16 = float32ToPcm16(resampled)
        const base64 = arrayBufferToBase64(pcm16.buffer)

        if (this.onAudioData) {
          this.onAudioData(base64)
        }
      }

      this.sourceNode.connect(this.processorNode)
      // 连接到 destination 让 ScriptProcessorNode 正常触发（不会实际播放，因为输入是麦克风）
      this.processorNode.connect(this.audioContext.destination)

      console.log('[AudioEngine] Capture started')

    } catch (err) {
      console.error('[AudioEngine] Failed to start capture:', err)
      throw err
    }
  }

  /** 停止麦克风采集 */
  stopCapture(): void {
    if (this.processorNode) {
      this.processorNode.disconnect()
      this.processorNode = null
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop())
      this.mediaStream = null
    }
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
    this._inputLevel = 0
  }

  /**
   * 播放 AI 响应音频
   * @param pcm16Base64 base64 编码的 PCM16 24kHz mono 数据
   */
  playAudio(pcm16Base64: string): void {
    const pcm16 = base64ToInt16Array(pcm16Base64)
    const float32 = pcm16ToFloat32(pcm16)

    // 计算输出音量
    let sum = 0
    for (let i = 0; i < float32.length; i++) {
      sum += float32[i] * float32[i]
    }
    this._outputLevel = Math.sqrt(sum / float32.length)

    // 累计本段已入队音频时长 —— 转录揭示按 playedMs/receivedMs 比例推进(见 getAudioProgress)
    this.receivedMs += (float32.length / this.outRate) * 1000
    this.playbackQueue.push(float32)
    this.processPlaybackQueue()
  }

  /**
   * 一段新的 AI 音频回复开始 —— 重置已播/已收计时。
   * 由上层在收到「新 item_id 的 response.audio.delta」时调用,作为 burst 的权威起点
   * (不再依赖 processPlaybackQueue 的队列空→非空跃迁,避免音频欠载时被误重置)。
   */
  beginAudioTurn(): void {
    this.playedMs = 0
    this.receivedMs = 0
  }

  /**
   * 当前段音频的播放进度 —— playedMs 含正在播放 chunk 的实时已播部分。
   * 上层用 playedMs/receivedMs 比例把转录文字揭示节流到音频时钟(嘴和字同步)。
   */
  getAudioProgress(): { playedMs: number; receivedMs: number } {
    let played = this.playedMs
    if (this.currentSource && this.playbackContext) {
      played += Math.max(0, (this.playbackContext.currentTime - this.chunkStartCtxTime) * 1000)
    }
    return { playedMs: played, receivedMs: this.receivedMs }
  }

  /** 停止播放并清空队列（完全销毁用，会 close context） */
  stopPlayback(): void {
    this.playbackQueue = []
    this.isPlaying = false
    this.currentSource = null
    this.playedMs = 0
    this.receivedMs = 0
    this._outputLevel = 0
    if (this.playbackContext) {
      this.playbackContext.close()
      this.playbackContext = null
    }
  }

  /**
   * Barge-in 即时停播：用户开口时调用。
   * 与 stopPlayback 区别：不 close context（保留复用，低延迟），并返回本轮已播放 ms。
   * 返回值用于 conversation.item.truncate 的 audio_end_ms —— 告诉服务端用户实际听到了多少。
   */
  flushPlayback(): number {
    // 累加当前正在播放 chunk 的已播部分
    if (this.currentSource && this.playbackContext) {
      const partial = Math.max(0, (this.playbackContext.currentTime - this.chunkStartCtxTime) * 1000)
      this.playedMs += partial
    }
    const ms = Math.round(this.playedMs)

    // 立即停掉当前 source + 清空队列
    if (this.currentSource) {
      try {
        this.currentSource.onended = null
        this.currentSource.stop()
      } catch {
        // 已停止/已结束的 source 再 stop 会抛错，忽略
      }
      this.currentSource = null
    }
    this.playbackQueue = []
    this.isPlaying = false
    this._outputLevel = 0
    this.playedMs = 0  // 重置，下一段 AI 回复从 0 计
    this.receivedMs = 0
    return ms
  }

  /** 完全销毁 */
  destroy(): void {
    this.stopIndicator()
    this.stopCapture()
    this.stopPlayback()
    this.onAudioData = null
  }

  /**
   * 启动"思考中"提示音 —— 柔和的"水流/冥想"环境音循环，AI 第一个 token 流出时调用 stopIndicator()。
   * 复用 playbackContext（不重新创建，省电）。现场合成,无需外部 wav：
   *   平滑白噪(低通=流水质感) × 缓慢正弦呼吸包络(整数周期=无缝循环) + 边界交叉淡化(消除噪声接缝)。
   */
  startIndicator(): void {
    if (this.indicatorSource) return  // 已经在播
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ sampleRate: this.outRate })
    }
    if (!this.indicatorBuffer) {
      // 3 秒缓冲：足够长，呼吸感舒缓
      const totalSec = 3.0
      const n = Math.floor(totalSec * this.outRate)
      const buffer = this.playbackContext.createBuffer(1, n, this.outRate)
      const data = buffer.getChannelData(0)

      // 1) 生成白噪 → 移动平均低通(窗口越大越"闷"，像远处水声)
      const raw = new Float32Array(n)
      for (let i = 0; i < n; i++) raw[i] = Math.random() * 2 - 1
      const win = 24 // 低通窗口
      let acc = 0
      for (let i = 0; i < n; i++) {
        acc += raw[i]
        if (i >= win) acc -= raw[i - win]
        data[i] = acc / Math.min(i + 1, win)
      }

      // 2) 缓慢"呼吸"包络：1.5 个正弦周期 over 3s（整数半周期→首尾电平一致，利于无缝）
      //    幅度在 0.45~1.0 间起伏，营造潮汐/水流的进退感
      for (let i = 0; i < n; i++) {
        const phase = (i / n) * Math.PI * 2 * 1.5
        const breath = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase))
        data[i] *= breath
      }

      // 3) 边界交叉淡化：把末尾 0.15s 与开头 0.15s 线性混合，消除循环接缝的"咔"
      const fade = Math.floor(0.15 * this.outRate)
      for (let i = 0; i < fade; i++) {
        const t = i / fade
        const head = data[i]
        const tail = data[n - fade + i]
        // 开头位置写入 (淡入的开头 × t + 淡出的末尾 ×(1-t))
        data[i] = head * t + tail * (1 - t)
      }

      this.indicatorBuffer = buffer
    }

    // 增益：0.12 —— 比对话语音明显小，是"背景在工作"的暗示而非干扰
    if (!this.indicatorGain) {
      this.indicatorGain = this.playbackContext.createGain()
      this.indicatorGain.gain.value = 0.12
      this.indicatorGain.connect(this.playbackContext.destination)
    }

    this.indicatorSource = this.playbackContext.createBufferSource()
    this.indicatorSource.buffer = this.indicatorBuffer
    this.indicatorSource.loop = true
    this.indicatorSource.connect(this.indicatorGain)
    // 轻微淡入,避免启动"啪"一声
    try {
      const now = this.playbackContext.currentTime
      this.indicatorGain.gain.setValueAtTime(0.0001, now)
      this.indicatorGain.gain.exponentialRampToValueAtTime(0.12, now + 0.4)
    } catch {
      this.indicatorGain.gain.value = 0.12
    }
    this.indicatorSource.start()
  }

  /** 停止提示音 */
  stopIndicator(): void {
    if (this.indicatorSource) {
      try {
        this.indicatorSource.onended = null
        this.indicatorSource.stop()
      } catch {
        // 重复 stop / 未 start 不报错
      }
      this.indicatorSource = null
    }
  }

  private processPlaybackQueue(): void {
    if (this.isPlaying || this.playbackQueue.length === 0) return
    this.isPlaying = true
    // 注意:不在此重置 playedMs —— burst 起点由 beginAudioTurn 控制。
    // 若在此重置,音频流欠载(队列短暂排空又续上)会被误判为新 burst → 计时归零 → 字幕回跳。

    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ sampleRate: this.outRate })
    }

    const playNext = (): void => {
      if (this.playbackQueue.length === 0) {
        this.isPlaying = false
        this.currentSource = null
        this._outputLevel = 0
        return
      }

      const float32Data = this.playbackQueue.shift()!
      const buffer = this.playbackContext!.createBuffer(1, float32Data.length, this.outRate)
      // AudioBuffer 要求普通 ArrayBuffer 视图；复制同时隔离潜在的 SharedArrayBuffer 输入。
      buffer.copyToChannel(new Float32Array(float32Data), 0)

      const source = this.playbackContext!.createBufferSource()
      source.buffer = buffer
      source.connect(this.playbackContext!.destination)
      // 记录本 chunk 起播时刻 + 时长，供 flushPlayback 计算已播 ms
      this.chunkStartCtxTime = this.playbackContext!.currentTime
      this.currentSource = source
      source.onended = () => {
        // chunk 正常播完 → 累加完整时长
        this.playedMs += (float32Data.length / this.outRate) * 1000
        playNext()
      }
      source.start()
    }

    playNext()
  }
}

// ─── 工具函数 ───────────────────────────────────────────

/**
 * 降采样(带抗混叠)。每个输出样本 = 对应输入窗口内所有样本的均值(box 低通)+ 抽取。
 *
 * 旧实现是点采样/线性插值:48k→24k(ratio=2)时 frac 恒为 0,等于"每隔一个丢一个",
 * 没有任何低通 → >12kHz 的频率混叠回可听带成噪声 → 喂给 ASR 的音频劣化 → 转错/幻觉。
 * box 均值是廉价的抗混叠,虽非理想 sinc,但显著降低混叠,转录准确度明显改善。
 */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return input
  const ratio = fromRate / toRate
  const outputLength = Math.floor(input.length / ratio)
  const output = new Float32Array(outputLength)

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    let n = 0
    for (let j = start; j < end; j++) {
      sum += input[j]
      n++
    }
    output[i] = n > 0 ? sum / n : (input[start] || 0)
  }

  return output
}

function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm16
}

function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm16.length)
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff)
  }
  return float32
}

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToInt16Array(base64: string): Int16Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Int16Array(bytes.buffer)
}
