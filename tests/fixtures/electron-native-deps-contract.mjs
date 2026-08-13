import { createCanvas } from '@napi-rs/canvas'
import { PDFParse } from 'pdf-parse'
import sharp from 'sharp'

try {
  const sharpPng = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 1 }
    }
  }).png().toBuffer()

  const canvas = createCanvas(2, 2)
  const context = canvas.getContext('2d')
  context.fillStyle = '#010203'
  context.fillRect(0, 0, 2, 2)
  const canvasPng = canvas.toBuffer('image/png')

  process.stdout.write(JSON.stringify({
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    modulesVersion: process.versions.modules,
    sharpPngBytes: sharpPng.length,
    canvasPngBytes: canvasPng.length,
    pdfParseExport: typeof PDFParse,
    vipsVersion: sharp.versions.vips
  }))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
