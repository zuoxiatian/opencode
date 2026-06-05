import { CLIENT_API_BASE_URL } from "../config"
import { clientFetch } from "./client"

export type ClientReleasePlatform = "mac" | "win"
export type ClientReleaseArch = "x64" | "arm64" | "universal"
export type ClientReleaseChannel = "stable" | "beta" | "dev"

export type ClientRelease = {
    arch: ClientReleaseArch
    changelog: string | null
    channel: ClientReleaseChannel
    downloadUrl: string
    fileName: string
    fileSize: number
    forceUpdate: boolean
    id: number
    minVersion: string | null
    platform: ClientReleasePlatform
    publishedAt: string | null
    sha256: string | null
    title: string | null
    updatedAt: string
    version: string
}

export type ClientReleaseQuery = {
    arch?: ClientReleaseArch
    channel?: ClientReleaseChannel
    platform?: ClientReleasePlatform
}

export async function listClientReleases(query: ClientReleaseQuery = {}) {
    const url = new URL("/api/client/releases", CLIENT_API_BASE_URL)
    if (query.platform) url.searchParams.set("platform", query.platform)
    if (query.arch) url.searchParams.set("arch", query.arch)
    if (query.channel) url.searchParams.set("channel", query.channel)

    const response = await clientFetch(url)
    const data = await response.json().catch(() => undefined) as unknown
    if (!response.ok) {
        throw new Error(responseMessage(data) ?? `获取客户端版本失败：HTTP ${response.status}`)
    }

    return parseClientReleasesResponse(data).map(normalizeClientReleaseDownloadUrl)
}

function parseClientReleasesResponse(input: unknown) {
    if (typeof input !== "object" || input === null) throw new Error("客户端版本响应不是 JSON 对象")
    if ((input as { ok?: unknown }).ok !== true) throw new Error(responseMessage(input) ?? "客户端版本响应 ok 不为 true")
    const releases = (input as { releases?: unknown }).releases
    if (!Array.isArray(releases)) throw new Error("客户端版本响应缺少 releases 数组")

    return releases.map(parseClientRelease)
}

function parseClientRelease(input: unknown, index: number): ClientRelease {
    if (typeof input !== "object" || input === null) throw new Error(`第 ${index + 1} 个客户端版本不是对象`)
    const item = input as Record<string, unknown>
    return {
        arch: requiredArch(item.arch, index),
        changelog: optionalString(item.changelog),
        channel: requiredChannel(item.channel, index),
        downloadUrl: requiredString(item.downloadUrl, "downloadUrl", index),
        fileName: requiredString(item.fileName, "fileName", index),
        fileSize: requiredNumber(item.fileSize, "fileSize", index),
        forceUpdate: requiredBoolean(item.forceUpdate, "forceUpdate", index),
        id: requiredNumber(item.id, "id", index),
        minVersion: optionalString(item.minVersion),
        platform: requiredPlatform(item.platform, index),
        publishedAt: optionalString(item.publishedAt),
        sha256: optionalString(item.sha256),
        title: optionalString(item.title),
        updatedAt: requiredString(item.updatedAt, "updatedAt", index),
        version: requiredString(item.version, "version", index),
    }
}

function normalizeClientReleaseDownloadUrl(release: ClientRelease) {
    return {
        ...release,
        downloadUrl: new URL(release.downloadUrl, CLIENT_API_BASE_URL).toString(),
    }
}

function requiredString(input: unknown, field: string, index: number) {
    if (typeof input === "string") return input
    throw new Error(`第 ${index + 1} 个客户端版本缺少字段 ${field}`)
}

function optionalString(input: unknown) {
    return typeof input === "string" ? input : null
}

function requiredBoolean(input: unknown, field: string, index: number) {
    if (typeof input === "boolean") return input
    throw new Error(`第 ${index + 1} 个客户端版本缺少字段 ${field}`)
}

function requiredNumber(input: unknown, field: string, index: number) {
    if (typeof input === "number" && Number.isFinite(input)) return input
    if (typeof input === "string" && input.trim() && Number.isFinite(Number(input))) return Number(input)
    throw new Error(`第 ${index + 1} 个客户端版本缺少字段 ${field}`)
}

function requiredPlatform(input: unknown, index: number): ClientReleasePlatform {
    if (input === "mac" || input === "win") return input
    throw new Error(`第 ${index + 1} 个客户端版本 platform 不合法`)
}

function requiredArch(input: unknown, index: number): ClientReleaseArch {
    if (input === "x64" || input === "arm64" || input === "universal") return input
    throw new Error(`第 ${index + 1} 个客户端版本 arch 不合法`)
}

function requiredChannel(input: unknown, index: number): ClientReleaseChannel {
    if (input === "stable" || input === "beta" || input === "dev") return input
    throw new Error(`第 ${index + 1} 个客户端版本 channel 不合法`)
}

function responseMessage(input: unknown) {
    if (typeof input !== "object" || input === null) return undefined
    const message = (input as { message?: unknown }).message
    return typeof message === "string" && message.trim() ? message : undefined
}
