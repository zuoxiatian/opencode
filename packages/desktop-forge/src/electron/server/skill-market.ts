import extractZip from "extract-zip"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path, { join } from "node:path"
import { readSkillMetadata } from "./skill-metadata"
import type { InstalledSkill, SkillBundleMember, SkillInstallRequest, SkillRecordType, SkillSource } from "../../shared/skill-market"

interface SkillMarketState {
    version: 1
    skills: Record<string, SkillStateRecord>
}

interface ExtractedSkill {
    skillDir: string
    skillKey: string
    version: string
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
    recordType?: SkillRecordType
    bundleKey?: string
    bundleName?: string
    bundleVersion?: string
    bundleSkillNames?: string[]
    bundleSkills?: SkillBundleMember[]
}

const safeSkillKeyPattern = /^[a-zA-Z0-9._-]+$/
const skillMarketMetadataFile = ".lxz-skill-market.json"

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

export async function installSkillPackage(input: SkillInstallRequest): Promise<InstalledSkill[]> {
    validateSkillInstallRequest(input)

    await mkdir(skillsRootDir(), { recursive: true })
    await mkdir(skillMarketCacheDir(), { recursive: true })

    const workDir = await mkdtemp(join(skillMarketCacheDir(), `${input.skillKey}-`))
    const zipPath = join(workDir, input.fileName || `${input.skillKey}.zip`)
    const extractDir = join(workDir, "extract")

    return downloadPackage(input, zipPath)
        .then(() => mkdir(extractDir, { recursive: true }))
        .then(() => extractZip(zipPath, { dir: extractDir, onEntry: validateZipEntry }))
        .then(() => skillRecordType(input.recordType) === "bundle"
            ? installBundleFromExtract(extractDir, input)
            : installSingleSkillFromExtract(extractDir, input))
        .finally(() => rm(workDir, { recursive: true, force: true }))
}

export async function deleteInstalledSkill(skillKey: string) {
    validateSkillKey(skillKey)

    const state = await readSkillMarketState()
    const record = state.skills[skillKey]
    const location = skillDirFor(skillKey)
    if (!existsSync(join(location, "SKILL.md"))) throw new Error("技能不存在")

    await rm(location, { recursive: true, force: true })
    state.skills[skillKey] = {
        ...record,
        deletedAt: new Date().toISOString(),
        enabled: false,
        recordType: skillRecordType(record?.recordType),
        skillKey,
        source: skillSource(record?.source),
    }
    await writeSkillMarketState(state)

    return skillKey
}

export async function deleteInstalledBundle(bundleKey: string, skillKeys: string[] = []) {
    validateSkillKey(bundleKey)
    skillKeys.forEach(validateSkillKey)

    const state = await readSkillMarketState()
    const records = Object.values(state.skills).filter((record) =>
        record.source === "market" && record.bundleKey === bundleKey && record.enabled !== false)
    const keys = [...new Set([...records.map((record) => record.skillKey), ...skillKeys])]
    if (!keys.length) throw new Error("技能包不存在")

    const now = new Date().toISOString()
    await Promise.all(keys.map((skillKey) => rm(skillDirFor(skillKey), { recursive: true, force: true })))
    keys.forEach((skillKey) => {
        const record = state.skills[skillKey]
        state.skills[skillKey] = {
            ...record,
            bundleKey,
            deletedAt: now,
            enabled: false,
            recordType: "bundle",
            skillKey,
            source: record ? skillSource(record.source) : "market",
        }
    })
    await writeSkillMarketState(state)

    return bundleKey
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

async function installedSkillFromDirectory(skillKey: string, state: SkillMarketState): Promise<InstalledSkill> {
    const location = skillDirFor(skillKey)
    const metadata = await readSkillMetadata(location)
    const record = mergeSkillStateRecord(state.skills[skillKey], await readSkillInstallMetadata(location))
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
        recordType: skillRecordType(record?.recordType),
        sha256: record?.sha256,
        skillID: record?.skillID,
        skillKey,
        source,
        updatedAt: record?.updatedAt,
        version: metadata.version ?? record?.version ?? "unknown",
        bundleKey: record?.bundleKey,
        bundleName: record?.bundleName,
        bundleSkillNames: record?.bundleSkillNames,
        bundleSkills: record?.bundleSkills,
        bundleVersion: record?.bundleVersion,
    } satisfies InstalledSkill
}

async function readSkillInstallMetadata(location: string) {
    const raw = await readFile(join(location, skillMarketMetadataFile), "utf8").catch(() => undefined)
    if (!raw) return undefined

    const parsed = parseJson(raw)
    if (!isSkillStateRecord(parsed)) return undefined
    return parsed
}

