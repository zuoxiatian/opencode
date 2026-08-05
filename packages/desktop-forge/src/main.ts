import { app } from "electron"
import started from "electron-squirrel-startup"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { APP_ID, APP_NAME } from "./electron/constants"
import { createMainState } from "./electron/app/state"
import { registerIpcHandlers } from "./electron/ipc"
import { createMainWindow } from "./electron/window/create-window"
import { stopServer } from "./electron/server/opencode-server"

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
    if (app.isPackaged) app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
    if (process.platform === "win32") app.setAppUserModelId(APP_ID)

    registerIpcHandlers(state)
    registerAppLifecycle()

    await app.whenReady()
    await openWindow()
    if (!app.isPackaged || !process.argv.includes("--desktop-forge-packaged-smoke")) return

    await writeFile(
        path.join(app.getPath("userData"), "desktop-forge-packaged-smoke.json"),
        `${JSON.stringify({
            browserRuntime: state.browserRuntime !== null,
            browserTransport: state.browserTransport !== null,
            ready: true,
        })}\n`,
    )
    state.window?.hide()
    app.quit()
}

function registerAppLifecycle() {
    app.on("activate", async () => {
        if (state.window && !state.window.isDestroyed()) return
        await openWindow()
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

    app.on("before-quit", (event) => {
        state.closeDirectoryWatchers()
        stopServer(state)
        const runtime = state.browserRuntime
        const pending = state.browserRuntimeDestroy
        if (!runtime && !pending) {
            state.browserTransport?.close()
            state.browserTransport = null
            return
        }

        event.preventDefault()
        state.browserRuntime = null
        state.browserRuntimeDestroy = null
        state.browserTransport?.close()
        state.browserTransport = null
        const finish = () => {
            state.browserRuntimeDestroy = null
            app.quit()
        }
        state.browserRuntimeDestroy = Promise.all([
            pending ?? Promise.resolve(),
            runtime?.destroy() ?? Promise.resolve(),
        ]).then(() => undefined)
        void state.browserRuntimeDestroy.then(finish, finish)
    })
}

async function openWindow() {
    state.window = await createMainWindow(state)
    if (state.serverInfo) state.window.webContents.send("server-ready", state.serverInfo)
}
