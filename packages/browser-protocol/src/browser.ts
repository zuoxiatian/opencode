import type { BrowserRuntimeError } from "./errors"
import type { BrowserCapabilityInfo } from "./capabilities"
import type {
  BrowserClipboardItem,
  BrowserDialog,
  BrowserDownload,
  BrowserFileChooser,
} from "./files"
import type { BrowserHistoryEntry } from "./tab"

export const BROWSER_PROTOCOL_VERSION = 3 as const
export const DEFAULT_BROWSER_ID = "embedded"

export interface BrowserBounds {
  height: number
  width: number
  x: number
  y: number
}

export interface BrowserInfo {
  apiSupportOverrides?: Record<string, boolean>
  capabilities: {
    browser?: BrowserCapabilityInfo[]
    tab?: BrowserCapabilityInfo[]
  }
  family?: string
  id: string
  metadata?: Record<string, string>
  name: string
  type: "cdp" | "extension" | "iab"
}

export interface BrowserUserTabInfo {
  id: string
  lastOpened?: string
  providerTabId?: string
  tabGroup?: string
  title?: string
  url?: string
}

export type BrowserCapabilityId = "visibility" | "viewport"
export type BrowserTabCapabilityId = string

export interface BrowserLoadError {
  code: number
  description: string
  kind: "crash" | "load"
  url: string
}

export interface BrowserTabOwnership {
  createdBy: "agent" | "user"
  disposition: "deliverable" | "handoff" | "temporary"
  ownerSessionId?: string
}

export interface BrowserTabState {
  canGoBack: boolean
  canGoForward: boolean
  capabilities: BrowserTabCapabilityId[]
  dialog: BrowserDialog | null
  downloadCount: number
  error: BrowserLoadError | null
  favicon: string | null
  generation: number
  id: string
  loading: boolean
  ownership: BrowserTabOwnership
  title: string
  url: string
}

export interface BrowserState {
  activeTabId: string | null
  browserId: string
  tabs: BrowserTabState[]
  viewport: BrowserBounds
  visible: boolean
}

export interface BrowserNavigationResult {
  error?: BrowserRuntimeError
  finalUrl: string
  generation: number
  status: "committed" | "failed" | "stopped"
}

export interface BrowserCommandData {
  automationSnapshot?: import("./automation").BrowserAutomationSnapshot
  box?: import("./automation").BrowserAutomationBox | null
  browsers?: BrowserInfo[]
  cdp?: unknown
  cdpEvents?: import("./automation").BrowserCdpEvents
  clipboardItems?: BrowserClipboardItem[]
  clipboardText?: string
  count?: number
  dialog?: BrowserDialog | null
  dom?: string
  download?: BrowserDownload
  downloads?: BrowserDownload[]
  fileChooser?: BrowserFileChooser
  history?: BrowserHistoryEntry[]
  html?: string
  logs?: import("./automation").BrowserDevLogEntry[]
  navigation?: BrowserNavigationResult
  pdf?: import("./automation").BrowserPdf
  readable?: import("./automation").BrowserReadableContent
  styles?: Record<string, string>
  screenshot?: import("./automation").BrowserScreenshot
  tab?: BrowserTabState
  tabs?: BrowserTabState[]
  truncated?: boolean
  userTabs?: BrowserUserTabInfo[]
  value?: unknown
  visibleDom?: import("./automation").BrowserDomSnapshot
}