function mergeSkillStateRecord(stateRecord: SkillStateRecord | undefined, metadataRecord: SkillStateRecord | undefined) {
    if (!stateRecord) return metadataRecord
    if (!metadataRecord) return stateRecord
    return {
        ...metadataRecord,
        ...stateRecord,
        bundleKey: stateRecord.bundleKey ?? metadataRecord.bundleKey,
        bundleName: stateRecord.bundleName ?? metadataRecord.bundleName,
        bundleSkillNames: stateRecord.bundleSkillNames ?? metadataRecord.bundleSkillNames,
        bundleSkills: stateRecord.bundleSkills ?? metadataRecord.bundleSkills,
        bundleVersion: stateRecord.bundleVersion ?? metadataRecord.bundleVersion,
        recordType: stateRecord.recordType ?? metadataRecord.recordType,
        source: stateRecord.source ?? metadataRecord.source,
    } satisfies SkillStateRecord
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
    const candidates = await findExtractedSkillDirs(extractDir)
    const metadataCandidates = await Promise.all(candidates.map(async (candidate) => ({
        metadata: await readSkillMetadata(candidate),
        skillDir: candidate,
    })))
    const exactMetadata = metadataCandidates.find((candidate) => candidate.metadata.name === input.skillKey)
    if (exactMetadata) return exactMetadata.skillDir
    const exactDirectory = candidates.find((candidate) => path.basename(candidate) === input.skillKey)
    if (exactDirectory) return exactDirectory
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

async function installSingleSkillFromExtract(extractDir: string, input: SkillInstallRequest) {
    return resolveExtractedSkillDir(extractDir, input)
        .then((skillDir) => validateExtractedSkill(skillDir, input).then(() => skillDir))
        .then((skillDir) => replaceSkillDirectory(skillDir, skillDirFor(input.skillKey)))
        .then(() => writeInstalledState(input))
        .then(() => installedSkillsByKeys([input.skillKey]))
}

async function installBundleFromExtract(extractDir: string, input: SkillInstallRequest) {
    const skills = await extractedBundleSkills(extractDir, input)
    await skills.reduce(
        (previous, skill) => previous.then(() => replaceSkillDirectory(skill.skillDir, skillDirFor(skill.skillKey))),
        Promise.resolve(),
    )
    await writeBundleInstalledState(input, skills)
    return installedSkillsByKeys(skills.map((skill) => skill.skillKey))
}

async function extractedBundleSkills(extractDir: string, input: SkillInstallRequest) {
    const skills = await Promise.all(
        outermostSkillDirs((await findExtractedSkillDirs(extractDir)).filter((skillDir) => skillDir !== extractDir))
            .map((skillDir) => extractedSkillInfo(skillDir, input.version)),
    )
    if (!skills.length) throw new Error("技能包中没有找到 SKILL.md")

    const duplicate = skills.find((skill, index) =>
        skills.findIndex((item) => item.skillKey === skill.skillKey) !== index)
    if (duplicate) throw new Error(`技能包包含重复技能：${duplicate.skillKey}`)

    return skills
}

async function extractedSkillInfo(skillDir: string, fallbackVersion: string): Promise<ExtractedSkill> {
    const metadata = await readSkillMetadata(skillDir)
    if (!metadata.name) throw new Error(`SKILL.md 缺少 name：${path.relative(skillDir, join(skillDir, "SKILL.md"))}`)
    validateSkillKey(metadata.name)
    return {
        skillDir,
        skillKey: metadata.name,
        version: metadata.version ?? fallbackVersion,
    }
}

async function findExtractedSkillDirs(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const nested = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => findExtractedSkillDirs(join(dir, entry.name))),
    )
    return [
        ...(existsSync(join(dir, "SKILL.md")) ? [dir] : []),
        ...nested.flat(),
    ]
}

function outermostSkillDirs(skillDirs: string[]) {
    return skillDirs.filter((skillDir) =>
        !skillDirs.some((candidate) => candidate !== skillDir && isPathInside(candidate, skillDir)))
}

function isPathInside(parent: string, child: string) {
    const relative = path.relative(parent, child)
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
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
        recordType: "skill",
        sha256: input.sha256,
        skillID: input.skillID,
        skillKey: input.skillKey,
        source: "market",
        updatedAt: now,
        version: input.version,
    }
    await writeSkillMarketState(state)
    await writeSkillInstallMetadata(input.skillKey, state.skills[input.skillKey])
}

