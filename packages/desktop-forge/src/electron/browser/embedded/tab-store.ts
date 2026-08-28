import { WebContentsView, type BrowserWindow } from "electron"
import type {
    BrowserBounds,
    BrowserCommandRequest,
    BrowserHistoryEntry,
    BrowserHistoryOptions,
    BrowserState,
    BrowserTabOwnership,
} from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import type { BrowserEventStore } from "../event-store"
import { TabDebuggerTransport } from "../agent-browser/debugger-transport"
import { browserState, EMPTY_BOUNDS, sanitizeBounds, tabState } from "./state"
import type { EmbeddedTab } from "./tab"

export class EmbeddedTabStore {
    private readonly tabs: EmbeddedTab[] = []
    private readonly historyEntries: Array<{ conversationId: string; entry: BrowserHistoryEntry }> = []
    private readonly conversations = new Map<string, {
        activeTabId: string | null
        lastSelectedAt: number
        visible: boolean
    }>()
    private readonly promotedConversations = new Map<string, string>()
    private activeConversationId: string | null = null
    private attachedTabId: string | null = null
    private layoutBounds: BrowserBounds = EMPTY_BOUNDS
    private suspended = false
    private destroyed = false
    private readonly sweepTimer: NodeJS.Timeout

    constructor(
        private readonly window: BrowserWindow,
        private readonly events: BrowserEventStore,
        private readonly register: (tab: EmbeddedTab) => void,
        private readonly raiseOverlays?: () => void,
    ) {
        this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000)
        this.sweepTimer.unref()
    }

    create(
        conversationId: string,
        ownership: BrowserTabOwnership,
        request?: BrowserCommandRequest,
        activate = true,
    ) {
        if (this.destroyed) throw new BrowserRuntimeException("BROWSER_UNAVAILABLE", "Embedded browser is closed")
        const state = this.conversation(conversationId)
        const previousActiveTabId = state.activeTabId
        const view = new WebContentsView({
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                partition: "persist:desktop-forge-browser",
                sandbox: true,
                webSecurity: true,
            },
        })
        const tab: EmbeddedTab = {
            cdpEvents: [],
            cdpSequence: 0,
            closed: false,
            conversationId,
            debuggerTransport: new TabDebuggerTransport(view.webContents),
            debuggerQueue: Promise.resolve(),
            debuggerReady: Promise.resolve(),
            dialog: null,
            downloads: new Map(),
            fileChooser: null,
            generation: 0,
            id: `browser-tab-${crypto.randomUUID()}`,
            lastTouchedAt: Date.now(),
            logs: [],
            networkRequests: new Set(),
            ownership,
            view,
            webContents: view.webContents,
        }
        this.tabs.push(tab)
        if (activate) state.activeTabId = tab.id
        tab.webContents.once("destroyed", () => {
            tab.closed = true
        })
        try {
            this.register(tab)
        } catch (error) {
            this.tabs.pop()
            state.activeTabId = previousActiveTabId
            tab.closed = true
            if (!tab.webContents.isDestroyed()) tab.webContents.close()
            throw new BrowserRuntimeException(
                "BROWSER_UNAVAILABLE",
                error instanceof Error ? error.message : "Unable to initialize browser tab",
                true,
            )
        }
        this.publish("tab.created", tab, request)
        return tab
    }

    activate(conversationId: string, tabId: string, request?: BrowserCommandRequest) {
        const tab = this.require(conversationId, tabId)
        const state = this.conversation(conversationId)
        state.activeTabId = tab.id
        state.visible = true
        state.lastSelectedAt = Date.now()
        this.syncView()
        this.publish("tab.activated", tab, request)
        return tab
    }

    close(conversationId: string, tabId: string, request?: BrowserCommandRequest) {
        const index = this.tabs.findIndex((tab) => tab.id === tabId && tab.conversationId === conversationId)
        if (index < 0) throw new BrowserRuntimeException("TAB_NOT_FOUND", `Browser tab not found: ${tabId}`)
        const tab = this.tabs[index]
        const closedState = tabState(tab)
        const scopedIndex = this.tabs.slice(0, index).filter((item) => item.conversationId === conversationId).length
        if (this.attachedTabId === tabId) this.detach()
        tab.closed = true
        tab.debuggerTransport.destroy()
        tab.webContents.close()
        this.tabs.splice(index, 1)
        const state = this.conversation(conversationId)
        if (state.activeTabId === tabId) {
            const tabs = this.list(conversationId)
            state.activeTabId = tabs[Math.min(scopedIndex, tabs.length - 1)]?.id ?? null
        }
        if (!this.list(conversationId).length) state.visible = false
        this.syncView()
        this.publish("tab.closed", tab, request, closedState)
    }

    get(conversationId: string, tabId?: string | null) {
        const id = tabId ?? this.conversation(conversationId).activeTabId
        return this.tabs.find((tab) => tab.id === id && tab.conversationId === conversationId)
    }

    require(conversationId: string, tabId?: string | null) {
        const tab = this.get(conversationId, tabId)
        if (!tab) throw new BrowserRuntimeException("TAB_NOT_FOUND", `Browser tab not found: ${tabId ?? "active"}`)
        if (tab.closed || tab.webContents.isDestroyed()) {
            throw new BrowserRuntimeException("TAB_CLOSED", `Browser tab is closed: ${tab.id}`)
        }
        return tab
    }

    list(conversationId: string) {
        return this.tabs.filter((tab) => tab.conversationId === conversationId)
    }

    findByWebContentsId(webContentsId: number) {
        return this.tabs.find((tab) => tab.webContents.id === webContentsId)
    }

    show(conversationId: string, ownership: BrowserTabOwnership, request?: BrowserCommandRequest) {
        const state = this.conversation(conversationId)
        state.visible = true
        if (!this.list(conversationId).length) {
            this.create(conversationId, ownership, request)
        }
        this.syncView()
        this.events.publish("browser.shown", eventInput(conversationId, request))
    }

    hide(conversationId: string, request?: BrowserCommandRequest) {
        this.conversation(conversationId).visible = false
        this.syncView()
        this.events.publish("browser.hidden", eventInput(conversationId, request))
    }

    setLayoutBounds(bounds: BrowserBounds) {
        const [width, height] = this.window.isDestroyed() ? [0, 0] : this.window.getContentSize()
        this.layoutBounds = sanitizeBounds(bounds, { height, width })
        if (this.destroyed || this.window.isDestroyed()) return
        this.findByTabId(this.attachedTabId)?.view.setBounds(this.layoutBounds)
    }

    setSuspended(suspended: boolean) {
        if (this.suspended === suspended) return
        this.suspended = suspended
        this.syncView()
    }

    getState(conversationId: string): BrowserState {
        if (this.destroyed) return browserState([], null, false, EMPTY_BOUNDS)
        const state = this.conversation(conversationId)
        return browserState(this.list(conversationId), state.activeTabId, state.visible, this.layoutBounds)
    }

    syncOwner(conversationId: string | null) {
        this.activeConversationId = conversationId
        if (conversationId) this.conversation(conversationId).lastSelectedAt = Date.now()
        this.syncView()
        return conversationId ? this.getState(conversationId) : null
    }

    getActiveConversationId() {
        return this.activeConversationId
    }

    promoteConversation(sourceConversationId: string, targetConversationId: string) {
        const promoted = this.promotedConversations.get(sourceConversationId)
        if (promoted && promoted !== targetConversationId) {
            throw new BrowserRuntimeException(
                "BROWSER_UNAVAILABLE",
                "Browser draft was already attached to another conversation",
            )
        }
        if (promoted) return this.getState(targetConversationId)
        if (this.list(targetConversationId).length) {
            throw new BrowserRuntimeException(
                "BROWSER_UNAVAILABLE",
                "Target conversation already has browser tabs",
            )
        }

        const source = this.conversations.get(sourceConversationId)
        const target = this.conversations.get(targetConversationId)
        this.tabs
            .filter((tab) => tab.conversationId === sourceConversationId)
            .forEach((tab) => {
                tab.conversationId = targetConversationId
                if (tab.ownership.ownerSessionId === sourceConversationId) {
                    tab.ownership.ownerSessionId = targetConversationId
                }
                tab.downloads.forEach((download) => {
                    if (download.sessionId === sourceConversationId) download.sessionId = targetConversationId
                })
            })
        this.historyEntries.forEach((item) => {
            if (item.conversationId === sourceConversationId) item.conversationId = targetConversationId
        })
        this.conversations.delete(sourceConversationId)
        this.conversations.set(targetConversationId, source ?? target ?? {
            activeTabId: null,
            lastSelectedAt: Date.now(),
            visible: false,
        })
        this.promotedConversations.set(sourceConversationId, targetConversationId)
        if (this.activeConversationId === sourceConversationId) this.activeConversationId = targetConversationId
        this.syncView()
        return this.getState(targetConversationId)
    }

    changed(tab: EmbeddedTab, request?: BrowserCommandRequest) {
        if (!this.tabs.includes(tab) || tab.closed || tab.webContents.isDestroyed()) return
        if (request) tab.lastTouchedAt = Date.now()
        this.syncView()
        this.publish("tab.updated", tab, request)
    }

    finalize(
        sessionId: string,
        input: { keep?: Array<{ status: "deliverable" | "handoff"; tabId: string }> },
        request?: BrowserCommandRequest,
    ) {
        const keep = new Map(input.keep?.map((item) => [item.tabId, item.status]) ?? [])
        this.tabs
            .filter((tab) => tab.conversationId === sessionId && tab.ownership.ownerSessionId === sessionId)
            .forEach((tab) => {
                if (keep.get(tab.id) === "deliverable") {
                    tab.ownership.disposition = "deliverable"
                    tab.ownership.ownerSessionId = undefined
                    this.changed(tab, request)
                    return
                }
                if (keep.get(tab.id) === "handoff" || tab.ownership.disposition === "handoff") {
                    tab.ownership.disposition = "handoff"
                    tab.ownership.ownerSessionId = undefined
                    this.changed(tab, request)
                    return
                }
                if (tab.ownership.createdBy === "agent" && tab.ownership.disposition === "temporary") {
                    this.close(tab.conversationId, tab.id, request)
                    return
                }
                tab.ownership.ownerSessionId = undefined
                this.changed(tab, request)
            })
    }

    recordHistory(tab: EmbeddedTab) {
        const url = tab.webContents.getURL()
        if (!/^https?:/i.test(url)) return
        const entry = {
            dateVisited: new Date().toISOString(),
            title: tab.webContents.getTitle() || undefined,
            url,
        }
        const previous = this.historyEntries[0]
        if (
            previous?.conversationId === tab.conversationId
            && previous.entry.url === entry.url
            && previous.entry.title === entry.title
        ) {
            this.historyEntries[0] = { conversationId: tab.conversationId, entry }
            return
        }
        this.historyEntries.unshift({ conversationId: tab.conversationId, entry })
        if (this.historyEntries.length > 10_000) this.historyEntries.length = 10_000
    }

    history(conversationId: string, options: BrowserHistoryOptions = {}) {
        const from = options.from ? new Date(options.from).getTime() : Number.NEGATIVE_INFINITY
        const to = options.to ? new Date(options.to).getTime() : Number.POSITIVE_INFINITY
        const queries = options.queries?.map((query) => query.toLocaleLowerCase()) ?? []
        return this.historyEntries
            .filter((item) => {
                if (item.conversationId !== conversationId) return false
                const entry = item.entry
                const visited = new Date(entry.dateVisited).getTime()
                if (visited < from || visited > to) return false
                if (!queries.length) return true
                const text = `${entry.title ?? ""} ${entry.url}`.toLocaleLowerCase()
                return queries.every((query) => text.includes(query))
            })
            .slice(0, options.limit ?? 100)
            .map((item) => ({ ...item.entry }))
    }

    mark(tab: EmbeddedTab, disposition: BrowserTabOwnership["disposition"], request: BrowserCommandRequest) {
        tab.ownership.disposition = disposition
        if (request.sessionId !== "renderer") tab.ownership.ownerSessionId = request.sessionId
        this.changed(tab, request)
    }

    claim(tab: EmbeddedTab, sessionId: string, request: BrowserCommandRequest) {
        if (tab.ownership.ownerSessionId && tab.ownership.ownerSessionId !== sessionId) {
            throw new BrowserRuntimeException("TAB_NOT_OWNED", "Browser tab is controlled by another session")
        }
        tab.ownership.ownerSessionId = sessionId
        this.changed(tab, request)
    }

    touch(tab: EmbeddedTab) {
        tab.lastTouchedAt = Date.now()
    }

    async destroy() {
        if (this.destroyed) return
        this.destroyed = true
        clearInterval(this.sweepTimer)
        this.detach()
        this.tabs.splice(0).forEach((tab) => {
            tab.closed = true
            tab.debuggerTransport.destroy()
            if (!tab.webContents.isDestroyed()) tab.webContents.close()
        })
    }

    disposeConversation(conversationId: string) {
        this.list(conversationId).forEach((tab) => this.close(conversationId, tab.id))
        this.conversations.delete(conversationId)
        this.promotedConversations.delete(conversationId)
        for (const [source, target] of this.promotedConversations) {
            if (target === conversationId) this.promotedConversations.delete(source)
        }
        const history = this.historyEntries.filter((item) => item.conversationId !== conversationId)
        this.historyEntries.splice(0, this.historyEntries.length, ...history)
        if (this.activeConversationId !== conversationId) return
        this.activeConversationId = null
        this.syncView()
    }

    private publish(
        type: "tab.activated" | "tab.closed" | "tab.created" | "tab.updated",
        tab: EmbeddedTab,
        request?: BrowserCommandRequest,
        state = tabState(tab),
    ) {
        this.events.publish(type, {
            browserId: "embedded",
            generation: tab.generation,
            payload: { tab: state },
            requestId: request?.requestId,
            sessionId: tab.conversationId,
            tabId: tab.id,
        })
    }

    private syncView() {
        if (this.destroyed || this.window.isDestroyed()) return
        const state = this.activeConversationId ? this.conversation(this.activeConversationId) : undefined
        const active = this.activeConversationId ? this.get(this.activeConversationId) : undefined
        const shouldAttach = !this.suspended
            && state?.visible === true
            && active
            && !active.closed
            && !active.webContents.isDestroyed()
            && !active.error
            && Boolean(active.webContents.getURL())
        if (this.attachedTabId && (!shouldAttach || this.attachedTabId !== active?.id)) this.detach()
        if (!shouldAttach || this.attachedTabId === active.id) return
        this.window.contentView.addChildView(active.view)
        this.raiseOverlays?.()
        this.attachedTabId = active.id
        active.view.setBounds(this.layoutBounds)
    }

    private detach() {
        const attached = this.findByTabId(this.attachedTabId)
        if (attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(attached.view)
        this.attachedTabId = null
    }

    private sweepExpired() {
        const expiredBefore = Date.now() - 30 * 60_000
        this.tabs
            .filter((tab) => tab.ownership.ownerSessionId && tab.lastTouchedAt < expiredBefore)
            .forEach((tab) => {
                if (
                    tab.ownership.createdBy === "agent"
                    && tab.ownership.disposition === "temporary"
                ) {
                    this.close(tab.conversationId, tab.id)
                    return
                }
                tab.ownership.ownerSessionId = undefined
                if (tab.ownership.createdBy === "user" && tab.ownership.disposition === "temporary") {
                    tab.ownership.disposition = "deliverable"
                }
                this.changed(tab)
            })
    }

    private conversation(conversationId: string) {
        const existing = this.conversations.get(conversationId)
        if (existing) return existing
        const state = { activeTabId: null, lastSelectedAt: Date.now(), visible: false }
        this.conversations.set(conversationId, state)
        return state
    }

    private findByTabId(tabId?: string | null) {
        if (!tabId) return
        return this.tabs.find((tab) => tab.id === tabId)
    }
}

function eventInput(conversationId: string, request?: BrowserCommandRequest) {
    return {
        browserId: "embedded",
        requestId: request?.requestId,
        sessionId: conversationId,
    }
}
