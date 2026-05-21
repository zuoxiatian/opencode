import type { BrowserWindow as BrowserWindowType, MenuItemConstructorOptions, TitleBarOverlayOptions } from "electron"
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from "electron"
import { existsSync, watch, type FSWatcher } from "fs"
import { delimiter, join } from "path"
import { spawn, ChildProcess } from "child_process"
import { fileURLToPath } from "url"
import { cp, mkdir, readFile, readdir, writeFile } from "fs/promises"
import { homedir } from "os"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

const APP_ID = "ai.opencode.desktop"
const APP_NAME = "LongwiseTechAgent"
const APP_VERSION = "1.0.0"

let mainWindow: BrowserWindowType | null = null
let serverProcess: ChildProcess | null = null
let serverInfo: ServerInfo | null = null
const directoryWatchers = new Map<string, FSWatcher>()

app.setName(APP_NAME)
if (process.platform === "win32") {
    app.setAppUserModelId(APP_ID)
}

interface ServerInfo {
    url: string
    password: string | null
}

interface DirectoryWatchOptions {
    path: string
    watcherID: string
}

type ThemeMode = "system" | "light" | "dark"
type ResolvedTheme = Exclude<ThemeMode, "system">

function isThemeMode(value: string): value is ThemeMode {
    return value === "system" || value === "light" || value === "dark"
}

function themeModePath() {
    return join(app.getPath("userData"), "theme-mode.txt")
}

async function readStoredThemeMode(): Promise<ThemeMode> {
    if (!existsSync(themeModePath())) return "system"

    const value = (await readFile(themeModePath(), "utf8")).trim()
    if (isThemeMode(value)) return value
    return "system"
}

async function writeStoredThemeMode(mode: ThemeMode) {
    await mkdir(app.getPath("userData"), { recursive: true })
    await writeFile(themeModePath(), mode)
}

function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
    if (mode !== "system") return mode
    return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function windowThemeColors(theme: ResolvedTheme) {
    if (theme === "light") {
        return {
            backgroundColor: "#ffffff",
            symbolColor: "#1a1b1f",
        }
    }

    return {
        backgroundColor: "#181818",
        symbolColor: "#d4d4d4",
    }
}

function getRepoRoot() {
    return join(__dirname, "..", "..", "..", "..")
}

function closeDirectoryWatcher(watcherID: string) {
    directoryWatchers.get(watcherID)?.close()
    directoryWatchers.delete(watcherID)
}

function closeDirectoryWatchers() {
    directoryWatchers.forEach((watcher) => watcher.close())
    directoryWatchers.clear()
}

function getBunCommand() {
    if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH

    if (process.platform === "win32") {
        const candidates = [
            process.env.LOCALAPPDATA
                ? join(
                    process.env.LOCALAPPDATA,
                    "Microsoft",
                    "WinGet",
                    "Packages",
                    "Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe",
                    "bun-windows-x64",
                    "bun.exe",
                )
                : "",
            process.env.USERPROFILE ? join(process.env.USERPROFILE, ".bun", "bin", "bun.exe") : "",
        ].filter(Boolean)

        const match = candidates.find((path) => existsSync(path))
        if (match) return match
        return "bun.exe"
    }

    return "bun"
}

function getAppIconPath() {
    const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png"
    const iconPath = process.env.NODE_ENV === "development"
        ? join(getRepoRoot(), "packages", "desktop-lxz", "build", iconFile)
        : join(process.resourcesPath, iconFile)

    if (existsSync(iconPath)) return iconPath
    return undefined
}

function configureApplicationMenu(appIconPath: string | undefined) {
    if (process.platform === "win32") {
        Menu.setApplicationMenu(null)
        return
    }

    if (process.platform !== "darwin") return

    app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: APP_VERSION,
        version: APP_VERSION,
        iconPath: appIconPath,
    })

    const template: MenuItemConstructorOptions[] = [
        {
            label: APP_NAME,
            submenu: [
                { label: `关于 ${APP_NAME}`, role: "about" },
                { type: "separator" },
                { label: "服务", role: "services" },
                { type: "separator" },
                { label: `隐藏 ${APP_NAME}`, role: "hide" },
                { label: "隐藏其他", role: "hideOthers" },
                { label: "全部显示", role: "unhide" },
                { type: "separator" },
                { label: `退出 ${APP_NAME}`, role: "quit" },
            ],
        },
    ]

    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

async function ensureDefaultOpencodeConfig() {
    const configDir = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "config")
    const configFiles = ["opencode.jsonc", "opencode.json", "config.json"].map((file) => join(configDir, file))

    if (configFiles.some((file) => existsSync(file))) return

    await mkdir(configDir, { recursive: true })
    await writeFile(configFiles[0], await readFile(defaultOpencodeConfigPath(), "utf8"))
}