async function writeBundleInstalledState(input: SkillInstallRequest, skills: ExtractedSkill[]) {
    const state = await readSkillMarketState()
    const now = new Date().toISOString()
    const nextSkillKeys = new Set(skills.map((skill) => skill.skillKey))
    const removedSkills = Object.values(state.skills).filter((record) =>
        record.source === "market" && record.bundleKey === installBundleKey(input) && !nextSkillKeys.has(record.skillKey))
    const bundleSkillNames = skills.map((skill) => skill.skillKey)
    const bundleSkills = bundleMembersForInstalledSkills(input, skills)

    await Promise.all(removedSkills.map((record) => rm(skillDirFor(record.skillKey), { recursive: true, force: true })))
    removedSkills.forEach((record) => {
        state.skills[record.skillKey] = {
            ...record,
            deletedAt: now,
            enabled: false,
        }
    })
    skills.forEach((skill) => {
        const previous = state.skills[skill.skillKey]
        state.skills[skill.skillKey] = {
            bundleKey: installBundleKey(input),
            bundleName: input.bundleMeta?.bundleName || input.name,
            bundleSkillNames,
            bundleSkills,
            bundleVersion: input.bundleMeta?.bundleVersion || input.version,
            downloadUrl: input.downloadUrl,
            enabled: true,
            fileName: input.fileName,
            fileSize: input.fileSize,
            installedAt: previous?.installedAt ?? now,
            recordType: "bundle",
            sha256: input.sha256,
            skillID: input.skillID,
            skillKey: skill.skillKey,
            source: "market",
            updatedAt: now,
            version: skill.version,
        }
    })

    await writeSkillMarketState(state)
    await Promise.all(skills.map((skill) => writeSkillInstallMetadata(skill.skillKey, state.skills[skill.skillKey])))
}

async function writeSkillInstallMetadata(skillKey: string, record: SkillStateRecord) {
    await writeFile(join(skillDirFor(skillKey), skillMarketMetadataFile), JSON.stringify(record, null, 2))
}

function bundleMembersForInstalledSkills(input: SkillInstallRequest, skills: ExtractedSkill[]) {
    const membersByKey = new Map(bundleMembersForInstalledVersion(input).map((skill) => [skill.skillKey, skill]))
    return skills.map((skill) => ({
        ...membersByKey.get(skill.skillKey),
        skillKey: skill.skillKey,
        version: membersByKey.get(skill.skillKey)?.version ?? skill.version,
    }))
}

function bundleMembersForInstalledVersion(input: SkillInstallRequest) {
    if (input.bundleMeta?.skills.length) return input.bundleMeta.skills
    return input.bundleHistory?.find((item) => item.bundleVersion === (input.bundleMeta?.bundleVersion || input.version))?.skills ?? []
}

async function installedSkillsByKeys(skillKeys: string[]) {
    const installedByKey = new Map((await listInstalledSkills()).map((skill) => [skill.skillKey, skill]))
    return skillKeys.map((skillKey) => installedByKey.get(skillKey)).filter(isDefined)
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

function skillRecordType(recordType: SkillRecordType | undefined): SkillRecordType {
    return recordType === "bundle" ? "bundle" : "skill"
}

function installBundleKey(input: SkillInstallRequest) {
    return input.bundleKey || input.bundleMeta?.bundleKey || input.skillKey
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

function isSkillStateRecord(input: unknown): input is SkillStateRecord {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return false
    const record = input as Record<string, unknown>
    return typeof record.skillKey === "string"
        && safeSkillKeyPattern.test(record.skillKey)
        && (record.source === "market" || record.source === "local")
        && typeof record.enabled === "boolean"
        && (record.recordType === undefined || record.recordType === "skill" || record.recordType === "bundle")
        && (record.bundleSkillNames === undefined || isStringArray(record.bundleSkillNames))
        && (record.bundleSkills === undefined || isBundleMembers(record.bundleSkills))
}

function isStringArray(input: unknown): input is string[] {
    return Array.isArray(input) && input.every((item) => typeof item === "string")
}

function isBundleMembers(input: unknown): input is SkillBundleMember[] {
    return Array.isArray(input) && input.every((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return false
        const member = item as Record<string, unknown>
        return typeof member.skillKey === "string"
            && safeSkillKeyPattern.test(member.skillKey)
            && (member.skillID === undefined || typeof member.skillID === "number")
            && (member.name === undefined || typeof member.name === "string")
            && (member.version === undefined || typeof member.version === "string")
    })
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined
}
