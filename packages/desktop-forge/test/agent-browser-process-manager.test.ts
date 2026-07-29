// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserRuntimeException } from "../src/electron/browser/errors"
import {
    AgentBrowserProcessManager,
    type AgentBrowserProcessExecutor,
    agentBrowserPlatformKey,
    agentBrowserResourcePaths,
    agentBrowserSocketDir,
} from "../src/electron/browser/agent-browser/process-manager"

const fixture = fileURLToPath(new URL("./fixtures/fake-agent-browser.mjs", import.meta.url))

describe("agent-browser ProcessManager", () => {
    test("verifies the binary and uses scoped provider environment", async () => {
        const runtimeDir = await mkdtemp("/tmp/df-process-manager-")
        const manager = createManager(runtimeDir)
        const result = await manager.run({
            args: ["snapshot", "-i"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "snapshot",
            session: "df-tab",
        })
        const data = result.data as Record<string, unknown>

        expect(result.success).toBe(true)
        expect(data.command).toEqual(["snapshot", "-i"])
        expect(data.provider).toBe("desktop-forge")
        expect(data.profilePresent).toBe(false)
        expect(data.cdpUrl).toBe("ws://127.0.0.1:43127/cdp/opaque")
        expect(data.config).toBe(path.join(runtimeDir, "config", "config.json"))
        expect(data.noAutoDialog).toBe("true")
        expect(data.privateTokenPresent).toBe(false)
        expect(data.socketDir).toBe(path.join(runtimeDir, "sockets"))
        expect(data.plugins).toEqual([{
            args: [fixture, "provider"],
            capabilities: ["browser.provider"],
            command: process.execPath,
            name: "desktop-forge",
        }])
    })

    test("maps Gateway authentication failures without returning raw output", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const error = await manager.run({
            args: ["fail-auth"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque-secret",
            operation: "snapshot",
            session: "df-tab",
        }).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toEqual({
            code: "GATEWAY_AUTH_FAILED",
            details: {
                agentExitCode: 1,
                causeCategory: "agent_process",
                operation: "snapshot",
            },
            message: "Browser automation Gateway lease was rejected",
            retryable: false,
        })
        expect(error.message).not.toContain("opaque-secret")
    })

    test("maps locator failures without returning the raw selector", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const error = await manager.run({
            args: ["fail-locator"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "click",
            session: "df-tab",
        }).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser.code).toBe("LOCATOR_NOT_FOUND")
        expect(error.message).not.toContain("#private-account-selector")
    })

    test("maps Gateway method policy failures to a non-retryable error", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const error = await manager.run({
            args: ["fail-cdp-policy"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "snapshot",
            session: "df-tab",
        }).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "CDP_METHOD_DENIED",
            retryable: false,
        })
    })

    test("distinguishes non-actionable targets from missing locators", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const error = await manager.run({
            args: ["fail-actionable"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "fill",
            session: "df-tab",
        }).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "ELEMENT_NOT_ACTIONABLE",
            retryable: true,
        })
        expect(error.message).not.toContain("#private-hidden-selector")
    })

    test("only reports timeout for an explicit timed-out condition", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const error = await manager.run({
            args: ["fail-timeout"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "waitFor",
            session: "df-tab",
        }).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "TIMEOUT",
            retryable: true,
        })
        expect(error.message).not.toContain("#private-late-selector")
    })

    test("identifies Gateway CDP timeouts without exposing transport details", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const error = await manager.run({
            args: ["fail-gateway-timeout"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "snapshot",
            session: "df-tab",
        }).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "TIMEOUT",
            details: {
                causeCategory: "gateway_timeout",
                operation: "snapshot",
            },
            retryable: true,
        })
    })

    test("supports AbortSignal cancellation", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"))
        const controller = new AbortController()
        const command = manager.run({
            args: ["hang"],
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            operation: "wait",
            session: "df-tab",
            signal: controller.signal,
        }).catch((failure: unknown) => failure)
        setTimeout(() => controller.abort(), 20)

        const error = await command
        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser.code).toBe("CANCELLED")
    })

    test("stops one exact daemon session and removes its sidecars", async () => {
        const runtimeDir = await mkdtemp("/tmp/df-process-manager-")
        const directory = path.join(
            runtimeDir,
            "sockets",
            "namespaces",
            "desktop-forge",
            "run",
        )
        await mkdir(directory, { recursive: true })
        await Promise.all([
            writeFile(path.join(directory, "df-tab.config"), "{}"),
            writeFile(path.join(directory, "df-tab.pid"), "2147483647"),
            writeFile(path.join(directory, "df-tab.sock"), ""),
            writeFile(path.join(directory, "other.config"), "{}"),
        ])
        await createManager(runtimeDir).stop({
            cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
            session: "df-tab",
            timeout: 25,
        })

        expect(await readdir(directory)).toEqual(["other.config"])
    })

    test("rejects version mismatches", async () => {
        const manager = createManager(await mkdtemp("/tmp/df-process-manager-"), "0.32.0")
        const error = await manager.prepare().catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser.code).toBe("AGENT_BROWSER_UNAVAILABLE")
    })
})

