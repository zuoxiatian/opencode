export type BrowserEventType =
  | "browser.hidden"
  | "browser.shown"
  | "dialog.closed"
  | "dialog.opened"
  | "download.completed"
  | "download.created"
  | "download.failed"
  | "download.updated"
  | "fileChooser.closed"
  | "fileChooser.opened"
  | "navigation.committed"
  | "navigation.completed"
  | "navigation.failed"
  | "navigation.started"
  | "permission.requested"
  | "permission.resolved"
  | "tab.activated"
  | "tab.closed"
  | "tab.crashed"
  | "tab.created"
  | "tab.updated"

export interface BrowserEvent {
  browserId: string
  eventId: string
  generation?: number
  payload?: Record<string, unknown>
  requestId?: string
  sessionId?: string
  tabId?: string
  timestamp: number
  type: BrowserEventType
}
