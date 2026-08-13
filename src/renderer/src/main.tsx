import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PresenterView } from './components/PresenterView'
import './styles/openpipal-ds.css'
import './styles/glass.css'
import './styles/tokens.css'
import './styles/global.css'
import './styles/shimmer.css'
import { installWebApiShim } from './web-api-shim'
import { initThemeOnLoad } from './stores/themeStore'
import {
  getBrowserPreferredLanguages,
  initializeRendererI18n,
  resolveInitialLocaleState,
} from './i18n'
import { LocaleProvider } from './i18n/LocaleProvider'
import { resolveSystemLocale, type SupportedLocale } from '../../shared/i18n/contract'
import { fatalStartupText } from './i18n/fatalStartup'

// 环境检测：浏览器中没有 Electron preload bridge，安装 Web API shim
if (!window.api) {
  installWebApiShim()
}

// 启动时立即应用主题(避免 :root 未注入 CSS variables 时的闪烁)
initThemeOnLoad()

// URL 查询参数分流：?view=presenter → PresenterView（独立小窗口），否则主 App
// 不用多入口/多 html，完全复用一套 Vite 配置（遵循"不重复造轮子"）
const params = new URLSearchParams(window.location.search)
const view = params.get('view')
let fatalLocale: SupportedLocale = resolveSystemLocale(getBrowserPreferredLanguages())

async function bootstrap(): Promise<void> {
  let initialLocaleState = await resolveInitialLocaleState({
    getLocaleState: window.api.getLocaleState,
  })
  fatalLocale = initialLocaleState.locale
  try {
    await initializeRendererI18n(initialLocaleState.locale)
  } catch (error) {
    // Bundled Simplified Chinese is the authoritative last-resort catalogue.
    // A locale bootstrap failure must not leave the application root blank.
    console.error('[Locale] renderer initialization failed, using bundled fallback:', error)
    initialLocaleState = { preference: 'system', locale: 'zh-CN' }
    await initializeRendererI18n('zh-CN')
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initialState={initialLocaleState}>
        {view === 'presenter' ? <PresenterView /> : <App />}
      </LocaleProvider>
    </React.StrictMode>
  )
}

void bootstrap().catch((error) => {
  console.error('[Startup] renderer bootstrap failed:', error)
  const root = document.getElementById('root')
  document.documentElement.lang = fatalLocale
  document.documentElement.dir = 'ltr'
  if (root) root.textContent = fatalStartupText(fatalLocale)
})
