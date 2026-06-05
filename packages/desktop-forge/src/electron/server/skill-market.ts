import extractZip from "extract-zip"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path, { join } from "node:path"
import { readSkillMetadata } from "./skill-metadata"
import type { InstalledSkill, SkillInstallRequest, SkillSource } from "../../shared/skill-market"

interface SkillMarketState {
    version: 1
    skills: Record<string, SkillStateRecord>
}

interface SkillStateRecord {
    skillKey: string
    source: SkillSource
    enabled: boolean
    version?: string
    sha256?: string
    fileName?: string
    fileSize?: number
    downloadUrl?: string
    installedAt?: string
    updatedAt?: string
    deletedAt?: string
    skillID?: number
}

const safeSkillKeyPattern = /^[a-zA-Z0-9._-]+$/

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
    await mkdir(skillsRootDir(), { recursive: true })

    const state = await readSkillMarketState()
    const entries = await readdir(skillsRootDir(), { withFileTypes: true }).catch(() => [])
    const skills = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && existsSync(join(skillsRootDir(), entry.name, "SKILL.md")))
            .map((entry) => installedSkillFromDirectory(entry.name, state)),
    )

    return skills.toSorted((a, b) => a.name.localeCompare(b.name))
}

export async function installSkillPackage(input: SkillInstallRequest) {
    validateSkillInstallRequest(input)

    await mkdir(skillsRootDir(), { recursive: true })
    await mkdir(skillMarketCacheDir(), { recursive: true })

    const workDir = await mkdtemp(join(skillMarketCacheDir(), `${input.skillKey}-`))
    const zipPath = join(workDir, input.fileName || `${input.skillKey}.zip`)
    const extractDir = join(workDir, "extract")

    return downloadPackage(input, zipPath)
        .then(() => mkdir(extractDir, { recursive: true }))
        .then(() => extractZip(zipPath, { dir: extractDir, onEntry: validateZipEntry }))
        .then(() => resolveExtractedSkillDir(extractDir, input))
        .then((skillDir) => validateExtractedSkill(skillDir, input).then(() => skillDir))
        .then((skillDir) => replaceSkillDirectory(skillDir, skillDirFor(input.skillKey)))
        .then(() => writeInstalledState(input))
        .then(() => installedSkillByKey(input.skillKey))
        .finally(() => rm(workDir, { recursive: true, force: true }))
}

export async function deleteInstalledSkill(skillKey: string) {
    validateSkillKey(skillKey)

    const location = skillDirFor(skillKey)
    if (!existsSync(join(location, "SKILL.md"))) throw new Error("技能不存在")

    const state = await readSkillMarketState()
    const record = state.skills[skillKey]

    await rm(location, { recursive: true, force: true })
    state.skills[skillKey] = {
        ...record,
        deletedAt: new Date().toISOString(),
        enabled: false,
        skillKey,
        source: skillSource(record?.source),
    }
    await writeSkillMarketState(state)

    return skillKey
}

export function skillDirFor(skillKey: string) {
    validateSkillKey(skillKey)
    return join(skillsRootDir(), skillKey)
}

function lxzRootDir() {
    return join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".lxz")
}

function skillsRootDir() {
    return join(lxzRootDir(), "skills")
}

function skillMarketStatePath() {
    return join(lxzRootDir(), "state", "skill-market.json")
}

function skillMarketCacheDir() {
    return join(lxzRootDir(), "cache", "skill-market")
}

async function installedSkillByKey(skillKey: string) {
    return (await listInstalledSkills()).find((item) => item.skillKey === skillKey)
        ?? (() => { throw new Error("技能安装后未找到") })()
}

async function installedSkillFromDirectory(skillKey: string, state: SkillMarketState): Promise<InstalledSkill> {
    const location = skillDirFor(skillKey)
    const metadata = await readSkillMetadata(location)
    const record = state.skills[skillKey]
    const source = skillSource(record?.source)

    return {
        canDelete: true,
        deletedAt: record?.deletedAt,
        description: metadata.description,
        downloadUrl: record?.downloadUrl,
        enabled: record?.enabled ?? true,
        fileName: record?.fileName,
        fileSize: record?.fileSize,
        installedAt: record?.installedAt,
        location,
        managed: source !== "local",
        name: metadata.name ?? skillKey,
        sha256: record?.sha256,
        skillID: record?.skillID,
        skillKey,
        source,
        updatedAt: record?.updatedAt,
        version: metadata.version ?? record?.version ?? "unknown",
    } satisfies InstalledSkill
}

