import { clearClientAuthSession, type ClientUser } from "../auth"
import { clientFetch } from "./client"

export type ClientCapabilities = {
    [feature: string]: boolean
    appMarket: boolean
}

type StoredClientCapabilities = {
    features: ClientCapabilities
    userID: number
    username: string
}

const CLIENT_CAPABILITIES_STORAGE_KEY = "desktop-lxz.clientCapabilities"

export async function getClientCapabilities() {
    const response = await clientFetch("/api/client/capabilities")
    const data = await response.json().catch(() => undefined) as unknown
    if (response.status === 401) clearClientAuthSession()
    if (!response.ok) {
        throw new Error(responseMessage(data) ?? `读取客户端能力失败：HTTP ${response.status}`)
    }

    return parseClientCapabilitiesResponse(data)
}

export function readStoredClientCapabilities(user: ClientUser) {
    const raw = localStorage.getItem(CLIENT_CAPABILITIES_STORAGE_KEY)
    if (!raw) return null
    const stored = parseStoredClientCapabilities(raw)
    if (!stored) {
        clearStoredClientCapabilities()
        return null
    }
    if (stored.userID !== user.id || stored.username !== user.username) return null
    return stored.features
}

export function writeStoredClientCapabilities(user: ClientUser, features: ClientCapabilities) {
    localStorage.setItem(CLIENT_CAPABILITIES_STORAGE_KEY, JSON.stringify({
        features,
        userID: user.id,
        username: user.username,
    } satisfies StoredClientCapabilities))
}

export function clearStoredClientCapabilities() {
    localStorage.removeItem(CLIENT_CAPABILITIES_STORAGE_KEY)
}

export function clientCapabilitiesAccountKey(user: ClientUser) {
    return `${user.id}:${user.username}`
}

function parseClientCapabilitiesResponse(input: unknown): ClientCapabilities {
    if (!isRecord(input)) throw new Error("客户端能力响应不是 JSON 对象")
    if (input.ok !== true) throw new Error(responseMessage(input) ?? "读取客户端能力失败")
    if (!isBooleanRecord(input.features) || typeof input.features.appMarket !== "boolean") {
        throw new Error("客户端能力响应缺少 features.appMarket")
    }
    return {
        ...input.features,
        appMarket: input.features.appMarket,
    }
}

function parseStoredClientCapabilities(raw: string): StoredClientCapabilities | null {
    try {
        const input = JSON.parse(raw) as unknown
        if (!isRecord(input)) return null
        if (typeof input.userID !== "number" || typeof input.username !== "string") return null
        if (!isBooleanRecord(input.features) || typeof input.features.appMarket !== "boolean") return null
        return {
            features: {
                ...input.features,
                appMarket: input.features.appMarket,
            },
            userID: input.userID,
            username: input.username,
        }
    } catch {
        return null
    }
}

function isBooleanRecord(input: unknown): input is Record<string, boolean> {
    return isRecord(input) && Object.values(input).every((value) => typeof value === "boolean")
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
}

function responseMessage(input: unknown) {
    if (!isRecord(input)) return undefined
    const message = input.message
    return typeof message === "string" && message.trim() ? message : undefined
}
