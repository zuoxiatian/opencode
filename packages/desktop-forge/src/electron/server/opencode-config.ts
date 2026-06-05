import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export async function writeSyncedOpencodeConfig(config: unknown) {
    if (!isRecord(config)) throw new Error("模型配置不是 JSON 对象")
    await writeOpencodeConfigContent(`${JSON.stringify(config, null, 2)}\n`)
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

async function writeOpencodeConfigContent(content: string) {
    await mkdir(opencodeConfigDir(), { recursive: true })
    await writeFileForce(join(opencodeConfigDir(), "opencode.jsonc"), content)
}

function opencodeConfigDir() {
    return join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "config")
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
}

function clearWindowsReadonlyAttribute(file: string) {
    if (process.platform !== "win32") return
    spawnSync("attrib", ["-R", file], { stdio: "ignore", windowsHide: true })
}
