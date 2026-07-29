import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, stat } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { promisify } from "node:util"
import { app, BrowserWindow, WebContentsView } from "electron"
import { TabDebuggerTransport } from "../src/electron/browser/agent-browser/debugger-transport"
import { CdpTabGateway } from "../src/electron/browser/agent-browser/gateway"
import { DESKTOP_FORGE_AGENT_BROWSER_CDP_URL } from "../src/electron/browser/agent-browser/provider-contract"

const execFileAsync = promisify(execFile)
const binary = process.env.AGENT_BROWSER_POC_BINARY
const provider = process.env.AGENT_BROWSER_POC_PROVIDER
const providerRuntime = process.env.AGENT_BROWSER_POC_PROVIDER_RUNTIME
if (!binary) throw new Error("AGENT_BROWSER_POC_BINARY is required")
if (!provider && !providerRuntime) {
    throw new Error("AGENT_BROWSER_POC_PROVIDER or AGENT_BROWSER_POC_PROVIDER_RUNTIME is required")
}

const packageDir = process.cwd()
app.commandLine.appendSwitch("site-per-process")
void app.whenReady().then(runPoc, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    app.exit(1)
})

async function runPoc() {
    const window = new BrowserWindow({ show: false })
    const view = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    })
    window.contentView.addChildView(view)
    view.setBounds({ height: 600, width: 900, x: 0, y: 0 })

    const transport = new TabDebuggerTransport(view.webContents)
    const gateway = new CdpTabGateway()
    const methods: string[] = []
    const socketDir = await mkdtemp("/tmp/df-ab-")
    const session = `df-${process.pid}`
    const frame = await listen(createServer((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.end(`
            <!doctype html>
            <label for="frame-query">Frame query</label>
            <input id="frame-query" placeholder="Frame search">
            <button>Frame submit</button>
        `)
    }))

    try {
        step("page")
        await view.webContents.loadURL(page())
        step("gateway")
        await gateway.start()
        const issued = gateway.createLease({
            active: () => !view.webContents.isDestroyed(),
            ownerSessionId: "poc-owner",
            tabGeneration: 1,
            tabId: "poc-tab",
            transport: {
                hasChildSession: (sessionId) => transport.hasChildSession(sessionId),
                onDetach: (listener) => transport.onDetach(listener),
                onMessage: (listener) => transport.onMessage(listener),
                sendCommand: (method, params, sessionId) => {
                    methods.push(method)
                    return transport.sendCommand(method, params, sessionId)
                },
            },
        })
        const env = {
            ...process.env,
            AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
            AGENT_BROWSER_DEFAULT_TIMEOUT: "5000",
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "10000",
            AGENT_BROWSER_PLUGINS: JSON.stringify([{
                args: provider
                    ? []
                    : ["run", path.join(packageDir, "script", "agent-browser-provider.ts")],
                capabilities: ["browser.provider"],
                command: provider ?? providerRuntime,
                name: "desktop-forge",
            }]),
            AGENT_BROWSER_PROVIDER: "desktop-forge",
            AGENT_BROWSER_SOCKET_DIR: socketDir,
            [DESKTOP_FORGE_AGENT_BROWSER_CDP_URL]: issued.url,
        }

        step("open")
        const initialUrl = view.webContents.getURL()
        const openSession = `${session}-open`
        const openLease = gateway.createLease({
            active: () => !view.webContents.isDestroyed(),
            ownerSessionId: "poc-owner",
            tabGeneration: 1,
            tabId: "poc-tab",
            transport,
        })
        await run(["--session", openSession, "--json", "open"], {
            ...env,
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "250",
            [DESKTOP_FORGE_AGENT_BROWSER_CDP_URL]: openLease.url,
        })
        assert.equal(view.webContents.getURL(), initialUrl)
        await waitForNoDaemon(socketDir, openSession)

        step("snapshot")
        const initial = snapshotText(
            await run(["--session", session, "--json", "snapshot", "-i"], env),
        )
        assert.match(initial, /textbox|Search|Query/)
        assert.match(initial, /button|Submit/)
        assert.doesNotMatch(initial, /Clear search/)
        const initialQuery = initial.match(/textbox "Query" \[ref=(e\d+)\]/)?.[1]
        assert.ok(initialQuery)

        step("actions")
        await run(["--session", session, "--json", "fill", `@${initialQuery}`, "agent-browser"], env)
        const changed = snapshotText(
            await run(["--session", session, "--json", "snapshot", "-i"], env),
        )
        const clear = changed.match(/button "Clear search" \[ref=(e\d+)\]/)
        assert.ok(clear, "state-changing input must expose a clear button in the new snapshot")
        await run(["--session", session, "--json", "click", `@${clear[1]}`], env)
        const cleared = snapshotText(
            await run(["--session", session, "--json", "snapshot", "-i"], env),
        )
        const clearedQuery = cleared.match(/textbox "Query" \[ref=(e\d+)\]/)?.[1]
        assert.ok(clearedQuery)
        assert.match(
            await run(["--session", session, "--json", "get", "value", `@${clearedQuery}`], env),
            /"value":""/,
        )
        await run(["--session", session, "--json", "fill", `@${clearedQuery}`, "agent-browser"], env)
        const ready = snapshotText(
            await run(["--session", session, "--json", "snapshot", "-i"], env),
        )
        const readyQuery = ready.match(/textbox "Query" \[ref=(e\d+)\]/)?.[1]
        const readySubmit = ready.match(/button "Submit" \[ref=(e\d+)\]/)?.[1]
        assert.ok(readyQuery)
        assert.ok(readySubmit)
        await run(["--session", session, "--json", "click", `@${readySubmit}`], env)
        assert.match(
            await run(["--session", session, "--json", "get", "text", "#result"], env),
            /submitted:agent-browser/,
        )
        assert.match(
            await run(["--session", session, "--json", "get", "box", `@${readyQuery}`], env),
            /width|height/,
        )
        assert.match(
            await run(["--session", session, "--json", "get", "html", "#root"], env),
            /input|button/,
        )

        step("oopif")
        await view.webContents.loadURL(oopifPage(frame.port))
        const oopif = snapshotText(
            await run(["--session", session, "--json", "snapshot", "-i"], env),
        )
        assert.match(oopif, /Frame query/)
        assert.ok(transport.childSessions.size > 0)
        const frameQuery = oopif.match(/textbox "Frame query" \[ref=(e\d+)\]/)
        assert.ok(frameQuery)
        await run(["--session", session, "--json", "fill", `@${frameQuery[1]}`, "inside-oopif"], env)
        assert.match(
            await run(["--session", session, "--json", "get", "value", `@${frameQuery[1]}`], env),
            /inside-oopif/,
        )
        step("close")
        await run(["--session", session, "--json", "close"], env)
        await waitForNoDaemon(socketDir, session)

        step("idle-timeout")
        const idleSession = `${session}-idle`
        const idleLease = gateway.createLease({
            active: () => !view.webContents.isDestroyed(),
            ownerSessionId: "poc-owner",
            tabGeneration: 1,
            tabId: "poc-tab",
            transport,
        })
        await run(["--session", idleSession, "--json", "snapshot", "-i"], {
            ...env,
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "250",
            [DESKTOP_FORGE_AGENT_BROWSER_CDP_URL]: idleLease.url,
        })
        await waitForNoDaemon(socketDir, idleSession)

        assert.equal(view.webContents.isDestroyed(), false)
        assert.equal(
            await view.webContents.executeJavaScript("document.querySelector('h1')?.textContent"),
            "OOPIF host",
        )
        assert.equal(methods.includes("Target.getTargets"), false)
        assert.equal(methods.includes("Target.createTarget"), false)
        assert.equal(methods.includes("Browser.close"), false)

        process.stdout.write(JSON.stringify({
            directPage: true,
            idleTimeout: true,
            methods: [...new Set(methods)].sort(),
            success: true,
        }))
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        process.stderr.write(`agent-browser-poc:methods:${[...new Set(methods)].sort().join(",")}\n`)
        process.exitCode = 1
    } finally {
        step("cleanup")
        await gateway.close()
        transport.destroy()
        window.destroy()
        await close(frame.server)
        app.exit(process.exitCode ?? 0)
    }
}

