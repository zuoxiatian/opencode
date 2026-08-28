import type { BrowserWindow } from "electron"
import {
    BROWSER_PROTOCOL_VERSION,
    DEFAULT_BROWSER_ID,
    parseBrowserCommandInput,
    type BrowserCommandInput,
    type BrowserCommandRequest,
    type BrowserCommandResponse,
    type BrowserEvent,
} from "@opencode-ai/browser-protocol"
import { BrowserCommandDispatcher } from "./command-dispatcher"
import { BrowserEventStore } from "./event-store"
import { createEmbeddedBrowserBackend } from "./embedded/backend"
import { BrowserRegistry } from "./registry"
import { BrowserSecurityGate } from "./security"

export interface BrowserRuntime {
    command: (
        input: BrowserCommandInput,
        identity?: {
            actor?: "agent" | "renderer"
            callId?: string
            conversationId?: string
            sessionId?: string
        },
        signal?: AbortSignal,
    ) => Promise<BrowserCommandResponse>
    destroy: () => Promise<void>
    disposeConversation: (conversationId: string) => Promise<void>
    dispatch: (request: BrowserCommandRequest, signal?: AbortSignal) => Promise<BrowserCommandResponse>
    getActiveConversationId: () => string | null
    getState: (
        conversationId: string,
        browserId?: string,
    ) => import("@opencode-ai/browser-protocol").BrowserState
    promoteConversation: (
        sourceConversationId: string,
        targetConversationId: string,
    ) => import("@opencode-ai/browser-protocol").BrowserState
    setLayoutBounds: (bounds: import("@opencode-ai/browser-protocol").BrowserBounds) => void
    setSuspended: (suspended: boolean) => void
    subscribe: (listener: (event: BrowserEvent) => void) => () => void
    syncOwner: (conversationId: string | null) => import("@opencode-ai/browser-protocol").BrowserState | null
}

export function createBrowserRuntime(window: BrowserWindow, raiseOverlays?: () => void): BrowserRuntime {
    const events = new BrowserEventStore()
    const registry = new BrowserRegistry()
    registry.add(createEmbeddedBrowserBackend(window, events, raiseOverlays))
    const dispatcher = new BrowserCommandDispatcher(registry, new BrowserSecurityGate(), events)
    events.subscribe((event) => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return
        window.webContents.send("browser:event", event)
        if (!event.sessionId) return
        window.webContents.send("browser:state-changed", {
            conversationId: event.sessionId,
            state: registry.get(event.browserId).getState(event.sessionId),
        })
    })

    return {
        command: (input, identity = {}, signal) => {
            const parsed = parseBrowserCommandInput(input)
            const backend = registry.get(parsed.browserId ?? DEFAULT_BROWSER_ID)
            const actor = identity.actor ?? (identity.sessionId && identity.sessionId !== "renderer" ? "agent" : "renderer")
            const conversationId = identity.conversationId
                ?? (actor === "agent" ? identity.sessionId : backend.getActiveConversationId())
            if (!conversationId) {
                throw new Error("Embedded browser command requires an active conversation")
            }
            return dispatcher.dispatch({
                browserId: parsed.browserId ?? DEFAULT_BROWSER_ID,
                callId: identity.callId,
                command: parsed.command,
                expectedOrigin: parsed.expectedOrigin,
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                requestId: crypto.randomUUID(),
                sessionId: actor === "renderer" ? "renderer" : identity.sessionId ?? conversationId,
                tabId: parsed.tabId,
            }, { actor, conversationId, signal })
        },
        destroy: () => registry.destroy(),
        disposeConversation: (conversationId) => registry.get(DEFAULT_BROWSER_ID).disposeConversation(conversationId),
        dispatch: (request, signal) => dispatcher.dispatch(request, {
            actor: "agent",
            conversationId: request.sessionId,
            signal,
        }),
        getActiveConversationId: () => registry.get(DEFAULT_BROWSER_ID).getActiveConversationId(),
        getState: (conversationId, browserId = DEFAULT_BROWSER_ID) => registry.get(browserId).getState(conversationId),
        promoteConversation: (sourceConversationId, targetConversationId) =>
            registry.get(DEFAULT_BROWSER_ID).promoteConversation(sourceConversationId, targetConversationId),
        setLayoutBounds: (bounds) => registry.get(DEFAULT_BROWSER_ID).setLayoutBounds(bounds),
        setSuspended: (suspended) => registry.get(DEFAULT_BROWSER_ID).setSuspended(suspended),
        subscribe: (listener) => events.subscribe(listener),
        syncOwner: (conversationId) => registry.get(DEFAULT_BROWSER_ID).syncOwner(conversationId),
    }
}
