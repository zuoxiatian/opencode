export type BrowserReadFormat = "html" | "metadata" | "text"
export type BrowserLoadState = "domcontentloaded" | "load" | "networkidle"
export type BrowserWaitUntil = BrowserLoadState | "commit"
export type BrowserTabsContentType = "domSnapshot" | "html" | "text"
export type BrowserFinalizeTabStatus = "deliverable" | "handoff"

export interface BrowserFinalizeTabsInput {
  keep?: BrowserFinalizeTabKeep[]
}

export interface BrowserFinalizeTabKeep {
  status: BrowserFinalizeTabStatus
  tab: string | { id: string }
}

export interface BrowserTabsContentInput {
  contentType: BrowserTabsContentType
  timeoutMs?: number
  urls: string[]
}

export interface BrowserTabsContentResult {
  content: null | string
  title: null | string
  url: string
}

export interface BrowserHistoryOptions {
  from?: string | Date
  limit?: number
  queries?: string[]
  to?: string | Date
}

export interface BrowserHistoryEntry {
  dateVisited: string
  title?: string
  url: string
}
