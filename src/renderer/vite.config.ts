import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const projectRoot = resolve(__dirname, '../..')
const pkgVersion = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')).version as string

// 独立 renderer dev server 配置（仅用于 E2E 测试）
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion)
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src')
    }
  },
  css: {
    postcss: {
      plugins: [
        // E2E/Browser preview must compile the same token-backed classes as
        // the Electron renderer; a second hard-coded palette made visual QA lie.
        tailwindcss(resolve(projectRoot, 'tailwind.config.js')),
        autoprefixer()
      ]
    }
  }
})
