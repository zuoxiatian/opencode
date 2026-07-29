// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import { WebSocket } from "ws"
import {
    CdpTabGateway,
    isCdpMethodAllowed,
    isGatewayLeaseAvailable,
    type CdpTabTransport,
} from "../src/electron/browser/agent-browser/gateway"

class FakeTransport implements CdpTabTransport {
    hold = false
    readonly calls: Array<{
        method: string
        params?: Record<string, unknown>
        sessionId?: string
    }> = []
    readonly sessions = new Set<string>()
    private readonly messages = new Set<Parameters<CdpTabTransport["onMessage"]>[0]>()
    private readonly detaches = new Set<Parameters<CdpTabTransport["onDetach"]>[0]>()

    hasChildSession(sessionId: string) {
        return this.sessions.has(sessionId)
    }

    onDetach(listener: Parameters<CdpTabTransport["onDetach"]>[0]) {
        this.detaches.add(listener)
        return () => this.detaches.delete(listener)
    }

    onMessage(listener: Parameters<CdpTabTransport["onMessage"]>[0]) {
        this.messages.add(listener)
        return () => this.messages.delete(listener)
    }

    sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string) {
        this.calls.push({ method, params, sessionId })
        if (this.hold) return new Promise<never>(() => undefined)
        return Promise.resolve({ method })
    }

    emitMessage(method: string, params: Record<string, unknown>, sessionId?: string) {
        this.messages.forEach((listener) => listener(method, params, sessionId))
    }

    detach() {
        this.detaches.forEach((listener) => listener("target closed"))
    }
}

describe("CDP tab Gateway", () => {
    test("binds one opaque lease to one connection and one transport", async () => {
        const gateway = new CdpTabGateway()
        const transport = new FakeTransport()
        await gateway.start()
        const issued = gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 3,
            tabId: "tab-1",
            transport,
        })
        const socket = await openWebSocket(issued.url)

        expect(await command(socket, {
            id: 1,
            method: "Accessibility.enable",
        })).toEqual({
            id: 1,
            result: { method: "Accessibility.enable" },
        })
        expect(transport.calls).toEqual([
            {
                method: "Target.setAutoAttach",
                params: {
                    autoAttach: true,
                    flatten: true,
                    waitForDebuggerOnStart: false,
                },
                sessionId: undefined,
            },
            {
                method: "Accessibility.enable",
                params: {},
                sessionId: undefined,
            },
        ])
        expect(gateway.getLease(issued.lease.id)?.connectedAt).toEqual(expect.any(Number))
        expect(isGatewayLeaseAvailable(
            gateway.getLease(issued.lease.id),
            Date.now(),
            true,
        )).toBe(false)
        expect(await rejectedWebSocket(issued.url)).toBe(true)

        socket.terminate()
        await gateway.close()
    })

    test("forwards debugger events and validates child sessions", async () => {
        const gateway = new CdpTabGateway()
        const transport = new FakeTransport()
        transport.sessions.add("child-1")
        await gateway.start()
        const socket = await openWebSocket(gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-1",
            transport,
        }).url)

        expect(await command(socket, {
            id: 2,
            method: "Runtime.evaluate",
            params: { expression: "1" },
            sessionId: "child-1",
        })).toEqual({
            id: 2,
            result: { method: "Runtime.evaluate" },
        })
        expect((await command(socket, {
            id: 3,
            method: "Runtime.evaluate",
            sessionId: "other-tab-child",
        })).error).toEqual({
            code: -32000,
            message: "CDP session is not available",
        })

        const event = nextMessage(socket)
        transport.emitMessage("Page.loadEventFired", { timestamp: 1 }, "child-1")
        expect(await event).toEqual({
            method: "Page.loadEventFired",
            params: { timestamp: 1 },
            sessionId: "child-1",
        })

        socket.terminate()
        await gateway.close()
    })

    test("denies browser discovery, tab creation, and browser shutdown", async () => {
        const gateway = new CdpTabGateway()
        const transport = new FakeTransport()
        await gateway.start()
        const socket = await openWebSocket(gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-1",
            transport,
        }).url)

        for (const [id, method] of [
            [1, "Target.getTargets"],
            [2, "Target.createTarget"],
            [3, "Target.closeTarget"],
            [4, "Browser.close"],
            [5, "SystemInfo.getInfo"],
        ] as const) {
            expect((await command(socket, { id, method })).error).toEqual({
                code: -32000,
                message: "CDP method is not allowed",
            })
        }
        expect(transport.calls).toEqual([])

        socket.terminate()
        await gateway.close()
    })

    test("does not expose discovery pages and rejects browser-originated sockets", async () => {
        const gateway = new CdpTabGateway()
        const transport = new FakeTransport()
        const port = await gateway.start()
        const issued = gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-1",
            transport,
        })

        expect(await Promise.all([
            fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.status),
            fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.status),
        ])).toEqual([404, 404])
        expect(issued.url.startsWith(`ws://127.0.0.1:${port}/cdp/`)).toBe(true)
        expect(gateway.getLease(issued.lease.id)?.connectedAt).toBeUndefined()
        expect(isGatewayLeaseAvailable(
            gateway.getLease(issued.lease.id),
            Date.now(),
            true,
            "https://untrusted.example",
        )).toBe(false)

        await gateway.close()
    })

    test("rejects unknown tokens and closes oversized debugger events", async () => {
        const gateway = new CdpTabGateway()
        const transport = new FakeTransport()
        await gateway.start()
        const issued = gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-1",
            transport,
        })
        const unknown = `${issued.url.slice(0, -1)}${issued.url.endsWith("A") ? "B" : "A"}`
        expect(await rejectedWebSocket(unknown)).toBe(true)
        const socket = await openWebSocket(issued.url)
        const closed = new Promise<number>((resolve) => socket.once("close", resolve))
        transport.emitMessage("Runtime.consoleAPICalled", {
            value: "x".repeat(16 * 1024 * 1024),
        })
        expect(await closed).toBe(1009)

        await gateway.close()
    })

    test("revokes expired, closed, and inactive leases", async () => {
        let now = 100
        const gateway = new CdpTabGateway(() => now)
        const transport = new FakeTransport()
        await gateway.start()
        const expired = gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-expired",
            transport,
            ttl: 1,
        })
        now = 102
        expect(isGatewayLeaseAvailable(gateway.getLease(expired.lease.id), now, true)).toBe(false)

        const revoked = gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-revoked",
            transport,
        })
        expect(gateway.revoke(revoked.lease.id)).toBe(true)
        expect(isGatewayLeaseAvailable(gateway.getLease(revoked.lease.id), now, true)).toBe(false)

        const connected = gateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-connected",
            transport,
        })
        const socket = await openWebSocket(connected.url)
        const closed = new Promise<number>((resolve) => socket.once("close", resolve))
        transport.detach()
        expect(await closed).toBe(1011)

        await gateway.close()
    })

    test("limits pending requests and identifies Gateway command timeouts", async () => {
        const pendingGateway = new CdpTabGateway()
        const pendingTransport = new FakeTransport()
        pendingTransport.hold = true
        await pendingGateway.start()
        const pendingSocket = await openWebSocket(pendingGateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-pending",
            transport: pendingTransport,
        }).url)
        const limited = responseForId(pendingSocket, 257)
        Array.from({ length: 257 }, (_, index) => index + 1).forEach((id) => {
            pendingSocket.send(JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression: "1" },
            }))
        })
        expect((await limited).error).toEqual({
            code: -32000,
            message: "Too many pending CDP requests",
        })
        expect(pendingTransport.calls).toHaveLength(256)
        pendingSocket.terminate()
        await pendingGateway.close()

        const timeoutGateway = new CdpTabGateway(Date.now, 5)
        const timeoutTransport = new FakeTransport()
        timeoutTransport.hold = true
        await timeoutGateway.start()
        const timeoutSocket = await openWebSocket(timeoutGateway.createLease({
            active: () => true,
            ownerSessionId: "owner-1",
            tabGeneration: 1,
            tabId: "tab-timeout",
            transport: timeoutTransport,
        }).url)
        expect((await command(timeoutSocket, {
            id: 1,
            method: "Runtime.evaluate",
        })).error).toEqual({
            code: -32000,
            message: "CDP command timed out",
        })
        timeoutSocket.terminate()
        await timeoutGateway.close()
    })
})

