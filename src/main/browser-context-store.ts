export interface BrowserContext {
  tabId?: number
  url?: string
  title?: string
  selectedText?: string
  subtitles?: string
  pageContent?: string
  pdfBase64?: string
  contentNote?: string
  meta?: Record<string, unknown>
}

let currentBrowserContext: BrowserContext | null = null
let extensionActive = false

export function getBrowserContext(): BrowserContext | null {
  return currentBrowserContext
}

export function setBrowserContext(context: BrowserContext | null): void {
  currentBrowserContext = context
}

export function isExtensionActive(): boolean {
  return extensionActive
}

export function markExtensionActive(): void {
  extensionActive = true
}
