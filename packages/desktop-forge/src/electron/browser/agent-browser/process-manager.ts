import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    realpath,
    stat,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { BrowserRuntimeException } from "../errors"
import {
    DESKTOP_FORGE_AGENT_BROWSER_CDP_URL,
    DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
} from "./provider-contract"
import type { AgentBrowserDiagnosticSink } from "./diagnostics"

const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const BASE_ENV_KEYS = new Set([
    "APPDATA",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_RUNTIME_DIR",
])

export type AgentBrowserProcessExecutor = (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeout: number,
    signal?: AbortSignal,
) => Promise<{
    exitCode: number | null
    reason?: "cancelled" | "output_limit" | "timeout"
    stderrBytes: number
    stdout: string
}>

export type AgentBrowserProcessManagerOptions = {
    baseEnv?: NodeJS.ProcessEnv
    binary: string
    binaryArgs?: string[]
    commandTimeout?: number
    diagnostic?: AgentBrowserDiagnosticSink
    executor?: AgentBrowserProcessExecutor
    expectedSha256?: string
    expectedVersion: string
    idleTimeout?: number
    maxOutput?: number
    provider: {
        args?: string[]
        command: string
    }
    runtimeDir: string
    socketDir?: string
}

export type AgentBrowserCommandInput = {
    args: string[]
    cdpUrl: string
    operation: string
    session: string
    signal?: AbortSignal
    timeout?: number
}

export type AgentBrowserStopInput = Pick<
    AgentBrowserCommandInput,
    "cdpUrl" | "session" | "timeout"
>

export type AgentBrowserJsonResult = {
    _boundary?: {
        nonce?: string
        origin?: string
    }
    data?: unknown
    error?: string | null
    success: boolean
}

export type AgentBrowserPlatformKey =
    | "darwin-arm64"
    | "darwin-x64"
    | "linux-arm64"
    | "linux-x64"
    | "win32-x64"

export class AgentBrowserProcessManager {
    private prepared?: Promise<void>

    constructor(private readonly options: AgentBrowserProcessManagerOptions) {}

    prepare() {
        this.prepared ??= this.prepareRuntime()
        return this.prepared
    }

    async run(input: AgentBrowserCommandInput) {
        await this.prepare()
        if (input.signal?.aborted) {
            throw new BrowserRuntimeException("CANCELLED", "Browser automation command was cancelled", true, {
                operation: input.operation,
            })
        }
        const result = await (this.options.executor ?? execute)(
            this.options.binary,
            [
                ...(this.options.binaryArgs ?? []),
                "--session",
                input.session,
                "--json",
                ...input.args,
            ],
            this.environment(input.cdpUrl),
            input.timeout ?? this.options.commandTimeout ?? 10_000,
            input.signal,
        )
        if (result.reason === "cancelled") {
            throw new BrowserRuntimeException("CANCELLED", "Browser automation command was cancelled", true, {
                operation: input.operation,
            })
        }
        if (result.reason === "timeout") {
            throw new BrowserRuntimeException("TIMEOUT", "Browser automation command timed out", true, {
                operation: input.operation,
            })
        }
        if (result.reason === "output_limit") {
            throw new BrowserRuntimeException("AGENT_SESSION_FAILED", "Browser automation output exceeded its limit", false, {
                causeCategory: "output_limit",
                operation: input.operation,
            })
        }
        const output = parseOutput(result.stdout)
        if (result.exitCode === 0 && output?.success) return output
        throw processFailure(output?.error, result.exitCode, input.operation)
    }

