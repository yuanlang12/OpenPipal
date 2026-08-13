import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  bundle: true,
  // 只 bundle ACP SDK——其他都 external（Node 内置 + 用户安装的运行时依赖）
  // 不 bundle undici 避免 ESM 解 require('assert') 的死局；改用 Node 20+ 内置 fetch
  noExternal: ['@agentclientprotocol/sdk'],
  platform: 'node',
  // 给 bin 加 shebang
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  minify: false,
})
