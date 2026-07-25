import type { BrowserCommandRequest } from "@opencode-ai/browser-protocol"
import type { EmbeddedTabStore } from "./embedded/tab-store"

export class BrowserLifecycle {
    constructor(private readonly tabs: EmbeddedTabStore) {}

    finalize(request: BrowserCommandRequest & {
        command: Extract<import("@opencode-ai/browser-protocol").BrowserCommand, { name: "tabs.finalize" }>
    }) {
        this.tabs.finalize(request.sessionId, request.command, request)
    }
}
