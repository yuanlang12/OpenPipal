/**
 * 配饰目录 —— 角色身份挂在配饰上，不挂在眼型上（眼型是核心符号，六个角色一模一样）。
 *
 * 分层：默认画在身体**上层**，眼镜这类必须压住眼睛的道具才成立；只有真要绕到脑后的
 * 部件（耳机头梁、猫耳、天线杆）走 `behind`。这是每件配饰自己的属性，不是全局 z-index。
 *
 * 坐标系同 geometry：中心原点，瓷砖 ±32，道具可越界到 ±56（SVG overflow: visible，
 * 不改变布局盒，所以接入时不用动任何调用处的尺寸）。
 * 颜色一律 `currentColor`，由 <g style="color: var(--sw-mark-<hue>)"> 注入。
 */

export type AccessoryId =
  | 'none' | 'scarf' | 'question' | 'palette' | 'briefcase' | 'headphones'
  | 'glasses' | 'gradcap' | 'chefhat' | 'hardhat' | 'stetho' | 'coffee'
  | 'pencil' | 'magnifier' | 'wrench' | 'crown' | 'bowtie' | 'antenna'
  | 'catears' | 'flower' | 'note' | 'badge'

export interface Accessory {
  id: AccessoryId
  /** i18n key 后缀；显示名走 t(`agentMark.accessory.${id}`) */
  labelKey: AccessoryId
  behind?: string
  front?: string
}

const paper = (x: number, y: number, r: number, o = 1): string =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--sw-mark-paper)" opacity="${o}"/>`

const petals = [0, 72, 144, 216, 288]
  .map((a) => `<circle cx="${(Math.cos((a * Math.PI) / 180) * 8).toFixed(2)}" cy="${(Math.sin((a * Math.PI) / 180) * 8).toFixed(2)}" r="6" fill="currentColor"/>`)
  .join('')

