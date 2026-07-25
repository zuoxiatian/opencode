export type BrowserLoadState = "domcontentloaded" | "load" | "networkidle"
export type BrowserWaitUntil = BrowserLoadState | "commit"
export type BrowserFinalizeTabStatus = "deliverable" | "handoff"

export interface BrowserFinalizeTabsInput {
  keep?: BrowserFinalizeTabKeep[]
}

export interface BrowserFinalizeTabKeep {
  status: BrowserFinalizeTabStatus
  tab: string | { id: string }
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
