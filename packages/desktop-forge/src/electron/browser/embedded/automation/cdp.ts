import type { BrowserCdpTarget } from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "../tab"
import { BrowserRuntimeException } from "../../errors"

export type CdpSender = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
) => Promise<unknown>

export function sendCdp(tab: EmbeddedTab): CdpSender {
    return (method, params = {}, sessionId) =>
        tab.debuggerTransport.sendCommand(method, params, sessionId)
}

export function withDebugger<T>(tab: EmbeddedTab, operation: (send: CdpSender) => Promise<T>) {
    const webContents = tab.webContents
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
        tab.debuggerTransport.sendCommand(method, params, sessionId)
    const task = tab.debuggerQueue.then(async () => {
        if (webContents.isDestroyed()) {
            throw new BrowserRuntimeException("TAB_CLOSED", `Browser tab is closed: ${tab.id}`)
        }
        tab.debuggerTransport.ensureAttached()
        return operation(send)
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
    const commandParams = allowedCdpParams(method, params)
    if (!target) return send(method, commandParams)
    if (target.sessionId) {
        if (!sessionIds.has(target.sessionId)) {
            throw new BrowserRuntimeException(
                "PERMISSION_DENIED",
                `CDP session does not belong to the current tab: ${target.sessionId}`,
            )
        }
        return send(method, commandParams, target.sessionId)
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
        return await send(method, commandParams, attached.sessionId)
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
        "Runtime.evaluate",
        "Runtime.getProperties",
    ].includes(method)
}

function allowedCdpParams(method: string, params: Record<string, unknown>) {
    if (method !== "Runtime.evaluate") return params
    if (params.returnByValue === false) {
        throw new BrowserRuntimeException(
            "PERMISSION_DENIED",
            "Runtime.evaluate requires returnByValue: true",
        )
    }
    if (params.returnByValue !== undefined && params.returnByValue !== true) {
        throw new BrowserRuntimeException(
            "INVALID_COMMAND",
            "Runtime.evaluate returnByValue must be true",
        )
    }
    return { ...params, returnByValue: true }
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
