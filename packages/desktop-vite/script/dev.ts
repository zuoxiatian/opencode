import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const env = { ...process.env }
const electronPath = require("electron")
const electronVersion = require("electron/package.json").version

delete env.ELECTRON_RUN_AS_NODE
env.ELECTRON_EXEC_PATH = electronPath
env.ELECTRON_MAJOR_VER = electronVersion.split(".")[0]

const proc = Bun.spawn({
    cmd: [
        path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "electron-vite.exe" : "electron-vite"),
        "dev",
    ],
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
})

process.exit(await proc.exited)
