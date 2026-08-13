export interface SyntheticStreamErrorMerge {
  content: string
  offset: number
}

/**
 * Main/SSE may already have emitted the terminal error as a stream chunk
 * before stream-end repeats the same error. Produce one tagged suffix and its
 * exact display offset without interpreting any earlier model text.
 */
export function mergeSyntheticStreamError(buffered: string, error: string): SyntheticStreamErrorMerge {
  const sentinel = `[Error] ${error}`
  const emittedSuffix = `\n\n${sentinel}`
  if (buffered === emittedSuffix) return { content: sentinel, offset: 0 }
  if (buffered.endsWith(emittedSuffix)) {
    return { content: buffered, offset: buffered.length - sentinel.length }
  }
  if (buffered === sentinel) return { content: buffered, offset: 0 }
  const separator = buffered ? '\n\n' : ''
  return {
    content: `${buffered}${separator}${sentinel}`,
    offset: buffered.length + separator.length
  }
}
