import { app } from "electron"
import { spawn, spawnSync } from "node:child_process"
import { unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { getBunCommand, inheritUserShellEnv } from "./shell-env"
import { packagedOpencodeBin, repoRoot } from "../resources/paths"
import { runtimeEnv } from "./runtime"
import type { MainState, ServerInfo } from "../app/state"
import { ensureDefaultDirectory } from "./default-directory"

export async function startServer(state: MainState, opencodeConfig: unknown): Promise<ServerInfo> {
    if (!isRecord(opencodeConfig)) throw new Error("模型配置不是 JSON 对象")
    if (!state.browserTransport) throw new Error("内嵌浏览器服务尚未就绪")
    const browserTransport = state.browserTransport
    const defaultDirectory = await ensureDefaultDirectory()
    await removeLegacySyncedOpencodeConfig()

    return new Promise((resolve, reject) => {
        const password = Math.random().toString(36).substring(2, 15)
        const baseEnv = inheritUserShellEnv(state)
        const command = serverCommand()
        const noProxy = loopbackNoProxy(baseEnv.NO_PROXY ?? baseEnv.no_proxy)

        const serverProcess = spawn(command.cmd, command.args, {
            cwd: app.isPackaged ? app.getPath("userData") : repoRoot(),
            env: {
                ...baseEnv,
                ...runtimeEnv(baseEnv),
                OPENCODE_AUTO_UPDATE: "false",
                OPENCODE_CONFIG_CONTENT: `${JSON.stringify(opencodeConfig, null, 2)}\n`,
                OPENCODE_DESKTOP_BROWSER_TOKEN: browserTransport.token,
                OPENCODE_DESKTOP_BROWSER_URL: browserTransport.url,
                OPENCODE_DISABLE_GLOBAL_CONFIG: "true",
                OPENCODE_TRUSTED_SKILLS_DIR: join(
                    process.env.OPENCODE_TEST_HOME ?? homedir(),
                    ".lxz",
                    "skills",
                ),
                OPENCODE_SERVER_PASSWORD: password,
                NO_PROXY: noProxy,
                no_proxy: noProxy,
                ComSpec: process.env.ComSpec || "C:\\WINDOWS\\system32\\cmd.exe",
                SystemRoot: process.env.SystemRoot || "C:\\WINDOWS",
            },
            stdio: ["pipe", "pipe", "pipe"],
        })
        state.serverProcess = serverProcess

        let output = ""
        let serverUrl: string | undefined

        serverProcess.stdout?.on("data", (data) => {
            output += data.toString()
            const match = output.match(/listening on (http:\/\/[^\s]+)/)
            if (match?.[1]) serverUrl = match[1].trim()
        })

        serverProcess.stderr?.on("data", (data) => {
            console.error("Server stderr:", data.toString())
        })

        serverProcess.on("error", reject)
        serverProcess.on("exit", (code) => {
            if (state.serverProcess === serverProcess) {
                state.serverInfo = null
                state.serverProcess = null
            }
            if (code !== 0 && code !== null) reject(new Error(`Server exited with code ${code}`))
        })

        void waitForServer(() => serverUrl)
            .then(() => {
                if (!serverUrl) throw new Error("Server URL missing")
                resolve({ defaultDirectory, password, url: serverUrl })
            })
            .catch(reject)
    })
}

export function stopServer(state: MainState) {
    state.serverProcess?.kill()
    state.serverProcess = null
    state.serverInfo = null
    state.serverStartPromise = null
}

function serverCommand() {
    if (app.isPackaged) {
        return {
            args: ["serve"],
            cmd: packagedOpencodeBin(),
        }
    }

    return {
        args: ["run", "--cwd", join(repoRoot(), "packages", "opencode"), "--conditions=browser", "src/index.ts", "serve"],
        cmd: getBunCommand(),
    }
}

function loopbackNoProxy(input?: string) {
    return [...new Set([
        ...(input ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        "127.0.0.1",
        "localhost",
        "::1",
    ])].join(",")
}

async function waitForServer(serverUrl: () => string | undefined) {
    await delay(3_000)
    return waitForServerAttempt(serverUrl, 0)
}

async function waitForServerAttempt(serverUrl: () => string | undefined, attempt: number): Promise<void> {
    if (attempt > 0) await delay(1_000)

    const url = serverUrl()
    if (!url) {
        if (attempt >= 59) throw new Error("Server startup timeout")
        return waitForServerAttempt(serverUrl, attempt + 1)
    }

    const response = await fetch(healthUrl(url), { signal: AbortSignal.timeout(1_500) }).catch(() => undefined)
    if (response && (response.ok || response.status === 401 || response.status === 403)) return
    if (attempt >= 59) throw new Error("Server startup timeout")
    return waitForServerAttempt(serverUrl, attempt + 1)
}

function healthUrl(serverUrl: string) {
    const url = new URL(serverUrl)
    url.pathname = "/health"
    return url.toString()
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
}

async function removeLegacySyncedOpencodeConfig() {
    const file = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "config", "opencode.jsonc")

    await unlink(file).catch((error: unknown) => {
        if (fileError(error, "ENOENT")) return
        if (!fileError(error, "EPERM") && !fileError(error, "EACCES")) {
            console.warn("Failed to remove legacy opencode config:", error)
            return
        }
        clearWindowsReadonlyAttribute(file)
        return unlink(file).catch((retryError: unknown) => {
            if (!fileError(retryError, "ENOENT")) console.warn("Failed to remove legacy opencode config:", retryError)
        })
    })
}

function fileError(error: unknown, code: "ENOENT" | "EPERM" | "EACCES") {
    return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function clearWindowsReadonlyAttribute(file: string) {
    if (process.platform !== "win32") return
    spawnSync("attrib", ["-R", file], { stdio: "ignore", windowsHide: true })
}
