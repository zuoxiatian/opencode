import type { BrowserCommandData } from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "../tab"
import { BrowserRuntimeException } from "../../errors"
import type { AriaSnapshotService } from "./aria-snapshot"
import { asRecord, withDebugger } from "./cdp"
import { textInput } from "./input"

export class NodeActionService {
    constructor(private readonly aria: AriaSnapshotService) {}

    run(
        tab: EmbeddedTab,
        input: {
            name: "tab.domCua.click" | "tab.domCua.doubleClick"
            nodeId: string
            snapshotId?: string
        },
    ): Promise<BrowserCommandData> {
        const action = input.name.split(".").at(-1) as "click" | "doubleClick"
        return this.runResolved(tab, input.snapshotId, input.nodeId, action)
    }

    scroll(
        tab: EmbeddedTab,
        input: { deltaX: number; deltaY: number; nodeId: string; snapshotId?: string },
    ) {
        return this.runResolved(
            tab,
            input.snapshotId,
            input.nodeId,
            "scroll",
            JSON.stringify({ x: input.deltaX, y: input.deltaY }),
        )
    }

    runResolved(
        tab: EmbeddedTab,
        snapshotId: string | undefined,
        nodeId: string,
        action: "check" | "click" | "doubleClick" | "fill" | "scroll" | "selectOption" | "type" | "uncheck",
        value?: string,
    ): Promise<BrowserCommandData> {
        const node = snapshotId
            ? this.aria.resolve(tab, snapshotId, nodeId)
            : this.aria.resolveLatest(tab, nodeId)
        return withDebugger(tab, async (send) => {
            const attached = node.targetId
                ? await send("Target.attachToTarget", { flatten: true, targetId: node.targetId })
                    .then(asRecord)
                    .catch(() => {
                        throw new BrowserRuntimeException("TARGET_GONE", "Frame target is no longer available", true)
                    })
                : undefined
            const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined
            if (node.targetId && !sessionId) {
                throw new BrowserRuntimeException("TARGET_GONE", "Frame target is no longer available", true)
            }
            try {
                const resolved = await send("DOM.resolveNode", {
                    backendNodeId: node.backendDOMNodeId,
                }, sessionId).then(asRecord).catch(() => {
                    throw new BrowserRuntimeException("STALE_NODE", "DOM node can no longer be resolved", true)
                })
                const objectId = asRecord(resolved.object).objectId
                if (typeof objectId !== "string") {
                    throw new BrowserRuntimeException("STALE_NODE", "DOM node can no longer be resolved", true)
                }
                const result = await send("Runtime.callFunctionOn", {
                    arguments: [{ value: action }, { value: value ?? "" }],
                    awaitPromise: true,
                    functionDeclaration: nodeActionFunction,
                    objectId,
                    returnByValue: true,
                    userGesture: true,
                }, sessionId).then(asRecord).catch(() => {
                    throw new BrowserRuntimeException("STALE_NODE", "DOM node changed before the action completed", true)
                })
                const exception = asRecord(result.exceptionDetails)
                if (Object.keys(exception).length) {
                    throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "DOM node action failed")
                }
                if (action === "type") await textInput(send, value ?? "")
                return { value: asRecord(result.result).value }
            } finally {
                if (sessionId) {
                    await send("Target.detachFromTarget", { sessionId }).catch(() => undefined)
                }
            }
        })
    }
}

const nodeActionFunction = `function(action, value) {
    if (!this || !this.isConnected) throw new Error("stale node")
    const disabled = this.disabled || this.getAttribute?.("aria-disabled") === "true"
    const editable = this.isContentEditable
        || this.tagName === "TEXTAREA"
        || (this.tagName === "INPUT"
            && !["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"]
                .includes((this.getAttribute("type") || "text").toLowerCase()))
    if (disabled && action !== "scroll") throw new Error("disabled")
    if (action === "click" || action === "doubleClick") {
        this.scrollIntoView({ block: "center", inline: "center" })
        this.click()
        if (action === "doubleClick") {
            this.click()
            this.dispatchEvent(new MouseEvent("dblclick", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: this.ownerDocument.defaultView,
            }))
        }
        return true
    }
    if (action === "scroll") {
        const delta = JSON.parse(value)
        this.scrollLeft += delta.x
        this.scrollTop += delta.y
        return true
    }
    if (action === "type") {
        if (!editable) throw new Error("not editable")
        this.scrollIntoView({ block: "center", inline: "center" })
        this.focus()
        return true
    }
    if (action === "fill") {
        if (!editable) throw new Error("not editable")
        this.focus()
        if (this.isContentEditable) this.textContent = value
        else this.value = value
        this.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
        return value
    }
    if (action === "check" || action === "uncheck") {
        if (!("checked" in this)) throw new Error("not checkable")
        this.checked = action === "check"
        this.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
        return this.checked
    }
    if (action === "selectOption") {
        if (this.tagName !== "SELECT") throw new Error("not a select")
        this.value = value
        this.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
        return this.value
    }
    throw new Error("unsupported node action")
}`
