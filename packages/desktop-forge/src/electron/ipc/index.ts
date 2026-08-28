import type { MessageBoxOptions, TitleBarOverlayOptions } from "electron"
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from "electron"
import { existsSync, watch } from "node:fs"
import { readFile, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { applyWindowTheme, isThemeMode, resolveThemeMode, writeStoredThemeMode } from "../window/theme"
import type { DirectoryWatchOptions, MainState, ThemeMode } from "../app/state"
import { startServer, stopServer } from "../server/opencode-server"
import { deleteInstalledBundle, deleteInstalledSkill, installSkillPackage, listInstalledSkills, skillDirFor } from "../server/skill-market"
import type { ClientApiRequest, ClientApiResponse } from "../../shared/client-api"
import type { ClientAppInfo, ClientUpdatePrompt } from "../../shared/client-update"
import type {
    SkillDeleteResult,
    SkillInstallRequest,
    SkillMarketOperation,
    SkillMarketOperationOptions,
    SkillMarketOperationSource,
    SkillMarketOperationType,
    SkillOperationResult,
} from "../../shared/skill-market"
import type { BrowserBounds, BrowserCommandInput } from "../../shared/browser"
import { isBrowserDraftConversationId } from "../../shared/browser-conversation"
import type { DesktopToastInput, ModalOverlayContentSize, ModalOverlayInput, OverlayAction } from "../../shared/overlay"

type SkillMarketMutationResult = SkillOperationResult | SkillDeleteResult

const skillOperations = new Map<string, SkillMarketOperation>()

export function registerIpcHandlers(state: MainState) {
    ipcMain.handle("overlay:open", (event, input: ModalOverlayInput) => {
        assertMainWindowSender(state, event.sender)
        if (!isModalOverlayInput(input)) throw new Error("无效的浮层类型")
        state.overlayManager?.open(input)
    })

    ipcMain.handle("overlay:close", (event) => state.overlayManager?.closeModal(event.sender))

    ipcMain.handle("overlay:modal-ready", (event) => state.overlayManager?.readyModal(event.sender))

    ipcMain.handle("overlay:modal-rendered", (event, revision: number, contentSize?: ModalOverlayContentSize) => {
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("无效的弹框版本")
        if (contentSize && (
            !Number.isFinite(contentSize.width) || contentSize.width <= 0 ||
            !Number.isFinite(contentSize.height) || contentSize.height <= 0
        )) throw new Error("无效的弹框内容尺寸")
        state.overlayManager?.renderedModal(event.sender, revision, contentSize)
    })

    ipcMain.handle("overlay:action", (event, action: OverlayAction) => {
        state.overlayManager?.sendAction(event.sender, action)
    })

    ipcMain.handle("overlay:show-toast", (event, input: DesktopToastInput) => {
        assertAppWindowSender(state, event.sender)
        if (!input || typeof input.title !== "string") throw new Error("无效的提示内容")
        return state.overlayManager?.showToast(input)
    })

    ipcMain.handle("overlay:resize-toast", (event, revision: number, height: number) => {
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("无效的提示版本")
        if (!Number.isFinite(height)) throw new Error("无效的提示高度")
        state.overlayManager?.resizeToast(event.sender, revision, height)
    })

    ipcMain.handle("overlay:toast-ready", (event) => state.overlayManager?.readyToast(event.sender))

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
        if (!isWebUrl(url)) throw new Error("只允许打开 HTTP 或 HTTPS 链接")
        await shell.openExternal(url)
    })

    ipcMain.handle("browser:get-state", (event, conversationId: string) => {
        assertMainWindowSender(state, event.sender)
        if (!state.browserRuntime) throw new Error("内嵌浏览器当前不可用")
        return state.browserRuntime.getState(requireConversationId(conversationId))
    })

    ipcMain.handle("browser:dispose-conversation", (event, conversationId: string) => {
        assertMainWindowSender(state, event.sender)
        if (!state.browserRuntime) throw new Error("内嵌浏览器当前不可用")
        return state.browserRuntime.disposeConversation(requireConversationId(conversationId))
    })

    ipcMain.handle("browser:promote-conversation", (
        event,
        sourceConversationId: string,
        targetConversationId: string,
    ) => {
        assertMainWindowSender(state, event.sender)
        if (!state.browserRuntime) throw new Error("内嵌浏览器当前不可用")
        const source = requireConversationId(sourceConversationId)
        const target = requireConversationId(targetConversationId)
        if (!isBrowserDraftConversationId(source)) throw new Error("浏览器草稿 ID 无效")
        if (isBrowserDraftConversationId(target)) throw new Error("目标会话必须是真实会话")
        return state.browserRuntime.promoteConversation(source, target)
    })

    ipcMain.handle("browser:set-bounds", (event, bounds: BrowserBounds) => {
        assertMainWindowSender(state, event.sender)
        state.browserRuntime?.setLayoutBounds(bounds)
    })

    ipcMain.handle("browser:set-suspended", (event, suspended: boolean) => {
        assertMainWindowSender(state, event.sender)
        if (typeof suspended !== "boolean") throw new Error("浏览器暂停状态必须是布尔值")
        state.browserRuntime?.setSuspended(suspended)
    })

    ipcMain.handle("browser:sync-owner", (event, conversationId: string | null) => {
        assertMainWindowSender(state, event.sender)
        if (!state.browserRuntime) throw new Error("内嵌浏览器当前不可用")
        return state.browserRuntime.syncOwner(conversationId === null ? null : requireConversationId(conversationId))
    })

    ipcMain.handle("browser:command", (event, conversationId: string, command: BrowserCommandInput) => {
        assertMainWindowSender(state, event.sender)
        if (!state.browserRuntime) throw new Error("内嵌浏览器当前不可用")
        const id = requireConversationId(conversationId)
        if (state.browserRuntime.getActiveConversationId() !== id) {
            throw new Error("浏览器会话已经切换，请重试")
        }
        return state.browserRuntime.command(command, {
            actor: "renderer",
            conversationId: id,
            sessionId: "renderer",
        })
    })

    ipcMain.handle("client-api:request", (_, input: ClientApiRequest) => requestClientApi(input))

    ipcMain.handle("get-app-info", () => ({
        arch: clientReleaseArch(),
        platform: clientReleasePlatform(),
        version: app.getVersion(),
    } satisfies ClientAppInfo))

    ipcMain.handle("client-update:prompt", async (event, update: ClientUpdatePrompt) => {
        const result = await showClientUpdateDialog(event.sender, update)
        if (result.response !== clientUpdateActionButtonIndex(update)) return { action: "cancel" }

        await shell.openExternal(update.officialUrl)
        return { action: "open" }
    })

    ipcMain.handle("skill-sync:prompt-updated", (event) => showSkillUpdateReminderDialog(event.sender))

    ipcMain.handle("open-path", async (_, targetPath: string) => {
        const error = await shell.openPath(targetPath)
        return error ? { error, success: false } : { success: true }
    })

    ipcMain.handle("restart", async () => {
        app.relaunch()
        app.exit(0)
    })

    ipcMain.handle("get-server-info", () => state.serverInfo)

    ipcMain.handle("start-server", async (_, options?: { opencodeConfig?: unknown }) => {
        if (state.serverInfo) return state.serverInfo
        if (state.serverStartPromise) return state.serverStartPromise
        const pending = startServer(state, options?.opencodeConfig)
            .then((info) => {
                state.serverInfo = info
                state.window?.webContents.send("server-ready", info)
                return info
            })
            .finally(() => {
                if (state.serverStartPromise === pending) state.serverStartPromise = null
            })
        state.serverStartPromise = pending
        return pending
    })

    ipcMain.handle("check-server-health", () => checkServerHealth(state))

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
        if (!isThemeMode(mode)) throw new Error("无效主题模式")

        await writeStoredThemeMode(mode)
        const window = BrowserWindow.fromWebContents(event.sender)
        if (window) return applyWindowTheme(window, mode)
        if (state.overlayManager?.ownsWebContents(event.sender)) {
            nativeTheme.themeSource = mode
            return resolveThemeMode(mode)
        }
        throw new Error("无法定位主题窗口")
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
            skillInstallOperationKey(input),
            await installOperationType(input),
            options?.source ?? "manual",
            () => installSkillPackage(input)
                .then((skills) => ({ skills, success: true } satisfies SkillOperationResult))
                .catch((error: unknown) => ({ error: errorMessage(error), success: false } satisfies SkillOperationResult)),
        ),
    )

    ipcMain.handle("skill-market:delete", async (_, skillKey: string, options?: SkillMarketOperationOptions) =>
        runSkillOperation(
            state,
            options?.bundleKey ?? skillKey,
            options?.type === "archive-delete" ? "archive-delete" : "delete",
            options?.source ?? "manual",
            () => (options?.bundleKey
                ? deleteInstalledBundle(options.bundleKey, options.bundleSkillKeys)
                : deleteInstalledSkill(skillKey))
                .then((deleted) => ({ skillKey: deleted, success: true } satisfies SkillDeleteResult))
                .catch((error: unknown) => ({ error: errorMessage(error), success: false } satisfies SkillDeleteResult)),
        ),
    )
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function assertMainWindowSender(state: MainState, sender: Electron.WebContents) {
    if (!state.window || state.window.isDestroyed() || state.window.webContents !== sender) {
        throw new Error("拒绝非主窗口发起的浏览器操作")
    }
}

