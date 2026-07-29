export interface BrowserClip {
  height: number
  width: number
  x: number
  y: number
}

export interface BrowserScreenshotInput {
  clip?: BrowserClip
  fullPage?: boolean
  imageFormat?: "jpeg" | "png"
  quality?: number
}

export interface BrowserScreenshot {
  data?: string
  height: number
  mimeType: "image/jpeg" | "image/png"
  reference?: string
  width: number
}

export type BrowserAutomationTarget =
  | { ref: string; snapshotId: string }
  | { exact?: boolean; name?: string; role: string }
  | { exact?: boolean; label: string }
  | { exact?: boolean; placeholder: string }
  | { exact?: boolean; text: string }
  | { testId: string }
  | { advanced: true; css: string }

export interface BrowserAutomationSnapshot {
  content: string
  createdAt: string
  interactiveOnly: boolean
  snapshotId: string
  tabGeneration: number
  tabId: string
  truncated?: boolean
}

export interface BrowserAutomationBox {
  height: number
  width: number
  x: number
  y: number
}

export type BrowserAutomationWait =
  | { target: BrowserAutomationTarget }
  | { text: string }
  | { url: string }

export interface BrowserFrameRef {
  frameId: string
  name?: string
  url?: string
}

export interface BrowserDomNode {
  backendDOMNodeId?: number
  checked?: boolean | "mixed"
  description?: string
  disabled?: boolean
  expanded?: boolean
  frameId: string
  id: string
  name: string
  placeholder?: string
  role: string
  selected?: boolean
  tag?: string
  text?: string
  value?: string
}

export interface BrowserDomSnapshot {
  generation: number
  inaccessibleFrames: BrowserFrameRef[]
  nodes: BrowserDomNode[]
  snapshotId: string
  text: string
  title: string
  truncated: boolean
  url: string
}

export interface BrowserDevLogEntry {
  level: "debug" | "error" | "info" | "log" | "warn"
  message: string
  timestamp: string
  url?: string
}

export type BrowserCdpTarget =
  | { sessionId: string; targetId?: never }
  | { sessionId?: never; targetId: string }

export interface BrowserCdpEvent {
  method: string
  params?: Record<string, unknown>
  sequence: number
  source: {
    extensionId?: string
    sessionId?: string
    tabId?: number
    targetId?: string
  }
}

export interface BrowserCdpEvents {
  cursor: number
  events: BrowserCdpEvent[]
  hasMore: boolean
  truncated: boolean
}

export interface BrowserNodeInput {
  nodeId: string
  snapshotId?: string
  value?: string
}

export type BrowserMouseButton = "left" | "middle" | "right"
export type BrowserKeyModifier = "alt" | "control" | "meta" | "shift"
