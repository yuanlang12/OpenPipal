import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置 — 与 electron-vite 完全隔离。
 * 只跑 tests/unit/**,环境是纯 node(不需要 jsdom/electron)。
 * 命令: npm run test:unit
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 5000,
    reporters: 'default'
  }
})
