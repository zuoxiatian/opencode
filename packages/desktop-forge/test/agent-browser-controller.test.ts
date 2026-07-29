// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import type { EmbeddedTab } from "../src/electron/browser/embedded/tab"
import { BrowserRuntimeException } from "../src/electron/browser/errors"
import { AgentBrowserTabController } from "../src/electron/browser/agent-browser/controller"
import type { AgentBrowserDiagnosticEvent } from "../src/electron/browser/agent-browser/diagnostics"
import type { CdpTabGateway, CdpTabTransport } from "../src/electron/browser/agent-browser/gateway"
import type {
    AgentBrowserCommandInput,
    AgentBrowserProcessManager,
} from "../src/electron/browser/agent-browser/process-manager"

class FakeRunner {
    readonly calls: AgentBrowserCommandInput[] = []
    handler: (input: AgentBrowserCommandInput) => Promise<{
        data: Record<string, unknown>
        success: boolean
    }> = () => Promise.resolve({ data: {}, success: true })

    prepare() {
        return Promise.resolve()
    }

    run(input: AgentBrowserCommandInput) {
        this.calls.push(input)
        return this.handler(input)
    }

    stop(input: Pick<AgentBrowserCommandInput, "cdpUrl" | "session" | "timeout">) {
        return this.run({
            ...input,
            args: ["close"],
            operation: "close",
        }).then(() => undefined)
    }
}

class FakeGateway {
    readonly revoked: string[] = []
    startHandler: () => Promise<number> = () => Promise.resolve(3210)
    private readonly leases = new Map<string, {
        connectedAt?: number
        createdAt: number
        expiresAt: number
        id: string
        ownerSessionId: string
        tabGeneration: number
        tabId: string
    }>()
    private lease = 0

    start() {
        return this.startHandler()
    }

    createLease(input: {
        ownerSessionId: string
        tabGeneration: number
        tabId: string
    }) {
        const id = `lease-${++this.lease}`
        const lease = {
            createdAt: Date.now(),
            expiresAt: Date.now() + 30_000,
            id,
            ownerSessionId: input.ownerSessionId,
            tabGeneration: input.tabGeneration,
            tabId: input.tabId,
        }
        this.leases.set(id, lease)
        return {
            lease,
            url: `ws://127.0.0.1:3210/cdp/${id}`,
        }
    }

    getLease(id: string) {
        return this.leases.get(id)
    }

    beginCommand() {
        return undefined
    }

    getLastChildSession() {
        return undefined
    }

    markConnected(id: string) {
        const lease = this.leases.get(id)
        if (lease) lease.connectedAt = Date.now()
    }

    revoke(id: string) {
        this.revoked.push(id)
        return true
    }

    close() {
        return Promise.resolve()
    }
}

const transport: CdpTabTransport = {
    hasChildSession: () => false,
    onDetach: () => () => undefined,
    onMessage: () => () => undefined,
    sendCommand: () => Promise.resolve({}),
}

