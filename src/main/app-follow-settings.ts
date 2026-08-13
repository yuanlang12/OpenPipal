import { loadConfig, saveConfig } from './config-manager'

let cachedFollowingEnabled: boolean | null = null
let cachedDisabledApps: Set<string> | null = null
let cachedDetectedApps: Set<string> | null = null

function ensureSettingsCache(): void {
  if (cachedFollowingEnabled !== null && cachedDisabledApps && cachedDetectedApps) return
  const config = loadConfig()
  cachedFollowingEnabled = config.appFollowingEnabled !== false
  cachedDisabledApps = new Set(config.disabledApps || [])
  cachedDetectedApps = new Set(config.detectedApps || [])
}

export function isAppFollowingEnabled(): boolean {
  ensureSettingsCache()
  return cachedFollowingEnabled!
}

export function setAppFollowingEnabled(enabled: boolean): void {
  const config = { ...loadConfig(), appFollowingEnabled: enabled }
  saveConfig(config)
  cachedFollowingEnabled = enabled
}

export function getDisabledApps(): string[] {
  ensureSettingsCache()
  return Array.from(cachedDisabledApps!)
}

export function getDetectedApps(): string[] {
  ensureSettingsCache()
  return Array.from(cachedDetectedApps!)
}

export function setDisabledApps(apps: string[]): void {
  const config = { ...loadConfig(), disabledApps: apps }
  saveConfig(config)
  cachedDisabledApps = new Set(apps)
}

export function addDetectedApp(appName: string): void {
  ensureSettingsCache()
  if (cachedDetectedApps!.has(appName)) return
  const nextDetectedApps = new Set(cachedDetectedApps!)
  nextDetectedApps.add(appName)
  const config = { ...loadConfig(), detectedApps: Array.from(nextDetectedApps) }
  saveConfig(config)
  cachedDetectedApps = nextDetectedApps
}

export function isAppDisabled(appName: string): boolean {
  ensureSettingsCache()
  return cachedDisabledApps!.has(appName)
}

export function shouldFollowDetectedApp(appName: string): boolean {
  return isAppFollowingEnabled() && !isAppDisabled(appName)
}

export function resetAppFollowSettingsCacheForTests(): void {
  cachedFollowingEnabled = null
  cachedDisabledApps = null
  cachedDetectedApps = null
}
