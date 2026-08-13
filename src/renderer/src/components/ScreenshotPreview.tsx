import { X } from 'lucide-react'

interface ScreenshotPreviewProps {
  screenshot: string
  onRemove: () => void
}

export function ScreenshotPreview({ screenshot, onRemove }: ScreenshotPreviewProps) {
  return (
    <div className="relative inline-block mx-3 mt-2">
      <img
        src={`data:image/jpeg;base64,${screenshot}`}
        alt="preview"
        className="h-16 rounded-md border border-surface-100"
      />
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-surface-600 hover:bg-surface-700 rounded-full flex items-center justify-center text-surface-0 transition-colors"
      >
        <X className="w-2.5 h-2.5" strokeWidth={3} />
      </button>
    </div>
  )
}
