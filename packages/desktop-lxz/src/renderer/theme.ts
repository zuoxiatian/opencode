export const THEME_STORAGE_KEY = "desktop-lxz.theme"
export const THEME_MODES = ["system", "light", "dark"] as const

export type ThemeMode = (typeof THEME_MODES)[number]
export type ResolvedTheme = Exclude<ThemeMode, "system">

export function isThemeMode(value: string | null): value is ThemeMode {
    return value === "system" || value === "light" || value === "dark"
}

export function nextThemeMode(mode: ThemeMode) {
    if (mode === "system") return "light"
    if (mode === "light") return "dark"
    return "system"
}
