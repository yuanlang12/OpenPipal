import type { SupportedLocale } from '../../../shared/i18n/contract'

export type PreflowContextKind = 'brand' | 'screenshot' | 'codebase' | 'figma'

export interface PreflowTplOption {
  label: string
  subtitle?: string
  placeholder?: string
}

export interface PreflowField {
  id: string
  kind: 'text-options' | 'freeform'
  title: string
  subtitle?: string
  /** Legacy strings and richer presentation objects are both supported. */
  options?: Array<string | PreflowTplOption>
  default?: string
  multi?: boolean
  placeholder?: string
  display?: 'cards'
}

export type PreflowContextButton =
  | PreflowContextKind
  | { kind: PreflowContextKind; label?: string; subtitle?: string }

export interface PreflowLocaleFieldOverlay {
  title?: string
  subtitle?: string
  placeholder?: string
  /** Matched to the base field's options by index; behavior is never replaced. */
  options?: Array<string | Partial<PreflowTplOption>>
}

/**
 * Locale overlay for presentation and user-editable built-in drafts. It
 * deliberately excludes structured Runtime payload and behavior properties
 * such as field id/kind, allowSkip, dsSelector and asset category.
 */
export interface PreflowLocaleOverlay {
  title?: string
  inputPlaceholder?: string
  projectName?: { placeholder?: string }
  libraryTabs?: { artifacts?: string; systems?: string }
  systemsEmptyHint?: string
  systemsCreate?: { label?: string; kickoff?: string }
  contextButtons?: Partial<Record<PreflowContextKind, { label?: string; subtitle?: string }>>
  fields?: Record<string, PreflowLocaleFieldOverlay>
}

export interface PreflowManifest {
  title?: string
  projectName?: { enabled?: boolean; required?: boolean; placeholder?: string }
  fields?: PreflowField[]
  contextButtons?: PreflowContextButton[]
  allowSkip?: boolean
  inputPlaceholder?: string
  dsSelector?: { enabled?: boolean }
  /**
   * 前置页要不要带工作目录选择器。开着就把 WorkingDirBar 原样挂进输入卡下沿——
   * preflow 会整页替换欢迎页，不挂的话编码这类「先选仓库」的角色反而没地方选目录。
   * 目录直接写进 chatStore.conversationConfig.workingDir，不走 PreflowSubmitData。
   */
  workingDir?: { enabled?: boolean }
  libraryTabs?: { artifacts?: string; systems?: string }
  systemsEmptyHint?: string
  systemsCreate?: { label?: string; kickoff?: string }
  /** Base values remain the Simplified-Chinese/legacy fallback. */
  localeOverlays?: Partial<Record<SupportedLocale, PreflowLocaleOverlay>>
}

export function preflowOptionLabel(option: string | PreflowTplOption): string {
  return typeof option === 'string' ? option : option.label
}

export function preflowOptionMeta(option: string | PreflowTplOption): PreflowTplOption {
  return typeof option === 'string' ? { label: option } : option
}

function localizeOption(
  base: string | PreflowTplOption,
  overlay: string | Partial<PreflowTplOption> | undefined
): string | PreflowTplOption {
  if (overlay === undefined) return base
  if (typeof overlay === 'string') {
    return typeof base === 'string' ? overlay : { ...base, label: overlay }
  }
  const baseMeta = preflowOptionMeta(base)
  return { ...baseMeta, ...overlay, label: overlay.label || baseMeta.label }
}

/** Resolve only display properties, preserving every behavior and asset field. */
export function resolvePreflowManifest(
  manifest: PreflowManifest,
  locale: SupportedLocale
): PreflowManifest {
  const overlay = manifest.localeOverlays?.[locale]
  if (!overlay) return manifest

  return {
    ...manifest,
    title: overlay.title ?? manifest.title,
    inputPlaceholder: overlay.inputPlaceholder ?? manifest.inputPlaceholder,
    projectName: manifest.projectName
      ? { ...manifest.projectName, placeholder: overlay.projectName?.placeholder ?? manifest.projectName.placeholder }
      : manifest.projectName,
    libraryTabs: manifest.libraryTabs || overlay.libraryTabs
      ? {
          ...manifest.libraryTabs,
          artifacts: overlay.libraryTabs?.artifacts ?? manifest.libraryTabs?.artifacts,
          systems: overlay.libraryTabs?.systems ?? manifest.libraryTabs?.systems,
        }
      : undefined,
    systemsEmptyHint: overlay.systemsEmptyHint ?? manifest.systemsEmptyHint,
    systemsCreate: manifest.systemsCreate
      ? {
          ...manifest.systemsCreate,
          label: overlay.systemsCreate?.label ?? manifest.systemsCreate?.label,
          kickoff: overlay.systemsCreate?.kickoff ?? manifest.systemsCreate?.kickoff,
        }
      : undefined,
    contextButtons: manifest.contextButtons?.map((entry) => {
      const kind = typeof entry === 'string' ? entry : entry.kind
      const localized = overlay.contextButtons?.[kind]
      if (!localized) return entry
      return {
        ...(typeof entry === 'string' ? { kind } : entry),
        label: localized.label ?? (typeof entry === 'string' ? undefined : entry.label),
        subtitle: localized.subtitle ?? (typeof entry === 'string' ? undefined : entry.subtitle),
      }
    }),
    fields: manifest.fields?.map((field) => {
      const localized = overlay.fields?.[field.id]
      if (!localized) return field
      return {
        ...field,
        title: localized.title ?? field.title,
        subtitle: localized.subtitle ?? field.subtitle,
        placeholder: localized.placeholder ?? field.placeholder,
        options: field.options?.map((option, index) =>
          localizeOption(option, localized.options?.[index])
        ),
      }
    }),
  }
}

export interface PreflowOptionChoice extends PreflowTplOption {
  /** Stable value from the base manifest, independent of display locale. */
  value: string
}

export function getPreflowOptionChoices(
  baseField: PreflowField | undefined,
  localizedField: PreflowField | undefined
): PreflowOptionChoice[] {
  const baseOptions = baseField?.options || []
  const localizedOptions = localizedField?.options || baseOptions
  return baseOptions.map((base, index) => ({
    ...preflowOptionMeta(localizedOptions[index] ?? base),
    value: preflowOptionLabel(base),
  }))
}

/** Convert stable selections to display labels only; never persist this result. */
export function localizePreflowFieldValue(
  baseField: PreflowField,
  localizedField: PreflowField | undefined,
  value: unknown
): unknown {
  if (baseField.kind !== 'text-options') return value
  const choices = getPreflowOptionChoices(baseField, localizedField)
  const localizeOne = (item: unknown): unknown => {
    if (typeof item !== 'string') return item
    return choices.find(choice => choice.value === item)?.label ?? item
  }
  return Array.isArray(value) ? value.map(localizeOne) : localizeOne(value)
}
