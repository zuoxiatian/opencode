import { contextBridge, ipcRenderer } from "electron"

export interface DirectoryChangeEvent {
    path: string
    eventType: "rename" | "change"
    filename: string | null
}

interface DirectoryWatchResult {
    success: boolean
    error?: string
}

export interface ElectronAPI {
    onServerReady: (callback: (data: { url: string; password: string | null }) => void) => void
    getServerInfo: () => Promise<{ url: string; password: string | null } | null>
    pickDirectory: () => Promise<string | null>
    pickFile: (options?: { multiple?: boolean }) => Promise<string | string[] | null>
    saveFile: (options?: { defaultPath?: string }) => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<{ success: boolean; error?: string }>
    restart: () => Promise<void>
    readDirectory: (path: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
    readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>
    readFileBase64: (path: string) => Promise<{ success: boolean; base64?: string; error?: string }>
    deleteFile: (path: string) => Promise<{ success: boolean; error?: string }>
    setTitleBarOverlay: (options: { color: string; symbolColor: string }) => Promise<void>
    setThemeMode: (mode: "system" | "light" | "dark") => Promise<void>
    watchDirectory: (path: string, callback: (event: DirectoryChangeEvent) => void) => () => void
}

const electronAPI: ElectronAPI = {
    onServerReady: (callback) => {
        ipcRenderer.on("server-ready", (_, data) => callback(data))
    },

    getServerInfo: () => ipcRenderer.invoke("get-server-info"),

    pickDirectory: () => ipcRenderer.invoke("pick-directory"),

    pickFile: (options) => ipcRenderer.invoke("pick-file", options),

    saveFile: (options) => ipcRenderer.invoke("save-file", options),

    openExternal: (url) => ipcRenderer.invoke("open-external", url),

    openPath: (path) => ipcRenderer.invoke("open-path", path),

    restart: () => ipcRenderer.invoke("restart"),

    readDirectory: (path) => ipcRenderer.invoke("read-directory", path),

    readFile: (path) => ipcRenderer.invoke("read-file", path),

    readFileBase64: (path) => ipcRenderer.invoke("read-file-base64", path),

    deleteFile: (path) => ipcRenderer.invoke("delete-file", path),

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
            console.error("监听目录失败:", result.error)
        })

        return () => {
            ipcRenderer.removeListener("directory-changed", handler)
            void ipcRenderer.invoke("unwatch-directory", watcherID)
        }
    },
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

// 类型声明
declare global {
    interface Window {
        electronAPI: ElectronAPI
    }
}
