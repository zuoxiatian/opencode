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
import { browserState, EMPTY_BOUNDS, sanitizeBounds, tabState } from "./state"
import type { EmbeddedTab } from "./tab"

export class EmbeddedTabStore {
    private readonly tabs: EmbeddedTab[] = []
    private readonly historyEntries: BrowserHistoryEntry[] = []
    private activeTabId: string | null = null
    private attachedTabId: string | null = null
    private bounds: BrowserBounds = EMPTY_BOUNDS
    private destroyed = false
    private readonly sweepTimer: NodeJS.Timeout
    private visible = false

    constructor(
        private readonly window: BrowserWindow,
        private readonly events: BrowserEventStore,
        private readonly register: (tab: EmbeddedTab) => void,
    ) {
        this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000)
        this.sweepTimer.unref()
    }

    create(ownership: BrowserTabOwnership, request?: BrowserCommandRequest, activate = true) {
        if (this.destroyed) throw new BrowserRuntimeException("BROWSER_UNAVAILABLE", "Embedded browser is closed")
        const previousActiveTabId = this.activeTabId
        const tab: EmbeddedTab = {
            cdpEvents: [],
            cdpSequence: 0,
            cdpSessions: new Set(),
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
            view: new WebContentsView({
                webPreferences: {
                    contextIsolation: true,
                    nodeIntegration: false,
                    partition: "persist:desktop-forge-browser",
                    sandbox: true,
                    webSecurity: true,
                },
            }),
        }
        this.tabs.push(tab)
        if (activate) this.activeTabId = tab.id
        try {
            this.register(tab)
        } catch (error) {
            this.tabs.pop()
            this.activeTabId = previousActiveTabId
            tab.view.webContents.close()
            throw new BrowserRuntimeException(
                "BROWSER_UNAVAILABLE",
                error instanceof Error ? error.message : "Unable to initialize browser tab",
                true,
            )
        }
        this.publish("tab.created", tab, request)
        return tab
    }

    activate(tabId: string, request?: BrowserCommandRequest) {
        const tab = this.require(tabId)
        this.activeTabId = tab.id
        this.visible = true
        this.syncView()
        this.publish("tab.activated", tab, request)
        return tab
    }

    close(tabId: string, request?: BrowserCommandRequest) {
        const index = this.tabs.findIndex((tab) => tab.id === tabId)
        if (index < 0) throw new BrowserRuntimeException("TAB_NOT_FOUND", `Browser tab not found: ${tabId}`)
        const tab = this.tabs[index]
        const state = tabState(tab)
        if (this.attachedTabId === tabId) this.detach()
        tab.view.webContents.close()
        this.tabs.splice(index, 1)
        if (this.activeTabId === tabId) {
            this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
        }
        if (!this.tabs.length) this.visible = false
        this.syncView()
        this.publish("tab.closed", tab, request, state)
    }

    get(tabId?: string | null) {
        const id = tabId ?? this.activeTabId
        return this.tabs.find((tab) => tab.id === id)
    }

    require(tabId?: string | null) {
        const tab = this.get(tabId)
        if (!tab) throw new BrowserRuntimeException("TAB_NOT_FOUND", `Browser tab not found: ${tabId ?? "active"}`)
        if (tab.view.webContents.isDestroyed()) throw new BrowserRuntimeException("TAB_CLOSED", `Browser tab is closed: ${tab.id}`)
        return tab
    }

    list() {
        return [...this.tabs]
    }

    show(request?: BrowserCommandRequest) {
        this.visible = true
        if (!this.tabs.length) {
            this.create({
                createdBy: request?.sessionId === "renderer" ? "user" : "agent",
                disposition: request?.sessionId === "renderer" ? "deliverable" : "temporary",
                ownerSessionId: request?.sessionId === "renderer" ? undefined : request?.sessionId,
            }, request)
        }
        this.syncView()
        this.events.publish("browser.shown", eventInput(request))
    }

    hide(request?: BrowserCommandRequest) {
        this.visible = false
        this.detach()
        this.events.publish("browser.hidden", eventInput(request))
    }

    setBounds(bounds: BrowserBounds) {
        this.bounds = sanitizeBounds(bounds)
        this.get(this.attachedTabId)?.view.setBounds(this.bounds)
    }

    getState(): BrowserState {
        if (this.destroyed) return browserState([], null, false, EMPTY_BOUNDS)
        return browserState(this.tabs, this.activeTabId, this.visible, this.bounds)
    }

    changed(tab: EmbeddedTab, request?: BrowserCommandRequest) {
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
            .filter((tab) => tab.ownership.ownerSessionId === sessionId)
            .forEach((tab) => {
                if (keep.get(tab.id) === "deliverable") {
                    tab.ownership = { createdBy: tab.ownership.createdBy, disposition: "deliverable" }
                    this.changed(tab, request)
                    return
                }
                if (keep.get(tab.id) === "handoff" || tab.ownership.disposition === "handoff") {
                    tab.ownership.disposition = "handoff"
                    this.changed(tab, request)
                    return
                }
                if (tab.ownership.createdBy === "agent" && tab.ownership.disposition === "temporary") {
                    this.close(tab.id, request)
                    return
                }
                if (tab.ownership.createdBy === "user" && tab.ownership.disposition === "temporary") {
                    tab.ownership.disposition = "deliverable"
                }
                tab.ownership.ownerSessionId = undefined
                this.changed(tab, request)
            })
    }

    recordHistory(tab: EmbeddedTab) {
        const url = tab.view.webContents.getURL()
        if (!/^https?:/i.test(url)) return
        const entry = {
            dateVisited: new Date().toISOString(),
            title: tab.view.webContents.getTitle() || undefined,
            url,
        }
        const previous = this.historyEntries[0]
        if (previous?.url === entry.url && previous.title === entry.title) {
            this.historyEntries[0] = entry
            return
        }
        this.historyEntries.unshift(entry)
        if (this.historyEntries.length > 10_000) this.historyEntries.length = 10_000
    }

    history(options: BrowserHistoryOptions = {}) {
        const from = options.from ? new Date(options.from).getTime() : Number.NEGATIVE_INFINITY
        const to = options.to ? new Date(options.to).getTime() : Number.POSITIVE_INFINITY
        const queries = options.queries?.map((query) => query.toLocaleLowerCase()) ?? []
        return this.historyEntries
            .filter((entry) => {
                const visited = new Date(entry.dateVisited).getTime()
                if (visited < from || visited > to) return false
                if (!queries.length) return true
                const text = `${entry.title ?? ""} ${entry.url}`.toLocaleLowerCase()
                return queries.every((query) => text.includes(query))
            })
            .slice(0, options.limit ?? 100)
            .map((entry) => ({ ...entry }))
    }

    mark(tab: EmbeddedTab, disposition: BrowserTabOwnership["disposition"], request: BrowserCommandRequest) {
        tab.ownership.disposition = disposition
        tab.ownership.ownerSessionId = request.sessionId
        this.changed(tab, request)
    }

    claim(tab: EmbeddedTab, sessionId: string, request: BrowserCommandRequest) {
        if (tab.ownership.ownerSessionId && tab.ownership.ownerSessionId !== sessionId) {
            throw new BrowserRuntimeException("TAB_NOT_OWNED", "Browser tab is controlled by another session")
        }
        tab.ownership.ownerSessionId = sessionId
        if (tab.ownership.createdBy === "user") tab.ownership.disposition = "temporary"
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
            tab.view.webContents.close()
        })
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
            sessionId: request?.sessionId ?? tab.ownership.ownerSessionId,
            tabId: tab.id,
        })
    }

    private syncView() {
        if (this.destroyed || this.window.isDestroyed()) return
        const active = this.get()
        const shouldAttach = this.visible && active && !active.error && Boolean(active.view.webContents.getURL())
        if (this.attachedTabId && (!shouldAttach || this.attachedTabId !== active?.id)) this.detach()
        if (!shouldAttach || this.attachedTabId === active.id) return
        this.window.contentView.addChildView(active.view)
        this.attachedTabId = active.id
        active.view.setBounds(this.bounds)
    }

    private detach() {
        const attached = this.get(this.attachedTabId)
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
                    && tab.ownership.disposition !== "deliverable"
                ) {
                    this.close(tab.id)
                    return
                }
                tab.ownership.ownerSessionId = undefined
                tab.ownership.disposition = "deliverable"
                this.changed(tab)
            })
    }
}

function eventInput(request?: BrowserCommandRequest) {
    return {
        browserId: "embedded",
        requestId: request?.requestId,
        sessionId: request?.sessionId,
    }
}
