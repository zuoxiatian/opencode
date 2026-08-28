import type {
    BrowserBounds,
    BrowserCommandData,
    BrowserCommandRequest,
    BrowserInfo,
    BrowserState,
} from "@opencode-ai/browser-protocol"

export interface BrowserDispatchContext {
    actor: "agent" | "renderer"
    conversationId: string
    signal?: AbortSignal
}

export interface BrowserBackend {
    readonly info: BrowserInfo
    destroy: () => Promise<void>
    disposeConversation: (conversationId: string) => Promise<void>
    dispatch: (request: BrowserCommandRequest, context: BrowserDispatchContext) => Promise<BrowserCommandData>
    getActiveConversationId: () => string | null
    getState: (conversationId: string) => BrowserState
    promoteConversation: (sourceConversationId: string, targetConversationId: string) => BrowserState
    setLayoutBounds: (bounds: BrowserBounds) => void
    setSuspended: (suspended: boolean) => void
    syncOwner: (conversationId: string | null) => BrowserState | null
}
