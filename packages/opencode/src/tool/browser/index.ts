import { BrowserActionTool, BROWSER_ACTION_COMMANDS } from "./action"
import { BrowserCdpTool, BROWSER_CDP_COMMANDS } from "./cdp"
import { BrowserNavigateTool, BROWSER_NAVIGATE_COMMANDS } from "./navigate"
import { BrowserReadTool, BROWSER_READ_COMMANDS } from "./read"
import { BrowserSnapshotTool, BROWSER_SNAPSHOT_COMMANDS } from "./snapshot"
import { BrowserTabsTool, BROWSER_TABS_COMMANDS } from "./tabs"
import { BrowserWaitTool, BROWSER_WAIT_COMMANDS } from "./wait"

export * from "./action"
export * from "./cdp"
export * from "./common"
export * from "./navigate"
export * from "./read"
export * from "./snapshot"
export * from "./tabs"
export * from "./wait"

export const BROWSER_TOOL_COMMANDS = {
  browser_tabs: BROWSER_TABS_COMMANDS,
  browser_navigate: BROWSER_NAVIGATE_COMMANDS,
  browser_snapshot: BROWSER_SNAPSHOT_COMMANDS,
  browser_read: BROWSER_READ_COMMANDS,
  browser_action: BROWSER_ACTION_COMMANDS,
  browser_wait: BROWSER_WAIT_COMMANDS,
  browser_cdp: BROWSER_CDP_COMMANDS,
} as const

export const BROWSER_TOOLS = [
  BrowserTabsTool,
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserReadTool,
  BrowserActionTool,
  BrowserWaitTool,
  BrowserCdpTool,
] as const
