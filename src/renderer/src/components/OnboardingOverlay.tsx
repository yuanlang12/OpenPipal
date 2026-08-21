import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../stores/appStore'
import { AgentMark, type ExpressionId, type AccessoryId, type MarkHue } from './agent-mark'

interface OnboardingApi {
  getOnboardingStatus?: () => Promise<{ completed: boolean }>
  completeOnboarding?: () => Promise<{ ok: boolean }>
}

function getOnboardingApi(): typeof window.api & OnboardingApi {
  return window.api as typeof window.api & OnboardingApi
}

/**
 * OnboardingOverlay — 首次启动的全屏四步引导
 *
 * 触发: `~/.openpipal/config.json` 中 onboardingCompleted !== true;
 * 设置页「重看一遍引导」发 `openpipal:show-onboarding` 事件随时重放。
 * 完成/跳过: 写入 true,后续启动不再展示。
 *
 * 四屏讲产品的四个核心点: 极简 pi 内核 → 随时捏自己的 Agent →
 * 把 Agent 当 ACP 服务发给别的应用 → 预制 Agent 全家福。
 * 引导动线是 Agent Mark 本体:第 2 步它被"捏"上配饰,之后一路戴着——
 * 先去编辑器里当服务,最后站进全家福的空位。插画全部是代码画的 mock,零位图。
 */

type StepKey = 'welcome' | 'create' | 'acp' | 'presets'

interface StepDef {
  key: StepKey
  expression: ExpressionId
  /** 第 2 步捏上配饰后一直戴着,叙事上它从"官方标识"变成"你的 Agent"。
      配饰要给非 ink 的 hue,否则和身体同色、只剩一个轮廓鼓包 */
  accessory: AccessoryId
  hue: MarkHue
  /** Mark 在插画卡内的落点(百分比),步进时用弹性曲线滑过去 */
  mark: { left: string; top: string }
}

const STEPS: StepDef[] = [
  { key: 'welcome', expression: 'neutral', accessory: 'none', hue: 'ink', mark: { left: '36%', top: '45%' } },
  { key: 'create', expression: 'happy', accessory: 'bowtie', hue: 'red', mark: { left: '38%', top: '52%' } },
  { key: 'acp', expression: 'focused', accessory: 'bowtie', hue: 'red', mark: { left: '84.5%', top: '42%' } },
  { key: 'presets', expression: 'proud', accessory: 'bowtie', hue: 'red', mark: { left: '77.5%', top: '44%' } },
]

/** Mark 滑动的弹性曲线:略过冲再落位,才像"跑过去"而不是"平移" */
const GLIDE = 'left 0.7s cubic-bezier(0.3, 1.25, 0.4, 1), top 0.7s cubic-bezier(0.3, 1.25, 0.4, 1)'

