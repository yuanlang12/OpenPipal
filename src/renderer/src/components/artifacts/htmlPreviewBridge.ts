export interface HtmlPreviewBridgeCopy {
  commentOverlay: string
}

const COPY_MARKER = '__OPENPIPAL_PREVIEW_COPY__'

/**
 * Serialize localized product copy before it enters an iframe script.
 * Escaping `<` prevents a translation from closing the surrounding script tag.
 */
export function serializeHtmlPreviewBridgeCopy(copy: HtmlPreviewBridgeCopy): string {
  return JSON.stringify(copy).replace(/</g, '\\u003c')
}

export function buildHtmlPreviewBridgeScript(
  template: string,
  copy: HtmlPreviewBridgeCopy
): string {
  if (!template.includes(COPY_MARKER)) {
    throw new Error('HtmlPreview bridge copy marker is missing')
  }
  return template.replace(COPY_MARKER, serializeHtmlPreviewBridgeCopy(copy))
}

/** A content echo may skip one reload, but it must never swallow a locale bridge update. */
export function shouldSkipSelfEditEcho(
  selfEdit: string | null,
  content: string,
  bridgeChanged: boolean
): boolean {
  return !bridgeChanged && selfEdit !== null && selfEdit === content
}
