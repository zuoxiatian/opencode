import type { BrowserCommandData, BrowserState } from "./browser"
import type { BrowserCommand } from "./commands"
import type { BrowserEvent } from "./events"

export interface BrowserCommandRequest {
  browserId: string
  callId?: string
  command: BrowserCommand
  expectedOrigin?: string
  protocolVersion: 1
  requestId: string
  sessionId: string
  tabId?: string
}

export interface BrowserCommandResponse<T = BrowserCommandData> {
  data: T
  events: BrowserEvent[]
  protocolVersion: 1
  requestId: string
  state?: BrowserState
}
