import type { WebContents } from "electron"
import type { BrowserLoadState, BrowserWaitUntil } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../../errors"

export function waitForLoadState(
    webContents: WebContents,
    state: BrowserLoadState,
    timeout = 10_000,
    signal?: AbortSignal,
) {
    if (signal?.aborted) {
        return Promise.reject(new BrowserRuntimeException("CANCELLED", "Browser wait was cancelled", true))
    }
    if (webContents.isDestroyed()) {
        return Promise.reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab is closed"))
    }
    if (state === "networkidle") {
        return Promise.reject(new BrowserRuntimeException(
            "CAPABILITY_UNAVAILABLE",
            "Browser load-state waits do not support networkidle",
        ))
    }

    return webContents.executeJavaScript("document.readyState", true)
        .catch(() => undefined)
        .then((readyState: unknown) => {
            if (readyState === "complete") return
            if (state === "domcontentloaded" && readyState === "interactive") return
            return waitForDocumentState(webContents, state, timeout, signal)
        })
}

export function waitForTimeout(timeout: number, signal?: AbortSignal) {
    if (signal?.aborted) {
        return Promise.reject(new BrowserRuntimeException("CANCELLED", "Browser wait was cancelled", true))
    }
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            cleanup()
            resolve()
        }
        const cancel = () => {
            cleanup()
            reject(new BrowserRuntimeException("CANCELLED", "Browser wait was cancelled", true))
        }
        const timer = setTimeout(finish, Math.max(0, timeout))
        const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", cancel)
        }
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) cancel()
    })
}

function waitForDocumentState(
    webContents: WebContents,
    state: Exclude<BrowserLoadState, "networkidle">,
    timeout: number,
    signal?: AbortSignal,
) {
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            cleanup()
            resolve()
        }
        const fail = () => {
            cleanup()
            reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while waiting"))
        }
        const cancel = () => {
            cleanup()
            reject(new BrowserRuntimeException("CANCELLED", "Browser wait was cancelled", true))
        }
        const loaded = () => {
            finish()
        }
        const timer = setTimeout(() => {
            cleanup()
            reject(new BrowserRuntimeException("TIMEOUT", `Timed out waiting for ${state}`, true))
        }, Math.max(1, timeout))
        timer.unref()
        const cleanup = () => {
            clearTimeout(timer)
            if (state === "domcontentloaded") webContents.removeListener("dom-ready", loaded)
            else webContents.removeListener("did-finish-load", loaded)
            webContents.removeListener("destroyed", fail)
            signal?.removeEventListener("abort", cancel)
        }
        if (state === "domcontentloaded") webContents.once("dom-ready", loaded)
        else webContents.once("did-finish-load", loaded)
        webContents.once("destroyed", fail)
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) cancel()
    })
}

export async function waitForURL(
    webContents: WebContents,
    expected: string,
    timeout = 10_000,
    signal?: AbortSignal,
    waitUntil?: BrowserWaitUntil,
) {
    if (signal?.aborted) {
        throw new BrowserRuntimeException("CANCELLED", "Browser URL wait was cancelled", true)
    }
    if (webContents.isDestroyed()) {
        throw new BrowserRuntimeException("TAB_CLOSED", "Browser tab is closed")
    }
    const current = webContents.getURL()
    const url = urlMatches(current, expected) ? current : await new Promise<string>((resolve, reject) => {
        const navigated = (_event: Electron.Event, url: string) => {
            if (!urlMatches(url, expected)) return
            cleanup()
            resolve(url)
        }
        const fail = () => {
            cleanup()
            reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while waiting for URL"))
        }
        const cancel = () => {
            cleanup()
            reject(new BrowserRuntimeException("CANCELLED", "Browser URL wait was cancelled", true))
        }
        const timer = setTimeout(() => {
            cleanup()
            reject(new BrowserRuntimeException("TIMEOUT", `Timed out waiting for URL: ${expected}`, true))
        }, Math.max(1, timeout))
        timer.unref()
        const cleanup = () => {
            clearTimeout(timer)
            webContents.removeListener("did-navigate", navigated)
            webContents.removeListener("did-navigate-in-page", navigated)
            webContents.removeListener("destroyed", fail)
            signal?.removeEventListener("abort", cancel)
        }
        webContents.on("did-navigate", navigated)
        webContents.on("did-navigate-in-page", navigated)
        webContents.once("destroyed", fail)
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) cancel()
    })
    if (waitUntil && waitUntil !== "commit") await waitForLoadState(webContents, waitUntil, timeout, signal)
    return url
}

