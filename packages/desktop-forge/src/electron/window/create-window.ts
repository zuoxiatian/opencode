import type { BrowserWindow as BrowserWindowType, MenuItemConstructorOptions } from "electron"
import { app, BrowserWindow, Menu, nativeTheme } from "electron"
import { join } from "node:path"
import { APP_NAME, APP_VERSION } from "../constants"
import { BUNDLE_DIR, appIconPath } from "../resources/paths"
import { readStoredThemeMode, resolveThemeMode, windowThemeColors } from "./theme"
import type { MainState } from "../app/state"
import { createBrowserRuntime } from "../browser/runtime"
import { startBrowserTransportServer } from "../browser/transport-server"
import { OverlayWindowManager } from "./overlay-window"

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined
declare const MAIN_WINDOW_VITE_NAME: string

export async function createMainWindow(state: MainState) {
    const icon = appIconPath()
    const startupThemeMode = await readStoredThemeMode()
    nativeTheme.themeSource = startupThemeMode

    if (process.platform === "darwin" && icon) app.dock?.setIcon(icon)
    configureApplicationMenu(icon)

    const colors = windowThemeColors(resolveThemeMode(startupThemeMode))
    const isWindows = process.platform === "win32"
    const window = new BrowserWindow({
        autoHideMenuBar: isWindows,
        backgroundColor: colors.backgroundColor,
        frame: isWindows,
        height: 900,
        icon,
        minHeight: 600,
        minWidth: 800,
        show: true,
        title: APP_NAME,
        titleBarStyle: "hidden",
        ...(isWindows
            ? {
                titleBarOverlay: {
                    color: "rgba(0, 0, 0, 0)",
                    symbolColor: colors.symbolColor,
                },
            }
            : {
                titleBarOverlay: {
                    color: colors.backgroundColor,
                    height: 52,
                    symbolColor: colors.symbolColor,
                },
                trafficLightPosition: { x: 19, y: 19 },
            }),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: join(BUNDLE_DIR, "preload.js"),
            webSecurity: app.isPackaged,
        },
        width: 1400,
    })

    window.on("ready-to-show", () => window.show())
    window.on("closed", () => {
        state.overlayManager?.destroy()
        state.overlayManager = null
        state.closeDirectoryWatchers()
        const destroy = state.browserRuntime?.destroy()
        state.browserRuntime = null
        if (destroy) {
            state.browserRuntimeDestroy = destroy
            const clearDestroy = () => {
                if (state.browserRuntimeDestroy === destroy) state.browserRuntimeDestroy = null
            }
            void destroy.then(clearDestroy, clearDestroy)
        }
        if (state.window === window) state.window = null
    })

    state.overlayManager?.destroy()
    state.overlayManager = new OverlayWindowManager(window)

    await state.browserRuntimeDestroy?.catch(() => undefined)
    await state.browserRuntime?.destroy()
    state.browserRuntimeDestroy = null
    state.browserRuntime = createBrowserRuntime(window, () => state.overlayManager?.raiseViews())
    state.browserTransport ??= await startBrowserTransportServer(() => state.browserRuntime)
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url)) {
            void state.browserRuntime
                ?.command({ command: { name: "tabs.new" } })
                .then((created) => created.data.tab?.id
                    ? state.browserRuntime?.command({
                        command: { name: "tab.goto", url },
                        tabId: created.data.tab.id,
                    })
                    : undefined)
                .catch(() => undefined)
        }
        return { action: "deny" }
    })
    registerEditShortcuts(window)
    await loadRenderer(window)
    void state.overlayManager?.prewarm().catch((error: unknown) => console.error("预热桌面浮层失败:", error))
    return window
}

async function loadRenderer(window: BrowserWindowType) {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
        if (url.hostname === "localhost") url.hostname = "127.0.0.1"
        await window.loadURL(url.toString())
        window.webContents.openDevTools()
        return
    }

    await window.loadFile(join(BUNDLE_DIR, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
}

function configureApplicationMenu(iconPath: string | undefined) {
    if (process.platform === "win32") {
        Menu.setApplicationMenu(null)
        return
    }

    if (process.platform !== "darwin") return

    app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: APP_VERSION,
        iconPath,
        version: APP_VERSION,
    })

    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: APP_NAME,
            submenu: [
                { label: `About ${APP_NAME}`, role: "about" },
                { type: "separator" },
                { label: "Services", role: "services" },
                { type: "separator" },
                { label: `Hide ${APP_NAME}`, role: "hide" },
                { label: "Hide Others", role: "hideOthers" },
                { label: "Show All", role: "unhide" },
                { type: "separator" },
                { label: `Quit ${APP_NAME}`, role: "quit" },
            ],
        },
    ] satisfies MenuItemConstructorOptions[]))
}

function registerEditShortcuts(window: BrowserWindowType) {
    window.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown" || input.alt) return
        if (process.platform === "darwin" ? !input.meta : !input.control) return

        const key = input.key.toLowerCase()
        const command = key === "a" && !input.shift
            ? () => window.webContents.selectAll()
            : key === "c" && !input.shift
                ? () => window.webContents.copy()
                : key === "v" && !input.shift
                    ? () => window.webContents.paste()
                    : key === "x" && !input.shift
                        ? () => window.webContents.cut()
                        : key === "z"
                            ? input.shift
                                ? () => window.webContents.redo()
                                : () => window.webContents.undo()
                            : key === "y" && !input.shift && process.platform !== "darwin"
                                ? () => window.webContents.redo()
                                : undefined

        if (!command) return
        event.preventDefault()
        command()
    })
}

function isWebUrl(input: string) {
    return input.startsWith("https://") || input.startsWith("http://")
}
