import { CLIENT_API_BASE_URL } from "../config"
import { clientFetch } from "./client"

export interface ClientSkill {
    id: number
    skillKey: string
    name: string
    version: string
    category: string | null
    description: string | null
    changelog: string | null
    platform: "all" | "mac" | "win"
    minClientVersion: string | null
    fileName: string
    fileSize: number
    downloadUrl: string
    sha256: string
    manifest: unknown
    isRequired: boolean
    status: "published" | "archived"
    isLatest: boolean | null
    publishedAt: string
    updatedAt: string
}

export async function listClientSkills() {
    return (await listClientSkillCatalog()).skills
}

export async function listClientSkillCatalog() {
    const url = new URL("/api/client/skills", CLIENT_API_BASE_URL)
    const platform = currentSkillPlatform()
    if (platform) url.searchParams.set("platform", platform)

    const response = await clientFetch(url)
    const data = await response.json().catch(() => undefined) as unknown
    if (!response.ok) {
        throw new Error(responseMessage(data) ?? `获取技能列表失败：HTTP ${response.status}`)
    }

    const catalog = parseClientSkillsResponse(data)
    return {
        archivedSkills: catalog.archivedSkills.map(normalizeClientSkillDownloadUrl),
        skills: catalog.skills.map(normalizeClientSkillDownloadUrl),
    }
}

export function currentSkillPlatform() {
    const platform = navigator.platform.toLowerCase()
    if (platform.includes("mac")) return "mac"
    if (platform.includes("win")) return "win"
    return undefined
}

function parseClientSkillsResponse(input: unknown) {
    if (typeof input !== "object" || input === null) throw new Error("技能列表响应不是 JSON 对象")
    if ((input as { ok?: unknown }).ok !== true) throw new Error(responseMessage(input) ?? "技能列表响应 ok 不为 true")
    const skills = (input as { skills?: unknown }).skills
    if (!Array.isArray(skills)) throw new Error("技能列表响应缺少 skills 数组")
    const archivedSkills = (input as { archivedSkills?: unknown }).archivedSkills
    if (archivedSkills !== undefined && !Array.isArray(archivedSkills)) throw new Error("技能列表响应 archivedSkills 不是数组")

    return {
        archivedSkills: (archivedSkills ?? []).map((skill, index) => parseClientSkill(skill, index, "archived")),
        skills: skills.map((skill, index) => parseClientSkill(skill, index, "published")),
    }
}

function parseClientSkill(input: unknown, index: number, status: ClientSkill["status"]): ClientSkill {
    if (typeof input !== "object" || input === null) throw new Error(`第 ${index + 1} 个技能不是对象`)
    const item = input as Record<string, unknown>
    return {
        category: optionalString(item.category),
        changelog: optionalString(item.changelog),
        description: optionalString(item.description),
        downloadUrl: requiredString(item.downloadUrl, "downloadUrl", index),
        fileName: requiredString(item.fileName, "fileName", index),
        fileSize: requiredNumber(item.fileSize, "fileSize", index),
        id: requiredNumber(item.id, "id", index),
        isLatest: optionalBoolean(item.isLatest),
        isRequired: optionalBoolean(item.isRequired) ?? false,
        manifest: item.manifest ?? {},
        minClientVersion: optionalString(item.minClientVersion),
        name: requiredString(item.name, "name", index),
        platform: requiredPlatform(item.platform, index),
        publishedAt: requiredString(item.publishedAt, "publishedAt", index),
        sha256: requiredString(item.sha256, "sha256", index),
        skillKey: requiredString(item.skillKey, "skillKey", index),
        status,
        updatedAt: requiredString(item.updatedAt, "updatedAt", index),
        version: requiredString(item.version, "version", index),
    }
}

function normalizeClientSkillDownloadUrl(skill: ClientSkill) {
    return {
        ...skill,
        downloadUrl: new URL(skill.downloadUrl, CLIENT_API_BASE_URL).toString(),
    }
}

function requiredString(input: unknown, field: string, index: number) {
    if (typeof input === "string") return input
    throw new Error(`第 ${index + 1} 个技能缺少字段 ${field}`)
}

function optionalString(input: unknown) {
    return typeof input === "string" ? input : null
}

function optionalBoolean(input: unknown) {
    return typeof input === "boolean" ? input : null
}

function requiredNumber(input: unknown, field: string, index: number) {
    if (typeof input === "number" && Number.isFinite(input)) return input
    if (typeof input === "string" && input.trim() && Number.isFinite(Number(input))) return Number(input)
    throw new Error(`第 ${index + 1} 个技能缺少字段 ${field}`)
}

function requiredPlatform(input: unknown, index: number): ClientSkill["platform"] {
    if (input === "all" || input === "mac" || input === "win") return input
    throw new Error(`第 ${index + 1} 个技能 platform 不合法`)
}

function responseMessage(input: unknown) {
    if (typeof input !== "object" || input === null) return undefined
    const message = (input as { message?: unknown }).message
    return typeof message === "string" && message.trim() ? message : undefined
}
