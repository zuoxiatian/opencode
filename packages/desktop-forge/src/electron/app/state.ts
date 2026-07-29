import type { BrowserWindow } from "electron"
import type { FSWatcher } from "node:fs"
import type { ChildProcess } from "node:child_process"
import type { BrowserRuntime } from "../browser/runtime"
import type { BrowserTransportServer } from "../browser/transport-server"

export interface ServerInfo {
    url: string
    password: string | null
    defaultDirectory: string
}

export interface DirectoryWatchOptions {
    path: string
    watcherID: string
}

export type ThemeMode = "system" | "light" | "dark"
export type ResolvedTheme = Exclude<ThemeMode, "system">

export interface MainState {
    browserRuntime: BrowserRuntime | null
    browserRuntimeDestroy: Promise<void> | null
    browserTransport: BrowserTransportServer | null
    cachedShellEnv: NodeJS.ProcessEnv | null
    closeDirectoryWatcher: (watcherID: string) => void
    closeDirectoryWatchers: () => void
    directoryWatchers: Map<string, FSWatcher>
    serverInfo: ServerInfo | null
    serverProcess: ChildProcess | null
    serverStartPromise: Promise<ServerInfo> | null
    shellEnvProbed: boolean
    window: BrowserWindow | null
}

export function createMainState(): MainState {
    const directoryWatchers = new Map<string, FSWatcher>()

    return {
        browserRuntime: null,
        browserRuntimeDestroy: null,
        browserTransport: null,
        cachedShellEnv: null,
        closeDirectoryWatcher: (watcherID) => {
            directoryWatchers.get(watcherID)?.close()
            directoryWatchers.delete(watcherID)
        },
        closeDirectoryWatchers: () => {
            directoryWatchers.forEach((watcher) => watcher.close())
            directoryWatchers.clear()
        },
        directoryWatchers,
        serverInfo: null,
        serverProcess: null,
        serverStartPromise: null,
        shellEnvProbed: false,
        window: null,
    }
}