    async stop(input: AgentBrowserStopInput) {
        await this.prepare()
        const base = path.join(this.daemonDir(), input.session)
        const initialPidText = await readFile(`${base}.pid`, "utf8").catch(() => "")
        await this.run({
            args: ["close"],
            cdpUrl: input.cdpUrl,
            operation: "close",
            session: input.session,
            timeout: input.timeout ?? 3_000,
        }).catch(() => undefined)
        const pidText = await readFile(`${base}.pid`, "utf8").catch(() => initialPidText)
        const timeout = input.timeout ?? 3_000
        if (await waitForDaemonExit(base, pidText, timeout)) {
            await cleanupDaemonFiles(base)
            return
        }
        const pid = Number.parseInt(pidText, 10)
        const currentPid = await readFile(`${base}.pid`, "utf8").catch(() => "")
        if (
            !Number.isSafeInteger(pid)
            || pid <= 1
            || pid === process.pid
            || currentPid.trim() !== pidText.trim()
        ) {
            if (await daemonSidecarsActive(base)) {
                throw new BrowserRuntimeException(
                    "AGENT_SESSION_FAILED",
                    "Browser automation daemon could not be identified for shutdown",
                    true,
                    { causeCategory: "daemon_shutdown" },
                )
            }
            await cleanupDaemonFiles(base)
            return
        }
        if (!await processAlive(pid)) {
            await cleanupDaemonFiles(base)
            return
        }
        await signalProcess(pid, "SIGTERM")
        if (!await waitForDaemonExit(base, pidText, 1_000)) {
            await signalProcess(pid, "SIGKILL")
            await waitForDaemonExit(base, pidText, 1_000)
        }
        if (await processAlive(pid)) {
            throw new BrowserRuntimeException(
                "AGENT_SESSION_FAILED",
                "Browser automation daemon did not stop",
                true,
                { causeCategory: "daemon_shutdown" },
            )
        }
        await cleanupDaemonFiles(base)
    }

    private async prepareRuntime() {
        await Promise.all([
            stat(this.options.binary),
            stat(this.options.provider.command),
            this.prepareSocketDirectory(),
            mkdir(path.join(this.options.runtimeDir, "config"), { recursive: true }),
            mkdir(path.join(this.options.runtimeDir, "logs"), { recursive: true }),
            mkdir(path.join(this.options.runtimeDir, "tmp"), { recursive: true }),
        ]).catch(() => {
            throw new BrowserRuntimeException(
                "AGENT_BROWSER_UNAVAILABLE",
                "Packaged browser automation runtime is unavailable",
            )
        })
        if (process.platform !== "win32") await chmod(this.socketStorageDir(), 0o700)
        if (this.options.expectedSha256) {
            const actual = await sha256(this.options.binary)
            if (actual !== this.options.expectedSha256) {
                throw new BrowserRuntimeException(
                    "AGENT_BROWSER_UNAVAILABLE",
                    "Browser automation binary checksum does not match the pinned manifest",
                )
            }
        }
        const version = await (this.options.executor ?? execute)(
            this.options.binary,
            [...(this.options.binaryArgs ?? []), "--version"],
            sanitizedBaseEnv(this.options.baseEnv ?? process.env),
            5_000,
        )
        if (
            version.exitCode !== 0
            || version.stdout.trim() !== `agent-browser ${this.options.expectedVersion}`
        ) {
            throw new BrowserRuntimeException(
                "AGENT_BROWSER_UNAVAILABLE",
                "Browser automation binary version does not match the pinned manifest",
            )
        }
        await writeFile(path.join(this.options.runtimeDir, "config", "config.json"), "{}\n", {
            encoding: "utf8",
            mode: 0o600,
        })
        this.options.diagnostic?.({
            component: "process",
            event: "runtime_ready",
            version: this.options.expectedVersion,
        })
    }

    private environment(cdpUrl: string) {
        return {
            ...sanitizedBaseEnv(this.options.baseEnv ?? process.env),
            AGENT_BROWSER_CONFIG: path.join(this.options.runtimeDir, "config", "config.json"),
            AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
            AGENT_BROWSER_DEFAULT_TIMEOUT: String(this.options.commandTimeout ?? 10_000),
            AGENT_BROWSER_IDLE_TIMEOUT_MS: String(this.options.idleTimeout ?? 5 * 60_000),
            AGENT_BROWSER_MAX_OUTPUT: String(this.options.maxOutput ?? 1_000_000),
            AGENT_BROWSER_NAMESPACE: "desktop-forge",
            AGENT_BROWSER_NO_AUTO_DIALOG: "true",
            AGENT_BROWSER_PLUGINS: JSON.stringify([{
                args: this.options.provider.args ?? [],
                capabilities: ["browser.provider"],
                command: this.options.provider.command,
                name: DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
            }]),
            AGENT_BROWSER_PROVIDER: DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
            AGENT_BROWSER_SOCKET_DIR: this.socketDir(),
            [DESKTOP_FORGE_AGENT_BROWSER_CDP_URL]: cdpUrl,
        }
    }

    private socketDir() {
        return this.options.socketDir ?? path.join(this.options.runtimeDir, "sockets")
    }

    private socketStorageDir() {
        return path.join(this.options.runtimeDir, "sockets")
    }

