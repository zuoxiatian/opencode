// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import type { WebContents } from "electron"
import { EventEmitter } from "node:events"
import { TabDebuggerTransport } from "../src/electron/browser/agent-browser/debugger-transport"

class FakeDebugger extends EventEmitter {
    attachCount = 0
    attached = false
    readonly commands: Array<{ method: string; params: unknown; sessionId?: string }> = []

    attach() {
        this.attachCount += 1
        this.attached = true
    }

    detach() {
        this.attached = false
        this.emit("detach", {}, "target closed")
    }

    isAttached() {
        return this.attached
    }

    sendCommand(method: string, params: unknown, sessionId?: string) {
        this.commands.push({ method, params, sessionId })
        return Promise.resolve({})
    }
}

class FakeWebContents extends EventEmitter {
    readonly debugger = new FakeDebugger()
    private destroyed = false

    destroy() {
        this.destroyed = true
        this.emit("destroyed")
    }

    markDestroyed() {
        this.destroyed = true
    }

    isDestroyed() {
        return this.destroyed
    }
}

describe("debugger message lifecycle", () => {
    test("owns one debugger attachment and forwards commands", async () => {
        const webContents = new FakeWebContents()
        const transport = new TabDebuggerTransport(webContents as unknown as WebContents)

        transport.ensureAttached()
        transport.ensureAttached()
        await transport.sendCommand("Runtime.evaluate", { expression: "1" }, "child")

        expect(webContents.debugger.attachCount).toBe(1)
        expect(webContents.debugger.commands).toEqual([{
            method: "Runtime.evaluate",
            params: { expression: "1" },
            sessionId: "child",
        }])
        transport.destroy()
    })

    test("removes debugger listeners when webContents is destroyed", () => {
        const webContents = new FakeWebContents()
        const transport = new TabDebuggerTransport(webContents as unknown as WebContents)
        const messages: string[] = []
        transport.onMessage((method) => messages.push(method))

        webContents.debugger.emit("message", {}, "Network.requestWillBeSent", {})
        expect(messages).toEqual(["Network.requestWillBeSent"])
        expect(webContents.debugger.listenerCount("message")).toBe(1)
        expect(webContents.debugger.listenerCount("detach")).toBe(1)

        webContents.destroy()
        expect(webContents.debugger.listenerCount("message")).toBe(0)
        expect(webContents.debugger.listenerCount("detach")).toBe(0)

        webContents.debugger.emit("message", {}, "Network.loadingFinished", {})
        expect(messages).toEqual(["Network.requestWillBeSent"])
    })

    test("tracks and invalidates child sessions", () => {
        const webContents = new FakeWebContents()
        const transport = new TabDebuggerTransport(webContents as unknown as WebContents)

        webContents.debugger.emit("message", {}, "Target.attachedToTarget", {
            sessionId: "child-1",
        })
        webContents.debugger.emit("message", {}, "Runtime.executionContextCreated", {}, "child-2")
        expect([...transport.childSessions]).toEqual(["child-1", "child-2"])

        webContents.debugger.emit("message", {}, "Target.detachedFromTarget", {
            sessionId: "child-1",
        })
        expect([...transport.childSessions]).toEqual(["child-2"])

        webContents.debugger.emit("detach", {}, "devtools opened")
        expect([...transport.childSessions]).toEqual([])
        transport.destroy()
    })

    test("ignores a late debugger message before destroy cleanup runs", () => {
        const webContents = new FakeWebContents()
        const messages: string[] = []
        const transport = new TabDebuggerTransport(webContents as unknown as WebContents)
        transport.onMessage((method) => messages.push(method))

        webContents.markDestroyed()
        webContents.debugger.emit("message", {}, "Network.loadingFinished", {})

        expect(messages).toEqual([])
        transport.destroy()
    })
})