function defaultOpencodeConfigPath() {
    return process.env.NODE_ENV === "development"
        ? join(getRepoRoot(), "packages", "desktop-lxz", "config", "opencode.jsonc")
        : join(process.resourcesPath, "config", "opencode.jsonc")
}

function bundledSkillsDir() {
    return process.env.NODE_ENV === "development"
        ? join(getRepoRoot(), "packages", "desktop-lxz", "skills")
        : join(process.resourcesPath, "skills")
}

function bundledRuntimeDir() {
    return process.env.NODE_ENV === "development"
        ? join(getRepoRoot(), "packages", "desktop-lxz", "runtimes", `${process.platform}-${process.arch}`)
        : join(process.resourcesPath, "runtimes", `${process.platform}-${process.arch}`)
}

function runtimeExecutable(dir: string, name: "node" | "python") {
    return (
        process.platform === "win32"
            ? [
                join(dir, name, `${name}.exe`),
                join(dir, "bin", `${name}.exe`),
                join(dir, "bin", `${name}.cmd`),
            ]
            : [
                join(dir, name, "bin", name),
                ...(name === "python" ? [join(dir, "python", "bin", "python3")] : []),
                join(dir, "bin", name),
            ]
    ).find((item) => existsSync(item))
}

function runtimePathDirs(dir: string) {
    return [
        join(dir, "bin"),
        join(dir, "node"),
        join(dir, "node", "bin"),
        join(dir, "python"),
        join(dir, "python", "bin"),
        process.platform === "win32" ? join(dir, "python", "Scripts") : undefined,
    ].filter((item): item is string => !!item && existsSync(item))
}

function runtimeEnv() {
    const dir = bundledRuntimeDir()
    if (!existsSync(dir)) return {}

    const node = runtimeExecutable(dir, "node")
    const python = runtimeExecutable(dir, "python")

    return {
        OPENCODE_RUNTIME_DIR: dir,
        OPENCODE_NODE: node,
        OPENCODE_PYTHON: python,
        PYTHONHOME: process.platform === "win32"
            ? undefined
            : existsSync(join(dir, "python"))
                ? join(dir, "python")
                : undefined,
        PIP_INDEX_URL: process.env.PIP_INDEX_URL ?? "https://pypi.tuna.tsinghua.edu.cn/simple",
        PIP_TRUSTED_HOST: process.env.PIP_TRUSTED_HOST ?? "pypi.tuna.tsinghua.edu.cn",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        npm_config_registry: process.env.npm_config_registry ?? "https://registry.npmmirror.com",
        BUN_CONFIG_REGISTRY: process.env.BUN_CONFIG_REGISTRY ?? "https://registry.npmmirror.com",
        NoDefaultCurrentDirectoryInExePath: process.platform === "win32" ? "1" : undefined,
        PYTHONUTF8: process.platform === "win32" ? "1" : undefined,
        PYTHONIOENCODING: process.platform === "win32" ? "utf-8" : undefined,
        npm_config_unicode: process.platform === "win32" ? "true" : undefined,
        PYTHONPATH: "",
        PYTHONNOUSERSITE: "1",
        PATH: [...runtimePathDirs(dir), process.env.PATH ?? ""].join(delimiter),
    }
}

async function ensureBundledSkills() {
    const source = bundledSkillsDir()
    if (!existsSync(source)) return

    const target = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "skills")
    await mkdir(target, { recursive: true })

    const skills = await readdir(source, { withFileTypes: true })
    await Promise.all(
        skills
            .filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, "SKILL.md")))
            .map((entry) => {
                const destination = join(target, entry.name)
                if (existsSync(destination)) return Promise.resolve()
                return cp(join(source, entry.name), destination, { recursive: true, force: false })
            }),
    )
}

/**
 * 启动 OpenCode 服务器
 */