describe("agent-browser TabController", () => {
    test("serializes commands within one tab", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        const tab = fakeTab("tab-1", "owner")
        const releases: Array<() => void> = []
        runner.handler = (input) => input.operation === "close"
            ? Promise.resolve({ data: {}, success: true })
            : new Promise((resolve) => releases.push(() => resolve({
                data: {},
                success: true,
            })))

        const first = controller.run(command(tab, "first"))
        const second = controller.run(command(tab, "second"))
        await tick()
        expect(runner.calls.map((call) => call.operation)).toEqual(["first"])

        releases.shift()?.()
        await first
        await tick()
        expect(runner.calls.map((call) => call.operation)).toEqual(["first", "second"])

        releases.shift()?.()
        await second
        await controller.destroy()
    })

    test("allows different tabs to run concurrently", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        const releases: Array<() => void> = []
        runner.handler = (input) => input.operation === "close"
            ? Promise.resolve({ data: {}, success: true })
            : new Promise((resolve) => releases.push(() => resolve({
                data: {},
                success: true,
            })))

        const first = controller.run(command(fakeTab("tab-1", "owner"), "first"))
        const second = controller.run(command(fakeTab("tab-2", "owner"), "second"))
        await tick()
        expect(new Set(runner.calls.map((call) => call.operation))).toEqual(new Set(["first", "second"]))

        releases.splice(0).forEach((release) => release())
        await Promise.all([first, second])
        await controller.destroy()
    })

    test("enforces the active session limit", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner, 1)
        let release = () => undefined
        runner.handler = (input) => input.operation === "close"
            ? Promise.resolve({ data: {}, success: true })
            : new Promise((resolve) => {
                release = () => resolve({ data: {}, success: true })
            })
        const active = controller.run(command(fakeTab("tab-1", "owner"), "first"))
        await tick()

        const error = await controller.run(command(fakeTab("tab-2", "owner"), "second"))
            .catch((failure: unknown) => failure)
        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser.code).toBe("AGENT_SESSION_LIMIT")

        release()
        await active
        await controller.destroy()
    })

    test("invalidates snapshots on navigation", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        const tab = fakeTab("tab-1", "owner")
        await controller.run(command(tab, "snapshot"))
        const snapshot = controller.recordSnapshot(tab.id, "owner", ["e1"])

        expect(() =>
            controller.validateSnapshot(tab.id, "owner", snapshot.snapshotId, "e1"))
            .not.toThrow()
        expect(() =>
            controller.validateSnapshot(tab.id, "owner", snapshot.snapshotId, "e2"))
            .toThrow("Browser snapshot reference is stale")
        tab.generation += 1
        expect(() => controller.validateSnapshot(tab.id, "owner", snapshot.snapshotId))
            .toThrow("Browser snapshot reference is stale")

        await controller.destroy()
    })

    test("reconnects once after a recoverable session failure", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        let failed = false
        runner.handler = (input) => {
            if (input.operation === "snapshot" && !failed) {
                failed = true
                return Promise.reject(new BrowserRuntimeException(
                    "GATEWAY_UNAVAILABLE",
                    "Gateway disconnected",
                    true,
                ))
            }
            return Promise.resolve({ data: {}, success: true })
        }

        const result = await controller.run(command(fakeTab("tab-1", "owner"), "snapshot"))
        expect(result.sessionGeneration).toBe(2)
        expect(runner.calls.map((call) => call.operation)).toEqual(["snapshot", "close", "snapshot"])

        await controller.destroy()
    })

    test("does not reconnect more than once for the same command", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        runner.handler = (input) => input.operation === "close"
            ? Promise.resolve({ data: {}, success: true })
            : Promise.reject(new BrowserRuntimeException(
                "GATEWAY_UNAVAILABLE",
                "Gateway disconnected",
                true,
            ))

        const error = await controller.run(
            command(fakeTab("tab-1", "owner"), "snapshot"),
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect(runner.calls.map((call) => call.operation)).toEqual([
            "snapshot",
            "close",
            "snapshot",
        ])
        expect(gateway.revoked).toEqual(["lease-1"])
        await controller.destroy()
    })

    test("reconnects an internally consumed lease after debugger detach", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        let failed = false
        runner.handler = (input) => {
            if (input.operation === "snapshot" && !failed) {
                failed = true
                gateway.markConnected("lease-1")
                return Promise.reject(new BrowserRuntimeException(
                    "GATEWAY_AUTH_FAILED",
                    "Gateway lease was rejected",
                    false,
                ))
            }
            return Promise.resolve({ data: {}, success: true })
        }

        const result = await controller.run(command(fakeTab("tab-1", "owner"), "snapshot"))
        expect(result.sessionGeneration).toBe(2)
        expect(runner.calls.map((call) => call.operation)).toEqual([
            "snapshot",
            "close",
            "snapshot",
        ])

        await controller.destroy()
    })

    test("does not reconnect an unconsumed rejected lease", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        runner.handler = () => Promise.reject(new BrowserRuntimeException(
            "GATEWAY_AUTH_FAILED",
            "Gateway lease was rejected",
            false,
        ))

        const error = await controller.run(
            command(fakeTab("tab-1", "owner"), "snapshot"),
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect(runner.calls.map((call) => call.operation)).toEqual(["snapshot"])
        await controller.destroy()
    })

    test("maps raw Gateway startup failures", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        gateway.startHandler = () => Promise.reject(new Error("listen EADDRINUSE 127.0.0.1"))

        const error = await controller.run(
            command(fakeTab("tab-1", "owner"), "snapshot"),
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toEqual({
            code: "GATEWAY_UNAVAILABLE",
            details: { causeCategory: "gateway_start" },
            message: "Browser automation Gateway could not start",
            retryable: true,
        })
        expect(error.message).not.toContain("EADDRINUSE")
        await controller.destroy()
    })

    test("closeTab cancels work, closes the daemon session, and revokes the lease", async () => {
        const gateway = new FakeGateway()
        const runner = new FakeRunner()
        const controller = createController(gateway, runner)
        const tab = fakeTab("tab-1", "owner")
        runner.handler = (input) => {
            if (input.operation === "close") {
                return Promise.resolve({ data: {}, success: true })
            }
            return new Promise((_resolve, reject) => {
                input.signal?.addEventListener("abort", () => reject(
                    new BrowserRuntimeException(
                        "CANCELLED",
                        "Browser automation command was cancelled",
                        true,
                    ),
                ), { once: true })
            })
        }

        const commandResult = controller.run(command(tab, "wait"))
            .catch((failure: unknown) => failure)
        await tick()
        await controller.closeTab(tab.id)

        await expect(commandResult).resolves.toBeInstanceOf(BrowserRuntimeException)
        expect(runner.calls.map((call) => call.operation)).toEqual(["wait", "close"])
        expect(gateway.revoked).toEqual(["lease-1"])
        expect(() => controller.recordSnapshot(tab.id, "owner"))
            .toThrow("Browser automation session is not ready")
        await controller.destroy()
    })

    test("emits only structured, redacted session and command diagnostics", async () => {
        const events: AgentBrowserDiagnosticEvent[] = []
        const controller = createController(
            new FakeGateway(),
            new FakeRunner(),
            4,
            (event) => events.push(event),
        )

        await controller.run(command(fakeTab("private-tab-id", "owner"), "snapshot"))
        await controller.destroy()

        expect(events.map((event) => event.event)).toEqual([
            "session_creating",
            "session_ready",
            "command_started",
            "command_finished",
            "session_closing",
            "session_closed",
        ])
        expect(events.find((event) => event.event === "command_finished")).toMatchObject({
            command: "snapshot",
            outcome: "success",
        })
        expect(JSON.stringify(events)).not.toContain("private-tab-id")
        expect(JSON.stringify(events)).not.toContain("lease-")
        expect(events.every((event) => event.tabHash?.length === 12)).toBe(true)
    })

    test("records when an agent-browser session becomes idle", async () => {
        const events: AgentBrowserDiagnosticEvent[] = []
        const controller = createController(
            new FakeGateway(),
            new FakeRunner(),
            4,
            (event) => events.push(event),
            5,
        )

        await controller.run(command(fakeTab("tab-idle", "owner"), "snapshot"))
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(events.some((event) => event.event === "session_idle")).toBe(true)
        await controller.destroy()
    })
})

function createController(
    gateway: FakeGateway,
    runner: FakeRunner,
    maxSessions = 4,
    diagnostic?: (event: AgentBrowserDiagnosticEvent) => void,
    idleTimeout?: number,
) {
    return new AgentBrowserTabController(
        gateway as unknown as CdpTabGateway,
        runner as unknown as Pick<AgentBrowserProcessManager, "prepare" | "run" | "stop">,
        maxSessions,
        diagnostic,
        idleTimeout,
    )
}

function fakeTab(id: string, ownerSessionId: string) {
    return {
        closed: false,
        debuggerTransport: transport,
        generation: 1,
        id,
        ownership: {
            createdBy: "agent",
            disposition: "temporary",
            ownerSessionId,
        },
        webContents: {
            isDestroyed: () => false,
        },
    } as unknown as EmbeddedTab
}

function command(tab: EmbeddedTab, operation: string) {
    return {
        args: [operation],
        operation,
        ownerSessionId: "owner",
        tab,
    }
}

function tick() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0))
}