function assertAppWindowSender(state: MainState, sender: Electron.WebContents) {
    if (state.window?.webContents === sender) return
    if (state.overlayManager?.ownsWebContents(sender)) return
    throw new Error("拒绝未知窗口发起应用操作")
}

function isModalOverlayInput(input: ModalOverlayInput) {
    return Boolean(input && ["image-preview", "settings", "sidebar-dialog", "skill-market"].includes(input.kind))
}

function isWebUrl(input: string) {
    return input.startsWith("https://") || input.startsWith("http://")
}

function requireConversationId(input: unknown) {
    if (typeof input === "string" && input.trim()) return input
    throw new Error("浏览器命令缺少会话 ID")
}

async function requestClientApi(input: ClientApiRequest): Promise<ClientApiResponse> {
    const url = new URL(input.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Unsupported client API protocol: ${url.protocol}`)
    }

    const response = await fetch(url, {
        body: input.body,
        headers: new Headers(input.headers),
        method: input.method,
        signal: AbortSignal.timeout(30_000),
    })

    return {
        body: response.status === 204 || response.status === 304 ? null : await response.text(),
        headers: [...response.headers.entries()],
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
    }
}

function checkServerHealth(state: MainState) {
    return Boolean(state.serverInfo && isServerProcessRunning(state))
}

function isServerProcessRunning(state: MainState) {
    return Boolean(state.serverProcess && state.serverProcess.exitCode === null && state.serverProcess.signalCode === null)
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

async function installOperationType(input: SkillInstallRequest): Promise<SkillMarketOperationType> {
    if (input.recordType === "bundle") {
        return (await listInstalledSkills()).some((skill) => skill.bundleKey === skillInstallOperationKey(input)) ? "update" : "install"
    }
    return existsSync(join(skillDirFor(input.skillKey), "SKILL.md")) ? "update" : "install"
}

function skillInstallOperationKey(input: SkillInstallRequest) {
    if (input.recordType !== "bundle") return input.skillKey
    return input.bundleKey || input.bundleMeta?.bundleKey || input.skillKey
}

function showClientUpdateDialog(sender: Electron.WebContents, update: ClientUpdatePrompt) {
    const options: MessageBoxOptions = {
        buttons: update.forceUpdate ? ["去更新"] : ["取消", "去更新"],
        cancelId: 0,
        defaultId: clientUpdateActionButtonIndex(update),
        detail: [
            `当前版本：${update.currentVersion}`,
            update.title,
            update.changelog,
            update.minVersion ? `最低可升级版本：${update.minVersion}` : "",
        ].filter(Boolean).join("\n\n"),
        message: `${update.forceUpdate ? "发现必需更新" : "发现新版本"} ${update.version}`,
        noLink: true,
        title: "新版本更新",
        type: "info",
    }
    const window = BrowserWindow.fromWebContents(sender)
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

function clientUpdateActionButtonIndex(update: ClientUpdatePrompt) {
    return update.forceUpdate ? 0 : 1
}

function showSkillUpdateReminderDialog(sender: Electron.WebContents) {
    const options: MessageBoxOptions = {
        buttons: ["知道了"],
        cancelId: 0,
        defaultId: 0,
        detail: "历史对话可能仍在使用旧版本基础技能，可能影响当前业务处理效果。建议开启新对话窗口后再继续。",
        message: "基础技能已经更新",
        noLink: true,
        title: "基础技能更新",
        type: "none",
    }
    const window = BrowserWindow.fromWebContents(sender)
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

function clientReleasePlatform(): ClientAppInfo["platform"] {
    if (process.platform === "darwin") return "mac"
    if (process.platform === "win32") return "win"
    return null
}

function clientReleaseArch(): ClientAppInfo["arch"] {
    if (process.arch === "x64") return "x64"
    if (process.arch === "arm64") return "arm64"
    return null
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
