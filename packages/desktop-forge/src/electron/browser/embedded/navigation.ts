import type { Session } from "electron"
import type { BrowserCommandRequest, BrowserLoadError, BrowserNavigationResult } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import type { BrowserEventStore } from "../event-store"
import type { EmbeddedTab } from "./tab"
import type { EmbeddedTabStore } from "./tab-store"
import { onDebuggerMessage } from "./automation/cdp"
import { expectNavigation } from "./automation/waits"

export class NavigationService {
    constructor(
        private readonly browserSession: Session,
        private readonly tabs: EmbeddedTabStore,
        private readonly events: BrowserEventStore,
    ) {}

    register(tab: EmbeddedTab) {
        tab.webContents.on("did-start-loading", () => this.tabs.changed(tab))
        tab.webContents.on("did-stop-loading", () => {
            this.tabs.changed(tab)
            this.events.publish("navigation.completed", eventInput(tab))
        })
        tab.webContents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
            if (!isMainFrame || !isWebUrl(url)) return
            if (inPlace) {
                tab.generation += 1
                this.events.publish("navigation.started", eventInput(tab, { url }))
                this.tabs.changed(tab)
                return
            }
            if (!tab.pendingUrl) {
                this.prepare(tab, url)
            } else if (tab.pendingUrl !== url) {
                tab.pendingUrl = url
            }
            this.events.publish("navigation.started", eventInput(tab, { url }))
            this.tabs.changed(tab)
        })
        tab.webContents.on("did-finish-load", () => {
            const response = tab.httpResponse
            const currentUrl = tab.webContents.getURL()
            const generation = tab.generation
            if (
                !response
                || response.statusCode < 400
                || !sameDocumentUrl(response.url, currentUrl)
            ) return
            const tracked = this.inspectHttpError(tab, response.statusCode, currentUrl, generation).finally(() => {
                if (tab.httpCheck === tracked) tab.httpCheck = undefined
            })
            tab.httpCheck = tracked
        })
        tab.webContents.on("did-navigate", (_event, url) => {
            if (tab.pendingUrl && tab.pendingUrl !== url) return
            tab.error = undefined
            tab.pendingUrl = undefined
            this.events.publish("navigation.committed", eventInput(tab, { url }))
            this.tabs.recordHistory(tab)
            this.tabs.changed(tab)
        })
        tab.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
            if (isMainFrame && isWebUrl(url)) {
                this.events.publish("navigation.committed", eventInput(tab, { url }))
                this.tabs.recordHistory(tab)
            }
            this.tabs.changed(tab)
        })
        tab.webContents.on("page-favicon-updated", (_event, favicons) => {
            if (tab.error) return
            const favicon = browserFavicon(favicons)
            if (!favicon || favicon === tab.faviconSource) return
            tab.faviconSource = favicon
            const generation = tab.generation
            void loadFavicon(this.browserSession, favicon).then((data) => {
                if (!data || tab.error || tab.generation !== generation || tab.faviconSource !== favicon) return
                tab.favicon = data
                this.tabs.changed(tab)
            })
        })
        tab.webContents.on("page-title-updated", () => this.tabs.changed(tab))
        const failed = (
            _event: Electron.Event,
            code: number,
            description: string,
            url: string,
            isMainFrame: boolean,
        ) => {
            const normalized = description.replace(/^net::/i, "").toUpperCase()
            if (!isMainFrame || code === -3 || ["ERR_ABORTED", "ERR_BLOCKED_BY_CLIENT"].includes(normalized)) return
            const failedUrl = url || tab.pendingUrl || tab.webContents.getURL()
            if (tab.pendingUrl && failedUrl !== tab.pendingUrl) return
            const currentUrl = tab.webContents.getURL()
            if (!tab.pendingUrl && browserOrigin(currentUrl) && failedUrl !== currentUrl) {
                return
            }
            if (tab.error?.kind === "load" && tab.error.url === failedUrl) return
            this.fail(tab, {
                code,
                description: normalized || "ERR_FAILED",
                kind: "load",
                url: failedUrl,
            })
        }
        tab.webContents.on("did-fail-load", failed)
        tab.webContents.on("did-fail-provisional-load", failed)
        tab.webContents.on("render-process-gone", (_event, details) => {
            if (details.reason === "clean-exit") return
            this.events.publish("tab.crashed", eventInput(tab, { reason: details.reason }))
            this.fail(tab, {
                code: 0,
                description: details.reason === "oom" ? "ERR_OUT_OF_MEMORY" : "PAGE_CRASHED",
                kind: "crash",
                url: tab.pendingUrl || tab.webContents.getURL(),
            })
        })
    }

    async goto(
        tab: EmbeddedTab,
        input: string,
        request: BrowserCommandRequest,
        signal?: AbortSignal,
        activate = true,
        timeout = 10_000,
    ) {
        const url = normalizeUrl(input)
        this.prepare(tab, url)
        const generation = tab.generation
        if (activate) this.tabs.activate(tab.id, request)
        const completed = expectNavigation(tab.webContents, timeout, signal, url)
        const loading = tab.webContents.loadURL(url)
        void loading.catch(() => undefined)
        this.tabs.changed(tab, request)
        await navigationCompletion(tab, completed, signal).catch((error: unknown) => {
            ensureCurrent(tab, generation)
            if (error instanceof BrowserRuntimeException) throw error
            if (!tab.error) this.fail(tab, browserLoadError(error, url), request)
        })
        await tab.httpCheck
        ensureCurrent(tab, generation)
        this.tabs.changed(tab, request)
        if (tab.error) return failedResult(tab)
        return {
            finalUrl: tab.webContents.getURL(),
            generation: tab.generation,
            status: "committed",
        } satisfies BrowserNavigationResult
    }

    async back(tab: EmbeddedTab, request: BrowserCommandRequest, signal?: AbortSignal) {
        const history = tab.webContents.navigationHistory
        if (!history.canGoBack()) return currentResult(tab)
        const url = history.getEntryAtIndex(history.getActiveIndex() - 1)?.url
        if (!url) return currentResult(tab)
        this.prepare(tab, url)
        const generation = tab.generation
        const completed = expectNavigation(tab.webContents, 10_000, signal)
        history.goBack()
        await navigationCompletion(tab, completed, signal).catch((error: unknown) => {
            ensureCurrent(tab, generation)
            if (error instanceof BrowserRuntimeException) throw error
            if (!tab.error) this.fail(tab, browserLoadError(error, url), request)
        })
        await tab.httpCheck
        ensureCurrent(tab, generation)
        this.tabs.changed(tab, request)
        return tab.error ? failedResult(tab) : currentResult(tab)
    }

    async forward(tab: EmbeddedTab, request: BrowserCommandRequest, signal?: AbortSignal) {
        const history = tab.webContents.navigationHistory
        if (!history.canGoForward()) return currentResult(tab)
        const url = history.getEntryAtIndex(history.getActiveIndex() + 1)?.url
        if (!url) return currentResult(tab)
        this.prepare(tab, url)
        const generation = tab.generation
        const completed = expectNavigation(tab.webContents, 10_000, signal)
        history.goForward()
        await navigationCompletion(tab, completed, signal).catch((error: unknown) => {
            ensureCurrent(tab, generation)
            if (error instanceof BrowserRuntimeException) throw error
            if (!tab.error) this.fail(tab, browserLoadError(error, url), request)
        })
        await tab.httpCheck
        ensureCurrent(tab, generation)
        this.tabs.changed(tab, request)
        return tab.error ? failedResult(tab) : currentResult(tab)
    }

    async reload(tab: EmbeddedTab, request: BrowserCommandRequest, signal?: AbortSignal) {
        await tab.debuggerReady
        if (tab.error?.url) return this.goto(tab, tab.error.url, request, signal)
        const url = tab.webContents.getURL()
        if (!url) throw new BrowserRuntimeException("NAVIGATION_FAILED", "Browser tab has no page to reload")
        this.prepare(tab, url)
        const generation = tab.generation
        const started = expectNavigation(tab.webContents, 10_000, signal)
        tab.webContents.reload()
        await navigationCompletion(tab, started, signal)
        await tab.httpCheck
        ensureCurrent(tab, generation)
        this.tabs.changed(tab, request)
        return tab.error ? failedResult(tab) : currentResult(tab)
    }

    stop(tab: EmbeddedTab, request: BrowserCommandRequest) {
        const finalUrl = tab.error?.url || tab.pendingUrl || tab.webContents.getURL()
        if (tab.pendingUrl || tab.webContents.isLoading()) tab.generation += 1
        tab.pendingUrl = undefined
        tab.webContents.stop()
        tab.networkRequests.clear()
        this.tabs.changed(tab, request)
        return {
            finalUrl,
            generation: tab.generation,
            status: "stopped",
        } satisfies BrowserNavigationResult
    }

    private prepare(tab: EmbeddedTab, url: string) {
        const currentUrl = tab.error?.url || tab.pendingUrl || tab.webContents.getURL()
        if (tab.error || browserOrigin(currentUrl) !== browserOrigin(url)) tab.favicon = undefined
        tab.faviconSource = undefined
        tab.dialog = null
        tab.error = undefined
        tab.fileChooser = null
        tab.generation += 1
        tab.httpCheck = undefined
        tab.httpResponse = undefined
        tab.networkRequests.clear()
        tab.pendingUrl = url
    }

    private fail(tab: EmbeddedTab, error: BrowserLoadError, request?: BrowserCommandRequest) {
        if (tab.webContents.isDestroyed()) return
        tab.error = error
        tab.favicon = undefined
        tab.faviconSource = undefined
        tab.httpResponse = undefined
        tab.networkRequests.clear()
        tab.pendingUrl = undefined
        this.events.publish("navigation.failed", {
            ...eventInput(tab, { error }),
            requestId: request?.requestId,
            sessionId: request?.sessionId,
        })
        this.tabs.changed(tab, request)
    }

    private async inspectHttpError(
        tab: EmbeddedTab,
        statusCode: number,
        url: string,
        generation: number,
    ) {
        const hasContent = await tab.webContents.executeJavaScript(`(() => {
            const body = document.body
            if (!body) return false
            if ((body.innerText || "").trim().length > 0) return true
            return Boolean(body.querySelector("img, svg, video, canvas, main, article, form, button, input"))
        })()`, true).catch(() => true)
        if (
            hasContent
            || tab.generation !== generation
            || !sameDocumentUrl(tab.webContents.getURL(), url)
        ) return
        this.fail(tab, {
            code: statusCode,
            description: "ERR_HTTP_RESPONSE_CODE_FAILURE",
            kind: "load",
            url,
        })
    }
}

