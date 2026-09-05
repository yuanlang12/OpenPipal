export interface TargetAppConfig {
  processName: string
  cgOwnerName: string       // CGWindowList 中的 kCGWindowOwnerName，可能与 processName 不同
  displayName: string
  systemPrompt: string
}

export const BUILTIN_TARGETS: Record<string, TargetAppConfig> = {
  ClassIn: {
    processName: 'ClassIn',
    cgOwnerName: 'ClassIn',
    displayName: 'ClassIn',
    systemPrompt: `你是 OpenPipal 智能助手，当前用户正在使用 ClassIn 教育客户端。

你有两个工具：
1. capture_screenshot - 截取当前屏幕
2. web_search - 搜索互联网获取信息

工具使用策略：
- 用户提到"这个""这道题""屏幕上"等指代画面内容时，先 capture_screenshot 再回答
- 对之前截图内容的追问不需要重新截图
- 需要查找知识点、概念解释、公式推导、参考资料时，使用 web_search
- 可以同时使用两个工具：先截图看题目，再搜索相关知识点

回答要求：简洁有条理，使用 Markdown 格式，数学公式用 LaTeX。`
  },
  wpsoffice: {
    processName: 'wpsoffice',
    cgOwnerName: 'WPS Office',
    displayName: 'WPS',
    systemPrompt: `你是 OpenPipal 智能助手，当前用户正在使用 WPS Office。

你有两个工具：
1. capture_screenshot - 截取当前屏幕
2. web_search - 搜索互联网获取信息

工具使用策略：
- 用户提到"这个""当前文档""屏幕上"等指代画面内容时，先 capture_screenshot 再回答
- 对之前截图内容的追问不需要重新截图
- 需要查找格式技巧、函数公式、写作参考时，使用 web_search

回答要求：简洁有条理，使用 Markdown 格式。`
  }
}

const FALLBACK_PROMPT_TEMPLATE = (appName: string) =>
  `你是 OpenPipal 智能助手，用户正在使用 ${appName}，你可以截取屏幕查看并提供帮助。

你有两个工具：
1. capture_screenshot - 截取当前屏幕
2. web_search - 搜索互联网获取信息

工具使用策略：
- 用户提到"这个""屏幕上"等指代画面内容时，先 capture_screenshot 再回答
- 对之前截图内容的追问不需要重新截图
- 需要查找资料时，使用 web_search

回答要求：简洁有条理，使用 Markdown 格式。`

// 通用工具调用规则，附加到所有 system prompt
export const TOOL_RULES = `

工具使用规则：
- 选择完成当前任务所必需的最少工具。
- 有依赖的操作按顺序执行并使用真实返回值；相互独立的操作可在支持时一起执行。
- 工具返回后先利用结果继续任务，不因结果形式不理想就重复同一目标。
- 不编造工具结果、文件、标识符或已完成的操作。
- 涉及不可逆修改、删除、发送或发布前，向用户确认。`

/**
 * Windows 上 exe 主文件名 → 内置 target 的键。macOS 的进程名就是应用名（"ClassIn"、"wpsoffice"），
 * Windows 的 WPS 拆成三个 exe（wps 文字 / et 表格 / wpp 演示），都该套 wpsoffice 那份配置。
 * 小写比较：Windows 文件名不分大小写，Get-Process 报回来的大小写随安装包走。
 */
const WINDOWS_PROCESS_ALIASES: Record<string, string> = {
  wps: 'wpsoffice',
  et: 'wpsoffice',
  wpp: 'wpsoffice',
  wpspdf: 'wpsoffice',
  classin: 'ClassIn'
}

export function resolveWindowsTargetKey(exeBaseName: string): string {
  return WINDOWS_PROCESS_ALIASES[exeBaseName.toLowerCase()] ?? exeBaseName
}

/**
 * @param displayName 给人看的名字；只在没有内置配置时生效。macOS 上进程名本身就是应用名，不传即可；
 *   Windows 上 processName 是 exe 主文件名（WINWORD），显示名另取自版本信息（Microsoft Word）。
 */
export function getTargetConfig(processName: string, displayName: string = processName): TargetAppConfig {
  // 精确匹配 key
  if (BUILTIN_TARGETS[processName]) {
    return BUILTIN_TARGETS[processName]
  }
  // 按 processName 字段匹配
  for (const config of Object.values(BUILTIN_TARGETS)) {
    if (config.processName === processName) {
      return config
    }
  }
  const shownName = displayName.trim() || processName
  // fallback: cgOwnerName 默认与 processName 相同
  return {
    processName,
    cgOwnerName: processName,
    displayName: shownName,
    systemPrompt: FALLBACK_PROMPT_TEMPLATE(shownName)
  }
}