    private async prepareSocketDirectory() {
        await mkdir(this.socketStorageDir(), { mode: 0o700, recursive: true })
        if (this.socketDir() === this.socketStorageDir()) return
        const storage = await realpath(this.socketStorageDir())
        const existing = await lstat(this.socketDir()).then(
            (info) => info.isSymbolicLink() ? realpath(this.socketDir()) : "",
            (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined
                throw error
            },
        )
        if (existing === storage) return
        if (existing !== undefined) throw new Error("agent-browser socket alias is not trusted")
        await symlink(storage, this.socketDir(), "dir").catch(async (error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST" && await realpath(this.socketDir()) === storage) return
            throw error
        })
    }

    private daemonDir() {
        return path.join(this.socketDir(), "namespaces", "desktop-forge", "run")
    }
}

export function agentBrowserPlatformKey(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): AgentBrowserPlatformKey {
    if (platform === "darwin" && arch === "arm64") return "darwin-arm64"
    if (platform === "darwin" && arch === "x64") return "darwin-x64"
    if (platform === "win32" && arch === "x64") return "win32-x64"
    if (platform === "linux" && arch === "arm64") return "linux-arm64"
    if (platform === "linux" && arch === "x64") return "linux-x64"
    throw new BrowserRuntimeException(
        "AGENT_BROWSER_UNAVAILABLE",
        `Browser automation is unavailable on ${platform}-${arch}`,
    )
}

export function agentBrowserResourcePaths(
    resourcesPath: string,
    platform = process.platform,
    arch = process.arch,
) {
    const directory = path.join(resourcesPath, "agent-browser", agentBrowserPlatformKey(platform, arch))
    return {
        binary: path.join(directory, platform === "win32" ? "agent-browser.exe" : "agent-browser"),
        provider: path.join(
            directory,
            platform === "win32"
                ? "desktop-forge-agent-browser-provider.exe"
                : "desktop-forge-agent-browser-provider",
        ),
    }
}

export function agentBrowserSocketDir(runtimeDir: string, platform = process.platform) {
    if (platform === "win32") return path.join(runtimeDir, "sockets")
    return path.join(
        "/tmp",
        `df-agent-browser-${createHash("sha256").update(runtimeDir).digest("hex").slice(0, 12)}`,
    )
}

function sanitizedBaseEnv(env: NodeJS.ProcessEnv) {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) => BASE_ENV_KEYS.has(key.toUpperCase())),
    )
}

function execute(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeout: number,
    signal?: AbortSignal,
) {
    return new Promise<{
        exitCode: number | null
        reason?: "cancelled" | "output_limit" | "timeout"
        stderrBytes: number
        stdout: string
    }>((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        })
        const streamsSettled = Promise.all([
            streamSettled(child.stdout),
            streamSettled(child.stderr),
        ])
        const stdout: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let reason: "cancelled" | "output_limit" | "timeout" | undefined
        const timer = setTimeout(() => {
            reason = "timeout"
            child.kill()
        }, Math.max(1, timeout))
        timer.unref()
        const cancel = () => {
            reason = "cancelled"
            child.kill()
        }
        signal?.addEventListener("abort", cancel, { once: true })
        child.stdout.on("data", (data: Buffer) => {
            stdoutBytes += data.byteLength
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                reason = "output_limit"
                child.kill()
                return
            }
            stdout.push(data)
        })
        child.stderr.on("data", (data: Buffer) => {
            stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + data.byteLength)
        })
        child.once("error", (error) => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", cancel)
            reject(error)
        })
        child.once("close", async (exitCode) => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", cancel)
            await streamsSettled
            resolve({
                exitCode,
                reason,
                stderrBytes,
                stdout: Buffer.concat(stdout).toString("utf8"),
            })
        })
    }).catch((error: unknown) => {
        if (error instanceof BrowserRuntimeException) throw error
        throw new BrowserRuntimeException(
            "AGENT_BROWSER_UNAVAILABLE",
            "Unable to start the packaged browser automation runtime",
            false,
            { causeCategory: "spawn" },
        )
    })
}

function streamSettled(stream: NodeJS.ReadableStream) {
    return new Promise<void>((resolve) => {
        const settled = () => {
            stream.removeListener("end", settled)
            stream.removeListener("close", settled)
            resolve()
        }
        stream.once("end", settled)
        stream.once("close", settled)
    })
}

function parseOutput(stdout: string): AgentBrowserJsonResult | undefined {
    const line = stdout.trim().split(/\r?\n/).at(-1)
    if (!line) return undefined
    try {
        const parsed = JSON.parse(line)
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
        if (typeof parsed.success !== "boolean") return undefined
        return parsed as AgentBrowserJsonResult
    } catch {
        return undefined
    }
}

