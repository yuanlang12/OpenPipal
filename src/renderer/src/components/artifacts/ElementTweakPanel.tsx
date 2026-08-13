import { useCallback, useEffect, useRef, useState } from 'react'
import { GripVertical, Link2, Link2Off, Settings, Mic } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocalSTT } from '../../hooks/useLocalSTT'

export interface TweakFields {
  text: string
  color: string
  backgroundColor: string
  opacity: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  borderRadius: string
  borderColor: string
  borderWidth: string
  width: string
  height: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  marginTop: string
  marginRight: string
  marginBottom: string
  marginLeft: string
}

interface ElementTweakPanelProps {
  tagName: string
  initial: TweakFields
  /** 面板整体可用高度上限(px)——由宿主(HtmlPreview)按容器剩余空间实时算出，封顶 60vh；
   * 缺省时退回 60vh（供本组件脱离宿主场景独立渲染时仍有兜底）。内部滚动区吸收超出部分，
   * 底栏(取消/✓)是 flex 尾部、不参与滚动，始终可见。 */
  maxHeight?: number
  onLivePreview: (fields: TweakFields) => void
  onCancel: () => void
  onConfirm: (fields: TweakFields, description: string) => void
}

const FONT_FAMILY_PRESETS = ['system-ui', 'serif', 'sans-serif', 'monospace']
const FONT_WEIGHT_OPTIONS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']
const CUSTOM_FONT = '__custom__'

const safeColor = (v: string): string => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : '#000000')
/** hex → "rgb(r, g, b)" 展示文本——参考设计的色块胶囊右侧显示的是 rgb(...) 格式而非 hex */
const hexToRgbText = (hex: string): string => {
  const h = safeColor(hex)
  const r = parseInt(h.slice(1, 3), 16)
  const g = parseInt(h.slice(3, 5), 16)
  const b = parseInt(h.slice(5, 7), 16)
  return `rgb(${r}, ${g}, ${b})`
}
const toNum = (v: string): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const pillCls =
  'h-7 min-w-0 flex-1 px-3 rounded-full border border-[#e4dbc9] dark:border-[#4a4438] bg-white dark:bg-[#3a352e] text-[12px] text-[#3d3527] dark:text-[#ecE3d4] outline-none focus:border-[#c9a876] dark:focus:border-[#8a7550] transition-colors'
const rowLabelCls = 'shrink-0 w-[76px] text-[12px] leading-tight break-words text-[#7a6f5c] dark:text-[#b3a68e]'
const groupCls = 'divide-y divide-[#e9e1d2] dark:divide-[#443e34]'
const rowCls = 'flex items-center gap-2 py-2'