export function OnboardingOverlay(): JSX.Element | null {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)
  const setActiveView = useAppStore(s => s.setActiveView)

  useEffect(() => {
    let cancelled = false
    getOnboardingApi().getOnboardingStatus?.().then((res) => {
      if (!cancelled && !res?.completed) setVisible(true)
    })
    // 设置页「重看引导」入口:不重置 config,只是再放一遍
    const replay = (): void => { setStep(0); setVisible(true) }
    window.addEventListener('openpipal:show-onboarding', replay)
    return () => {
      cancelled = true
      window.removeEventListener('openpipal:show-onboarding', replay)
    }
  }, [])

  const finish = async (): Promise<void> => {
    await getOnboardingApi().completeOnboarding?.()
    setVisible(false)
  }

  const next = (): void => {
    if (step >= STEPS.length - 1) void finish()
    else setStep(step + 1)
  }
  const back = (): void => { if (step > 0) setStep(step - 1) }

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      // 焦点在按钮上时 Enter 已触发 click,再吃一次会连跳两步
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'BUTTON') return
      if (e.key === 'Escape') void finish()
      else if (e.key === 'Enter' || e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, step])

  if (!visible) return null

  const cur = STEPS[step]
  const isLast = step === STEPS.length - 1

  const openView = (view: 'settings' | 'agents'): void => {
    setActiveView(view)
    void finish()
  }

  const titles: Record<StepKey, string> = {
    welcome: t('onboarding.welcomeTitle'),
    create: t('onboarding.steps.create.title'),
    acp: t('onboarding.steps.acp.title'),
    presets: t('onboarding.steps.presets.title'),
  }
  const descs: Record<StepKey, string> = {
    welcome: t('onboarding.subtitle'),
    create: t('onboarding.steps.create.description'),
    acp: t('onboarding.steps.acp.description'),
    presets: t('onboarding.steps.presets.description'),
  }
  const ctas: Partial<Record<StepKey, { label: string; onClick: () => void }>> = {
    create: { label: t('onboarding.steps.create.action'), onClick: () => openView('agents') },
    presets: { label: t('onboarding.steps.presets.action'), onClick: () => openView('settings') },
  }
  const cta = ctas[cur.key]

  return (
    <div
      data-testid="onboarding-overlay"
      className="absolute inset-0 z-[60] bg-surface-0 flex flex-col animate-fade-in"
    >
      {/* 顶部留白兼拖拽区;跳过永远可达 */}
      <div className="h-12 shrink-0 relative">
        <button
          data-testid="onboarding-skip"
          onClick={() => void finish()}
          aria-label={t('onboarding.skipAriaLabel')}
          className="absolute right-5 top-4 text-[12px] text-surface-400 hover:text-surface-600 transition-colors"
        >
          {t('onboarding.actions.skip')}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-7 px-6 pb-2">
        {/* 标题区:key 换步重放入场动画 */}
        <div className="text-center max-w-[620px]">
          <h1
            key={`t${step}`}
            data-testid="onboarding-step-title"
            className="animate-fade-in text-[clamp(22px,3.2vw,30px)] font-semibold tracking-tight leading-snug text-surface-800"
            style={{ textWrap: 'balance' } as React.CSSProperties}
          >
            {titles[cur.key]}
          </h1>
          <p key={`d${step}`} className="animate-fade-in mt-2.5 mx-auto max-w-[52ch] text-[13.5px] leading-relaxed text-surface-500">
            {descs[cur.key]}
          </p>
          {cta && (
            <button
              key={`c${step}`}
              data-testid="onboarding-step-cta"
              onClick={cta.onClick}
              className="animate-fade-in inline-flex items-center gap-1 mt-3.5 pl-3.5 pr-2.5 h-8 rounded-full border border-surface-200 text-[12.5px] font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors"
            >
              {cta.label}
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 插画卡:品牌渐变底 + 代码 mock,Mark 作为引导动线浮在最上层。
            Mark 落点约定:永远压在白色 mock 表面上(深色主题下表面变深、mark 自动反相)。 */}
        <div
          aria-hidden
          className="relative w-[min(92%,600px)] aspect-[8/5] shrink-0 rounded-[28px] overflow-hidden shadow-2xl bg-gradient-to-br from-brand-400 to-brand-600 dark:from-brand-600 dark:to-brand-800"
        >
          {/* 左上柔光,让渐变有"打了盏灯"的体积感 */}
          <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_18%_-10%,rgba(255,255,255,0.38),transparent_55%)] dark:bg-[radial-gradient(120%_90%_at_18%_-10%,rgba(255,255,255,0.14),transparent_55%)]" />

          <Scene active={step === 0}><SceneMinimal /></Scene>
          <Scene active={step === 1}><SceneStudio /></Scene>
          <Scene active={step === 2}><SceneServe /></Scene>
          <Scene active={step === 3}><SceneCrew /></Scene>

          <div
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2 drop-shadow-lg pointer-events-none"
            style={{ left: cur.mark.left, top: cur.mark.top, transition: GLIDE }}
          >
            <AgentMark size={60} animated expression={cur.expression} accessory={cur.accessory} hue={cur.hue} />
          </div>
        </div>
      </div>

      {/* 底部:进度点 + 双胶囊按钮(参照系统级引导的黑白双钮) */}
      <div className="shrink-0 flex flex-col items-center gap-5 pt-3 pb-10">
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step ? 'w-5 bg-surface-700' : 'w-1.5 bg-surface-200'
              }`}
            />
          ))}
        </div>
        <div className="flex flex-col items-center gap-2.5 w-[min(80%,300px)]">
          <button
            data-testid="onboarding-next"
            onClick={next}
            className="w-full h-11 rounded-full bg-surface-900 text-surface-0 text-[14px] font-medium hover:bg-surface-800 active:scale-[0.99] transition"
          >
            {isLast ? t('onboarding.actions.start') : t('onboarding.actions.next')}
          </button>
          <button
            data-testid="onboarding-back"
            onClick={back}
            className={`w-full h-11 rounded-full bg-surface-100 text-surface-600 text-[14px] font-medium hover:bg-surface-200 active:scale-[0.99] transition ${
              step === 0 ? 'invisible' : ''
            }`}
          >
            {t('onboarding.actions.back')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ────────── 插画积木:全代码 mock,颜色一律走 token ────────── */

function Scene({ active, children }: { active: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <div
      className={`absolute inset-0 transition-all duration-500 ease-out ${
        active ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.96] pointer-events-none'
      }`}
    >
      {children}
    </div>
  )
}

/** macOS 红绿灯是通用视觉语言,这三个 hex 不进 token 层 */
function Chrome(): JSX.Element {
  return (
    <div className="flex items-center gap-[5px] px-2.5 h-6 shrink-0 bg-surface-100 dark:bg-surface-200">
      <span className="w-[7px] h-[7px] rounded-full bg-[#ff5f57]" />
      <span className="w-[7px] h-[7px] rounded-full bg-[#febc2e]" />
      <span className="w-[7px] h-[7px] rounded-full bg-[#28c840]" />
    </div>
  )
}

function Win({ className, children }: { className: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className={`absolute rounded-[10px] bg-surface-0 dark:bg-surface-100 shadow-xl border border-surface-200/70 overflow-hidden flex flex-col ${className}`}>
      <Chrome />
      {children}
    </div>
  )
}

function Ln({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`h-1.5 rounded-full bg-surface-200 dark:bg-surface-300 ${className}`} />
}

/** OpenPipal 侧栏面板的缩影:两条气泡 + 输入胶囊 */
function PanelBody(): JSX.Element {
  return (
    <div className="flex-1 min-h-0 p-2 flex flex-col gap-1.5">
      <div className="self-start w-3/4 h-4 rounded-lg rounded-bl-sm bg-surface-100 dark:bg-surface-200" />
      <div className="self-end w-4/5 h-5 rounded-lg rounded-br-sm bg-brand-100 dark:bg-brand-900/40" />
      <div className="mt-auto h-5 rounded-full border border-surface-200 dark:border-surface-300" />
    </div>
  )
}

/** ① 极简:整张卡只有一条输入胶囊,光标闪着等你打字 */
function SceneMinimal(): JSX.Element {
  return (
    <div className="absolute left-[22%] top-[50%] w-[56%] h-10 rounded-full bg-surface-0 dark:bg-surface-100 shadow-xl border border-surface-200/70 flex items-center gap-2 px-4">
      <Ln className="w-2/5" />
      <div className="w-0.5 h-4 rounded-full bg-surface-500 animate-pulse-soft shrink-0" />
      <div className="ml-auto w-6 h-6 rounded-full bg-surface-800 dark:bg-surface-300 shrink-0" />
    </div>
  )
}

/** ② 捏帮手:预览位 + 名牌 + 一张"交代过的活儿"清单 + 配饰货架 */
function SceneStudio(): JSX.Element {
  const shelf: AccessoryId[] = ['glasses', 'catears', 'crown', 'coffee', 'flower', 'antenna']
  return (
    <Win className="left-[16%] top-[16%] w-[68%] h-[62%]">
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          {/* 交代给它的活儿:一张勾好的小清单 */}
          <div className="absolute left-3 top-3 w-[34%] rounded-md border border-surface-100 dark:border-surface-200 bg-surface-50 dark:bg-surface-200/60 p-1.5 space-y-1.5">
            {[true, true, false].map((done, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className={`w-2 h-2 rounded-[3px] shrink-0 ${done ? 'bg-brand-500' : 'border border-surface-300'}`} />
                <Ln className={`h-1 ${i === 0 ? 'w-4/5' : i === 1 ? 'w-3/5' : 'w-2/3'}`} />
              </div>
            ))}
          </div>
          {/* 预览位:底座 + 名牌,留给引导 Mark 落进来 */}
          <div className="absolute left-1/2 -translate-x-1/2 bottom-3 flex flex-col items-center gap-1.5">
            <div className="w-16 h-2 rounded-full bg-surface-100 dark:bg-surface-200" />
            <div className="px-2.5 py-1 rounded-full border border-surface-100 dark:border-surface-200 bg-surface-50 dark:bg-surface-200/60">
              <Ln className="h-1 w-10" />
            </div>
          </div>
        </div>
        {/* 配饰货架 */}
        <div className="w-[38%] shrink-0 border-l border-surface-100 dark:border-surface-200 bg-surface-50 dark:bg-surface-200/60 p-2 grid grid-cols-3 gap-1.5 content-start">
          {shelf.map(a => (
            <div key={a} className="aspect-square rounded-md bg-surface-0 dark:bg-surface-100 border border-surface-100 dark:border-surface-200 flex items-center justify-center">
              <AgentMark size={20} accessory={a} />
            </div>
          ))}
        </div>
      </div>
    </Win>
  )
}

/** ③ ACP 输出:OpenPipal 面板 → 虚线通道 → 你已有的网页系统里多了它的侧栏 */
function SceneServe(): JSX.Element {
  return (
    <>
      <Win className="left-[6%] top-[28%] w-[20%] h-[40%]">
        {/* 左边的 OpenPipal 里也是同一个红领结帮手——"跟你走"的就是它 */}
        <div className="flex items-center gap-1.5 px-2 pt-1.5">
          <AgentMark size={16} accessory="bowtie" hue="red" />
          <Ln className="h-1 w-1/3" />
        </div>
        <PanelBody />
      </Win>
      {/* 通道:白/墨随主题,虚线 + 两颗流动感的点 */}
      <div className="absolute left-[27.5%] top-[47.5%] w-[8%] border-t-2 border-dashed border-surface-0" />
      <div className="absolute left-[29%] top-[46.4%] w-1.5 h-1.5 rounded-full bg-surface-0 animate-pulse-soft" />
      <div className="absolute left-[33%] top-[46.4%] w-1.5 h-1.5 rounded-full bg-surface-0 animate-pulse-soft" style={{ animationDelay: '0.7s' }} />
      {/* 日常在用的网页系统:地址栏 + 数据表格,右侧多出它的侧栏(Mark 落这里) */}
      <Win className="left-[36%] top-[15%] w-[57%] h-[66%]">
        <div className="h-6 shrink-0 bg-surface-50 dark:bg-surface-200 border-b border-surface-100 dark:border-surface-300 flex items-center gap-1.5 px-2">
          <div className="h-3.5 flex-1 rounded-full bg-surface-100 dark:bg-surface-300/60" />
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 p-2.5 space-y-1.5">
            <div className="h-5 rounded-[4px] bg-surface-100 dark:bg-surface-200" />
            {[0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-surface-100 dark:bg-surface-200 shrink-0" />
                <Ln className={`h-1 ${i === 1 ? 'w-1/2' : 'w-2/3'}`} />
                <div className="ml-auto h-2.5 w-8 rounded-full bg-surface-100 dark:bg-surface-200 shrink-0" />
              </div>
            ))}
          </div>
          <div className="w-[30%] shrink-0 bg-surface-0 dark:bg-surface-100 border-l border-surface-200/50 flex flex-col">
            <PanelBody />
          </div>
        </div>
      </Win>
    </>
  )
}

/** ④ 全家福:预制帮手排排站,各自亮出拿手活,最后留一个虚线空位给"你的那个" */
function SceneCrew(): JSX.Element {
  const crew: { accessory: AccessoryId; hue: MarkHue; work: JSX.Element }[] = [
    {
      accessory: 'none', hue: 'ink', // 通用:什么都搭把手 → 一条勾掉的待办
      work: (
        <div className="flex items-center gap-1 w-3/5">
          <div className="w-2 h-2 rounded-[3px] bg-brand-500 shrink-0" />
          <Ln className="h-1 flex-1" />
        </div>
      ),
    },
    {
      accessory: 'palette', hue: 'amber', // design:能交出成品 → 一张小海报
      work: (
        <div className="w-3/5 rounded-[4px] border border-surface-200 dark:border-surface-300 overflow-hidden">
          <div className="h-4 bg-brand-200 dark:bg-brand-900/50" />
          <div className="p-1 space-y-0.5">
            <Ln className="h-0.5 w-full" />
            <Ln className="h-0.5 w-2/3" />
          </div>
        </div>
      ),
    },
    {
      accessory: 'headphones', hue: 'teal', // 口译:对话两来两往
      work: (
        <div className="w-3/5 space-y-1">
          <div className="h-1.5 w-4/5 rounded-full bg-surface-200 dark:bg-surface-300" />
          <div className="h-1.5 w-4/5 rounded-full bg-brand-100 dark:bg-brand-900/40 ml-auto" />
        </div>
      ),
    },
  ]
  return (
    <>
      {crew.map((m, i) => (
        <div
          key={m.accessory}
          className="absolute top-[28%] w-[16%] h-[44%] rounded-[10px] bg-surface-0 dark:bg-surface-100 shadow-xl border border-surface-200/70 flex flex-col items-center justify-center gap-2.5"
          style={{ left: `${11 + i * 19.5}%` }}
        >
          <AgentMark size={34} accessory={m.accessory} hue={m.hue} />
          {m.work}
        </div>
      ))}
      {/* 空位:边框虚线,等引导 Mark 滑进来站定 */}
      <div className="absolute left-[69.5%] top-[28%] w-[16%] h-[44%] rounded-[10px] bg-surface-0/60 dark:bg-surface-100/60 border-2 border-dashed border-surface-0 dark:border-surface-300 flex flex-col items-center justify-end pb-3">
        <Ln className="w-1/2" />
      </div>
    </>
  )
}
