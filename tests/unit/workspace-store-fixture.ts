/**
 * workspaceStore 单测共享夹具——字段表只此一份。
 * 此前 workspace-visibility-memory 与 workspace-auto-open-suppress 各养一份 reset,
 * 新增 store 字段要同步改两处,漏改即跨用例状态污染(评审登记)。
 */
import { useWorkspaceStore, SUMMARY_TAB_ID } from '../../src/renderer/src/stores/workspaceStore'

export function resetWorkspaceStore(currentConversationId: string | null = null): void {
  useWorkspaceStore.setState({
    open: false,
    filesPanelOpen: false,
    tabs: [],
    activeTabId: SUMMARY_TAB_ID,
    rehydrating: false,
    visibilityMemory: {},
    artifactTabsMemory: {},
    currentConversationId,
    autoOpenSuppressedConvId: null
  })
}
