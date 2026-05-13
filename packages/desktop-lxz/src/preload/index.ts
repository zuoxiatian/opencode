import { contextBridge, ipcRenderer } from "electron"

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
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

// 类型声明
declare global {
    interface Window {
        electronAPI: ElectronAPI
    }
}
