/**
 * Main 进程失败结果 → 渲染层展示形态。
 *
 * Main 侧自造的文案带 `errorKey`（见 main-i18n.ts 的 mainError），渲染层用当前
 * UI 语言重新翻译；没有 errorKey 说明是外部文本（网关响应 / OS stderr / 第三方
 * message），原样透传不翻译。
 */
export interface MainErrorLike {
  error?: string
  errorKey?: string
  errorParams?: Record<string, unknown>
}

export interface DisplayError {
  key?: string
  values?: Record<string, unknown>
  raw?: string
}

export function toDisplayError(res: MainErrorLike | null | undefined, fallbackKey?: string): DisplayError {
  if (res?.errorKey) return { key: res.errorKey, values: res.errorParams }
  if (res?.error) return { raw: res.error }
  return { key: fallbackKey }
}

/** 展示形态 → 一行文案。key 优先（跟随 UI 语言），没有 key 就吐外部原文。 */
export function renderDisplayError(
  t: (key: string, values?: Record<string, unknown>) => string,
  display: DisplayError | null | undefined
): string {
  if (!display) return ''
  if (display.key) return t(display.key, display.values)
  return display.raw ?? ''
}
