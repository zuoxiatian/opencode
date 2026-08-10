import { app, BrowserWindow, nativeTheme } from "electron"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ResolvedTheme, ThemeMode } from "../app/state"

export function isThemeMode(value: string): value is ThemeMode {
    return value === "system" || value === "light" || value === "dark"
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
    if (mode !== "system") return mode
    return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

export function windowThemeColors(theme: ResolvedTheme) {
    if (theme === "light") {
        return {
            backgroundColor: "#ffffff",
            symbolColor: "#1a1b1f",
        }
    }

    return {
        backgroundColor: "#181818",
        symbolColor: "#d4d4d4",
    }
}

export async function readStoredThemeMode(): Promise<ThemeMode> {
    if (!existsSync(themeModePath())) return "system"

    const value = (await readFile(themeModePath(), "utf8")).trim()
    if (isThemeMode(value)) return value
    return "system"
}

export async function writeStoredThemeMode(mode: ThemeMode) {
    await mkdir(app.getPath("userData"), { recursive: true })
    await writeFile(themeModePath(), mode)
}

export function applyWindowTheme(window: BrowserWindow, mode: ThemeMode) {
    nativeTheme.themeSource = mode
    const theme = resolveThemeMode(mode)
    window.setBackgroundColor(windowThemeColors(theme).backgroundColor)
    return theme
}

function themeModePath() {
    return join(app.getPath("userData"), "theme-mode.txt")
}
