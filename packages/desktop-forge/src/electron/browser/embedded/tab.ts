import type { WebContents, WebContentsView } from "electron"
import type {
    BrowserCdpEvent,
    BrowserDialog,
    BrowserDownload,
    BrowserFileChooser,
    BrowserLoadError,
    BrowserTabOwnership,
} from "@opencode-ai/browser-protocol"
import type { TabDebuggerTransport } from "../agent-browser/debugger-transport"

export interface EmbeddedTab {
    cdpEvents: BrowserCdpEvent[]
    cdpSequence: number
    closed: boolean
    conversationId: string
    debuggerTransport: TabDebuggerTransport
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
    webContents: WebContents
}
