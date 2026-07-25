import type { WebContentsView } from "electron"
import type {
    BrowserCdpEvent,
    BrowserDialog,
    BrowserDownload,
    BrowserFileChooser,
    BrowserLoadError,
    BrowserTabOwnership,
} from "@opencode-ai/browser-protocol"

export interface EmbeddedTab {
    cdpEvents: BrowserCdpEvent[]
    cdpSequence: number
    cdpSessions: Set<string>
    debuggerQueue: Promise<void>
    debuggerReady: Promise<void>
    dialog: BrowserDialog | null
    downloads: Map<string, BrowserDownload>
    error?: BrowserLoadError
    favicon?: string
    faviconSource?: string
    fileChooser: BrowserFileChooser | null
    generation: number
    httpCheck?: Promise<void>
    httpResponse?: {
        contentLength?: number
        statusCode: number
        url: string
    }
    id: string
    lastTouchedAt: number
    logs: import("@opencode-ai/browser-protocol").BrowserDevLogEntry[]
    networkRequests: Set<string>
    ownership: BrowserTabOwnership
    pendingUrl?: string
    view: WebContentsView
}