async function startServer(): Promise<ServerInfo> {
    await ensureDefaultOpencodeConfig()
    await ensureBundledSkills()

    return new Promise((resolve, reject) => {
        const isDev = process.env.NODE_ENV === "development"
        let opencodeCmd: string
        let args: string[]

        // 生成随机密码
        const password = Math.random().toString(36).substring(2, 15)

        if (isDev) {
            const repoRoot = getRepoRoot()
            opencodeCmd = getBunCommand()
            args = ["run", "--cwd", join(repoRoot, "packages", "opencode"), "--conditions=browser", "src/index.ts", "serve"]
        } else {
            const binDir = join(process.resourcesPath, "bin")
            opencodeCmd = process.platform === "win32"
                ? join(binDir, "opencode.exe")
                : join(binDir, "opencode")
            args = ["serve"]
        }

        console.log("Starting server:", opencodeCmd, args)

        // 确定工作目录
        const cwd = isDev ? getRepoRoot() : app.getPath("userData")

        // 在 Windows 上直接调用 bun.exe
        serverProcess = spawn(opencodeCmd, args, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd,
            // 不使用 shell，直接执行 bun.cmd
            env: {
                ...process.env,
                ...runtimeEnv(),
                OPENCODE_AUTO_UPDATE: "false",
                OPENCODE_SERVER_PASSWORD: password,
                // 确保 Windows 系统环境变量存在
                ComSpec: process.env.ComSpec || "C:\\WINDOWS\\system32\\cmd.exe",
                SystemRoot: process.env.SystemRoot || "C:\\WINDOWS",
            },
        })

        let output = ""
        let serverUrl = ""

        serverProcess.stdout?.on("data", (data) => {
            const text = data.toString()
            output += text
            console.log("Server stdout:", text)

            // 从输出中解析服务器 URL
            const match = text.match(/listening on (http:\/\/[^\s]+)/)
            if (match && match[1]) {
                serverUrl = match[1].trim()
                console.log("检测到服务器 URL:", serverUrl)
            }
        })

        serverProcess.stderr?.on("data", (data) => {
            console.error("Server stderr:", data.toString())
        })

        serverProcess.on("error", (err) => {
            console.error("Failed to start server:", err)
            reject(err)
        })

        serverProcess.on("exit", (code) => {
            console.log("Server exited with code:", code)
            if (code !== 0 && code !== null) {
                reject(new Error(`Server exited with code ${code}`))
            }
        })

        // 使用轮询方式检测服务器是否启动
        let attempts = 0
        const maxAttempts = 60 // 60秒超时

        const checkServer = async () => {
            attempts++

            // 如果还没有从 stdout 获取到 URL，使用默认的
            const urlToCheck = serverUrl || "http://127.0.0.1:4096"
            console.log(`检查服务器状态 (${attempts}/${maxAttempts}): ${urlToCheck}`)

            try {
                const response = await fetch(urlToCheck, { method: "HEAD" })
                console.log(`服务器响应状态: ${response.status}`)
                if (response.ok || response.status === 401) {
                    // 服务器启动成功
                    console.log("Server ready:", urlToCheck)
                    resolve({
                        url: urlToCheck,
                        password,
                    })
                    return
                }
            } catch (e) {
                // 服务器还没启动，继续等待
                console.log(`服务器未就绪，继续等待...`)
            }

            if (attempts >= maxAttempts) {
                reject(new Error("Server startup timeout"))
                return
            }

            // 继续轮询
            setTimeout(checkServer, 1000)
        }

        // 等 3 秒后开始轮询
        setTimeout(checkServer, 3000)
    })
}

/**
 * 创建主窗口
 */
async function createWindow() {
    const appIconPath = getAppIconPath()
    const isWindows = process.platform === "win32"
    const startupThemeMode = await readStoredThemeMode()
    nativeTheme.themeSource = startupThemeMode
    const startupColors = windowThemeColors(resolveThemeMode(startupThemeMode))

    if (process.platform === "darwin" && appIconPath) {
        app.dock.setIcon(appIconPath)
    }

    configureApplicationMenu(appIconPath)

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: APP_NAME,
        icon: appIconPath,
        frame: isWindows,
        autoHideMenuBar: isWindows,
        titleBarStyle: "hidden" as const,
        ...(isWindows
            ? {
                titleBarOverlay: {
                    color: "rgba(0, 0, 0, 0)",
                    symbolColor: startupColors.symbolColor,
                },
            }
            : {
                trafficLightPosition: { x: 19, y: 19 },
                titleBarOverlay: {
                    color: startupColors.backgroundColor,
                    symbolColor: startupColors.symbolColor,
                    height: 52,
                },
            }),
        backgroundColor: startupColors.backgroundColor,
        webPreferences: {
            preload: join(__dirname, "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: process.env.NODE_ENV !== "development", // 开发模式下禁用以绕过 CORS
        },
        show: true,
    })

    mainWindow.on("ready-to-show", () => {
        mainWindow?.show()
    })

    mainWindow.on("closed", () => {
        closeDirectoryWatchers()
        mainWindow = null
    })

    registerEditShortcuts(mainWindow)

    // 先加载页面
    if (process.env.NODE_ENV === "development") {
        await mainWindow.loadURL("http://localhost:5173")
        mainWindow.webContents.openDevTools()
    } else {
        await mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
    }

    // 然后启动服务器
    try {
        serverInfo = await startServer()
        console.log("Sending server-ready event:", serverInfo)
        // 页面已加载完成，直接发送事件
        mainWindow.webContents.send("server-ready", serverInfo)
    } catch (err) {
        console.error("Failed to start server:", err)
        dialog.showErrorBox("启动失败", `无法启动 LongwiseTechAgent 服务器: ${err}`)
    }
}