describe("CDP Gateway method policy", () => {
    const transport = new FakeTransport()

    test("allows page domains and constrained OOPIF methods", () => {
        transport.sessions.add("child")
        expect(isCdpMethodAllowed("Accessibility.getFullAXTree", {}, undefined, transport)).toBe(true)
        expect(isCdpMethodAllowed("Runtime.evaluate", {}, "child", transport)).toBe(true)
        expect(isCdpMethodAllowed("Browser.getVersion", {}, undefined, transport)).toBe(true)
        expect(isCdpMethodAllowed("Target.setAutoAttach", {
            autoAttach: true,
            flatten: true,
            waitForDebuggerOnStart: false,
        }, undefined, transport)).toBe(true)
        expect(isCdpMethodAllowed("Target.detachFromTarget", {
            sessionId: "child",
        }, undefined, transport)).toBe(true)
    })

    test("rejects malformed or browser-scoped methods", () => {
        expect(isCdpMethodAllowed("Runtime.evaluate.extra", {}, undefined, transport)).toBe(false)
        expect(isCdpMethodAllowed("Target.getTargets", {}, undefined, transport)).toBe(false)
        expect(isCdpMethodAllowed("Browser.close", {}, undefined, transport)).toBe(false)
        expect(isCdpMethodAllowed("Target.detachFromTarget", {
            sessionId: "foreign-child",
        }, undefined, transport)).toBe(false)
    })
})

function openWebSocket(url: string) {
    return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url)
        socket.once("open", () => resolve(socket))
        socket.once("error", reject)
    })
}

function rejectedWebSocket(url: string) {
    return new Promise<true>((resolve, reject) => {
        const socket = new WebSocket(url)
        const timer = setTimeout(() => {
            socket.terminate()
            reject(new Error("WebSocket rejection timed out"))
        }, 1_000)
        const rejected = () => {
            clearTimeout(timer)
            resolve(true)
        }
        socket.on("error", rejected)
        socket.once("close", rejected)
        socket.once("open", () => reject(new Error("Rejected WebSocket unexpectedly opened")))
    })
}

function command(socket: WebSocket, value: unknown) {
    const response = nextMessage(socket)
    socket.send(JSON.stringify(value))
    return response as Promise<{
        error?: { code: number; message: string }
        id: number
        result?: unknown
    }>
}

function nextMessage(socket: WebSocket) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())))
        socket.once("error", reject)
    })
}

function responseForId(socket: WebSocket, id: number) {
    return new Promise<{
        error?: { code: number; message: string }
        id: number
        result?: unknown
    }>((resolve, reject) => {
        const message = (data: Parameters<Parameters<WebSocket["on"]>[1]>[0]) => {
            const response = JSON.parse(data.toString())
            if (response.id !== id) return
            socket.off("message", message)
            resolve(response)
        }
        socket.on("message", message)
        socket.once("error", reject)
    })
}
