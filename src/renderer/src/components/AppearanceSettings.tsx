/**
 * AppearanceSettings — 外观设置(对照 Codex codex-theme-v1 协议)
 *
 * 提供:主题模式切换 / 强调色 / 背景 / 前景 / 对比度 / 字体 / 半透明侧边栏 /
 *      Diff 颜色 / UI 字号 / 减少动效 / 复制主题字符串 / 导入主题字符串 / 重置默认
 */
import { useState, useRef } from 'react'
import { Copy, Check, RotateCcw, AlertCircle, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore, ThemeMode } from '../stores/appStore'
import { useThemeStore } from '../stores/themeStore'
import { DEFAULT_THEME, CHAT_DENSITY_TOKENS } from '../lib/theme'
import type { ChatDensity, OpenPipalThemeVariant, ThemeVariantKey } from '../types/theme'
import type { LocalePreference } from '../../../shared/i18n/contract'
import { resolveSystemLocale } from '../../../shared/i18n/contract'
import { getBrowserPreferredLanguages } from '../i18n'
import { AnchoredMenu } from './shared/AnchoredMenu'
import { useLocale } from '../i18n/LocaleProvider'

const THEME_MODE_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.appearance.theme.modes.light' },
  { value: 'dark', labelKey: 'settings.appearance.theme.modes.dark' },
  { value: 'system', labelKey: 'settings.appearance.theme.modes.system' },
]

const UI_FONT_PRESETS = [
  'DM Sans',
  'Inter',
  'PingFang SC',
  '-apple-system',
  'Helvetica Neue',
  'SF Pro Text',
  '方正悠宋',
]

const MONO_FONT_PRESETS = [
  'SF Mono',
  'JetBrains Mono',
  'Fira Code',
  'Menlo',
  'Cascadia Code',
  'Consolas',
]

const REDUCED_MOTION_OPTIONS: { value: 'system' | 'always' | 'never'; labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.appearance.reducedMotion.options.system' },
  { value: 'always', labelKey: 'settings.appearance.reducedMotion.options.always' },
  { value: 'never', labelKey: 'settings.appearance.reducedMotion.options.never' },
]

const CHAT_DENSITY_OPTIONS: { value: ChatDensity; key: 'compact' | 'comfortable' | 'relaxed' }[] = [
  { value: 'compact', key: 'compact' },
  { value: 'comfortable', key: 'comfortable' },
  { value: 'relaxed', key: 'relaxed' },
]

