/**
 * 捏头像的目录（只有 id 与说明）——主进程与渲染层共用一份，各配饰的 SVG 只在渲染层。
 *
 * 主进程要它做两件事：
 *   1. 组长在团队里建出来的 Pal 直接配一个头像（agents/<id>/mark.json），不再用 emoji；
 *   2. 把配饰清单连同"像什么角色"的提示写进 manage_team 的参数说明，让组长按角色挑。
 * 颜色与轮廓由 id 散列决定：同一个 Pal 每次一样，两个 Pal 一眼分得开。
 *
 * 颜色是两层（所有者 2026-09-16）：身体一个色、配饰另一个色——身体色是远看认人的主轴（Grok 那套"形状 × 颜色"），
 * 配饰色只负责和身体拉开、又看着和谐。随机配时从 MARK_ACCENTS 的搭配表里挑；手捏不受这张表限制。
 */

export const ACCESSORY_IDS = [
  'none', 'scarf', 'question', 'palette', 'briefcase', 'headphones',
  'glasses', 'gradcap', 'chefhat', 'hardhat', 'stetho', 'coffee',
  'pencil', 'magnifier', 'wrench', 'crown', 'bowtie', 'antenna',
  'catears', 'flower', 'note', 'badge',
] as const
export type AccessoryId = (typeof ACCESSORY_IDS)[number]

export const MARK_HUES = ['ink', 'red', 'blue', 'amber', 'slate', 'teal', 'sage', 'plum', 'rose'] as const
export type MarkHue = (typeof MARK_HUES)[number]

export const MARK_SHAPES = ['square', 'circle', 'drop', 'hexagon', 'cloud', 'triangle'] as const
export type MarkShape = (typeof MARK_SHAPES)[number]

export interface MarkConfig {
  accessory: AccessoryId
  /** 身体色 */
  hue: MarkHue
  /** 配饰色；没写时渲染层按搭配表取 hue 的头一个搭子（老 mark.json 只有 hue） */
  accent?: MarkHue
  shape: MarkShape
}

/**
 * 身体色 → 看着和谐、又拉得开的配饰色（每个身体两个搭子，随机配时按 id 二选一）。
 * 挑法：色相隔得远（互补或分裂互补），亮暗两套 token 下都不糊——暗色下九个 hue 亮度接近，全靠色相差认。
 *   墨 + 鼠尾草 / 琥珀：品牌黑绿、黑金
 *   红 + 青 / 石板：陶土配青、配灰蓝
 *   蓝 + 琥珀 / 玫瑰：藏青配金、蓝配粉
 *   琥珀 + 蓝 / 梅：金配藏青、芥末配梅紫
 *   石板 + 玫瑰 / 琥珀：灰蓝配粉、配金
 *   青 + 琥珀 / 玫瑰：青配芥末、青配粉
 *   鼠尾草 + 梅 / 玫瑰：橄榄配梅、绿配粉
 *   梅 + 鼠尾草 / 琥珀：梅配橄榄、配芥末
 *   玫瑰 + 青 / 鼠尾草：粉配青、粉配绿
 */
export const MARK_ACCENTS: Record<MarkHue, readonly [MarkHue, MarkHue]> = {
  ink: ['sage', 'amber'],
  red: ['teal', 'slate'],
  blue: ['amber', 'rose'],
  amber: ['blue', 'plum'],
  slate: ['rose', 'amber'],
  teal: ['amber', 'rose'],
  sage: ['plum', 'rose'],
  plum: ['sage', 'amber'],
  rose: ['teal', 'sage'],
}

/** 身体色的搭子：pick 偶数取头一个、奇数取第二个 */
export const accentFor = (hue: MarkHue, pick = 0): MarkHue => MARK_ACCENTS[hue][pick & 1]

/** 配饰像什么角色——给组长挑头像时看的一句话 */
export const ACCESSORY_HINTS: Record<AccessoryId, string> = {
  none: '不戴（通用）',
  scarf: '文艺、编辑、写作',
  question: '提问、调研、访谈',
  palette: '设计、视觉、前端',
  briefcase: '产品、项目、运营',
  headphones: '客服、音频、播客',
  glasses: '分析、评审、审阅',
  gradcap: '教学、辅导、学术',
  chefhat: '烹饪、配方、流程',
  hardhat: '工程、基建、部署',
  stetho: '医疗、健康、诊断',
  coffee: '陪聊、日常、助理',
  pencil: '出题、文案、起草',
  magnifier: '测试、QA、查错',
  wrench: '开发、修理、集成',
  crown: '决策、评委、终审',
  bowtie: '主持、礼仪、接待',
  antenna: '通信、集成、信号',
  catears: '轻松、陪伴、社群',
  flower: '生活、园艺、疗愈',
  note: '音乐、韵律、配乐',
  badge: '负责人、审核、把关',
}

export const isAccessoryId = (v: unknown): v is AccessoryId =>
  typeof v === 'string' && (ACCESSORY_IDS as readonly string[]).includes(v)
export const isMarkHue = (v: unknown): v is MarkHue =>
  typeof v === 'string' && (MARK_HUES as readonly string[]).includes(v)
export const isMarkShape = (v: unknown): v is MarkShape =>
  typeof v === 'string' && (MARK_SHAPES as readonly string[]).includes(v)

function hashSeed(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return hash
}

/** 团队的默认 mark 是六边形 + 徽章；Pal 组合时避开这两样，团队与 Pal 不会混。墨色留给没捏过的 Pal（emoji 底色） */
const TEAM_ACCESSORY: AccessoryId = 'badge'
const TEAM_SHAPE: MarkShape = 'hexagon'
const VIVID_HUES = MARK_HUES.filter(h => h !== 'ink')
/** 组长建成员时可挑的配饰（manage_team 的 look 参数只列这些） */
export const PAL_ACCESSORIES = ACCESSORY_IDS.filter(a => a !== 'none' && a !== TEAM_ACCESSORY)
const PAL_SHAPES = MARK_SHAPES.filter(s => s !== TEAM_SHAPE)

/** 团队没捏过头像时画的默认 mark：颜色按 id 散列，同一个团队每次一样 */
export function composeTeamMark(teamId: string): MarkConfig {
  const hash = hashSeed(teamId)
  const hue = VIVID_HUES[hash % VIVID_HUES.length]
  return { accessory: TEAM_ACCESSORY, hue, accent: accentFor(hue, hash >>> 4), shape: TEAM_SHAPE }
}

/**
 * 按 id 组合一个 Pal 的头像：配饰可指定（角色像什么就挑什么，认不出就散列挑），
 * 颜色与轮廓由 id 散列——确定性的"随机"，同一个 Pal 每次一样。各取散列的一段，互不牵连；
 * 配饰色不是独立随机，是身体色的搭子（搭配表二选一），保证随机出来的都和谐。
 */
export function composeMark(seed: string, accessory?: string | null): MarkConfig {
  const hash = hashSeed(seed)
  const hue = VIVID_HUES[(hash >>> 8) % VIVID_HUES.length]
  return {
    accessory: isAccessoryId(accessory) ? accessory : PAL_ACCESSORIES[hash % PAL_ACCESSORIES.length],
    hue,
    accent: accentFor(hue, hash >>> 12),
    shape: PAL_SHAPES[(hash >>> 16) % PAL_SHAPES.length],
  }
}
