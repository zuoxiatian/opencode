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

export interface BrowserSnapshot {
  account: string | null
  canonicalUrl: string | null
  description: string | null
  html?: string
  platform: string
  publishedAt: string | null
  text?: string
  title: string
  url: string
}

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

export interface BrowserElementInfoRect {
  height: number
  width: number
  x: number
  y: number
}

export interface BrowserElementInfo {
  ariaName?: string | null
  boundingBox?: BrowserElementInfoRect | null
  nodeId?: number | null
  preview: string
  role?: string | null
  selector: {
    candidates: string[]
    frameSelectors?: string[]
    primary?: string | null
  }
  tagName: string
  testId?: string | null
  visibleText?: string | null
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

export interface BrowserLocator {
  css?: string
  exact?: boolean
  frameId?: string
  frameSelectors?: readonly string[]
  href?: string
  label?: string
  name?: string
  placeholder?: string
  role?: string
  selector?: string
  testId?: string
  text?: string
}

export interface BrowserSelectOption {
  index?: number
  label?: string
  value?: string
}

export interface BrowserElementInput {
  arg?: unknown
  attribute?: string
  button?: BrowserMouseButton
  checked?: boolean
  expression?: string
  filePaths?: string[]
  force?: boolean
  key?: string
  locator: BrowserLocator
  modifiers?: readonly BrowserKeyModifier[]
  options?: readonly BrowserSelectOption[]
  state?: "attached" | "detached" | "hidden" | "visible"
  timeout?: number
  value?: string
}

export interface BrowserNodeInput {
  nodeId: string
  snapshotId?: string
  value?: string
}

export type BrowserMouseButton = "left" | "middle" | "right"
export type BrowserKeyModifier = "alt" | "control" | "meta" | "shift"
