/**
 * ProcessGroup — Codex 风的"过程折叠"组件
 *
 * 一个 turn 的所有过程性消息(thinking / tool / search / code)折叠成单条计时分割线:
 *   - 进行中:"处理中 12 秒"(shimmer)+ 默认展开,实时显示每一步
 *   - 完成后:"处理完成 12 秒" 安静的灰字 + 默认折叠(focus 关时由 defaultExpanded 铺开)
 *   - 用户手动点开/收起后,尊重用户选择(不再自动切换)
 *
 * 版式(对标 Claude 官方):元信息**左对齐**在一行,下面一条贯通的细横线 —— 线是"过程到此为止"
 * 的收口,线下面就是结论/成品。不再把文字夹在两截线中间居中,那种版式会把视线拽到屏幕中央,
 * 而这一行本该是可以被忽略的背景信息。展开后每一步也从同一条左边界起排,全列左对齐。
 */
import { useState, useEffect, useRef, memo } from 'react'
import { ChevronRight, FileCode, BookOpen, Brain, Search } from 'lucide-react'
import { ChatMessage } from '../types'
import { MessageBubble } from './MessageBubble'
import { buildProcessRenderItems } from '../chat/processRender'
import { ThinkingStream } from './ThinkingStream'
import { FileDisplayInfo } from '../chat/fileDisplay'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

// 折叠行按钮与旋转 chevron——ProcessGroup 主行 / FileEditGroup 共用(色档差异由调用方追加类)。
// 文字**贴左**、不留 chevron 的位:展开控件一律排在文字**后面**(与分割线那一行同款),
// 这样收起/展开、有没有 chevron,左边界都不动 —— 前置 chevron 会把整列文字推开一格,
// 隐身时那一格还空着,看上去就是"没对齐"。行本身是 hover 组(group/row)。
//
// **chevron 显隐规范(全站统一,ToolCallCard / SubagentCard / FileResultCard … 同款)**:
//   只有 hover 或**键盘**聚焦时才浮现,展开与否一律不改这条 —— 展开态下方已经铺着内容,
//   状态本身不需要一个常驻箭头来说明;台面恒定安静,指过去才长出控件。
//   焦点判定用 :focus-visible 而不是 :focus-within —— Chromium 里鼠标点按钮同样给焦点,
//   focus-within 会把"刚点过的那一行"的箭头钉住不走,于是同一个控件因为点没点过而长得
//   不一样,正是用户说的「交互规范不一致」(2026-08-18 实锤)。
const toggleRowCls = 'group/row flex items-center gap-1.5 text-chat-meta transition-colors'

// 组内展开体的嵌套竖轨——内容缩进一格 + 左侧细竖线挂在标题行下面(对标官方过程栏)。
// 竖线不是装饰:它把"这几行属于上面那一步"这件事画出来,否则展开后多组内容会糊成一片。
const nestedBodyCls = 'mt-1 ml-1.5 pl-3 border-l border-border space-y-1'

export function formatProcessDuration(ms: number, locale: string, t: TFunction): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000)
  const formatter = new Intl.NumberFormat(locale)
  if (totalSeconds < 60) {
    return t('chat.process.duration.seconds', { value: formatter.format(totalSeconds) })
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0
    ? t('chat.process.duration.minutesSeconds', {
        minutes: formatter.format(minutes),
        seconds: formatter.format(seconds),
      })
    : t('chat.process.duration.minutes', { value: formatter.format(minutes) })
}

function ToggleChevron({ open, className = '' }: { open: boolean; className?: string }) {
  return <ChevronRight className={`w-3 h-3 shrink-0 transition duration-200 ${open ? 'rotate-90' : ''} ${className}`} />
}

