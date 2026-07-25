import type { WebContents } from "electron"
import type { BrowserCommandRequest } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import type { BrowserEventStore } from "../event-store"
import type { EmbeddedTab } from "./tab"
import type { EmbeddedTabStore } from "./tab-store"
import { onDebuggerMessage } from "./automation/cdp"

type RunDialogInfo = {
    defaultPromptText?: string
    dialogType: "alert" | "confirm" | "prompt"
    messageText: string
}

type RunDialogCallback = (accept: boolean, promptText: string) => void

export class DialogService {
    private readonly callbacks = new Map<string, { callback: RunDialogCallback; dialogId: string }>()
    private readonly waiters = new Map<string, Set<(dialog: NonNullable<EmbeddedTab["dialog"]>) => void>>()

    constructor(
        private readonly tabs: EmbeddedTabStore,
        private readonly events: BrowserEventStore,
    ) {}

    register(tab: EmbeddedTab) {
        tab.webContents.removeAllListeners("-run-dialog")
        const onRunDialog = tab.webContents.on.bind(tab.webContents) as unknown as (
            event: "-run-dialog",
            listener: (info: RunDialogInfo, callback: RunDialogCallback) => void,
        ) => WebContents
        onRunDialog("-run-dialog", (info, callback) => {
            if (!["alert", "confirm", "prompt"].includes(info.dialogType)) {
                callback(false, "")
                return
            }
            if (tab.dialog) {
                callback(false, "")
                return
            }
            tab.dialog = {
                defaultPrompt: info.defaultPromptText,
                generation: tab.generation,
                id: crypto.randomUUID(),
                message: info.messageText,
                type: info.dialogType,
            }
            this.callbacks.set(tab.id, { callback, dialogId: tab.dialog.id })
            this.waiters.get(tab.id)?.forEach((waiter) => waiter(tab.dialog!))
            this.events.publish("dialog.opened", eventInput(tab, { dialog: tab.dialog }))
            this.tabs.changed(tab)
        })
        tab.webContents.once("destroyed", () => this.callbacks.delete(tab.id))
        onDebuggerMessage(tab.webContents, (_event, method, params) => {
            if (method === "Page.javascriptDialogClosed") {
                if (this.callbacks.has(tab.id)) return
                if (!tab.dialog) return
                const dialogId = tab.dialog.id
                tab.dialog = null
                this.events.publish("dialog.closed", eventInput(tab, { dialogId }))
                this.tabs.changed(tab)
                return
            }
            if (method !== "Page.javascriptDialogOpening") return
            if (this.callbacks.has(tab.id)) return
            const type = params.type
            if (type !== "beforeunload") return
            tab.dialog = {
                defaultPrompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : undefined,
                generation: tab.generation,
                id: crypto.randomUUID(),
                message: typeof params.message === "string" ? params.message : "",
                type,
            }
            this.waiters.get(tab.id)?.forEach((waiter) => waiter(tab.dialog!))
            this.events.publish("dialog.opened", eventInput(tab, { dialog: tab.dialog }))
            this.tabs.changed(tab)
        }, () => !tab.closed)
    }

    wait(tab: EmbeddedTab, timeout = 30_000, signal?: AbortSignal) {
        if (tab.dialog) return Promise.resolve(tab.dialog)
        const webContents = tab.webContents
        if (webContents.isDestroyed()) {
            return Promise.reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab is closed"))
        }

        const generation = tab.generation
        return new Promise<NonNullable<EmbeddedTab["dialog"]>>((resolve, reject) => {
            const finish = (dialog: NonNullable<EmbeddedTab["dialog"]>) => {
                cleanup()
                resolve(dialog)
            }
            const closed = () => {
                cleanup()
                reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while waiting for a dialog"))
            }
            const replaced = () => {
                if (tab.generation === generation) return
                cleanup()
                reject(new BrowserRuntimeException(
                    "NAVIGATION_REPLACED",
                    "Page changed while waiting for a dialog",
                    true,
                ))
            }
            const cancel = () => {
                cleanup()
                reject(new BrowserRuntimeException("CANCELLED", "Dialog wait was cancelled", true))
            }
            const timer = setTimeout(() => {
                cleanup()
                reject(new BrowserRuntimeException("TIMEOUT", "Timed out waiting for a dialog", true))
            }, Math.max(1, timeout))
            timer.unref()
            const cleanup = () => {
                clearTimeout(timer)
                const waiters = this.waiters.get(tab.id)
                waiters?.delete(finish)
                if (!waiters?.size) this.waiters.delete(tab.id)
                webContents.removeListener("destroyed", closed)
                webContents.removeListener("did-start-navigation", replaced)
                signal?.removeEventListener("abort", cancel)
            }

            this.waiters.set(tab.id, new Set([...(this.waiters.get(tab.id) ?? []), finish]))
            webContents.once("destroyed", closed)
            webContents.on("did-start-navigation", replaced)
            signal?.addEventListener("abort", cancel, { once: true })
            if (signal?.aborted) cancel()
        })
    }

    async handle(
        tab: EmbeddedTab,
        input: { accept: boolean; dialogId: string; promptText?: string },
        request: BrowserCommandRequest,
    ) {
        if (!tab.dialog || tab.dialog.id !== input.dialogId || tab.dialog.generation !== tab.generation) {
            throw new BrowserRuntimeException("DIALOG_REQUIRED", "JavaScript dialog is no longer available")
        }
        const pending = this.callbacks.get(tab.id)
        if (pending?.dialogId === input.dialogId) {
            this.callbacks.delete(tab.id)
            tab.dialog = null
            pending.callback(input.accept, input.promptText ?? "")
            this.events.publish("dialog.closed", eventInput(tab, { dialogId: input.dialogId }))
            this.tabs.changed(tab, request)
            return
        }
        await tab.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", {
            accept: input.accept,
            promptText: input.promptText,
        })
        if (!tab.dialog || tab.dialog.id !== input.dialogId) return
        tab.dialog = null
        this.events.publish("dialog.closed", eventInput(tab, { dialogId: input.dialogId }))
        this.tabs.changed(tab, request)
    }
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
