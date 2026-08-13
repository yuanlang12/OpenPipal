import { useState } from 'react'
import { Cpu, Mic, Monitor, Brain, Info, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ModelSettings } from './ModelSettings'
import { VoiceSettings } from './VoiceSettings'
import { AppSettings } from './AppSettings'
import { MemorySettings } from './MemorySettings'
import { AboutSection } from './AboutSection'
import { AppearanceSettings } from './AppearanceSettings'

type SettingsTab = 'appearance' | 'model' | 'voice' | 'apps' | 'memory' | 'about'

const TABS: { key: SettingsTab; icon: React.ReactNode }[] = [
  { key: 'appearance', icon: <Palette className="w-4 h-4" /> },
  { key: 'model', icon: <Cpu className="w-4 h-4" /> },
  { key: 'voice', icon: <Mic className="w-4 h-4" /> },
  { key: 'apps', icon: <Monitor className="w-4 h-4" /> },
  { key: 'memory', icon: <Brain className="w-4 h-4" /> },
  { key: 'about', icon: <Info className="w-4 h-4" /> },
]

export function SettingsPanel() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')

  return (
    <div className="flex h-full">
      {/* 左侧 tab 导航 */}
      <div className="w-44 shrink-0 bg-surface-50 border-r border-surface-100 py-4 px-2 flex flex-col">
        <h2 className="text-[10px] font-semibold text-surface-300 uppercase tracking-wider px-3 mb-2">
          {t('settings.title')}
        </h2>
        <nav className="space-y-0.5">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              aria-current={activeTab === tab.key ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30'
                  : 'text-surface-500 hover:text-surface-700 hover:bg-surface-100'
              }`}
            >
              {tab.icon}
              {t(`settings.tabs.${tab.key}`)}
            </button>
          ))}
        </nav>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {activeTab === 'appearance' && <AppearanceSettings />}
        {activeTab === 'model' && <ModelSettings />}
        {activeTab === 'voice' && <VoiceSettings />}
        {activeTab === 'apps' && <AppSettings />}
        {activeTab === 'memory' && <MemorySettings />}
        {activeTab === 'about' && <AboutSection />}
      </div>
    </div>
  )
}
