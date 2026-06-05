import { app } from "electron"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { ensureDefaultOpencodeConfig } from "./default-opencode-config"
import { getBunCommand, inheritUserShellEnv } from "./shell-env"
import { packagedOpencodeBin, repoRoot } from "../resources/paths"
import { runtimeEnv } from "./runtime"
import type { MainState, ServerInfo } from "../app/state"

export async function startServer(state: MainState): Promise<ServerInfo> {
    await ensureDefaultOpencodeConfig()

    return new Promise((resolve, reject) => {
        const password = Math.random().toString(36).substring(2, 15)
        const baseEnv = inheritUserShellEnv(state)
        const command = serverCommand()

        state.serverProcess = spawn(command.cmd, command.args, {
            cwd: app.isPackaged ? app.getPath("userData") : repoRoot(),
            env: {
                ...baseEnv,
                ...runtimeEnv(baseEnv),
                OPENCODE_AUTO_UPDATE: "false",
                OPENCODE_SERVER_PASSWORD: password,
                ComSpec: process.env.ComSpec || "C:\\WINDOWS\\system32\\cmd.exe",
                SystemRoot: process.env.SystemRoot || "C:\\WINDOWS",
            },
            stdio: ["pipe", "pipe", "pipe"],
        })

        let output = ""
        let serverUrl: string | undefined

        state.serverProcess.stdout?.on("data", (data) => {
            output += data.toString()
            const match = output.match(/listening on (http:\/\/[^\s]+)/)
            if (match?.[1]) serverUrl = match[1].trim()
        })

        state.serverProcess.stderr?.on("data", (data) => {
            console.error("Server stderr:", data.toString())
        })

        state.serverProcess.on("error", reject)
        state.serverProcess.on("exit", (code) => {
            if (code !== 0 && code !== null) reject(new Error(`Server exited with code ${code}`))
        })

        void waitForServer(() => serverUrl)
            .then(() => {
                if (!serverUrl) throw new Error("Server URL missing")
                resolve({ password, url: serverUrl })
            })
            .catch(reject)
    })
}

export function stopServer(state: MainState) {
    state.serverProcess?.kill()
    state.serverProcess = null
    state.serverInfo = null
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
