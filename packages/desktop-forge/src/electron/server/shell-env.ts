import { existsSync } from "node:fs"
import { basename, delimiter, join } from "node:path"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import type { MainState } from "../app/state"

const SHELL_ENV_TIMEOUT_MS = 5_000

export function getBunCommand() {
    if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH

    if (process.platform === "win32") {
        const candidates = [
            process.env.LOCALAPPDATA
                ? join(
                    process.env.LOCALAPPDATA,
                    "Microsoft",
                    "WinGet",
                    "Packages",
                    "Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe",
                    "bun-windows-x64",
                    "bun.exe",
                )
                : "",
            process.env.USERPROFILE ? join(process.env.USERPROFILE, ".bun", "bin", "bun.exe") : "",
        ].filter(Boolean)

        const match = candidates.find((item) => existsSync(item))
        if (match) return match
        return "bun.exe"
    }

    return "bun"
}

export function inheritUserShellEnv(state: MainState) {
    const env = { ...process.env }
    const shellEnv = loadShellEnv(state)

    if (shellEnv) {
        Object.entries(shellEnv).forEach(([key, value]) => {
            if (key === "PATH") return
            if (typeof env[key] === "undefined") env[key] = value
        })

        if (!pathLooksUserConfigured(env.PATH) && shellEnv.PATH) {
            env.PATH = mergePathValues(shellEnv.PATH, env.PATH)
        }
    }

    env.NO_PROXY = env.NO_PROXY || "localhost,127.0.0.1"
    env.no_proxy = env.no_proxy || "localhost,127.0.0.1"

    return env
}

function loadShellEnv(state: MainState) {
    if (state.shellEnvProbed) return state.cachedShellEnv
    state.shellEnvProbed = true
    if (process.platform === "win32") return null

    const shellPath = process.env.SHELL ?? "/bin/sh"
    if (["nu", "nu.exe"].includes(basename(shellPath).toLowerCase())) return null

    state.cachedShellEnv = probeShellEnv(shellPath, "-il") ?? probeShellEnv(shellPath, "-l")
    return state.cachedShellEnv
}

function probeShellEnv(shellPath: string, mode: "-il" | "-l") {
    const result = spawnSync(shellPath, [mode, "-c", "env -0"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: SHELL_ENV_TIMEOUT_MS,
        windowsHide: true,
    })
    if (result.error || result.status !== 0) return null

    const env = parseShellEnv(result.stdout)
    if (Object.keys(env).length === 0) return null
    return env
}

function parseShellEnv(stdout: Buffer) {
    return stdout
        .toString("utf8")
        .split("\0")
        .reduce<NodeJS.ProcessEnv>((result, line) => {
            const index = line.indexOf("=")
            if (index <= 0) return result
            result[line.slice(0, index)] = line.slice(index + 1)
            return result
        }, {})
}

function pathLooksUserConfigured(value: string | undefined) {
    if (!value) return false

    const normalizedHome = homedir().replaceAll("\\", "/")
    const homeWithSep = normalizedHome ? `${normalizedHome}/` : ""
    const toolchainSegments = ["/opt/homebrew/", "/opt/pkg/", "/opt/pmk/", "/snap/"]
    const toolchainBasenames = new Set([
        ".cargo",
        ".bun",
        ".nvm",
        ".pyenv",
        ".rbenv",
        ".sdkman",
        ".asdf",
        ".volta",
        ".fnm",
        ".local",
        ".opencode",
        "node_modules",
    ])

    return value.split(delimiter).some((segment) => {
        if (!segment) return false
        const normalizedSegment = segment.replaceAll("\\", "/")
        if (normalizedHome && (normalizedSegment === normalizedHome || normalizedSegment.startsWith(homeWithSep))) return true
        if (toolchainSegments.some((prefix) => normalizedSegment.startsWith(prefix))) return true
        return normalizedSegment
            .split("/")
            .filter(Boolean)
            .some((part) => toolchainBasenames.has(part))
    })
}

function mergePathValues(primary: string | undefined, fallback: string | undefined) {
    const seen = new Set<string>()

    return [primary, fallback]
        .flatMap((value) => value?.split(delimiter) ?? [])
        .filter((segment) => {
            if (!segment || seen.has(segment)) return false
            seen.add(segment)
            return true
        })
        .join(delimiter)
}