/** 一个字段行：左标签 + 右侧胶囊控件（贯穿全面板的行布局，保持标签宽度一致对齐）*/
function FieldRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className={rowCls}>
      <span className={rowLabelCls}>{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

/** 色块胶囊：左侧圆形色块（叠一个透明的原生 color input 接管点击）+ 右侧 rgb(...) 值文本 */
function ColorField({ testId, value, onChange }: { testId: string; value: string; onChange: (hex: string) => void }): JSX.Element {
  const hex = safeColor(value)
  return (
    <div className={pillCls + ' flex items-center gap-2'}>
      <span className="relative h-4 w-4 shrink-0 rounded-full border border-black/10 dark:border-white/20" style={{ backgroundColor: hex }}>
        <input
          data-testid={testId}
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </span>
      <span className="truncate text-[11px]">{hexToRgbText(hex)}</span>
    </div>
  )
}

/** 数字输入 + px 后缀，同一个胶囊内 */
function PxField({ testId, value, onChange, min }: { testId: string; value: string; onChange: (v: string) => void; min?: number }): JSX.Element {
  return (
    <div className={pillCls + ' flex items-center gap-1 px-3'}>
      <input
        data-testid={testId}
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 bg-transparent outline-none text-[12px]"
      />
      <span className="shrink-0 text-[10px] text-[#9a8f78] dark:text-[#8a7d68]">px</span>
    </div>
  )
}

/**
 * 元素微调面板 —— comment 气泡「⚙ 展开」后出现，贴参考设计(Claude 浏览器批注面板)风格：
 * 暖米色卡片 + 全圆角胶囊控件 + 左标签右控件的行布局。
 * 纯受控展示：字段变化即回调 onLivePreview(全量当前字段)，由父组件(HtmlPreview)
 * postMessage 'tweak:preview' 驱动 iframe 内 live 预览；是否改了文本/样式的判定与
 * 直写 vs AI 改写分流也全部在父组件完成——本组件只管取值展示，不含业务判断。
 */
export function ElementTweakPanel({ tagName, initial, maxHeight, onLivePreview, onCancel, onConfirm }: ElementTweakPanelProps): JSX.Element {
  const { t } = useTranslation()
  const [fields, setFields] = useState<TweakFields>(initial)
  const [description, setDescription] = useState('')
  const [textFocused, setTextFocused] = useState(false)
  const [widthHeightLinked, setWidthHeightLinked] = useState(false)
  const aspectRatioRef = useRef<number | null>(null)
  const [fontCustom, setFontCustom] = useState(!FONT_FAMILY_PRESETS.includes(initial.fontFamily))
  // 「描述这些更改…」输入的麦克风听写：转写结果 append 到已有文本
  const descriptionStt = useLocalSTT(useCallback((t: string) => {
    setDescription((prev) => (prev ? `${prev} ${t}` : t))
  }, []))

  // 切换到新元素(initial 引用变化)时重置本地字段——避免残留上一个元素的编辑态
  useEffect(() => {
    setFields(initial)
    setDescription('')
    setTextFocused(false)
    setWidthHeightLinked(false)
    aspectRatioRef.current = null
    setFontCustom(!FONT_FAMILY_PRESETS.includes(initial.fontFamily))
  }, [initial])

  const update = (patch: Partial<TweakFields>): void => {
    const next = { ...fields, ...patch }
    setFields(next)
    onLivePreview(next)
  }

  const toggleLink = (): void => {
    const next = !widthHeightLinked
    if (next) {
      const w = toNum(fields.width)
      const h = toNum(fields.height)
      aspectRatioRef.current = h > 0 ? w / h : null
    } else {
      aspectRatioRef.current = null
    }
    setWidthHeightLinked(next)
  }

  const updateWidth = (v: string): void => {
    if (widthHeightLinked && aspectRatioRef.current) {
      const h = Math.round(toNum(v) / aspectRatioRef.current)
      update({ width: v, height: String(h) })
    } else {
      update({ width: v })
    }
  }

  const updateHeight = (v: string): void => {
    if (widthHeightLinked && aspectRatioRef.current) {
      const w = Math.round(toNum(v) * aspectRatioRef.current)
      update({ height: v, width: String(w) })
    } else {
      update({ height: v })
    }
  }

  return (
    <div
      data-testid="element-tweak-panel"
      className="w-full max-w-[340px] rounded-2xl border border-[#e4dbc9] dark:border-[#443e34] bg-[#f5f1ea] dark:bg-[#2b2721] shadow-xl overflow-hidden flex flex-col"
      style={{ maxHeight: maxHeight ? `${maxHeight}px` : '60vh' }}
    >
      {/* 顶栏：⚙ 圆形按钮 + 无边框「描述这些更改…」输入 */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 shrink-0">
        <span className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center bg-[#e9e1d2] dark:bg-[#3a352e] text-[#7a6f5c] dark:text-[#b3a68e]">
          <Settings size={12} />
        </span>
        <input
          data-testid="tweak-description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('artifacts.canvas.tweak.descriptionPlaceholder')}
          className="flex-1 min-w-0 h-6 bg-transparent outline-none text-[12px] text-[#3d3527] dark:text-[#ecE3d4] placeholder:text-[#a89b82] dark:placeholder:text-[#8a7d68]"
        />
        <button
          type="button"
          data-testid="tweak-description-mic"
          onClick={descriptionStt.toggle}
          title={descriptionStt.state === 'recording' ? t('artifacts.canvas.feedback.stopRecording') : descriptionStt.state === 'transcribing' ? t('artifacts.canvas.feedback.transcribing') : t('artifacts.canvas.feedback.voiceInput')}
          className={[
            'h-6 w-6 shrink-0 rounded-full flex items-center justify-center transition-colors',
            descriptionStt.state === 'recording'
              ? 'bg-red-500 text-white animate-pulse'
              : 'text-[#7a6f5c] dark:text-[#b3a68e] hover:bg-[#e9e1d2] dark:hover:bg-[#3a352e]'
          ].join(' ')}
        >
          <Mic size={12} />
        </button>
      </div>

      {/* 灰底 section 头：选中元素标签名 + 拖动把手(仅视觉) */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#ebe4d6] dark:bg-[#332e27] shrink-0">
        <span data-testid="tweak-tag-name" className="text-[11px] font-mono font-semibold text-[#5a5140] dark:text-[#c9bda3]">
          {tagName || 'element'}
        </span>
        <GripVertical size={13} className="text-[#b3a68e] dark:text-[#6b6250]" />
      </div>

      {/* 可滚动内容区：flex-1 min-h-0 吸收面板整体 max-height 的收缩——底栏是 flex 尾部，
          不在这个滚动子树里，收缩只会在这里出现滚动条，不会把底栏挤出可视区 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-4">
        {/* 组1：文本 */}
        <div className={groupCls}>
          <div className={rowCls}>
            <span className={rowLabelCls}>{t('artifacts.canvas.tweak.text')}</span>
            <div className="flex-1 min-w-0">
              {textFocused ? (
                <textarea
                  data-testid="tweak-field-text"
                  autoFocus
                  value={fields.text}
                  onChange={(e) => update({ text: e.target.value })}
                  onBlur={() => setTextFocused(false)}
                  rows={4}
                  className="w-full min-w-0 px-3 py-1.5 rounded-2xl border border-[#e4dbc9] dark:border-[#4a4438] bg-white dark:bg-[#3a352e] text-[12px] text-[#3d3527] dark:text-[#ecE3d4] outline-none resize-none"
                />
              ) : (
                <input
                  data-testid="tweak-field-text"
                  type="text"
                  value={fields.text}
                  onFocus={() => setTextFocused(true)}
                  onChange={(e) => update({ text: e.target.value })}
                  className={pillCls + ' truncate'}
                />
              )}
            </div>
          </div>
        </div>

        {/* 组2：文本颜色 / 背景 / Opacity */}
        <div className={groupCls}>
          <FieldRow label={t('artifacts.canvas.tweak.textColor')}>
            <ColorField testId="tweak-field-color" value={fields.color} onChange={(v) => update({ color: v })} />
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.background')}>
            <ColorField testId="tweak-field-bg" value={fields.backgroundColor} onChange={(v) => update({ backgroundColor: v })} />
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.opacity')}>
            <input
              data-testid="tweak-field-opacity"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={fields.opacity}
              onChange={(e) => update({ opacity: e.target.value })}
              className={pillCls}
            />
          </FieldRow>
        </div>

        {/* 组3：字体 / 字号 / 字重 */}
        <div className={groupCls}>
          <FieldRow label={t('artifacts.canvas.tweak.font')}>
            <div className="flex items-center gap-1.5">
              <select
                data-testid="tweak-field-font"
                value={fontCustom ? CUSTOM_FONT : fields.fontFamily}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_FONT) { setFontCustom(true); return }
                  setFontCustom(false)
                  update({ fontFamily: e.target.value })
                }}
                className={pillCls}
              >
                <option value={CUSTOM_FONT}>{fontCustom ? (fields.fontFamily || t('artifacts.canvas.tweak.customFont')) : t('artifacts.canvas.tweak.customFont')}</option>
                {FONT_FAMILY_PRESETS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            {fontCustom && (
              <input
                data-testid="tweak-field-font-custom"
                type="text"
                value={fields.fontFamily}
                onChange={(e) => update({ fontFamily: e.target.value })}
                placeholder={t('artifacts.canvas.tweak.customFontFamilyPlaceholder')}
                className={pillCls + ' mt-1.5'}
              />
            )}
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.fontSize')}>
            <PxField testId="tweak-field-font-size" value={fields.fontSize} onChange={(v) => update({ fontSize: v })} min={0} />
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.fontWeight')}>
            <select
              data-testid="tweak-field-font-weight"
              value={fields.fontWeight}
              onChange={(e) => update({ fontWeight: e.target.value })}
              className={pillCls}
            >
              {FONT_WEIGHT_OPTIONS.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </FieldRow>
        </div>

        {/* 组4：边框圆角 / 边框颜色 / 边框宽度 */}
        <div className={groupCls}>
          <FieldRow label={t('artifacts.canvas.tweak.radius')}>
            <PxField testId="tweak-field-border-radius" value={fields.borderRadius} onChange={(v) => update({ borderRadius: v })} min={0} />
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.borderColor')}>
            <ColorField testId="tweak-field-border-color" value={fields.borderColor} onChange={(v) => update({ borderColor: v })} />
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.borderWidth')}>
            <input
              data-testid="tweak-field-border-width"
              type="text"
              value={fields.borderWidth}
              onChange={(e) => update({ borderWidth: e.target.value })}
              placeholder={t('artifacts.canvas.tweak.borderWidthPlaceholder')}
              className={pillCls}
            />
          </FieldRow>
        </div>

        {/* 组5：宽度/高度(联动锁) / 内边距 / 外边距 */}
        <div className={groupCls}>
          <div className="flex items-start gap-2 py-2">
            <button
              type="button"
              data-testid="tweak-field-link-lock"
              onClick={toggleLink}
              title={widthHeightLinked ? t('artifacts.canvas.tweak.aspectLinked') : t('artifacts.canvas.tweak.aspectUnlinked')}
              aria-pressed={widthHeightLinked}
              className={[
                'h-7 w-7 shrink-0 mt-0 rounded-full flex items-center justify-center transition-colors',
                widthHeightLinked
                  ? 'bg-[#3d3527] text-[#f5f1ea] dark:bg-[#ecE3d4] dark:text-[#2b2721]'
                  : 'bg-[#e9e1d2] dark:bg-[#3a352e] text-[#7a6f5c] dark:text-[#b3a68e]'
              ].join(' ')}
            >
              {widthHeightLinked ? <Link2 size={12} /> : <Link2Off size={12} />}
            </button>
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={rowLabelCls}>{t('artifacts.canvas.tweak.width')}</span>
                <div className="flex-1 min-w-0">
                  <PxField testId="tweak-field-width" value={fields.width} onChange={updateWidth} min={0} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={rowLabelCls}>{t('artifacts.canvas.tweak.height')}</span>
                <div className="flex-1 min-w-0">
                  <PxField testId="tweak-field-height" value={fields.height} onChange={updateHeight} min={0} />
                </div>
              </div>
            </div>
          </div>

          <FieldRow label={t('artifacts.canvas.tweak.padding')}>
            <div className="flex items-center gap-1">
              <PxField testId="tweak-field-padding-top" value={fields.paddingTop} onChange={(v) => update({ paddingTop: v })} min={0} />
              <PxField testId="tweak-field-padding-right" value={fields.paddingRight} onChange={(v) => update({ paddingRight: v })} min={0} />
              <PxField testId="tweak-field-padding-bottom" value={fields.paddingBottom} onChange={(v) => update({ paddingBottom: v })} min={0} />
              <PxField testId="tweak-field-padding-left" value={fields.paddingLeft} onChange={(v) => update({ paddingLeft: v })} min={0} />
            </div>
          </FieldRow>
          <FieldRow label={t('artifacts.canvas.tweak.margin')}>
            <div className="flex items-center gap-1">
              <PxField testId="tweak-field-margin-top" value={fields.marginTop} onChange={(v) => update({ marginTop: v })} />
              <PxField testId="tweak-field-margin-right" value={fields.marginRight} onChange={(v) => update({ marginRight: v })} />
              <PxField testId="tweak-field-margin-bottom" value={fields.marginBottom} onChange={(v) => update({ marginBottom: v })} />
              <PxField testId="tweak-field-margin-left" value={fields.marginLeft} onChange={(v) => update({ marginLeft: v })} />
            </div>
          </FieldRow>
        </div>
      </div>

      {/* 底部：取消(胶囊) + 确认(圆形深色填充) */}
      <div className="flex items-center justify-between px-3 py-2.5 border-t border-[#e4dbc9] dark:border-[#443e34] shrink-0">
        <button
          data-testid="tweak-cancel"
          onClick={onCancel}
          className="h-7 px-4 rounded-full text-[12px] text-[#7a6f5c] dark:text-[#b3a68e] bg-[#ebe4d6] dark:bg-[#3a352e] hover:bg-[#e4dbc9] dark:hover:bg-[#443e34] transition-colors"
        >
          {t('artifacts.canvas.tweak.cancel')}
        </button>
        <button
          data-testid="tweak-confirm"
          onClick={() => onConfirm(fields, description)}
          title={t('artifacts.canvas.tweak.confirm')}
          aria-label={t('artifacts.canvas.tweak.confirm')}
          className="h-7 w-7 rounded-full flex items-center justify-center text-[13px] font-medium bg-[#3d3527] text-[#f5f1ea] dark:bg-[#ecE3d4] dark:text-[#2b2721] hover:opacity-90 transition-opacity"
        >
          ✓
        </button>
      </div>
    </div>
  )
}