function processFailure(error: string | null | undefined, exitCode: number | null, operation: string) {
    const details = {
        agentExitCode: exitCode ?? undefined,
        causeCategory: "agent_process",
        operation,
    }
    const category = error?.toLowerCase() ?? ""
    if (error?.includes("401 Unauthorized")) {
        return new BrowserRuntimeException(
            "GATEWAY_AUTH_FAILED",
            "Browser automation Gateway lease was rejected",
            false,
            details,
        )
    }
    if (error?.includes("CDP WebSocket connect failed")) {
        return new BrowserRuntimeException(
            "GATEWAY_UNAVAILABLE",
            "Browser automation Gateway connection failed",
            true,
            details,
        )
    }
    if (category.includes("cdp method is not allowed")) {
        return new BrowserRuntimeException(
            "CDP_METHOD_DENIED",
            "Browser automation requested a CDP method outside the single-tab policy",
            false,
            details,
        )
    }
    if (category.includes("cdp command timed out")) {
        return new BrowserRuntimeException(
            "TIMEOUT",
            "Browser automation Gateway command timed out",
            true,
            { ...details, causeCategory: "gateway_timeout" },
        )
    }
    if (category.includes("unknown ref")) {
        return new BrowserRuntimeException(
            "STALE_REF",
            "Browser snapshot reference is stale",
            true,
            details,
        )
    }
    if (
        category.includes("strict mode")
        || category.includes("matched multiple")
        || category.includes("multiple elements")
    ) {
        return new BrowserRuntimeException(
            "AMBIGUOUS_LOCATOR",
            "Browser automation target matched multiple elements",
            false,
            details,
        )
    }
    if (
        category.includes("no element found")
        || category.includes("element not found")
        || category.includes("could not locate element")
    ) {
        return new BrowserRuntimeException(
            "LOCATOR_NOT_FOUND",
            "Browser automation target was not found",
            true,
            details,
        )
    }
    if (
        category.includes("not visible")
        || category.includes("not enabled")
        || category.includes("not editable")
        || category.includes("not actionable")
        || category.includes("intercept")
        || category.includes("covered by")
    ) {
        return new BrowserRuntimeException(
            "ELEMENT_NOT_ACTIONABLE",
            "Browser automation target is not actionable",
            true,
            details,
        )
    }
    if (category.includes("timed out") || category.includes("timeout")) {
        return new BrowserRuntimeException(
            "TIMEOUT",
            "Browser automation condition timed out",
            true,
            details,
        )
    }
    if (category.includes("target closed") || category.includes("target gone")) {
        return new BrowserRuntimeException(
            "TARGET_GONE",
            "Browser automation target is no longer available",
            true,
            details,
        )
    }
    return new BrowserRuntimeException(
        "AGENT_SESSION_FAILED",
        "Browser automation session failed",
        true,
        details,
    )
}

function sha256(file: string) {
    return new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256")
        const stream = createReadStream(file)
        stream.on("data", (data) => hash.update(data))
        stream.once("error", reject)
        stream.once("end", () => resolve(hash.digest("hex")))
    })
}

async function waitForDaemonExit(base: string, pidText: string, timeout: number) {
    const pid = Number.parseInt(pidText, 10)
    const deadline = Date.now() + Math.max(1, timeout)
    while (Date.now() < deadline) {
        const active = await Promise.all([
            daemonSidecarsActive(base),
            Number.isSafeInteger(pid) && pid > 1 ? processAlive(pid) : false,
        ])
        if (!active.some(Boolean)) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
}

function daemonSidecarsActive(base: string) {
    return Promise.all(
        ["pid", "port", "sock"].map((extension) =>
            stat(`${base}.${extension}`).then(() => true, () => false)),
    ).then((active) => active.some(Boolean))
}

function processAlive(pid: number) {
    return Promise.resolve()
        .then(() => process.kill(pid, 0))
        .then(() => true, () => false)
}

function signalProcess(pid: number, signal: NodeJS.Signals) {
    return Promise.resolve()
        .then(() => process.kill(pid, signal))
        .then(() => undefined, () => undefined)
}

function cleanupDaemonFiles(base: string) {
    return Promise.all(
        [
            "config",
            "engine",
            "extensions",
            "pid",
            "port",
            "provider",
            "sock",
            "stream",
            "version",
        ].map((extension) => unlink(`${base}.${extension}`).catch(() => undefined)),
    ).then(() => undefined)
}
