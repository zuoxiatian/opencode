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
        identity?: { callId?: string; sessionId?: string },
        signal?: AbortSignal,
    ) => Promise<BrowserCommandResponse>
    destroy: () => Promise<void>
    dispatch: (request: BrowserCommandRequest, signal?: AbortSignal) => Promise<BrowserCommandResponse>
    getState: (browserId?: string) => import("@opencode-ai/browser-protocol").BrowserState
    setLayoutBounds: (bounds: import("@opencode-ai/browser-protocol").BrowserBounds) => void
    setSuspended: (suspended: boolean) => void
    subscribe: (listener: (event: BrowserEvent) => void) => () => void
}

export function createBrowserRuntime(window: BrowserWindow, raiseOverlays?: () => void): BrowserRuntime {
    const events = new BrowserEventStore()
    const registry = new BrowserRegistry()
    registry.add(createEmbeddedBrowserBackend(window, events, raiseOverlays))
    const dispatcher = new BrowserCommandDispatcher(registry, new BrowserSecurityGate(), events)
    events.subscribe((event) => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return
        window.webContents.send("browser:event", event)
        window.webContents.send("browser:state-changed", registry.get(event.browserId).getState())
    })

    return {
        command: (input, identity = {}, signal) => {
            const parsed = parseBrowserCommandInput(input)
            return dispatcher.dispatch({
                browserId: parsed.browserId ?? DEFAULT_BROWSER_ID,
                callId: identity.callId,
                command: parsed.command,
                expectedOrigin: parsed.expectedOrigin,
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                requestId: crypto.randomUUID(),
                sessionId: identity.sessionId ?? "renderer",
                tabId: parsed.tabId,
            }, { signal })
        },
        destroy: () => registry.destroy(),
        dispatch: (request, signal) => dispatcher.dispatch(request, { signal }),
        getState: (browserId = DEFAULT_BROWSER_ID) => registry.get(browserId).getState(),
        setLayoutBounds: (bounds) => registry.get(DEFAULT_BROWSER_ID).setLayoutBounds(bounds),
        setSuspended: (suspended) => registry.get(DEFAULT_BROWSER_ID).setSuspended(suspended),
        subscribe: (listener) => events.subscribe(listener),
    }
}
