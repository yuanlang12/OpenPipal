import { describe, expect, it } from 'vitest'
import {
  filterToolsForChatSource,
  SCHEDULER_BLOCKED_TOOL_NAMES
} from '../../src/main/agent-runtime/source-tool-policy'

describe('scheduler Runtime tool policy', () => {
  const interactiveTools = SCHEDULER_BLOCKED_TOOL_NAMES.map(name => ({ name }))
  const browserTools = [
    'browser_navigate',
    'browser_click',
    'browser_fill',
    'browser_select',
    'browser_scroll',
    'browser_read_page',
    'browser_list_tabs',
    'browser_screenshot',
    // Unknown/future tools and MCP collisions are denied by namespace too.
    'browser_future_mcp_collision'
  ].map(name => ({ name }))
  const backgroundTools = [{ name: 'read' }, { name: 'write' }, { name: 'web_search' }]

  it('removes every desktop or user-interaction tool from scheduler turns', () => {
    const tools = filterToolsForChatSource('scheduler', [
      ...interactiveTools,
      ...browserTools,
      ...backgroundTools
    ])

    expect(tools.map(tool => tool.name)).toEqual(backgroundTools.map(tool => tool.name))
    expect(SCHEDULER_BLOCKED_TOOL_NAMES).toEqual([
      'capture_screenshot',
      'read_screen',
      'get_environment',
      'present_to_user',
      'ask_user',
      'questions_v2'
    ])
  })

  it('does not alter interactive surfaces for non-scheduler callers', () => {
    const tools = [...interactiveTools, ...browserTools, ...backgroundTools]

    expect(filterToolsForChatSource('desktop', tools)).toBe(tools)
    expect(filterToolsForChatSource('acp', tools)).toBe(tools)
    expect(filterToolsForChatSource('extension', tools)).toBe(tools)
  })
})
