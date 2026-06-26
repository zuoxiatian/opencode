import { contextBridge, ipcRenderer } from "electron"
import type {
    InstalledSkill,
    SkillDeleteResult,
    SkillInstallRequest,
    SkillMarketOperation,
    SkillMarketOperationOptions,
    SkillOperationResult,
} from "./shared/skill-market"
import type { ClientApiRequest, ClientApiResponse } from "./shared/client-api"
import type { ClientAppInfo, ClientUpdatePrompt } from "./shared/client-update"

export interface DirectoryChangeEvent {
    path: string
    eventType: "rename" | "change"
    filename: string | null
}

interface DirectoryWatchResult {
    success: boolean
    error?: string
}

interface ServerInfo {
    url: string
    password: string | null
    defaultDirectory: string
}

export interface ElectronAPI {
    onServerReady: (callback: (data: ServerInfo) => void) => void
    getServerInfo: () => Promise<ServerInfo | null>
    startServer: (options: { opencodeConfig: unknown }) => Promise<ServerInfo>
    checkServerHealth: () => Promise<boolean>
    stopServer: () => Promise<{ success: boolean }>
    pickDirectory: () => Promise<string | null>
    pickFile: (options?: { multiple?: boolean }) => Promise<string | string[] | null>
    saveFile: (options?: { defaultPath?: string }) => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    clientApiRequest: (input: ClientApiRequest) => Promise<ClientApiResponse>
    getAppInfo: () => Promise<ClientAppInfo>
    promptClientUpdate: (update: ClientUpdatePrompt) => Promise<{ action: "cancel" | "open" }>
    promptSkillUpdateReminder: () => Promise<void>
    openPath: (path: string) => Promise<{ success: boolean; error?: string }>
    restart: () => Promise<void>
    readDirectory: (path: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
    readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>
    readFileBase64: (path: string) => Promise<{ success: boolean; base64?: string; error?: string }>
    deleteFile: (path: string) => Promise<{ success: boolean; error?: string }>
    listInstalledSkills: () => Promise<InstalledSkill[]>
    listSkillOperations: () => Promise<SkillMarketOperation[]>
    onSkillOperationsChanged: (callback: (operations: SkillMarketOperation[]) => void) => () => void
    installSkill: (input: SkillInstallRequest, options?: SkillMarketOperationOptions) => Promise<SkillOperationResult>
    deleteSkill: (skillKey: string, options?: SkillMarketOperationOptions) => Promise<SkillDeleteResult>
    setTitleBarOverlay: (options: { color: string; symbolColor: string }) => Promise<void>
    setThemeMode: (mode: "system" | "light" | "dark") => Promise<void>
    watchDirectory: (path: string, callback: (event: DirectoryChangeEvent) => void) => () => void
}

const electronAPI: ElectronAPI = {
    onServerReady: (callback) => {
        ipcRenderer.on("server-ready", (_, data) => callback(data))
    },

    getServerInfo: () => ipcRenderer.invoke("get-server-info"),

    startServer: (options) => ipcRenderer.invoke("start-server", options),

    checkServerHealth: () => ipcRenderer.invoke("check-server-health"),

    stopServer: () => ipcRenderer.invoke("stop-server"),

    pickDirectory: () => ipcRenderer.invoke("pick-directory"),

    pickFile: (options) => ipcRenderer.invoke("pick-file", options),

    saveFile: (options) => ipcRenderer.invoke("save-file", options),

    openExternal: (url) => ipcRenderer.invoke("open-external", url),

    clientApiRequest: (input) => ipcRenderer.invoke("client-api:request", input),

    getAppInfo: () => ipcRenderer.invoke("get-app-info"),

    promptClientUpdate: (update) => ipcRenderer.invoke("client-update:prompt", update),

    promptSkillUpdateReminder: () => ipcRenderer.invoke("skill-sync:prompt-updated"),

    openPath: (path) => ipcRenderer.invoke("open-path", path),

    restart: () => ipcRenderer.invoke("restart"),

    readDirectory: (path) => ipcRenderer.invoke("read-directory", path),

    readFile: (path) => ipcRenderer.invoke("read-file", path),

    readFileBase64: (path) => ipcRenderer.invoke("read-file-base64", path),

    deleteFile: (path) => ipcRenderer.invoke("delete-file", path),

    listInstalledSkills: () => ipcRenderer.invoke("skill-market:list-installed"),

    listSkillOperations: () => ipcRenderer.invoke("skill-market:list-operations"),

    onSkillOperationsChanged: (callback) => {
        const handler = (_: unknown, operations: SkillMarketOperation[]) => callback(operations)
        ipcRenderer.on("skill-market:operations-changed", handler)
        return () => ipcRenderer.removeListener("skill-market:operations-changed", handler)
    },

    installSkill: (input, options) => ipcRenderer.invoke("skill-market:install", input, options),

    deleteSkill: (skillKey, options) => ipcRenderer.invoke("skill-market:delete", skillKey, options),

    setTitleBarOverlay: (options) => ipcRenderer.invoke("set-title-bar-overlay", options),

    setThemeMode: (mode) => ipcRenderer.invoke("set-theme-mode", mode),

    watchDirectory: (path, callback) => {
        const watcherID = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const handler = (_: unknown, event: DirectoryChangeEvent & { watcherID: string }) => {
            if (event.watcherID !== watcherID) return
            callback({
                path: event.path,
                eventType: event.eventType,
                filename: event.filename,
            })
        }

        ipcRenderer.on("directory-changed", handler)
        void ipcRenderer.invoke("watch-directory", { path, watcherID }).then((result: DirectoryWatchResult) => {
            if (result.success) return
            console.error("Failed to watch directory:", result.error)
        })

        return () => {
            ipcRenderer.removeListener("directory-changed", handler)
            void ipcRenderer.invoke("unwatch-directory", watcherID)
        }
    },
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

declare global {
    interface Window {
        electronAPI: ElectronAPI
    }
}
