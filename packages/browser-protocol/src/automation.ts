import type { BrowserLoadState } from "./tab"

export interface BrowserClip {
  height: number
  width: number
  x: number
  y: number
}

export interface BrowserScreenshotInput {
  annotate?: boolean
  clip?: BrowserClip
  fullPage?: boolean
  imageFormat?: "jpeg" | "png"
  quality?: number
  target?: BrowserAutomationSelector
}

export interface BrowserScreenshotAnnotation {
  box: BrowserAutomationBox
  name?: string
  number: number
  ref: string
  role: string
}

export interface BrowserScreenshot {
  annotations?: BrowserScreenshotAnnotation[]
  data?: string
  height: number
  mimeType: "image/jpeg" | "image/png"
  reference?: string
  snapshotId?: string
  tabGeneration?: number
  width: number
}

export interface BrowserPdf {
  data?: string
  mimeType: "application/pdf"
  reference?: string
}

export interface BrowserReadableContent {
  content: string
  contentType: string
  finalUrl: string
  source: string
  status?: number
  truncated: boolean
  url: string
}

export type BrowserAutomationSelector =
  | { ref: string; snapshotId: string }
  | { advanced: true; css: string }

export type BrowserAutomationLocator =
  | { exact?: boolean; name?: string; role: string }
  | { exact?: boolean; label: string }
  | { exact?: boolean; placeholder: string }
  | { exact?: boolean; text: string }
  | { exact?: boolean; alt: string }
  | { exact?: boolean; title: string }
  | { testId: string }
  | { advanced: true; first: string }
  | { advanced: true; last: string }
  | { advanced: true; nth: number; selector: string }

export type BrowserAutomationTarget = BrowserAutomationSelector | BrowserAutomationLocator

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

export type BrowserAutomationElementState = "attached" | "detached" | "hidden" | "visible"

export type BrowserAutomationWait =
  | { state?: BrowserAutomationElementState; target: BrowserAutomationSelector }
  | { expression: string }
  | { loadState: BrowserLoadState }
  | { milliseconds: number }
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

export type BrowserCdpTarget = { sessionId: string; targetId?: never } | { sessionId?: never; targetId: string }

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
