import type { BrowserCdpTarget } from "@opencode-ai/browser-protocol"
import type { WebContents } from "electron"
import type { EmbeddedTab } from "../tab"
import { BrowserRuntimeException } from "../../errors"

export type CdpSender = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
) => Promise<unknown>

export type CdpMessageListener = (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
) => void

export function onDebuggerMessage(
    webContents: WebContents,
    listener: CdpMessageListener,
    active: () => boolean = () => true,
) {
    const browserDebugger = webContents.debugger
    const message: CdpMessageListener = (...args) => {
        if (!active() || webContents.isDestroyed()) return
        listener(...args)
    }
    const destroyed = () => browserDebugger.removeListener("message", message)
    const cleanup = () => {
        browserDebugger.removeListener("message", message)
        webContents.removeListener("destroyed", destroyed)
    }
    browserDebugger.on("message", message)
    webContents.once("destroyed", destroyed)
    return cleanup
}

export function sendCdp(tab: EmbeddedTab): CdpSender {
    const browserDebugger = tab.webContents.debugger
    return (method, params = {}, sessionId) =>
        browserDebugger.sendCommand(method, params, sessionId)
}

export function withDebugger<T>(tab: EmbeddedTab, operation: (send: CdpSender) => Promise<T>) {
    const webContents = tab.webContents
    const browserDebugger = webContents.debugger
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
        browserDebugger.sendCommand(method, params, sessionId)
    const task = tab.debuggerQueue.then(async () => {
        if (webContents.isDestroyed()) {
            throw new BrowserRuntimeException("TAB_CLOSED", `Browser tab is closed: ${tab.id}`)
        }
        const attached = browserDebugger.isAttached()
        if (!attached) browserDebugger.attach("1.3")
        try {
            return await operation(send)
        } finally {
            if (!attached && !webContents.isDestroyed() && browserDebugger.isAttached()) {
                browserDebugger.detach()
            }
        }
    })
    tab.debuggerQueue = task.then(() => undefined, () => undefined)
    return task
}

export async function executeRawCdp(
    send: CdpSender,
    method: string,
    params: Record<string, unknown> = {},
    target?: BrowserCdpTarget,
    sessionIds: ReadonlySet<string> = new Set(),
) {
    if (!allowedCdpMethod(method)) {
        throw new BrowserRuntimeException("PERMISSION_DENIED", `CDP command is not allowed: ${method}`)
    }
    if (!target) return send(method, params)
    if (target.sessionId) {
        if (!sessionIds.has(target.sessionId)) {
            throw new BrowserRuntimeException(
                "PERMISSION_DENIED",
                `CDP session does not belong to the current tab: ${target.sessionId}`,
            )
        }
        return send(method, params, target.sessionId)
    }
    const targetId = target.targetId
    if (!targetId || !readFrameIds(await send("Page.getFrameTree")).has(targetId)) {
        throw new BrowserRuntimeException(
            "PERMISSION_DENIED",
            `CDP target does not belong to the current tab: ${targetId}`,
        )
    }

    const attached = asRecord(await send("Target.attachToTarget", { flatten: true, targetId }))
    if (typeof attached.sessionId !== "string") {
        throw new BrowserRuntimeException("TARGET_GONE", `Unable to attach to target: ${targetId}`, true)
    }
    try {
        return await send(method, params, attached.sessionId)
    } finally {
        await send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => undefined)
    }
}

export function allowedCdpMethod(method: string) {
    if (!/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]+$/.test(method)) return false
    if (method.startsWith("Accessibility.")) {
        return ["getFullAXTree", "getPartialAXTree", "queryAXTree"]
            .some((name) => method === `Accessibility.${name}`)
    }
    if (method.startsWith("DOM.")) {
        return [
            "describeNode",
            "discardSearchResults",
            "getAttributes",
            "getBoxModel",
            "getDocument",
            "getFlattenedDocument",
            "getNodeForLocation",
            "getOuterHTML",
            "getSearchResults",
            "performSearch",
            "requestChildNodes",
            "requestNode",
            "resolveNode",
        ].some((name) => method === `DOM.${name}`)
    }
    return [
        "Network.getRequestPostData",
        "Network.getResponseBody",
        "Network.getResponseBodyForInterception",
        "Page.captureScreenshot",
        "Page.getAppManifest",
        "Page.getFrameTree",
        "Page.getLayoutMetrics",
        "Page.getNavigationHistory",
        "Performance.getMetrics",
        "Runtime.getProperties",
    ].includes(method)
}

export function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function readFrameIds(input: unknown) {
    const ids = new Set<string>()
    const visit = (value: unknown) => {
        const tree = asRecord(value)
        const frame = asRecord(tree.frame)
        if (typeof frame.id === "string") ids.add(frame.id)
        if (Array.isArray(tree.childFrames)) tree.childFrames.forEach(visit)
    }
    visit(asRecord(input).frameTree)
    return ids
}
