import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // 串行执行，因为测试之间有依赖（共享对话状态）
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'] // 控制台实时输出
  ],
  use: {
    // 用 5174 避开主 repo 默认 vite 端口(5173) — worktree 并行开发时主 repo 的 vite 常驻 5173;
    // E2E 跑 worktree 自己的 vite (`npx vite --config src/renderer/vite.config.ts --port 5174 src/renderer`)
    // 合并回主 repo 前可改回 5173,或继续保留(不影响只跑主 repo 时启 5173 的场景,只是要起到 5174)
    // 端口可被 E2E_BASE_URL 覆盖：多个 worktree 并行时 5174 会被先起的那个占住，
    // 而占住它的可能是别的仓库副本——跑出来的绿是别人代码的绿，比红更危险。
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 420, height: 700 }, // 模拟 OpenPipal 侧栏窗口尺寸
      },
    },
  ],
})
