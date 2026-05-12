import type { BrowserWindow as BrowserWindowType } from "electron"
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron"
import { existsSync } from "fs"
import { join } from "path"
import { spawn, ChildProcess } from "child_process"
import { fileURLToPath } from "url"
import { cp, mkdir, readFile, readdir, writeFile } from "fs/promises"
import { homedir } from "os"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

let mainWindow: BrowserWindowType | null = null
let serverProcess: ChildProcess | null = null
let serverInfo: ServerInfo | null = null

interface ServerInfo {
    url: string
    password: string | null
}

function getRepoRoot() {
    return join(__dirname, "..", "..", "..", "..")
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
    const iconPath = process.env.NODE_ENV === "development"
        ? join(getRepoRoot(), "packages", "desktop-lxz", "build", "icon.png")
        : join(process.resourcesPath, "icon.png")

    if (existsSync(iconPath)) return iconPath
    return undefined
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
                OPENCODE_AUTO_UPDATE: "false",
                OPENCODE_SERVER_PASSWORD: password,
                // 确保 Windows 系统环境变量存在
                ComSpec: process.env.ComSpec || "C:\\WINDOWS\\system32\\cmd.exe",
                SystemRoot: process.env.SystemRoot || "C:\\WINDOWS",
                PATH: process.env.PATH || "",
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

    if (process.platform === "darwin" && appIconPath) {
        app.dock.setIcon(appIconPath)
    }

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: "LongwiseTechAgent",
        icon: appIconPath,
        // 使用无边框窗口 + 自定义控件覆盖
        frame: false,
        titleBarStyle: "hidden",
        titleBarOverlay: {
            color: "#08080d",
            symbolColor: "#9ca3af",
            height: 32,
        },
        backgroundColor: "#08080d",
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
        mainWindow = null
    })

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

ipcMain.handle("restart", async () => {
    app.relaunch()
    app.exit(0)
})

ipcMain.handle("get-server-info", () => {
    return serverInfo
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
    if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
    }

    if (process.platform !== "darwin") {
        app.quit()
    }
})

app.on("before-quit", () => {
    if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
    }
})