async function downloadPackage(input: SkillInstallRequest, zipPath: string) {
    const response = await fetch(input.downloadUrl, { signal: AbortSignal.timeout(120_000) }).catch((error: unknown) => {
        throw new Error(`下载技能包失败：${String(error)}`)
    })
    if (!response.ok) throw new Error(`下载技能包失败：HTTP ${response.status}`)

    const body = Buffer.from(await response.arrayBuffer())
    if (input.fileSize && body.byteLength !== input.fileSize) {
        throw new Error("技能包大小与后台记录不一致")
    }

    const sha256 = createHash("sha256").update(body).digest("hex")
    if (sha256.toLowerCase() !== input.sha256.toLowerCase()) {
        throw new Error("技能包 sha256 校验失败")
    }

    await writeFile(zipPath, body)
}

async function resolveExtractedSkillDir(extractDir: string, input: SkillInstallRequest) {
    if (existsSync(join(extractDir, "SKILL.md"))) return extractDir

    const entries = await readdir(extractDir, { withFileTypes: true })
    const candidates = entries
        .filter((entry) => entry.isDirectory() && existsSync(join(extractDir, entry.name, "SKILL.md")))
        .map((entry) => join(extractDir, entry.name))
    const exact = candidates.find((candidate) => path.basename(candidate) === input.skillKey)
    if (exact) return exact
    if (candidates.length === 1) return candidates[0]

    throw new Error("技能包中没有找到唯一的 SKILL.md")
}

async function validateExtractedSkill(skillDir: string, input: SkillInstallRequest) {
    const metadata = await readSkillMetadata(skillDir)
    if (!metadata.name) throw new Error("SKILL.md 缺少 name")
    if (metadata.name !== input.skillKey) {
        throw new Error(`SKILL.md name 与技能标识不一致：${metadata.name}`)
    }
}

async function replaceSkillDirectory(source: string, destination: string) {
    const backupRoot = join(skillMarketCacheDir(), "backups")
    const backup = join(backupRoot, `${path.basename(destination)}-${Date.now()}`)
    await mkdir(backupRoot, { recursive: true })

    const hadExisting = existsSync(destination)
    if (hadExisting) await rename(destination, backup)

    return rename(source, destination)
        .catch((error: unknown) =>
            (hadExisting && !existsSync(destination)
                ? rename(backup, destination).catch(() => undefined)
                : Promise.resolve()
            ).then(() => {
                throw error
            }),
        )
        .finally(() => rm(backup, { recursive: true, force: true }))
}

async function writeInstalledState(input: SkillInstallRequest) {
    const state = await readSkillMarketState()
    const previous = state.skills[input.skillKey]
    const now = new Date().toISOString()
    state.skills[input.skillKey] = {
        downloadUrl: input.downloadUrl,
        enabled: true,
        fileName: input.fileName,
        fileSize: input.fileSize,
        installedAt: previous?.installedAt ?? now,
        sha256: input.sha256,
        skillID: input.skillID,
        skillKey: input.skillKey,
        source: "market",
        updatedAt: now,
        version: input.version,
    }
    await writeSkillMarketState(state)
}

async function readSkillMarketState(): Promise<SkillMarketState> {
    const raw = await readFile(skillMarketStatePath(), "utf8").catch(() => undefined)
    if (!raw) return { skills: {}, version: 1 }

    const parsed = parseJson(raw)
    if (!isSkillMarketState(parsed)) return { skills: {}, version: 1 }
    return parsed
}

async function writeSkillMarketState(state: SkillMarketState) {
    await mkdir(path.dirname(skillMarketStatePath()), { recursive: true })
    await writeFile(skillMarketStatePath(), JSON.stringify(state, null, 2))
}

function validateZipEntry(entry: { fileName: string; externalFileAttributes: number }) {
    const fileName = entry.fileName.replace(/\\/g, "/")
    if (fileName.startsWith("/") || fileName === ".." || fileName.includes("../")) {
        throw new Error(`技能包包含非法路径：${entry.fileName}`)
    }

    const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
    if (unixMode === 0o120000) throw new Error(`技能包不允许符号链接：${entry.fileName}`)
}

function validateSkillInstallRequest(input: SkillInstallRequest) {
    validateSkillKey(input.skillKey)
    if (!input.name.trim()) throw new Error("缺少技能名称")
    if (!input.version.trim()) throw new Error("缺少技能版本")
    if (!input.downloadUrl.trim()) throw new Error("缺少下载地址")
    if (!input.sha256.trim()) throw new Error("缺少 sha256")
}

function validateSkillKey(skillKey: string) {
    if (!safeSkillKeyPattern.test(skillKey)) throw new Error(`非法技能标识：${skillKey}`)
}

function skillSource(source: string | undefined): SkillSource {
    return source && source !== "local" ? "market" : "local"
}

function parseJson(raw: string) {
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return undefined
    }
}

function isSkillMarketState(input: unknown): input is SkillMarketState {
    if (typeof input !== "object" || input === null) return false
    const version = (input as { version?: unknown }).version
    const skills = (input as { skills?: unknown }).skills
    return version === 1 && typeof skills === "object" && skills !== null && !Array.isArray(skills)
}
