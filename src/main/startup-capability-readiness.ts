/**
 * 初始化一类可选的首轮能力。
 *
 * preload 与 initialize 对该能力保持严格顺序；任一阶段失败都会留下
 * 诊断并收敛为已处理状态，避免阻断其它能力或主窗口。
 */
export async function initializeOptionalStartupCapability(
  label: string,
  preload: () => Promise<void>,
  initialize: () => void
): Promise<void> {
  try {
    await preload()
    initialize()
  } catch (err) {
    console.error(`[Startup] ${label}初始化失败，将以降级能力继续启动:`, err)
  }
}
