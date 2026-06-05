import type { TitleBarOverlayOptions } from "electron"
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron"
import { existsSync, watch } from "node:fs"
import { readFile, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { applyWindowTheme, isThemeMode, writeStoredThemeMode } from "../window/theme"
import type { DirectoryWatchOptions, MainState, ThemeMode } from "../app/state"
import { startServer, stopServer } from "../server/opencode-server"
import { deleteInstalledSkill, installSkillPackage, listInstalledSkills, skillDirFor } from "../server/skill-market"
import type {
    SkillDeleteResult,
    SkillInstallRequest,
    SkillMarketOperation,
    SkillMarketOperationOptions,
    SkillMarketOperationSource,
    SkillMarketOperationType,
    SkillOperationResult,
} from "../../shared/skill-market"

type SkillMarketMutationResult = SkillOperationResult | SkillDeleteResult

const skillOperations = new Map<string, SkillMarketOperation>()

export function registerIpcHandlers(state: MainState) {
    ipcMain.handle("pick-directory", async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
        return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle("pick-file", async (_, options?: { multiple?: boolean }) => {
        const result = await dialog.showOpenDialog({
            properties: options?.multiple ? ["openFile", "multiSelections"] : ["openFile"],
        })
        return result.canceled ? null : options?.multiple ? result.filePaths : result.filePaths[0]
    })

    ipcMain.handle("save-file", async (_, options?: { defaultPath?: string }) => {
        const result = await dialog.showSaveDialog({ defaultPath: options?.defaultPath })
        return result.canceled ? null : result.filePath
    })

    ipcMain.handle("open-external", async (_, url: string) => {
        await shell.openExternal(url)
    })

    ipcMain.handle("open-path", async (_, targetPath: string) => {
        const error = await shell.openPath(targetPath)
        return error ? { error, success: false } : { success: true }
    })

    ipcMain.handle("restart", async () => {
        app.relaunch()
        app.exit(0)
    })

    ipcMain.handle("get-server-info", () => state.serverInfo)

    ipcMain.handle("start-server", async () => {
        if (state.serverInfo) return state.serverInfo
        const info = await startServer(state)
        state.serverInfo = info
        state.window?.webContents.send("server-ready", info)
        return info
    })

    ipcMain.handle("stop-server", () => {
        state.closeDirectoryWatchers()
        stopServer(state)
        return { success: true }
    })

    ipcMain.handle("set-title-bar-overlay", (event, options: TitleBarOverlayOptions) => {
        if (process.platform !== "win32") return
        BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(options)
    })

    ipcMain.handle("set-theme-mode", async (event, mode: ThemeMode) => {
        if (!isThemeMode(mode)) return

        await writeStoredThemeMode(mode)
        const window = BrowserWindow.fromWebContents(event.sender)
        if (window) applyWindowTheme(window, mode)
    })

    ipcMain.handle("read-directory", async (_, dirPath: string) =>
        readdir(dirPath, { withFileTypes: true })
            .then((entries) =>
                entries.map((entry) => ({
                    isDirectory: entry.isDirectory(),
                    name: entry.name,
                    path: join(dirPath, entry.name),
                })),
            )
            .catch((error: unknown) => {
                console.error("Failed to read directory:", error)
                return []
            }),
    )

    ipcMain.handle("watch-directory", (event, options: DirectoryWatchOptions) => {
        state.closeDirectoryWatcher(options.watcherID)

        return watchDirectory(state, event.sender, options)
            .then(() => ({ success: true }))
            .catch((error: unknown) => ({ error: String(error), success: false }))
    })

    ipcMain.handle("unwatch-directory", (_, watcherID: string) => {
        state.closeDirectoryWatcher(watcherID)
        return { success: true }
    })

    ipcMain.handle("read-file", async (_, filePath: string) =>
        readFile(filePath, "utf8")
            .then((content) => ({ content, success: true }))
            .catch((error: unknown) => ({ error: String(error), success: false })),
    )

    ipcMain.handle("read-file-base64", async (_, filePath: string) =>
        readFile(filePath)
            .then((buffer) => ({ base64: buffer.toString("base64"), success: true }))
            .catch((error: unknown) => ({ error: String(error), success: false })),
    )

    ipcMain.handle("delete-file", async (_, filePath: string) =>
        unlink(filePath)
            .then(() => ({ success: true }))
            .catch((error: unknown) => ({ error: String(error), success: false })),
    )

    ipcMain.handle("skill-market:list-installed", () => listInstalledSkills())

    ipcMain.handle("skill-market:list-operations", () => listSkillOperations())

    ipcMain.handle("skill-market:install", async (_, input: SkillInstallRequest, options?: SkillMarketOperationOptions) =>
        runSkillOperation(
            state,
            input.skillKey,
            installOperationType(input.skillKey),
            options?.source ?? "manual",
            () => installSkillPackage(input)
                .then((skill) => ({ skill, success: true } satisfies SkillOperationResult))
                .catch((error: unknown) => ({ error: errorMessage(error), success: false } satisfies SkillOperationResult)),
        ),
    )

    ipcMain.handle("skill-market:delete", async (_, skillKey: string, options?: SkillMarketOperationOptions) =>
        runSkillOperation(
            state,
            skillKey,
            options?.type === "archive-delete" ? "archive-delete" : "delete",
            options?.source ?? "manual",
            () => deleteInstalledSkill(skillKey)
                .then((deleted) => ({ skillKey: deleted, success: true } satisfies SkillDeleteResult))
                .catch((error: unknown) => ({ error: errorMessage(error), success: false } satisfies SkillDeleteResult)),
        ),
    )
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function listSkillOperations() {
    return [...skillOperations.values()]
}

async function runSkillOperation(
    state: MainState,
    skillKey: string,
    type: SkillMarketOperationType,
    source: SkillMarketOperationSource,
    task: () => Promise<SkillMarketMutationResult>,
) {
    if (skillOperations.has(skillKey)) return { error: "技能正在处理中", success: false }

    skillOperations.set(skillKey, {
        skillKey,
        source,
        startedAt: new Date().toISOString(),
        status: "running",
        type,
    })
    broadcastSkillOperations(state)

    return task()
        .finally(() => {
            skillOperations.delete(skillKey)
            broadcastSkillOperations(state)
        })
}

function broadcastSkillOperations(state: MainState) {
    if (!state.window || state.window.isDestroyed()) return
    state.window.webContents.send("skill-market:operations-changed", listSkillOperations())
}

function installOperationType(skillKey: string): SkillMarketOperationType {
    return existsSync(join(skillDirFor(skillKey), "SKILL.md")) ? "update" : "install"
}

async function watchDirectory(state: MainState, sender: Electron.WebContents, options: DirectoryWatchOptions) {
    const watcher = watch(options.path, { persistent: false }, (eventType, filename) => {
        if (sender.isDestroyed()) {
            state.closeDirectoryWatcher(options.watcherID)
            return
        }

        sender.send("directory-changed", {
            eventType,
            filename: filename?.toString() ?? null,
            path: options.path,
            watcherID: options.watcherID,
        })
    })

    watcher.on("error", (error) => {
        console.error("Failed to watch directory:", error)
        state.closeDirectoryWatcher(options.watcherID)
    })

    state.directoryWatchers.set(options.watcherID, watcher)
}