export const ACCESSORIES: Accessory[] = [
  { id: 'none', labelKey: 'none' },

  { id: 'scarf', labelKey: 'scarf', front:
    `<path d="M-38 18 Q0 32 38 18 L38 30 Q0 44 -38 30 Z" fill="currentColor"/>`
    + `<path d="M23 28 L36 24 L40 44 Q31 48 25 43 Z" fill="currentColor" opacity=".85"/>` },

  { id: 'question', labelKey: 'question', front:
    `<g transform="translate(31 -33)"><path d="M-7 -6 A7.5 7.5 0 1 1 .5 3 L.5 7.5" fill="none"`
    + ` stroke="currentColor" stroke-width="6" stroke-linecap="round"/>`
    + `<circle cx=".5" cy="16" r="3.4" fill="currentColor"/></g>` },

  { id: 'palette', labelKey: 'palette', front:
    `<g transform="translate(-36 16) rotate(-16)"><path d="M0 -18 A18 18 0 1 0 5 16 A4.6 4.6 0 0 1 8 8 A15 15 0 0 0 0 -18 Z" fill="currentColor"/>`
    + paper(-6, -8, 3.6) + paper(-11, 2, 3.6, 0.6) + paper(-3, 10, 3.6) + `</g>` },

  { id: 'briefcase', labelKey: 'briefcase', front:
    `<g transform="translate(30 24) rotate(8)"><path d="M-6 -10 V-13 A3 3 0 0 1 -3 -16 H3 A3 3 0 0 1 6 -13 V-10" fill="none" stroke="currentColor" stroke-width="3.2"/>`
    + `<rect x="-16" y="-10" width="32" height="23" rx="3.5" fill="currentColor"/>`
    + `<rect x="-16" y="-2" width="32" height="3.2" fill="var(--sw-mark-paper)" opacity=".55"/></g>` },

  { id: 'headphones', labelKey: 'headphones',
    behind: `<path d="M-36 -6 A36 36 0 0 1 36 -6" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>`,
    front: `<rect x="-44" y="-8" width="13" height="25" rx="6" fill="currentColor"/>`
      + `<rect x="31" y="-8" width="13" height="25" rx="6" fill="currentColor"/>` },

  { id: 'glasses', labelKey: 'glasses', front:
    `<g fill="none" stroke="currentColor" stroke-width="3.4">`
    + `<rect x="-20" y="-16" width="24" height="24" rx="8" transform="rotate(-11 -8 -4)"/>`
    + `<rect x="2" y="-21" width="24" height="24" rx="8" transform="rotate(-18 14 -9)"/>`
    + `<path d="M-21 -8 L-33 -12"/><path d="M26 -13 L36 -18"/></g>` },

  { id: 'gradcap', labelKey: 'gradcap', front:
    `<path d="M-32 -36 L0 -49 L32 -36 L0 -23 Z" fill="currentColor"/>`
    + `<path d="M-13 -31 L13 -31 L11 -20 Q0 -14 -11 -20 Z" fill="currentColor" opacity=".85"/>`
    + `<path d="M27 -37 L27 -20" stroke="currentColor" stroke-width="3"/>`
    + `<circle cx="27" cy="-17" r="4.5" fill="currentColor"/>` },

  { id: 'chefhat', labelKey: 'chefhat', front:
    `<path d="M-23 -32 Q-36 -54 -14 -52 Q-5 -63 8 -56 Q29 -57 23 -34 Z" fill="currentColor"/>`
    + `<rect x="-24" y="-35" width="48" height="9" rx="3" fill="currentColor" opacity=".8"/>` },

  { id: 'hardhat', labelKey: 'hardhat', front:
    `<path d="M-25 -32 A25 25 0 0 1 25 -32 Z" fill="currentColor"/>`
    + `<rect x="-34" y="-35" width="68" height="7" rx="3.5" fill="currentColor"/>` },

  { id: 'stetho', labelKey: 'stetho', front:
    `<path d="M-24 6 Q-30 34 -6 37 Q14 40 16 24" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round"/>`
    + `<circle cx="17" cy="18" r="8" fill="currentColor"/><circle cx="-24" cy="4" r="4" fill="currentColor"/>` },

  { id: 'coffee', labelKey: 'coffee', front:
    `<g transform="translate(30 26)"><path d="M-11 -9 H11 L8.5 12 Q0 16 -8.5 12 Z" fill="currentColor"/>`
    + `<path d="M11 -4 A6 6 0 0 1 11 6" fill="none" stroke="currentColor" stroke-width="3"/></g>` },

  { id: 'pencil', labelKey: 'pencil', front:
    `<g transform="translate(30 -6) rotate(24)"><rect x="-4.5" y="-22" width="9" height="32" rx="1.5" fill="currentColor"/>`
    + `<path d="M-4.5 10 L4.5 10 L0 20 Z" fill="currentColor"/></g>` },

  { id: 'magnifier', labelKey: 'magnifier', front:
    `<g transform="translate(31 14)"><circle cx="0" cy="-6" r="12" fill="none" stroke="currentColor" stroke-width="4.5"/>`
    + `<path d="M8 3 L18 14" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/></g>` },

  { id: 'wrench', labelKey: 'wrench', front:
    `<g transform="translate(32 12) rotate(38)"><path d="M-4 -20 A9 9 0 1 0 4 -20 L4 -13 L-4 -13 Z" fill="currentColor"/>`
    + `<rect x="-3.6" y="-14" width="7.2" height="30" rx="3" fill="currentColor"/></g>` },

  { id: 'crown', labelKey: 'crown', front:
    `<path d="M-25 -31 L-25 -50 L-12 -39 L0 -55 L12 -39 L25 -50 L25 -31 Z" fill="currentColor"/>` },

  { id: 'bowtie', labelKey: 'bowtie', front:
    `<path d="M-3 26 L-22 15 L-22 37 Z" fill="currentColor"/><path d="M3 26 L22 15 L22 37 Z" fill="currentColor"/>`
    + `<rect x="-5" y="20" width="10" height="12" rx="3" fill="currentColor"/>` },

  { id: 'antenna', labelKey: 'antenna',
    behind: `<path d="M0 -30 L0 -46" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>`,
    front: `<circle cx="0" cy="-51" r="6.5" fill="currentColor"/>` },

  { id: 'catears', labelKey: 'catears',
    behind: `<path d="M-28 -26 L-22 -52 L-4 -32 Z" fill="currentColor"/><path d="M28 -26 L22 -52 L4 -32 Z" fill="currentColor"/>` },

  { id: 'flower', labelKey: 'flower', front:
    `<g transform="translate(-28 -30)">${petals}${paper(0, 0, 4.4, 0.8)}</g>` },

  { id: 'note', labelKey: 'note', front:
    `<g transform="translate(30 -30)"><path d="M-2 10 L-2 -16 L14 -21 L14 -13 L4 -10 L4 10" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>`
    + `<circle cx="-6" cy="11" r="5.6" fill="currentColor"/><circle cx="8" cy="8" r="5.6" fill="currentColor"/></g>` },

  { id: 'badge', labelKey: 'badge', front:
    `<g transform="translate(-27 26)"><circle cx="0" cy="0" r="11" fill="currentColor"/>`
    + `<path d="M-4.5 0 L-1 3.6 L5 -3.4" fill="none" stroke="var(--sw-mark-paper)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>` },
]

export const ACCESSORY_BY_ID = new Map<string, Accessory>(ACCESSORIES.map((a) => [a.id, a]))

/** 配饰色 —— 走 token 层，不写死 hex；改种子色一次换掉所有用法。 */
export type MarkHue = 'ink' | 'red' | 'blue' | 'amber' | 'slate' | 'teal' | 'sage' | 'plum' | 'rose'
export const MARK_HUES: MarkHue[] = ['ink', 'red', 'blue', 'amber', 'slate', 'teal', 'sage', 'plum', 'rose']
export const hueVar = (hue: MarkHue): string => `var(--sw-mark-${hue})`

/**
 * 磁盘上的值是**不可信的字符串** —— 主进程只保证"是个短 slug"，认不认得出归这里判。
 * 认不出就当没设置，回落到角色默认；绝不把未知 id 塞进渲染（未知色号会解析成
 * 无效的 CSS 变量，配饰直接变透明，比回落默认难查得多）。
 */
export const isAccessoryId = (v: unknown): v is AccessoryId =>
  typeof v === 'string' && ACCESSORY_BY_ID.has(v)

export const isMarkHue = (v: unknown): v is MarkHue =>
  typeof v === 'string' && (MARK_HUES as string[]).includes(v)
