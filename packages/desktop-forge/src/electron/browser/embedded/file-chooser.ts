import type { BrowserFileChooser } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import type { BrowserEventStore } from "../event-store"
import type { EmbeddedTab } from "./tab"
import type { EmbeddedTabStore } from "./tab-store"
import { onDebuggerMessage, withDebugger } from "./automation/cdp"

interface PendingChooser extends BrowserFileChooser {
    backendNodeId: number
    tabId: string
}

export class FileChooserService {
    private readonly choosers = new Map<string, PendingChooser>()

    constructor(
        private readonly tabs: EmbeddedTabStore,
        private readonly events: BrowserEventStore,
    ) {}

    register(tab: EmbeddedTab) {
        const webContents = tab.webContents
        const clear = () => {
            let removed = false
            this.choosers.forEach((chooser, id) => {
                if (chooser.tabId !== tab.id) return
                this.choosers.delete(id)
                removed = true
            })
            if (removed && !webContents.isDestroyed()) {
                void withDebugger(tab, (send) =>
                    send("Page.setInterceptFileChooserDialog", { enabled: false }))
                    .catch(() => undefined)
            }
        }
        webContents.on("did-start-navigation", clear)
        webContents.once("destroyed", clear)
    }

    wait(
        tab: EmbeddedTab,
        timeout = 30_000,
        signal?: AbortSignal,
        trigger?: () => Promise<unknown>,
    ) {
        if (tab.fileChooser) return Promise.resolve(tab.fileChooser)
        const webContents = tab.webContents
        if (webContents.isDestroyed()) {
            return Promise.reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab is closed"))
        }
        if (signal?.aborted) {
            return Promise.reject(new BrowserRuntimeException("CANCELLED", "File chooser wait was cancelled", true))
        }
        const generation = tab.generation
        return new Promise<BrowserFileChooser>((resolve, reject) => {
            const browserDebugger = webContents.debugger
            const attached = browserDebugger.isAttached()
            if (!attached) browserDebugger.attach("1.3")
            let removeDebuggerListener: () => void = () => undefined
            const sender = (method: string, params?: Record<string, unknown>) =>
                browserDebugger.sendCommand(method, params)
            const message = (
                _event: Electron.Event,
                method: string,
                params: Record<string, unknown>,
            ) => {
                if (tab.closed || webContents.isDestroyed()) return
                if (method !== "Page.fileChooserOpened") return
                const backendNodeId = params.backendNodeId
                if (typeof backendNodeId !== "number") return
                const chooser: PendingChooser = {
                    backendNodeId,
                    generation: tab.generation,
                    id: crypto.randomUUID(),
                    multiple: params.mode === "selectMultiple",
                    tabId: tab.id,
                }
                const state: BrowserFileChooser = {
                    generation: chooser.generation,
                    id: chooser.id,
                    multiple: chooser.multiple,
                }
                this.choosers.set(chooser.id, chooser)
                tab.fileChooser = state
                cleanup()
                this.events.publish("fileChooser.opened", {
                    browserId: "embedded",
                    generation: tab.generation,
                    payload: { chooser: state },
                    sessionId: tab.ownership.ownerSessionId,
                    tabId: tab.id,
                })
                this.tabs.changed(tab)
                resolve(state)
            }
            const cancel = () => {
                cleanup(true)
                reject(new BrowserRuntimeException("CANCELLED", "File chooser wait was cancelled", true))
            }
            const closed = () => {
                cleanup(true)
                reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while waiting for a file chooser"))
            }
            const replaced = () => {
                if (tab.generation === generation) return
                cleanup(true)
                reject(new BrowserRuntimeException(
                    "NAVIGATION_REPLACED",
                    "Page changed while waiting for a file chooser",
                    true,
                ))
            }
            const timer = setTimeout(() => {
                cleanup(true)
                reject(new BrowserRuntimeException("TIMEOUT", "Timed out waiting for file chooser", true))
            }, Math.max(1, timeout))
            timer.unref()
            const cleanup = (disable = false) => {
                clearTimeout(timer)
                removeDebuggerListener()
                webContents.removeListener("destroyed", closed)
                webContents.removeListener("did-start-navigation", replaced)
                signal?.removeEventListener("abort", cancel)
                if (disable && !webContents.isDestroyed()) {
                    void sender("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined)
                }
                if (!attached && !webContents.isDestroyed() && browserDebugger.isAttached()) {
                    browserDebugger.detach()
                }
            }
            removeDebuggerListener = onDebuggerMessage(webContents, message, () => !tab.closed)
            webContents.once("destroyed", closed)
            webContents.on("did-start-navigation", replaced)
            signal?.addEventListener("abort", cancel, { once: true })
            if (signal?.aborted) {
                cancel()
                return
            }
            void sender("Page.setInterceptFileChooserDialog", { enabled: true })
                .then(() => {
                    if (signal?.aborted || webContents.isDestroyed()) return
                    return trigger?.()
                })
                .catch((error: unknown) => {
                    cleanup(true)
                    reject(error)
                })
        })
    }

    async setFiles(tab: EmbeddedTab, chooserId: string, files: string[]) {
        const chooser = this.choosers.get(chooserId)
        if (!chooser || chooser.generation !== tab.generation || tab.fileChooser?.id !== chooserId) {
            throw new BrowserRuntimeException("FILE_CHOOSER_NOT_FOUND", "File chooser is no longer available")
        }
        if (!chooser.multiple && files.length > 1) {
            throw new BrowserRuntimeException("INVALID_COMMAND", "File chooser accepts only one file")
        }
        await withDebugger(tab, (send) => send("DOM.setFileInputFiles", {
            backendNodeId: chooser.backendNodeId,
            files,
        }))
        await withDebugger(tab, (send) => send("Page.setInterceptFileChooserDialog", { enabled: false }))
        this.choosers.delete(chooserId)
        tab.fileChooser = null
        this.events.publish("fileChooser.closed", {
            browserId: "embedded",
            generation: tab.generation,
            payload: { chooserId },
            sessionId: tab.ownership.ownerSessionId,
            tabId: tab.id,
        })
        this.tabs.changed(tab)
    }

    destroy() {
        this.choosers.clear()
    }
}