function run(args: string[], env: NodeJS.ProcessEnv) {
    return execFileAsync(binary, args, {
        cwd: packageDir,
        env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
    }).then(
        (result) => result.stdout,
        (error: unknown) => {
            const failure = asRecord(error)
            throw new Error([
                typeof failure.message === "string" ? failure.message : "agent-browser command failed",
                typeof failure.stdout === "string" ? failure.stdout : "",
                typeof failure.stderr === "string" ? failure.stderr : "",
            ].map(sanitize).filter(Boolean).join("\n"))
        },
    )
}

function page() {
    return `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html>
        <html>
            <body>
                <div id="root">
                    <label for="query">Query</label>
                    <input class="s_ipt" id="query" placeholder="Search">
                    <button class="quickdelete" id="clear" hidden>Clear search</button>
                    <button id="submit">Submit</button>
                    <p id="result"></p>
                </div>
                <script>
                    const query = document.querySelector("#query")
                    const clear = document.querySelector("#clear")
                    query.addEventListener("input", () => {
                        clear.hidden = query.value.length === 0
                    })
                    clear.addEventListener("click", () => {
                        query.value = ""
                        clear.hidden = true
                        query.focus()
                    })
                    document.querySelector("#submit").addEventListener("click", () => {
                        document.querySelector("#result").textContent =
                            "submitted:" + query.value
                    })
                </script>
            </body>
        </html>
    `)}`
}

function oopifPage(framePort: number) {
    return `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html>
        <h1>OOPIF host</h1>
        <iframe title="Cross frame" src="http://localhost:${framePort}/frame"></iframe>
    `)}`
}

function step(name: string) {
    process.stderr.write(`agent-browser-poc:${name}\n`)
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {}
}

function sanitize(value: string) {
    return value.replace(/wss?:\/\/[^\s"]+\/cdp\/[A-Za-z0-9_-]+/g, "[gateway]")
}

function snapshotText(output: string) {
    const parsed = JSON.parse(output) as {
        data?: {
            snapshot?: unknown
        }
    }
    assert.equal(typeof parsed.data?.snapshot, "string")
    return parsed.data.snapshot
}

async function waitForNoDaemon(socketDir: string, session: string) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        const active = await Promise.all(
            ["pid", "port", "sock", "stream", "version"].map((extension) =>
                stat(path.join(socketDir, `${session}.${extension}`))
                    .then(() => true, () => false)),
        )
        if (!active.some(Boolean)) return
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.fail(`agent-browser daemon did not stop: ${session}`)
}

function listen(server: Server) {
    return new Promise<{ port: number; server: Server }>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject)
            resolve({ port: (server.address() as AddressInfo).port, server })
        })
    })
}

function close(server: Server) {
    return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
    })
}
