import { existsSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEPRECATED_BUNDLED_SKILLS } from "../constants"
import { bundledSkillsDir, defaultOpencodeConfigPath } from "../resources/paths"
import { compareSkillVersions, skillVersion } from "./skill-metadata"
import { isBundledSkillSuppressed } from "./skill-market"

export async function ensureDefaultOpencodeConfig() {
    const configDir = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "config")
    const source = defaultOpencodeConfigPath()

    if (!existsSync(source)) return

    await mkdir(configDir, { recursive: true })
    await writeFileForce(join(configDir, "opencode.jsonc"), await readFile(source, "utf8"))
}

export async function ensureBundledSkills() {
    const target = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz", "skills")
    await mkdir(target, { recursive: true })
    await Promise.all(
        DEPRECATED_BUNDLED_SKILLS.map((skill) => rm(join(target, skill), { recursive: true, force: true })),
    )

    const source = bundledSkillsDir()
    if (!existsSync(source)) return

    const skills = await readdir(source, { withFileTypes: true })
    await Promise.all(
        skills
            .filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, "SKILL.md")))
            .map(async (entry) => {
                const destination = join(target, entry.name)
                const skillSource = join(source, entry.name)
                if (await isBundledSkillSuppressed(entry.name)) return
                if (!(await shouldInstallBundledSkill(skillSource, destination))) return
                return cp(skillSource, destination, { recursive: true, force: true })
            }),
    )
}

async function shouldInstallBundledSkill(source: string, destination: string) {
    if (!existsSync(destination)) return true

    const sourceVersion = await skillVersion(source)
    if (!sourceVersion) return false

    return compareSkillVersions(sourceVersion, await skillVersion(destination)) > 0
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
