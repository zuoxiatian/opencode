import { app, dialog } from "electron"
import started from "electron-squirrel-startup"
import { APP_ID, APP_NAME } from "./electron/constants"
import { createMainState } from "./electron/app/state"
import { registerIpcHandlers } from "./electron/ipc"
import { createMainWindow } from "./electron/window/create-window"
import { startServer, stopServer } from "./electron/server/opencode-server"

const state = createMainState()

if (started) {
    app.quit()
} else {
    void bootstrap()
}

async function bootstrap() {
    if (!app.requestSingleInstanceLock()) {
        app.exit(0)
        process.exit(0)
    }

    app.setName(APP_NAME)
    app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
    if (process.platform === "win32") app.setAppUserModelId(APP_ID)

    registerIpcHandlers(state)
    registerAppLifecycle()

    await app.whenReady()
    await openWindowAndServer()
}

function registerAppLifecycle() {
    app.on("activate", async () => {
        if (state.window && !state.window.isDestroyed()) return
        await openWindowAndServer()
    })

    app.on("second-instance", () => {
        if (!state.window || state.window.isDestroyed()) return
        if (state.window.isMinimized()) state.window.restore()
        state.window.show()
        state.window.focus()
    })

    app.on("window-all-closed", () => {
        state.closeDirectoryWatchers()
        stopServer(state)
        if (process.platform !== "darwin") app.quit()
    })

    app.on("before-quit", () => {
        state.closeDirectoryWatchers()
        stopServer(state)
    })
}

async function openWindowAndServer() {
    state.window = await createMainWindow(state)
    await ensureServerReady()
}

async function ensureServerReady() {
    if (state.serverInfo) {
        state.window?.webContents.send("server-ready", state.serverInfo)
        return
    }

    await startServer(state)
        .then((info) => {
            state.serverInfo = info
            state.window?.webContents.send("server-ready", info)
        })
        .catch((error: unknown) => {
            console.error("Failed to start server:", error)
            dialog.showErrorBox("Startup failed", `Unable to start ${APP_NAME} server: ${String(error)}`)
        })
}