export function normalizeUrl(input: string) {
    try {
        const value = input.trim()
        const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`)
        if (!isWebUrl(url.toString())) {
            throw new BrowserRuntimeException("INVALID_COMMAND", `Unsupported URL: ${input}`)
        }
        return url.toString()
    } catch (error) {
        if (error instanceof BrowserRuntimeException) throw error
        throw new BrowserRuntimeException("INVALID_COMMAND", `Invalid browser URL: ${input}`)
    }
}

export function browserOrigin(input: string) {
    try {
        const url = new URL(input)
        return isWebUrl(url.toString()) ? url.origin : undefined
    } catch {
        return undefined
    }
}

function isWebUrl(input: string) {
    const protocol = new URL(input).protocol
    return protocol === "http:" || protocol === "https:"
}

function browserFavicon(favicons: string[]) {
    return favicons.find((favicon) => {
        try {
            return ["data:", "http:", "https:"].includes(new URL(favicon).protocol)
        } catch {
            return false
        }
    })
}

async function loadFavicon(browserSession: Session, input: string) {
    if (input.startsWith("data:")) {
        if (!input.startsWith("data:image/") || input.length > 350_000) return
        return input
    }
    const response = await browserSession.fetch(input, {
        credentials: "include",
        signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    if (!response?.ok) return
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    if (!mimeType?.startsWith("image/")) return
    const declaredSize = Number(response.headers.get("content-length") ?? 0)
    if (Number.isFinite(declaredSize) && declaredSize > 256 * 1024) return
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > 256 * 1024) return
    return `data:${mimeType};base64,${data.toString("base64")}`
}

function sameDocumentUrl(left: string, right: string) {
    try {
        const first = new URL(left)
        const second = new URL(right)
        first.hash = ""
        second.hash = ""
        return first.toString() === second.toString()
    } catch {
        return left === right
    }
}

function browserLoadError(error: unknown, url: string): BrowserLoadError {
    const message = error instanceof Error ? error.message : String(error)
    return {
        code: Number(message.match(/\((-?\d+)\)/)?.[1] ?? 0),
        description: message.match(/ERR_[A-Z_]+/)?.[0] ?? "ERR_FAILED",
        kind: "load",
        url,
    }
}

function currentResult(tab: EmbeddedTab): BrowserNavigationResult {
    return {
        finalUrl: tab.error?.url || tab.pendingUrl || tab.webContents.getURL(),
        generation: tab.generation,
        status: "committed",
    }
}

function failedResult(tab: EmbeddedTab): BrowserNavigationResult {
    return {
        error: {
            code: "NAVIGATION_FAILED",
            details: tab.error
                ? {
                    code: tab.error.code,
                    description: tab.error.description,
                    kind: tab.error.kind,
                    url: tab.error.url,
                }
                : undefined,
            message: tab.error?.description ?? "Navigation failed",
            retryable: true,
        },
        finalUrl: tab.error?.url ?? tab.webContents.getURL(),
        generation: tab.generation,
        status: "failed",
    }
}

function ensureCurrent(tab: EmbeddedTab, generation: number) {
    const webContents = tab.webContents
    if (!webContents || webContents.isDestroyed()) {
        throw new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed during navigation")
    }
    if (tab.generation === generation) return
    throw new BrowserRuntimeException(
        "NAVIGATION_REPLACED",
        "Browser navigation was replaced by a newer navigation",
        true,
    )
}

function eventInput(tab: EmbeddedTab, payload?: Record<string, unknown>) {
    return {
        browserId: "embedded",
        generation: tab.generation,
        payload,
        sessionId: tab.ownership.ownerSessionId,
        tabId: tab.id,
    }
}

function navigationCompletion<T>(tab: EmbeddedTab, promise: Promise<T>, signal?: AbortSignal) {
    if (signal?.aborted) {
        return Promise.reject(new BrowserRuntimeException("CANCELLED", "Browser navigation was cancelled", true))
    }
    const webContents = tab.webContents
    if (webContents.isDestroyed()) {
        return Promise.reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed during navigation"))
    }
    if (tab.dialog) {
        return Promise.reject(new BrowserRuntimeException("DIALOG_REQUIRED", "Navigation is waiting for a dialog"))
    }
    return new Promise<T>((resolve, reject) => {
        let removeDebuggerListener: () => void = () => undefined
        const complete = (value: T) => {
            cleanup()
            resolve(value)
        }
        const failed = (error: unknown) => {
            cleanup()
            reject(error)
        }
        const dialog = (_event: Electron.Event, method: string) => {
            if (method !== "Page.javascriptDialogOpening") return
            cleanup()
            reject(new BrowserRuntimeException("DIALOG_REQUIRED", "Navigation is waiting for a dialog"))
        }
        const closed = () => {
            cleanup()
            reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed during navigation"))
        }
        const cancel = () => {
            cleanup()
            reject(new BrowserRuntimeException("CANCELLED", "Browser navigation was cancelled", true))
        }
        const cleanup = () => {
            removeDebuggerListener()
            webContents.removeListener("destroyed", closed)
            signal?.removeEventListener("abort", cancel)
        }
        removeDebuggerListener = onDebuggerMessage(webContents, dialog, () => !tab.closed)
        webContents.once("destroyed", closed)
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) {
            cancel()
            return
        }
        void promise.then(complete, failed)
    })
}