/** 连续同文件 edit/write 的聚合行：文件芯片 ×N，点开逐次查看（对标官方文件芯片聚合） */
function FileEditGroup({ path, items, roleIcon }: { path: string; items: ChatMessage[]; roleIcon?: string }) {
  const [open, setOpen] = useState(false)
  const base = path.split('/').pop() || path
  return (
    <div data-testid="file-edit-group">
      <button onClick={() => setOpen(v => !v)} className={`${toggleRowCls} text-ink-secondary hover:text-ink-primary`}>
        <FileCode className="w-3 h-3 shrink-0" />
        <span className="font-medium min-w-0 truncate">{base}</span>
        <span className="text-ink-tertiary shrink-0">×{items.length}</span>
        <ToggleChevron open={open} className="opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
      </button>
      {open && (
        <div className={nestedBodyCls}>
          {items.map(m => <MessageBubble key={m.id} message={m} roleIcon={roleIcon} inProcess />)}
        </div>
      )}
    </div>
  )
}

/** 同一份长期档案的多次查阅聚合成一行——老师关心"它翻了我的教学风格"，不是翻了哪几个文件名 */
function ArchiveReadGroup({
  info,
  items,
  roleIcon
}: {
  info: FileDisplayInfo
  items: ChatMessage[]
  roleIcon?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isSystem = info.scope === 'role-system'
  return (
    <div data-testid="archive-read-group">
      <button onClick={() => setOpen(v => !v)} className={`${toggleRowCls} text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 dark:hover:text-emerald-200`}>
        <BookOpen className="w-3 h-3 shrink-0" />
        <span className="font-medium min-w-0 truncate">
          {isSystem
            ? t('chat.process.teachingStyle', { groupName: info.groupName })
            : t('chat.process.memory')}
        </span>
        <span className="text-ink-tertiary shrink-0">{t('chat.process.archiveCount', { count: items.length })}</span>
        <ToggleChevron open={open} className="opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
      </button>
      {open && (
        <div className={nestedBodyCls}>
          {items.map(m => <MessageBubble key={m.id} message={m} roleIcon={roleIcon} inProcess />)}
        </div>
      )}
    </div>
  )
}

/** 相邻探索步骤(翻文件/找文件/搜网页)的聚合行:「探索 · 1 搜索, 2 文件」,点开看逐条 */
function ExploreGroup({
  files,
  searches,
  items,
  roleIcon
}: {
  files: number
  searches: number
  items: ChatMessage[]
  roleIcon?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const parts: string[] = []
  if (searches > 0) parts.push(t('chat.process.exploreSearches', { count: searches }))
  if (files > 0) parts.push(t('chat.process.exploreFiles', { count: files }))
  return (
    <div data-testid="process-explore-group">
      <button onClick={() => setOpen(v => !v)} className={`${toggleRowCls} text-ink-secondary hover:text-ink-primary`}>
        <Search className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
        <span className="font-medium">{t('chat.process.explore')}</span>
        <span className="text-ink-tertiary min-w-0 truncate">· {parts.join(', ')}</span>
        <ToggleChevron open={open} className="opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
      </button>
      {open && (
        <div className={`${nestedBodyCls} animate-fade-in`}>
          {items.map(m => <MessageBubble key={m.id} message={m} roleIcon={roleIcon} inProcess />)}
        </div>
      )}
    </div>
  )
}

/**
 * 连续 thinking 段的聚合折叠行:默认一行,点开看全文——思考内容量大,不再默认平铺。
 * 行文案讲的是**状态**不是数量:还在想 → 「思考中」(扫光);想完了 → 「已思考 12 秒」。
 * 「· N 段」是实现细节(模型分几次吐 reasoning),对读的人零价值,已去掉。
 */
function ThinkGroup({ items, isActive }: { items: ChatMessage[]; isActive: boolean }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  // 还在想 = 本轮仍在跑 且 最后一段还没落下 thinkingMs(它由 thinking_end 写)。
  // 历史会话没有这个字段,但它们的 turn 早就不 active 了,不会被误判成"思考中"。
  const live = isActive && items[items.length - 1]?.thinkingMs === undefined
  const thoughtMs = items.reduce((sum, m) => sum + (m.thinkingMs ?? 0), 0)
  // 门槛是 1 秒不是 0:400ms 四舍五入成 0,会写出「已思考 0 秒」——
  // 而它正上方的分割线在同样情况下是特意不写秒数的("看着像消息丢了"),同屏自相矛盾。
  const label = live
    ? t('chat.message.thinking')
    : thoughtMs >= 1000
      ? t('chat.process.thoughtDuration', {
          duration: formatProcessDuration(thoughtMs, i18n.resolvedLanguage || i18n.language, t)
        })
      : t('chat.process.thought')  // 旧数据没有耗时:退回中性说法,不编一个秒数
  // 有些模型(deepseek-v4-flash 实测)只发 thinking 的起止事件、不吐 reasoning 正文,
  // 于是这一组有耗时却没有内容。此时**不给它展开控件**:hover 出一个箭头、点开却是空的,
  // 比没有箭头更糟。行照旧显示"已思考 N 秒"——耗时本身仍是有效信息。
  const hasText = items.some(m => (m.thinkingContent || '').trim().length > 0)
  const head = (
    <>
      <Brain className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
      <span className={`font-medium ${live ? 'sw-loading-shimmer' : ''}`}>{label}</span>
    </>
  )
  if (!hasText) {
    return (
      <div data-testid="process-think-group">
        <div className={`${toggleRowCls} text-ink-secondary`}>{head}</div>
      </div>
    )
  }
  return (
    <div data-testid="process-think-group">
      <button onClick={() => setOpen(v => !v)} className={`${toggleRowCls} text-ink-secondary hover:text-ink-primary`}>
        {head}
        <ToggleChevron open={open} className="opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
      </button>
      {open && (
        <div className={`${nestedBodyCls} animate-fade-in`}>
          {items.map(m => (
            <ThinkingStream key={m.id} content={m.thinkingContent} />
          ))}
        </div>
      )}
    </div>
  )
}

interface ProcessGroupProps {
  messages: ChatMessage[]
  /** 本 turn 是否正在执行(streaming + 最后一个 turn) */
  isActive: boolean
  roleIcon?: string
  /** 整轮起点 — **agent 真正开跑的时刻**(ConversationTurn.agentStartTs,回落用户消息时间戳)。
   *  不用用户按下回车的时刻:那之间可能夹着一段没有任何产出的等待(供应商 429 后换端点重试、
   *  排队),把它计进"处理"会写出 23 秒而展开只有一步 2 秒的思考。 */
  turnStartTs?: number
  /** 整轮终点(最终回答落地时间戳)— 用于算真实耗时 */
  turnEndTs?: number
  /** 完成后的默认展开态:focus 关时已完成 turn 直接铺开台面,不再折叠 */
  defaultExpanded?: boolean
  /** 本轮还在等模型服务开口(按下回车了,但一个模型事件都没到)。
   *  为真时这一行只写「连接模型…」不报秒数 —— 连接/排队/429 换端点重试那段时间
   *  不是"处理",给它记秒等于替模型认领它没干过的活。 */
  awaitingModel?: boolean
}

function ProcessGroupComponent({ messages, isActive, roleIcon, turnStartTs, turnEndTs, defaultExpanded = false, awaitingModel = false }: ProcessGroupProps) {
  const { t, i18n } = useTranslation()
  // 进行中默认展开;完成后按 defaultExpanded(focus 关 → 铺开)
  const [expanded, setExpanded] = useState(isActive || defaultExpanded)
  const userToggled = useRef(false)

  // isActive 变化时(执行完成 active:true→false),若用户没手动操作过则回落到默认态。
  // defaultExpanded 变化 = 用户拨了全局 focus 开关 —— 那是一条显式命令,清掉本轮的手动状态。
  // 不清的话,凡是被手动展开/收起过的轮次会对开关永久免疫,开关看上去"对有些轮次不生效"。
  const prevDefaultExpanded = useRef(defaultExpanded)
  useEffect(() => {
    if (prevDefaultExpanded.current !== defaultExpanded) {
      prevDefaultExpanded.current = defaultExpanded
      userToggled.current = false
    }
    if (!userToggled.current) setExpanded(isActive || defaultExpanded)
  }, [isActive, defaultExpanded])

  // 进行中:秒数实时走(每秒一个 tick,只影响这一条分割线)
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isActive])

  // 有没有可展开的步骤。**没有步骤也照样画这条线** —— 模型直接作答、只出了一件成品、
  // 或者 prompt 发出去 AI 服务就报错,这些轮次同样需要"处理到此为止"的收口:线上是读数、
  // 线下是内容。区别只在于此时它不是控件,只是一行读数(没有 chevron、点了也没反应)。
  const expandable = messages.length > 0

  // 真实耗时优先用整轮(agent 开跑→最终回答落地);回落到过程消息内部首末。
  // 进行中用 nowTs 持续增长;完成后用 turnEndTs 定格。
  // 起点/终点都可能缺席:没有用户消息的轮次(定时任务 / 主动问候)既没有 turnStartTs,
  // 零步骤分割线又让 messages 为空。以前这里写 `?? 0`,于是起点变成 1970 年,
  // 分割线写出「处理完成 29,783,645 分钟」。缺锚就**不报秒数**,而不是报一个荒谬的数。
  const procStart = messages[0]?.timestamp
  const procEnd = messages[messages.length - 1]?.timestamp ?? procStart
  const startTs = turnStartTs ?? procStart
  const endTs = isActive ? nowTs : (turnEndTs ?? procEnd)
  const durationMs =
    startTs !== undefined && endTs !== undefined ? Math.max(0, endTs - startTs) : null

  const handleToggle = () => {
    userToggled.current = true
    setExpanded(v => !v)
  }

  // <1s 完成时不写秒数("处理完成 0 秒"看着像消息丢了),但**文字必须还在**:
  // 早先的做法是给整个标签打 opacity-0,结果展开态只剩一个孤零零的 chevron 浮在那儿,
  // 没有任何东西说明它是干什么的 —— 少一个秒数,不该换来一个无主的控件。
  const durationLabel =
    durationMs === null ? '' : formatProcessDuration(durationMs, i18n.resolvedLanguage || i18n.language, t)
  const label = awaitingModel
    ? t('chat.process.connecting')
    : isActive
      ? durationMs === null
        ? t('chat.process.processing')
        : t('chat.process.processingWithDuration', { duration: durationLabel })
      : durationMs === null || durationMs < 1000
        ? t('chat.process.completedNoDuration')
        : t('chat.process.completedWithDuration2', { duration: durationLabel })

  // Claude 风计时分割线:左对齐的一行元信息 + 下方一条贯通细线。
  //  - 执行中:纯状态行,时长扫光,**没有展开控件**(整行不是按钮、不响应点击)。步骤本来就
  //    全程铺开着,此时给一个"展开"入口只会误导;focus 也不在这时收起任何东西。
  //  - 执行完:安静的灰字,hover/键盘聚焦时整行提亮 + chevron 从文字后面浮现,这才是可点的
  //    收展入口。展开态**同样**只在 hover 时才有箭头(见文件头 chevron 显隐规范)。
  // 外层刻意不套 max-w-msg:横线是"整栏的收口",要横穿整个消息列;里面的每一步各自带
  // max-w-msg(与台面上的消息同宽),不会因此变宽。
  return (
    <div className="mb-msg" data-testid="process-group">
      {isActive ? (
        <div
          className="flex items-center w-full py-0.5 text-chat-meta text-ink-secondary"
          data-testid="process-group-toggle"
          data-active="true"
        >
          <span className="sw-loading-shimmer">{label}</span>
        </div>
      ) : !expandable ? (
        // 无步骤可展开:同一套安静灰字,但不是按钮 —— 不给 hover 提亮、不给 chevron,
        // 免得诱着人去点一个点开是空的东西(与 ThinkGroup 的空思考同一条规矩)。
        <div
          className="flex items-center w-full py-0.5 text-chat-meta text-surface-300 dark:text-surface-500"
          data-testid="process-group-toggle"
          data-expandable="false"
        >
          <span>{label}</span>
        </div>
      ) : (
        <button
          onClick={handleToggle}
          className="group/proc flex items-center gap-1.5 w-full py-0.5 text-left text-chat-meta transition-colors text-surface-300 dark:text-surface-500 hover:text-ink-secondary"
          data-testid="process-group-toggle"
          aria-expanded={expanded}
        >
          <span>{label}</span>
          <ToggleChevron
            open={expanded}
            className="opacity-0 group-hover/proc:opacity-100 group-focus-visible/proc:opacity-100"
          />
        </button>
      )}
      {/* 收口横线:在元信息行下方贯通整列 —— 线以下是本轮的结论与成品 */}
      <div className="mt-1.5 h-px w-full bg-border" aria-hidden data-testid="process-group-rule" />

      {expanded && expandable && (
        /* 过程栏里的步骤是**清单**不是消息:各张卡自带的 mb-msg(消息间距)在这里太松,
           压到 mb-1,一屏能看完一轮做过什么。后代选择器天然比卡片自己的单类选择器更具体,
           不需要 !important。 */
        <div className="mt-2 max-w-msg animate-fade-in space-y-1 [&_.mb-msg]:mb-1">
          {buildProcessRenderItems(messages).map(item => {
            // 连续同文件 edit/write ≥2 次 → 聚合成"文件 ×N"芯片行
            if (item.kind === 'file-group' && item.items.length > 1) {
              return <FileEditGroup key={item.items[0].id} path={item.path} items={item.items} roleIcon={roleIcon} />
            }
            // 同一份长期档案翻了多份 → 一行"教学风格 · 小学语文 · 3 份"
            if (item.kind === 'archive-group' && item.items.length > 1) {
              return <ArchiveReadGroup key={item.items[0].id} info={item.info} items={item.items} roleIcon={roleIcon} />
            }
            // 相邻的探索步骤(读文件/找文件/搜网页)合并成一行——过程栏最碎的一类,不铺流水账。
            // **只有 ≥2 条才聚合**:一条 read 折成"探索 · 1 文件"是净亏 —— 收起态连文件名都没有,
            // 非点开不可;而同一个文件的一次 edit 仍然直接显示卡片(file-group 也要求 >1)。
            // 三种聚合行的门槛就此一致。
            if (item.kind === 'explore-group' && item.items.length > 1) {
              return (
                <ExploreGroup
                  key={item.items[0].id}
                  files={item.files}
                  searches={item.searches}
                  items={item.items}
                  roleIcon={roleIcon}
                />
              )
            }
            // 连续 thinking 合并成一行折叠——思考内容量大,默认收起,点开看全文
            if (item.kind === 'think-group') {
              return <ThinkGroup key={item.items[0].id} items={item.items} isActive={isActive} />
            }
            const m = item.kind === 'single' ? item.m : item.items[0]
            const lastId = messages[messages.length - 1]?.id
            // tool/search/code 保留各自单层卡片(有长输出值得折叠)
            return (
              <MessageBubble
                key={m.id}
                message={m}
                roleIcon={roleIcon}
                isLastStreaming={isActive && m.id === lastId}
                inProcess
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 已完成 turn 的过程组内容不会再变,但活跃 turn 的每个流事件都会让 ChatPanel 重渲染、
 * groupTurns 重建所有 messages 子数组——逐元素引用比较(chatStore 更新保留未变消息对象
 * 的引用)让历史过程组整组跳过,重渲染成本不再随会话长度线性增长。对齐 MessageBubble
 * 已有的 memo + 自定义比较器模式。
 */
function processGroupPropsEqual(prev: ProcessGroupProps, next: ProcessGroupProps): boolean {
  if (
    prev.isActive !== next.isActive ||
    prev.roleIcon !== next.roleIcon ||
    prev.turnStartTs !== next.turnStartTs ||
    prev.turnEndTs !== next.turnEndTs ||
    prev.defaultExpanded !== next.defaultExpanded ||
    prev.awaitingModel !== next.awaitingModel
  ) return false
  if (prev.messages === next.messages) return true
  if (prev.messages.length !== next.messages.length) return false
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i]) return false
  }
  return true
}

export const ProcessGroup = memo(ProcessGroupComponent, processGroupPropsEqual)
