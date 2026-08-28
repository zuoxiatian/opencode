import { app, type DownloadItem, type Event, type Session, type WebContents } from "electron"
import { mkdirSync } from "node:fs"
import { basename, join } from "node:path"
import type { BrowserDownload, BrowserCommandRequest } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import type { BrowserEventStore } from "../event-store"
import type { EmbeddedTabStore } from "./tab-store"
import type { EmbeddedTab } from "./tab"

export class DownloadService {
    private readonly createdAt = new Map<string, number>()
    private readonly directory = join(app.getPath("temp"), "longwise-browser-downloads")
    private readonly items = new Map<DownloadItem, {
        done: (event: Event, state: "cancelled" | "completed" | "interrupted") => void
        tabId: string
        updated: (event: Event, state: "interrupted" | "progressing") => void
    }>()
    private readonly listener: (event: Event, item: DownloadItem, webContents: WebContents) => void
    private readonly waiters = new Map<string, Array<(download: BrowserDownload) => void>>()

    constructor(
        private readonly browserSession: Session,
        private readonly tabs: EmbeddedTabStore,
        private readonly events: BrowserEventStore,
    ) {
        mkdirSync(this.directory, { recursive: true })
        this.listener = (_event, item, webContents) => {
            const tab = this.tabs.findByWebContentsId(webContents?.id ?? -1)
            if (!tab) return
            const download: BrowserDownload = {
                filename: item.getFilename(),
                id: crypto.randomUUID(),
                receivedBytes: item.getReceivedBytes(),
                sessionId: tab.ownership.ownerSessionId ?? "renderer",
                state: "pending",
                tabId: tab.id,
                totalBytes: item.getTotalBytes(),
                url: item.getURL(),
            }
            tab.downloads.set(download.id, download)
            this.createdAt.set(download.id, Date.now())
            if (this.waiters.has(tab.id)) {
                item.setSavePath(join(this.directory, `${download.id}-${basename(download.filename) || "download"}`))
            } else {
                item.setSaveDialogOptions({ defaultPath: item.getFilename(), title: "保存下载文件" })
            }
            this.resolveWaiter(tab.id, download)
            this.events.publish("download.created", eventInput(tab, download))
            const updated = (_updateEvent: Event, state: "interrupted" | "progressing") => {
                download.receivedBytes = item.getReceivedBytes()
                download.totalBytes = item.getTotalBytes()
                download.state = state === "interrupted" ? "failed" : "in-progress"
                download.error = state === "interrupted" ? "Download interrupted" : undefined
                this.events.publish("download.updated", eventInput(tab, download))
                this.tabs.changed(tab)
            }
            const done = (_doneEvent: Event, state: "cancelled" | "completed" | "interrupted") => {
                const listeners = this.items.get(item)
                if (listeners) this.removeItem(item, listeners)
                this.items.delete(item)
                download.receivedBytes = item.getReceivedBytes()
                download.totalBytes = item.getTotalBytes()
                download.path = state === "completed" ? item.getSavePath() : undefined
                download.state = state === "completed"
                    ? "completed"
                    : state === "cancelled"
                        ? "cancelled"
                        : "failed"
                download.error = state === "completed"
                    ? undefined
                    : state === "cancelled"
                        ? "Download cancelled"
                        : "Download interrupted"
                this.events.publish(
                    state === "completed" ? "download.completed" : "download.failed",
                    eventInput(tab, download),
                )
                this.tabs.changed(tab)
            }
            this.items.set(item, { done, tabId: tab.id, updated })
            item.on("updated", updated)
            item.once("done", done)
            this.tabs.changed(tab)
        }
        browserSession.on("will-download", this.listener)
    }

    get(tab: EmbeddedTab, downloadId: string, sessionId: string) {
        const download = tab.downloads.get(downloadId)
        if (!download || download.sessionId !== sessionId) {
            throw new BrowserRuntimeException("DOWNLOAD_NOT_FOUND", `Download not found: ${downloadId}`)
        }
        return download
    }

    wait(
        tab: EmbeddedTab,
        request: BrowserCommandRequest,
        timeout = 30_000,
        signal?: AbortSignal,
        includeRecent = true,
    ) {
        const tabId = tab.id
        if (signal?.aborted) {
            return Promise.reject(new BrowserRuntimeException("CANCELLED", "Download wait was cancelled", true))
        }
        const existing = includeRecent
            ? [...tab.downloads.values()]
                .findLast((download) =>
                    download.sessionId === request.sessionId
                    && Date.now() - (this.createdAt.get(download.id) ?? 0) < 5_000)
            : undefined
        if (existing) return Promise.resolve(existing)
        const webContents = tab.webContents
        return new Promise<BrowserDownload>((resolve, reject) => {
            const finish = (download: BrowserDownload) => {
                cleanup()
                download.sessionId = request.sessionId
                resolve(download)
            }
            const cancel = () => {
                cleanup()
                reject(new BrowserRuntimeException("CANCELLED", "Download wait was cancelled", true))
            }
            const closed = () => {
                cleanup()
                reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while waiting for a download"))
            }
            const timer = setTimeout(() => {
                cleanup()
                reject(new BrowserRuntimeException("TIMEOUT", "Timed out waiting for download", true))
            }, Math.max(1, timeout))
            timer.unref()
            const cleanup = () => {
                clearTimeout(timer)
                const waiters = this.waiters.get(tabId)
                const remaining = waiters?.filter((waiter) => waiter !== finish) ?? []
                if (remaining.length) this.waiters.set(tabId, remaining)
                else this.waiters.delete(tabId)
                webContents.removeListener("destroyed", closed)
                signal?.removeEventListener("abort", cancel)
            }
            this.waiters.set(tabId, [...(this.waiters.get(tabId) ?? []), finish])
            webContents.once("destroyed", closed)
            signal?.addEventListener("abort", cancel, { once: true })
            if (signal?.aborted) cancel()
        })
    }

    destroy() {
        this.browserSession.removeListener("will-download", this.listener)
        this.items.forEach((listeners, item) => this.removeItem(item, listeners))
        this.createdAt.clear()
        this.items.clear()
        this.waiters.clear()
    }

    clearTab(tabId: string) {
        this.items.forEach((listeners, item) => {
            if (listeners.tabId !== tabId) return
            this.removeItem(item, listeners)
            this.items.delete(item)
        })
        this.waiters.delete(tabId)
    }

    private resolveWaiter(tabId: string, download: BrowserDownload) {
        this.waiters.get(tabId)?.at(0)?.(download)
    }

    private removeItem(item: DownloadItem, listeners: {
        done: (event: Event, state: "cancelled" | "completed" | "interrupted") => void
        updated: (event: Event, state: "interrupted" | "progressing") => void
    }) {
        item.removeListener("updated", listeners.updated)
        item.removeListener("done", listeners.done)
    }
}

function eventInput(tab: EmbeddedTab, download: BrowserDownload) {
    return {
        browserId: "embedded",
        payload: { download: { ...download } },
        sessionId: tab.conversationId,
        tabId: download.tabId,
    }
}
