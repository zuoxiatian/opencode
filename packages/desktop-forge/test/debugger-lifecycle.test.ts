// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import type { WebContents } from "electron"
import { EventEmitter } from "node:events"
import { onDebuggerMessage } from "../src/electron/browser/embedded/automation/cdp"

class FakeDebugger extends EventEmitter {}

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
    test("removes the listener when webContents is destroyed", () => {
        const webContents = new FakeWebContents()
        const messages: string[] = []
        const cleanup = onDebuggerMessage(
            webContents as unknown as WebContents,
            (_event, method) => messages.push(method),
        )

        webContents.debugger.emit("message", {}, "Network.requestWillBeSent", {})
        expect(messages).toEqual(["Network.requestWillBeSent"])
        expect(webContents.debugger.listenerCount("message")).toBe(1)

        webContents.destroy()
        expect(webContents.debugger.listenerCount("message")).toBe(0)

        webContents.debugger.emit("message", {}, "Network.loadingFinished", {})
        expect(messages).toEqual(["Network.requestWillBeSent"])
        cleanup()
    })

    test("ignores debugger messages as soon as tab closing starts", () => {
        const webContents = new FakeWebContents()
        const messages: string[] = []
        let active = true
        onDebuggerMessage(
            webContents as unknown as WebContents,
            (_event, method) => messages.push(method),
            () => active,
        )

        active = false
        webContents.debugger.emit("message", {}, "Network.loadingFinished", {})

        expect(messages).toEqual([])
        expect(webContents.debugger.listenerCount("message")).toBe(1)
        webContents.destroy()
        expect(webContents.debugger.listenerCount("message")).toBe(0)
    })

    test("ignores a late debugger message before destroy cleanup runs", () => {
        const webContents = new FakeWebContents()
        const messages: string[] = []
        onDebuggerMessage(
            webContents as unknown as WebContents,
            (_event, method) => messages.push(method),
        )

        webContents.markDestroyed()
        webContents.debugger.emit("message", {}, "Network.loadingFinished", {})

        expect(messages).toEqual([])
    })
})
