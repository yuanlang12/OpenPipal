/**
 * 目录打成 zip——用系统自带的 bsdtar，不引入 npm 依赖，也不吃 PATH。
 *
 * 为什么是 tar 不是 zip：macOS 有 /usr/bin/zip，Windows 没有；但两边都自带 libarchive 的 bsdtar
 * （macOS /usr/bin/tar，Windows 10 1803+ 的 System32\tar.exe），`--format zip` 直接写 zip 容器，
 * 条目默认 deflate。用绝对路径是为了不吃 PATH 上的同名程序——skill-import 解压不可信 tarball
 * 时尤其重要。
 *
 * 两种布局：
 *   - nested：包内顶层是 <basename(dir)>/…，分享包用，不泄露绝对路径
 *   - flat：dir 的内容直接落在 zip 根，OOXML（pptx/docx）的硬要求。显式列出顶层条目而不是传
 *     "."，否则 bsdtar 会给每个条目加 "./" 前缀，PowerPoint 认不出 [Content_Types].xml
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execFileAsync = promisify(execFile)

export function systemTarPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  }
  return '/usr/bin/tar'
}

export type ZipLayout = 'nested' | 'flat'

export async function zipDirectory(dir: string, outPath: string, layout: ZipLayout): Promise<void> {
  // bsdtar 每次都新建归档；先删旧包只是把「不追加」的语义说死（zip -r 是追加）
  fs.rmSync(outPath, { force: true })
  let cwd: string
  let entries: string[]
  if (layout === 'nested') {
    cwd = path.dirname(dir)
    entries = [path.basename(dir)]
  } else {
    cwd = dir
    entries = fs.readdirSync(dir).sort((a, b) => {
      // [Content_Types].xml 排第一：不是规范要求，但 file(1) 这类嗅探器靠它认出 OOXML
      if (a === '[Content_Types].xml') return -1
      if (b === '[Content_Types].xml') return 1
      return a < b ? -1 : a > b ? 1 : 0
    })
    if (entries.length === 0) throw new Error(`zipDirectory: nothing to archive in ${dir}`)
  }
  await execFileAsync(
    systemTarPath(),
    ['--format', 'zip', '-c', '-f', outPath, '-C', cwd, '--', ...entries],
    { maxBuffer: 64 * 1024 * 1024 }
  )
}

/** 列出 zip 条目（校验与测试用）；bsdtar 在两个平台都能读 zip */
export async function listZipEntries(zipPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(systemTarPath(), ['-t', '-f', zipPath], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024
  })
  return stdout.split(/\r?\n/).filter(Boolean)
}
