/**
 * 语音音频留存 —— 把语音通话里「你说的」和「AI 说的」PCM16 存成 WAV,支持回听某一段。
 *
 * Realtime 的音频是裸 PCM16 24kHz mono(无容器)。这里加一个标准 44 字节 WAV 头,
 * 浏览器 <audio> 就能直接播。按 conversationId / itemId 分文件,跟 voiceItemId 一一对应。
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { dataPath } from './data-root'

const SAMPLE_RATE = 24000 // OpenAI Realtime: PCM16 24kHz mono
const NUM_CHANNELS = 1
const BITS_PER_SAMPLE = 16

function audioDir(conversationId: string): string {
  // 文件名安全化:只留字母数字/-/_,其余换成 _
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default'
  return dataPath('voice-audio', safe)
}

/** 裸 PCM16(little-endian)字节 → 标准 WAV(加 44 字节 RIFF 头) */
export function pcm16ToWav(pcm: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE) / 8
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4) // 文件总长 - 8
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk 长度
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(NUM_CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 存一段语音音频。base64Pcm = 该段累积的裸 PCM16 base64。
 * 返回写入的 wav 绝对路径(挂到 ChatMessage.audioPath,随消息持久化)。
 */
export function saveVoiceAudio(
  conversationId: string,
  itemId: string,
  role: string,
  base64Pcm: string
): { path: string } | { error: string } {
  try {
    if (!base64Pcm) return { error: '空音频' }
    const pcm = Buffer.from(base64Pcm, 'base64')
    if (pcm.length === 0) return { error: '空音频' }
    const dir = audioDir(conversationId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const safeItem = itemId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const path = join(dir, `${role}-${safeItem}.wav`)
    writeFileSync(path, pcm16ToWav(pcm))
    return { path }
  } catch (err: any) {
    console.error('[voice-audio] 存音频失败:', err?.message)
    return { error: err?.message || '写入失败' }
  }
}

/** 读回某段 wav → base64(renderer 转 Blob 用 <audio> 播) */
export function readVoiceAudio(path: string): { base64: string } | { error: string } {
  try {
    // 只允许读 voice-audio 目录下的文件(防路径穿越)
    const root = dataPath('voice-audio')
    if (!path.startsWith(root)) return { error: '非法路径' }
    if (!existsSync(path)) return { error: '文件不存在' }
    return { base64: readFileSync(path).toString('base64') }
  } catch (err: any) {
    console.error('[voice-audio] 读音频失败:', err?.message)
    return { error: err?.message || '读取失败' }
  }
}
