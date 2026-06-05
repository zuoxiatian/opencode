import { app } from "electron"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const BUNDLE_DIR = fileURLToPath(new URL(".", import.meta.url))

export function repoRoot() {
    return join(BUNDLE_DIR, "..", "..", "..", "..")
}

export function packageDir() {
    return join(repoRoot(), "packages", "desktop-forge")
}

export function packageResourcePath(...segments: string[]) {
    if (app.isPackaged) return join(process.resourcesPath, ...segments)
    return join(packageDir(), ...segments)
}

export function appIconPath() {
    const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png"
    const value = packageResourcePath("build", iconFile)
    if (existsSync(value)) return value

    const packagedValue = packageResourcePath(iconFile)
    if (existsSync(packagedValue)) return packagedValue
    return undefined
}

export function defaultOpencodeConfigPath() {
    return packageResourcePath("config", "opencode.jsonc")
}

export function bundledRuntimeDir() {
    return packageResourcePath("runtimes", `${process.platform}-${process.arch}`)
}

export function packagedOpencodeBin() {
    return packageResourcePath("bin", process.platform === "win32" ? "opencode.exe" : "opencode")
}
