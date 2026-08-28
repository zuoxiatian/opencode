import {
    BROWSER_PROTOCOL_VERSION,
    type BrowserCommandRequest,
    type BrowserCommandResponse,
    type BrowserState,
} from "@opencode-ai/browser-protocol"
import type { BrowserDispatchContext } from "./backend"
import { BrowserEventStore } from "./event-store"
import { BrowserRegistry } from "./registry"
import { BrowserSecurityGate } from "./security"
import { BrowserRuntimeException } from "./errors"

export class BrowserCommandDispatcher {
    private readonly requests = new Map<string, {
        promise: Promise<BrowserCommandResponse>
        sessionId: string
    }>()

    constructor(
        private readonly registry: BrowserRegistry,
        private readonly security: BrowserSecurityGate,
        private readonly events: BrowserEventStore,
    ) {}

    dispatch(
        request: BrowserCommandRequest,
        context: BrowserDispatchContext,
    ): Promise<BrowserCommandResponse> {
        const existing = this.requests.get(request.requestId)
        if (existing) {
            if (existing.sessionId !== request.sessionId) {
                throw new BrowserRuntimeException("PERMISSION_DENIED", "Browser request ID belongs to another session")
            }
            return existing.promise
        }
        const promise = this.execute(request, context)
        this.requests.set(request.requestId, { promise, sessionId: request.sessionId })
        const expiry = setTimeout(() => this.requests.delete(request.requestId), 2 * 60_000)
        expiry.unref()
        return promise
    }

    private async execute(
        request: BrowserCommandRequest,
        context: BrowserDispatchContext,
    ): Promise<BrowserCommandResponse> {
        const cursor = this.events.cursor()
        if (request.command.name === "browser.list") {
            return {
                data: { browsers: this.registry.list() },
                events: eventsForConversation(this.events.since(cursor), context.conversationId),
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                requestId: request.requestId,
            }
        }

        const backend = this.registry.get(request.browserId)
        this.security.ensureAllowed(request, backend.getState(context.conversationId), context)
        const data = await backend.dispatch(request, context)
        return {
            data,
            events: eventsForConversation(this.events.since(cursor), context.conversationId),
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            requestId: request.requestId,
            state: stateForActor(backend.getState(context.conversationId), request.sessionId, context.actor),
        }
    }
}

function eventsForConversation(
    events: BrowserCommandResponse["events"],
    conversationId: string,
) {
    return events.filter((event) => !event.sessionId || event.sessionId === conversationId)
}

function stateForActor(state: BrowserState, sessionId: string, actor: BrowserDispatchContext["actor"]): BrowserState {
    if (actor === "renderer") return state
    const tabs = state.tabs.filter((tab) => tab.ownership.ownerSessionId === sessionId)
    return {
        ...state,
        activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : null,
        tabs,
    }
}
