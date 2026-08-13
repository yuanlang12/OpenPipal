/**
 * File Parser
 * 解析上传的文件（PDF/DOCX/TXT/MD），提取文本内容。
 */

import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'

export interface ParsedFile {
  fileName: string
  fileType: string
  textContent: string
  sizeBytes: number
}

/** buffer 级 PDF 解析，供本文件与 pdf-context.ts（浏览器插件 PDF 直读管线）复用，返回未截断全文。 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buffer })
  try {
    const data = await parser.getText()
    return data.text
  } finally {
    await parser.destroy()
  }
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
  const fileName = basename(filePath)
  const ext = extname(filePath).toLowerCase().replace('.', '')
  const stats = statSync(filePath)

  let textContent = ''

  switch (ext) {
    case 'pdf': {
      textContent = await parsePdfBuffer(readFileSync(filePath))
      break
    }
    case 'docx': {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      textContent = result.value
      break
    }
    case 'txt':
    case 'md':
    case 'csv':
    case 'json':
    case 'xml':
    case 'html': {
      textContent = readFileSync(filePath, 'utf-8')
      break
    }
    default:
      textContent = `[不支持的文件类型: .${ext}]`
  }

  // 截断过长内容（避免占用过多上下文）
  const MAX_CHARS = 50000
  if (textContent.length > MAX_CHARS) {
    textContent = textContent.substring(0, MAX_CHARS) + `\n\n[内容已截断，共 ${textContent.length} 字符，显示前 ${MAX_CHARS} 字符]`
  }

  return {
    fileName,
    fileType: ext,
    textContent,
    sizeBytes: stats.size
  }
}
