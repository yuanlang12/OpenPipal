/**
 * 本地 Whisper.cpp STT 适配器
 *
 * 依赖：
 *   - whisper-cli 二进制（`brew install whisper-cpp`，装在 /opt/homebrew/bin/whisper-cli）
 *   - 模型文件（~/.openpipal/models/ggml-small.bin，首次运行手动下载）
 *
 * 录音 → WAV bytes → 临时文件 → spawn whisper-cli → 读 .txt 输出 → 返回 transcript
 * 隔离到独立文件避免污染 main/index.ts
 */
import { spawn } from 'child_process'
import { writeFile, readFile, mkdir, access, unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { mainError, type MainErrorPayload } from './main-i18n'
import { dataPath } from './data-root'

const WHISPER_BIN = '/opt/homebrew/bin/whisper-cli'
const MODEL_PATH = dataPath('models', 'ggml-small.bin')
const TMP_DIR = dataPath('tmp')

export interface STTStatus {
  ready: boolean
  reason?: string
  reasonKey?: string
  reasonParams?: Record<string, string | number>
}

/**
 * 预检：确认 whisper-cli 可执行 + 模型文件存在
 */
export async function checkSTT(): Promise<STTStatus> {
  try {
    await access(WHISPER_BIN)
  } catch {
    const failure = mainError('speech.errors.whisperMissing')
    return { ready: false, reason: failure.error, reasonKey: failure.errorKey }
  }
  try {
    await access(MODEL_PATH)
  } catch {
    const failure = mainError('speech.errors.modelMissing', { path: MODEL_PATH })
    return { ready: false, reason: failure.error, reasonKey: failure.errorKey, reasonParams: failure.errorParams }
  }
  return { ready: true }
}

/**
 * 转写 WAV bytes → 中文文本
 * 不用 Promise<void> 形式抛错，统一 { text? | error? } 让 renderer 可展示
 */
export async function transcribeWav(
  wavBytes: ArrayBuffer
): Promise<{ text?: string } & Partial<MainErrorPayload>> {
  const status = await checkSTT()
  if (!status.ready) {
    return { error: status.reason, errorKey: status.reasonKey, errorParams: status.reasonParams }
  }

  await mkdir(TMP_DIR, { recursive: true })
  const base = join(TMP_DIR, `rec-${Date.now()}`)
  const wavPath = `${base}.wav`
  const txtPath = `${base}.txt`

  try {
    await writeFile(wavPath, Buffer.from(wavBytes))
  } catch (err: any) {
    return mainError('speech.errors.wavWriteFailed', { detail: err.message })
  }

  return new Promise((resolve) => {
    // whisper-cli 参数：
    //   -m: 模型路径
    //   -f: 输入 wav
    //   -l zh: 中文语言（不指定会用 auto detect，更慢）
    //   --prompt: 初始提示，偏置解码向中文+学科术语——防止 "精准"→"precision"、"函数"→"function" 这类中英混淆
    //   -nt: 不打时间戳
    //   -otxt: 输出 .txt
    //   -of: 输出路径前缀（会自动追加 .txt）
    const biasPrompt = '以下是中文课堂教学对话，可能包含数学、物理、编程、语文、英语等学科内容。使用简体中文转写，专业术语保持中文表达。'
    const args = [
      '-m', MODEL_PATH,
      '-f', wavPath,
      '-l', 'zh',
      '--prompt', biasPrompt,
      '-nt', '-otxt', '-of', base
    ]
    const proc = spawn(WHISPER_BIN, args)
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', async (code) => {
      // 无论成功失败，清理临时 wav
      unlink(wavPath).catch(() => {})

      if (code !== 0) {
        resolve(mainError('speech.errors.whisperExited', { code: String(code), detail: stderr.slice(-300) }))
        return
      }

      try {
        const text = (await readFile(txtPath, 'utf-8')).trim()
        unlink(txtPath).catch(() => {})
        if (!text) {
          resolve(mainError('speech.errors.emptyTranscript'))
          return
        }
        resolve({ text })
      } catch (err: any) {
        resolve(mainError('speech.errors.readTextFailed', { detail: err.message }))
      }
    })

    proc.on('error', (err) => {
      unlink(wavPath).catch(() => {})
      resolve(mainError('speech.errors.spawnFailed', { detail: err.message }))
    })
  })
}
