import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { defaultOpencodeConfigPath } from "../resources/paths"

export async function ensureDefaultOpencodeConfig() {
    const configDir = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "config")
    const source = defaultOpencodeConfigPath()

    if (!existsSync(source)) return

    await mkdir(configDir, { recursive: true })
    await writeFileForce(join(configDir, "opencode.jsonc"), await readFile(source, "utf8"))
}

function permissionError(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error
        && (error.code === "EPERM" || error.code === "EACCES")
}

async function writeFileForce(file: string, content: string) {
    return writeFile(file, content).catch(async (error: unknown) => {
        if (!permissionError(error)) throw error
        clearWindowsReadonlyAttribute(file)
        return writeFile(file, content)
    })
}

function clearWindowsReadonlyAttribute(file: string) {
    if (process.platform !== "win32") return
    spawnSync("attrib", ["-R", file], { stdio: "ignore", windowsHide: true })
}