// IPC 处理
ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
    })
    return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle("pick-file", async (_, options?: { multiple?: boolean }) => {
    const result = await dialog.showOpenDialog({
        properties: options?.multiple ? ["openFile", "multiSelections"] : ["openFile"],
    })
    return result.canceled ? null : (options?.multiple ? result.filePaths : result.filePaths[0])
})

ipcMain.handle("save-file", async (_, options?: { defaultPath?: string }) => {
    const result = await dialog.showSaveDialog({
        defaultPath: options?.defaultPath,
    })
    return result.canceled ? null : result.filePath
})

ipcMain.handle("open-external", async (_, url: string) => {
    await shell.openExternal(url)
})

ipcMain.handle("open-path", async (_, targetPath: string) => {
    const error = await shell.openPath(targetPath)
    return error ? { success: false, error } : { success: true }
})

ipcMain.handle("restart", async () => {
    app.relaunch()
    app.exit(0)
})

ipcMain.handle("get-server-info", () => {
    return serverInfo
})

ipcMain.handle("set-title-bar-overlay", (event, options: TitleBarOverlayOptions) => {
    if (process.platform !== "win32") return
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(options)
})

ipcMain.handle("set-theme-mode", async (event, mode: ThemeMode) => {
    if (!isThemeMode(mode)) return

    await writeStoredThemeMode(mode)
    nativeTheme.themeSource = mode
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(windowThemeColors(resolveThemeMode(mode)).backgroundColor)
})

ipcMain.handle("read-directory", async (_, dirPath: string) => {
    try {
        const entries = await readdir(dirPath, { withFileTypes: true })
        const files = entries.map((entry) => ({
            name: entry.name,
            path: join(dirPath, entry.name),
            isDirectory: entry.isDirectory(),
        }))
        return files
    } catch (error) {
        console.error("读取目录失败:", error)
        return []
    }
})

ipcMain.handle("watch-directory", (event, options: DirectoryWatchOptions) => {
    closeDirectoryWatcher(options.watcherID)
    try {
        const watcher = watch(options.path, { persistent: false }, (eventType, filename) => {
            if (event.sender.isDestroyed()) {
                closeDirectoryWatcher(options.watcherID)
                return
            }
            event.sender.send("directory-changed", {
                watcherID: options.watcherID,
                path: options.path,
                eventType,
                filename: filename?.toString() ?? null,
            })
        })
        watcher.on("error", (error) => {
            console.error("监听目录失败:", error)
            closeDirectoryWatcher(options.watcherID)
        })
        directoryWatchers.set(options.watcherID, watcher)
        return { success: true }
    } catch (error) {
        console.error("监听目录失败:", error)
        return { success: false, error: String(error) }
    }
})

ipcMain.handle("unwatch-directory", (_, watcherID: string) => {
    closeDirectoryWatcher(watcherID)
    return { success: true }
})

ipcMain.handle("read-file", async (_, filePath: string) => {
    try {
        const { readFile } = await import("fs/promises")
        const content = await readFile(filePath, "utf-8")
        return { success: true, content }
    } catch (error) {
        console.error("读取文件失败:", error)
        return { success: false, error: String(error) }
    }
})

ipcMain.handle("read-file-base64", async (_, filePath: string) => {
    try {
        const { readFile } = await import("fs/promises")
        const buffer = await readFile(filePath)
        const base64 = buffer.toString("base64")
        return { success: true, base64 }
    } catch (error) {
        console.error("读取文件失败:", error)
        return { success: false, error: String(error) }
    }
})

ipcMain.handle("delete-file", async (_, filePath: string) => {
    try {
        const { unlink } = await import("fs/promises")
        await unlink(filePath)
        console.log("删除文件成功:", filePath)
        return { success: true }
    } catch (error) {
        console.error("删除文件失败:", error)
        return { success: false, error: String(error) }
    }
})

// 应用生命周期
app.whenReady().then(createWindow)

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

app.on("window-all-closed", () => {
    closeDirectoryWatchers()
    if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
    }

    if (process.platform !== "darwin") {
        app.quit()
    }
})

app.on("before-quit", () => {
    closeDirectoryWatchers()
    if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
    }
})
