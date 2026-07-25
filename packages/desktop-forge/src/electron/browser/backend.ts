import type {
    BrowserBounds,
    BrowserCommandData,
    BrowserCommandRequest,
    BrowserInfo,
    BrowserState,
} from "@opencode-ai/browser-protocol"

export interface BrowserDispatchContext {
    signal?: AbortSignal
}

export interface BrowserBackend {
    readonly info: BrowserInfo
    destroy: () => Promise<void>
    dispatch: (request: BrowserCommandRequest, context: BrowserDispatchContext) => Promise<BrowserCommandData>
    getState: () => BrowserState
    setBounds: (bounds: BrowserBounds) => void
}
