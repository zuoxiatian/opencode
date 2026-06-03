import { existsSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEPRECATED_BUNDLED_SKILLS } from "../constants"
import { bundledSkillsDir, defaultOpencodeConfigPath } from "../resources/paths"

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

async function skillVersion(skillDir: string) {
    const file = join(skillDir, "SKILL.md")
    if (!existsSync(file)) return undefined

    const markdown = await readFile(file, "utf8")
    return metadataValue(markdown, "version") ?? frontmatterValue(markdown, "version")
}

function metadataValue(markdown: string, key: string) {
    const lines = frontmatterLines(markdown)
    if (!lines) return undefined

    const metadataIndex = lines.findIndex((item) => item.trim() === "metadata:")
    if (metadataIndex < 0) return undefined

    const afterMetadata = lines.slice(metadataIndex + 1)
    const nextTopLevel = afterMetadata.findIndex((item) => item.trim() && !item.match(/^\s/))
    const prefix = `${key}:`
    const line = (nextTopLevel < 0 ? afterMetadata : afterMetadata.slice(0, nextTopLevel)).find((item) =>
        item.trimStart().startsWith(prefix),
    )
    if (!line) return undefined

    return cleanFrontmatterValue(line.slice(line.indexOf(":") + 1))
}

function frontmatterValue(markdown: string, key: string) {
    const lines = frontmatterLines(markdown)
    if (!lines) return undefined

    const prefix = `${key}:`
    const line = lines.find((item) => !item.match(/^\s/) && item.startsWith(prefix))
    if (!line) return undefined

    return cleanFrontmatterValue(line.slice(line.indexOf(":") + 1))
}

function frontmatterLines(markdown: string) {
    if (!markdown.startsWith("---")) return undefined

    const end = markdown.indexOf("\n---", 3)
    if (end < 0) return undefined

    return markdown.slice(3, end).split(/\r?\n/)
}

function cleanFrontmatterValue(value: string) {
    return value.trim().replace(/^["']|["']$/g, "")
}

function compareSkillVersions(next: string | undefined, current: string | undefined) {
    const nextParts = versionParts(next)
    const currentParts = versionParts(current)
    const length = Math.max(nextParts.length, currentParts.length)

    return Array.from({ length })
        .map((_, index) => (nextParts[index] ?? 0) - (currentParts[index] ?? 0))
        .find((diff) => diff !== 0) ?? 0
}

function versionParts(version: string | undefined) {
    return (version ?? "0")
        .trim()
        .replace(/^v/i, "")
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map((part) => Number(part))
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