export function expectNavigation(
    webContents: WebContents,
    timeout = 10_000,
    signal?: AbortSignal,
    expected?: string,
) {
    if (signal?.aborted) {
        return Promise.reject(new BrowserRuntimeException("CANCELLED", "Navigation wait was cancelled", true))
    }
    if (webContents.isDestroyed()) {
        return Promise.reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab is closed"))
    }
    return new Promise<string>((resolve, reject) => {
        let navigationStarted = false
        let navigationUrl = ""
        const start = (
            _event: Electron.Event,
            url: string,
            _isInPlace: boolean,
            isMainFrame: boolean,
        ) => {
            if (!isMainFrame) return
            if (expected && !urlMatches(url, expected)) return
            navigationStarted = true
            navigationUrl = url
        }
        const inPage = (_event: Electron.Event, url: string, isMainFrame: boolean) => {
            if (!isMainFrame || expected && !urlMatches(url, expected)) return
            cleanup()
            resolve(url)
        }
        const committed = (_event: Electron.Event, url: string) => {
            if (!navigationStarted) return
            cleanup()
            resolve(url)
        }
        const loaded = () => {
            if (!navigationStarted) return
            cleanup()
            resolve(webContents.getURL() || navigationUrl)
        }
        const loadFailed = (
            _event: Electron.Event,
            code: number,
            description: string,
            _url: string,
            isMainFrame: boolean,
        ) => {
            if (!isMainFrame || code === -3) return
            cleanup()
            reject(new Error(`${description} (${code})`))
        }
        const fail = () => {
            cleanup()
            reject(new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while waiting for navigation"))
        }
        const cancel = () => {
            cleanup()
            reject(new BrowserRuntimeException("CANCELLED", "Navigation wait was cancelled", true))
        }
        const timer = setTimeout(() => {
            cleanup()
            reject(new BrowserRuntimeException("TIMEOUT", "Timed out waiting for navigation", true))
        }, Math.max(1, timeout))
        timer.unref()
        const cleanup = () => {
            clearTimeout(timer)
            webContents.removeListener("did-start-navigation", start)
            webContents.removeListener("did-navigate", committed)
            webContents.removeListener("did-navigate-in-page", inPage)
            webContents.removeListener("dom-ready", loaded)
            webContents.removeListener("did-finish-load", loaded)
            webContents.removeListener("did-fail-load", loadFailed)
            webContents.removeListener("did-fail-provisional-load", loadFailed)
            webContents.removeListener("destroyed", fail)
            signal?.removeEventListener("abort", cancel)
        }
        webContents.on("did-start-navigation", start)
        webContents.on("did-navigate", committed)
        webContents.on("did-navigate-in-page", inPage)
        webContents.on("dom-ready", loaded)
        webContents.on("did-finish-load", loaded)
        webContents.on("did-fail-load", loadFailed)
        webContents.on("did-fail-provisional-load", loadFailed)
        webContents.once("destroyed", fail)
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) cancel()
    })
}

function urlMatches(actual: string, expected: string) {
    if (actual === expected) return true
    if (!expected.includes("*")) return false
    const escaped = expected.split("*").map(escapeRegExp).join(".*")
    return new RegExp(`^${escaped}$`).test(actual)
}

function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