export function AppearanceSettings() {
  const { t } = useTranslation()
  const appTheme = useAppStore(s => s.theme)
  const setAppTheme = useAppStore(s => s.setTheme)
  const theme = useThemeStore(s => s.theme)
  const variant = useThemeStore(s => s.variant)
  const updateVariant = useThemeStore(s => s.updateVariant)
  const setUiZoom = useThemeStore(s => s.setUiZoom)
  const setChatDensity = useThemeStore(s => s.setChatDensity)
  const setReducedMotion = useThemeStore(s => s.setReducedMotion)
  const resetToDefault = useThemeStore(s => s.resetToDefault)
  const importFromString = useThemeStore(s => s.importFromString)
  const exportToString = useThemeStore(s => s.exportToString)

  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportToString())
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch {
      setCopyState('idle')
    }
  }

  const handleImport = () => {
    if (!importText.trim()) {
      setImportError(t('settings.appearance.themeString.pasteRequired'))
      return
    }
    const ok = importFromString(importText.trim())
    if (ok) {
      setImportText('')
      setImportError(null)
    } else {
      setImportError(t('settings.appearance.themeString.invalid'))
    }
  }

  const handleReset = () => {
    if (window.confirm(t('settings.appearance.themeString.resetConfirm'))) {
      resetToDefault()
      setImportText('')
      setImportError(null)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <Palette className="w-4 h-4 text-brand-500" />
        <h2 className="text-sm font-semibold text-ink-primary">{t('settings.appearance.title')}</h2>
      </div>

      <LanguageSettings />

      {/* 主题模式 */}
      <Section
        title={t('settings.appearance.theme.title')}
        description={t('settings.appearance.theme.description')}
      >
        <div className="flex gap-1.5">
          {THEME_MODE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setAppTheme(opt.value)}
              className={`flex-1 text-sw-sm py-1.5 rounded-lg border transition-colors ${
                appTheme === opt.value
                  ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 border-brand-200 dark:border-brand-700'
                  : 'bg-surface-secondary text-ink-secondary border-border hover:border-border-heavy'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
        <p className="text-sw-xs text-ink-tertiary mt-2">
          {t('settings.appearance.theme.effective', {
            theme: t(`settings.appearance.theme.effectiveValues.${variant}`),
          })}
        </p>
      </Section>

      {/* 浅色主题配色 */}
      <VariantSection
        title={t('settings.appearance.variants.lightTitle')}
        variantKey="light"
        variant={theme.light}
        onUpdate={(patch) => updateVariant('light', patch)}
      />

      {/* 深色主题配色 */}
      <VariantSection
        title={t('settings.appearance.variants.darkTitle')}
        variantKey="dark"
        variant={theme.dark}
        onUpdate={(patch) => updateVariant('dark', patch)}
      />

      {/* 全局偏好 */}
      <Section
        title={t('settings.appearance.uiScale.title')}
        description={t('settings.appearance.uiScale.description')}
      >
        <div className="flex items-center gap-3">
          <input
            data-testid="ui-font-scale"
            type="range"
            min={0.8}
            max={1.5}
            step={0.05}
            value={theme.uiZoom}
            onChange={(e) => setUiZoom(parseFloat(e.target.value))}
            className="flex-1 accent-brand-500"
          />
          <span className="text-sw-sm text-ink-secondary w-20 text-right tabular-nums">
            {Math.round(14 * theme.uiZoom * CHAT_DENSITY_TOKENS[theme.chatDensity].contentScale)}px · {Math.round(theme.uiZoom * 100)}%
          </span>
        </div>
      </Section>

      <Section
        title={t('settings.appearance.readingDensity.title')}
        description={t('settings.appearance.readingDensity.description')}
      >
        <div
          className="grid grid-cols-3 gap-2"
          role="radiogroup"
          aria-label={t('settings.appearance.readingDensity.ariaLabel')}
        >
          {CHAT_DENSITY_OPTIONS.map(opt => {
            const selected = theme.chatDensity === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`chat-density-${opt.value}`}
                onClick={() => setChatDensity(opt.value)}
                className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? 'border-brand-300 bg-brand-50 dark:border-brand-600 dark:bg-brand-900/30'
                    : 'border-border bg-surface-secondary hover:border-border-heavy'
                }`}
              >
                <span className={`block text-sw-sm font-medium ${selected ? 'text-brand-700 dark:text-brand-300' : 'text-ink-primary'}`}>
                  {t(`settings.appearance.readingDensity.options.${opt.key}.label`)}
                </span>
                <span className="mt-0.5 block text-sw-xs text-ink-tertiary">
                  {t(`settings.appearance.readingDensity.options.${opt.key}.description`)}
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      <Section
        title={t('settings.appearance.reducedMotion.title')}
        description={t('settings.appearance.reducedMotion.description')}
      >
        <div className="flex gap-1.5">
          {REDUCED_MOTION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setReducedMotion(opt.value)}
              className={`flex-1 text-sw-sm py-1.5 rounded-lg border transition-colors ${
                theme.reducedMotion === opt.value
                  ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 border-brand-200 dark:border-brand-700'
                  : 'bg-surface-secondary text-ink-secondary border-border hover:border-border-heavy'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </Section>

      {/* 主题字符串导入导出 */}
      <Section
        title={t('settings.appearance.themeString.title')}
        description={t('settings.appearance.themeString.description')}
      >
        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-sw-sm py-2 rounded-lg border border-border bg-surface-secondary text-ink-secondary hover:border-border-heavy transition-colors"
            >
              {copyState === 'copied' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-success" />
                  <span className="text-success">{t('settings.appearance.themeString.copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  {t('settings.appearance.themeString.copyCurrent')}
                </>
              )}
            </button>
            <button
              onClick={handleReset}
              className="inline-flex items-center justify-center gap-1.5 text-sw-sm py-2 px-4 rounded-lg border border-border bg-surface-secondary text-ink-secondary hover:border-border-heavy transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('settings.appearance.themeString.resetDefault')}
            </button>
          </div>
          <textarea
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value)
              if (importError) setImportError(null)
            }}
            placeholder={t('settings.appearance.themeString.placeholder')}
            rows={3}
            className="w-full text-sw-sm font-mono px-3 py-2 rounded-lg border border-border bg-surface-primary text-ink-primary placeholder:text-ink-tertiary focus:outline-none focus:border-border-focus resize-none"
          />
          {importError && (
            <p className="text-sw-xs text-danger flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {importError}
            </p>
          )}
          <button
            onClick={handleImport}
            disabled={!importText.trim()}
            className="w-full text-sw-sm py-2 rounded-lg bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t('settings.appearance.themeString.import')}
          </button>
        </div>
      </Section>
    </div>
  )
}

/* ════════════════════════════════════════════════════════
 * 子组件
 * ════════════════════════════════════════════════════════ */

const LOCALE_OPTIONS: { value: LocalePreference; labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.language.options.system' },
  { value: 'zh-CN', labelKey: 'settings.language.options.zhCN' },
  { value: 'en', labelKey: 'settings.language.options.english' },
]

function LanguageSettings(): JSX.Element {
  const { t } = useTranslation()
  const {
    preference,
    locale,
    pendingPreference,
    setLocalePreference,
  } = useLocale()
  const systemLocale = resolveSystemLocale(getBrowserPreferredLanguages())
  const localeLabel = (value: 'zh-CN' | 'en'): string => value === 'zh-CN'
    ? t('settings.language.options.zhCN')
    : t('settings.language.options.english')

  return (
    <Section
      title={t('settings.language.title')}
      description={t('settings.language.description')}
    >
      <select
        value={pendingPreference ?? preference}
        onChange={(event) => {
          void setLocalePreference(event.target.value as LocalePreference)
        }}
        aria-label={t('settings.language.preferenceLabel')}
        aria-busy={pendingPreference !== null}
        className="w-full rounded-lg border border-border bg-surface-primary px-3 py-2 text-sw-sm text-ink-primary focus:outline-none focus:border-border-focus"
      >
        {LOCALE_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
      <div className="mt-2 space-y-0.5 text-sw-xs text-ink-tertiary" aria-live="polite">
        <p>{t('settings.language.systemDetected', { locale: localeLabel(systemLocale) })}</p>
        <p>{t('settings.language.effectiveLocale', { locale: localeLabel(locale) })}</p>
        <p>{t('settings.language.appliesImmediately')}</p>
      </div>
    </Section>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2">
        <h3 className="text-sw-sm font-medium text-ink-primary">{title}</h3>
        {description && (
          <p className="text-sw-xs text-ink-tertiary mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </div>
  )
}

function VariantSection({
  title,
  variantKey,
  variant,
  onUpdate,
}: {
  title: string
  variantKey: ThemeVariantKey
  variant: OpenPipalThemeVariant
  onUpdate: (patch: Partial<OpenPipalThemeVariant>) => void
}) {
  const { t } = useTranslation()
  const activeVariant = useThemeStore(s => s.variant)
  const isActive = activeVariant === variantKey

  const handleResetVariant = () => {
    onUpdate(DEFAULT_THEME[variantKey])
  }

  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sw-sm font-medium text-ink-primary">{title}</h3>
          {isActive && (
            <span className="text-sw-xs px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300">
              {t('settings.appearance.variants.current')}
            </span>
          )}
        </div>
        <button
          onClick={handleResetVariant}
          className="text-sw-xs text-ink-tertiary hover:text-ink-secondary transition-colors"
        >
          {t('settings.appearance.variants.resetPreset')}
        </button>
      </div>

      <ColorRow
        label={t('settings.appearance.variants.accent')}
        value={variant.accent}
        onChange={(v) => onUpdate({ accent: v })}
      />
      <ColorRow
        label={t('settings.appearance.variants.background')}
        value={variant.surface}
        onChange={(v) => onUpdate({ surface: v })}
      />
      <ColorRow
        label={t('settings.appearance.variants.foreground')}
        value={variant.ink}
        onChange={(v) => onUpdate({ ink: v })}
      />

      <Row label={t('settings.appearance.variants.contrast')}>
        <div className="flex items-center gap-3 flex-1">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={variant.contrast}
            onChange={(e) => onUpdate({ contrast: parseInt(e.target.value, 10) })}
            className="flex-1 accent-brand-500"
          />
          <span className="text-sw-sm text-ink-secondary w-10 text-right tabular-nums">
            {variant.contrast}
          </span>
        </div>
      </Row>

      <Row label={t('settings.appearance.variants.uiFont')}>
        <FontInput
          value={variant.fonts.ui}
          presets={UI_FONT_PRESETS}
          onChange={(v) => onUpdate({ fonts: { ...variant.fonts, ui: v } })}
        />
      </Row>

      <Row label={t('settings.appearance.variants.monoFont')}>
        <FontInput
          value={variant.fonts.mono}
          presets={MONO_FONT_PRESETS}
          onChange={(v) => onUpdate({ fonts: { ...variant.fonts, mono: v } })}
        />
      </Row>

      <Row label={t('settings.appearance.variants.translucentSidebar')}>
        <Toggle
          checked={!variant.sidebarOpaque}
          onChange={(v) => onUpdate({ sidebarOpaque: !v })}
          label={t('settings.appearance.variants.translucentSidebar')}
        />
      </Row>

      <Row label={t('settings.appearance.variants.diffColors')}>
        <div className="flex gap-2 flex-1">
          <ColorSwatch
            value={variant.semantic.diffAdded ?? DEFAULT_THEME[variantKey].semantic.diffAdded ?? '#04B84C'}
            onChange={(v) =>
              onUpdate({ semantic: { ...variant.semantic, diffAdded: v } })
            }
          />
          <ColorSwatch
            value={variant.semantic.diffRemoved ?? DEFAULT_THEME[variantKey].semantic.diffRemoved ?? '#FA423E'}
            onChange={(v) =>
              onUpdate({ semantic: { ...variant.semantic, diffRemoved: v } })
            }
          />
        </div>
      </Row>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sw-sm text-ink-secondary w-24 shrink-0">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-2 flex-1">
        <ColorSwatch value={value} onChange={onChange} />
        <input
          type="text"
          value={value.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value
            if (/^#[0-9a-fA-F]{0,8}$/.test(v)) onChange(v)
          }}
          maxLength={9}
          className="text-sw-sm font-mono px-2 py-1 rounded border border-border bg-surface-primary text-ink-primary w-24 focus:outline-none focus:border-border-focus uppercase"
        />
      </div>
    </Row>
  )
}

function ColorSwatch({
  value,
  onChange,
}: {
  value: string
  onChange: (hex: string) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="relative">
      <button
        onClick={() => ref.current?.click()}
        className="w-7 h-7 rounded-md border border-border-heavy"
        style={{ backgroundColor: value }}
        aria-label={t('settings.appearance.variants.selectColorAriaLabel')}
      />
      <input
        ref={ref}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="absolute inset-0 opacity-0 pointer-events-none"
      />
    </div>
  )
}

function FontInput({
  value,
  presets,
  onChange,
}: {
  value: string
  presets: string[]
  onChange: (v: string) => void
}) {
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setShowDropdown(true)}
        // Esc 关掉后输入框仍持有焦点，onFocus 不会二次触发——不补这个就再也点不开了
        onClick={() => setShowDropdown(true)}
        data-testid="font-input"
        aria-haspopup="listbox"
        aria-expanded={showDropdown}
        className="w-full text-sw-sm px-2 py-1 rounded border border-border bg-surface-primary text-ink-primary focus:outline-none focus:border-border-focus"
        style={{ fontFamily: `"${value}", system-ui, sans-serif` }}
      />
      {/* 外观页在设置面板的 overflow-y-auto 里，absolute 浮层滚到下半屏会被裁掉；
          与模型页共用同一个锚定浮层，点外面 / Esc / 上下键也一并由它管 */}
      {showDropdown && (
        <AnchoredMenu
          anchorRef={inputRef}
          open
          onClose={() => setShowDropdown(false)}
          testId="font-suggestions"
        >
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              role="option"
              data-menu-item
              aria-selected={p === value}
              onClick={() => {
                onChange(p)
                setShowDropdown(false)
              }}
              className="w-full text-left text-sw-sm px-3 py-1.5 hover:bg-surface-secondary text-ink-secondary"
              style={{ fontFamily: `"${p}", system-ui, sans-serif` }}
            >
              {p}
            </button>
          ))}
        </AnchoredMenu>
      )}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full transition-colors relative ${
        checked ? 'bg-brand-500' : 'bg-surface-200'
      }`}
      aria-pressed={checked}
      aria-label={label}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
