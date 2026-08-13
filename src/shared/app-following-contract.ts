export interface AppSettingsState {
  enabled: boolean
  detected: string[]
  disabled: string[]
  browsers: string[]
}

export interface AppFollowingUpdateResult {
  ok: true
  enabled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function parseAppSettingsState(value: unknown): AppSettingsState {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' ||
    !isStringArray(value.detected) || !isStringArray(value.disabled) || !isStringArray(value.browsers)) {
    throw new Error('OpenPipal app settings response is invalid')
  }
  return {
    enabled: value.enabled,
    detected: [...value.detected],
    disabled: [...value.disabled],
    browsers: [...value.browsers]
  }
}

export function parseAppFollowingUpdateResult(
  value: unknown,
  expectedEnabled: boolean
): AppFollowingUpdateResult {
  if (!isRecord(value) || value.ok !== true || value.enabled !== expectedEnabled) {
    throw new Error('OpenPipal app following response is invalid')
  }
  return { ok: true, enabled: expectedEnabled }
}

export function parseAppListUpdateResult(value: unknown): { ok: true } {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('OpenPipal disabled apps response is invalid')
  }
  return { ok: true }
}
