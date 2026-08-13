import { useState, useEffect } from 'react'
import { TargetAppStatus } from '../types'

export function useTargetStatus(): TargetAppStatus {
  const [status, setStatus] = useState<TargetAppStatus>({ connected: false })

  useEffect(() => {
    const cleanupStatus = window.api.onTargetStatus((newStatus: TargetAppStatus) => {
      // Phase 2 调试用日志：用 warn 级别让 main 的 console-message 转发器抓到
      // （main 只转发 level≥2，info 级别看不到；验收通过后可以降回 console.log）
      console.warn('[useTargetStatus]', JSON.stringify({
        connected: newStatus.connected,
        appName: newStatus.appName,
        isFullscreen: newStatus.isFullscreen
      }))
      setStatus(newStatus)
    })
    const cleanupAppChanged = window.api.onAppChanged((_: string, displayName: string) => {
      setStatus((prev) => ({ ...prev, appName: displayName }))
    })
    return () => {
      cleanupStatus()
      cleanupAppChanged()
    }
  }, [])

  return status
}