describe("agent-browser resource paths", () => {
    test("supports the target platform matrix", () => {
        expect(agentBrowserPlatformKey("darwin", "arm64")).toBe("darwin-arm64")
        expect(agentBrowserPlatformKey("darwin", "x64")).toBe("darwin-x64")
        expect(agentBrowserPlatformKey("win32", "x64")).toBe("win32-x64")
        expect(agentBrowserPlatformKey("linux", "arm64")).toBe("linux-arm64")
        expect(agentBrowserPlatformKey("linux", "x64")).toBe("linux-x64")
        expect(agentBrowserResourcePaths("/app/resources", "win32", "x64")).toEqual({
            binary: path.join("/app/resources", "agent-browser", "win32-x64", "agent-browser.exe"),
            provider: path.join(
                "/app/resources",
                "agent-browser",
                "win32-x64",
                "desktop-forge-agent-browser-provider.exe",
            ),
        })
    })

    test("rejects unsupported platforms", () => {
        expect(() => agentBrowserPlatformKey("aix", "ppc64"))
            .toThrow("Browser automation is unavailable on aix-ppc64")
    })

    test("keeps POSIX daemon sockets below the Unix path limit", () => {
        const directory = agentBrowserSocketDir(
            "/Users/example/Library/Application Support/LongwiseTechAgent/agent-browser",
            "darwin",
        )
        expect(directory).toMatch(/^\/tmp\/df-agent-browser-[a-f0-9]{12}$/)
        expect(Buffer.byteLength(path.join(
            directory,
            "namespaces",
            "desktop-forge",
            "run",
            "df-0123456789abcdef.sock",
        ))).toBeLessThanOrEqual(103)
        expect(agentBrowserSocketDir("C:\\runtime", "win32"))
            .toBe(path.join("C:\\runtime", "sockets"))
    })
})

function createManager(runtimeDir: string, expectedVersion = "0.33.0") {
    return new AgentBrowserProcessManager({
        baseEnv: {
            AGENT_BROWSER_PROFILE: "must-not-leak",
            DESKTOP_FORGE_AGENT_BROWSER_CDP_URL: "must-not-leak",
            PATH: process.env.PATH,
            PRIVATE_API_TOKEN: "must-not-leak",
        },
        binary: process.execPath,
        binaryArgs: [fixture],
        commandTimeout: 1_000,
        executor: fakeExecute,
        expectedVersion,
        provider: {
            args: [fixture, "provider"],
            command: process.execPath,
        },
        runtimeDir,
    })
}

const fakeExecute: AgentBrowserProcessExecutor = async (_command, args, env, _timeout, signal) => {
    if (args.includes("--version")) return result("agent-browser 0.33.0\n")
    const command = args.slice(args.indexOf("--json") + 1)
    if (command[0] === "hang") {
        return new Promise((resolve) => {
            const cancelled = () => resolve({
                ...result(""),
                reason: "cancelled",
            })
            if (signal?.aborted) return cancelled()
            signal?.addEventListener("abort", cancelled, { once: true })
        })
    }
    const failure = {
        "fail-actionable": "Element #private-hidden-selector is not actionable",
        "fail-auth": "401 Unauthorized: ws://127.0.0.1/cdp/opaque-secret",
        "fail-cdp-policy": "CDP method is not allowed: Target.createTarget",
        "fail-gateway-timeout": "CDP command timed out",
        "fail-locator": "No element found for #private-account-selector",
        "fail-timeout": "Timed out waiting for #private-late-selector",
    }[command[0] ?? ""]
    if (failure) {
        return {
            ...result(JSON.stringify({ error: failure, success: false })),
            exitCode: 1,
        }
    }
    return result(JSON.stringify({
        data: {
            cdpUrl: env.DESKTOP_FORGE_AGENT_BROWSER_CDP_URL,
            command,
            config: env.AGENT_BROWSER_CONFIG,
            noAutoDialog: env.AGENT_BROWSER_NO_AUTO_DIALOG,
            privateTokenPresent: env.PRIVATE_API_TOKEN !== undefined,
            plugins: JSON.parse(env.AGENT_BROWSER_PLUGINS ?? "[]"),
            profilePresent: env.AGENT_BROWSER_PROFILE !== undefined,
            provider: env.AGENT_BROWSER_PROVIDER,
            socketDir: env.AGENT_BROWSER_SOCKET_DIR,
        },
        success: true,
    }))
}

function result(stdout: string) {
    return {
        exitCode: 0,
        stderrBytes: 0,
        stdout,
    }
}
