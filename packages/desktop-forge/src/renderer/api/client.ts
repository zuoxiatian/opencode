import { CLIENT_API_BASE_URL } from "../config"
import {
    clearClientAuthSession,
    clientAuthSessionFromRefreshResponse,
    clientAuthSessionFromResponse,
    isClientAuthExpiringSoon,
    isClientAuthResponse,
    isClientTokenRefreshResponse,
    readStoredClientAuthSession,
    writeClientAuthSession,
    type ClientAuthSession,
} from "../auth"

export type ClientLoginFailureReason = "network" | "unauthorized" | "invalid"
type ClientRefreshFailureReason = "missing" | "network" | "expired" | "invalid"
let refreshPromise: Promise<ClientAuthSession> | null = null

export async function loginClient(input: { username: string; password: string }) {
    const response = await clientApiFetch("/api/client/login", {
        body: JSON.stringify(input),
        headers: new Headers({ "Content-Type": "application/json" }),
        method: "POST",
    })

    if (!response) return { ok: false, reason: "network" } as const

    const data = await response.json().catch(() => undefined) as unknown
    if (!response.ok || !isClientAuthResponse(data)) {
        return {
            message: responseMessage(data),
            ok: false,
            reason: response.status === 401 ? "unauthorized" : "invalid",
        } as const
    }

    const session = clientAuthSessionFromResponse(data)
    writeClientAuthSession(session)
    return { ok: true, session } as const
}

export async function refreshClientAuth() {
    if (refreshPromise) return refreshPromise

    refreshPromise = refreshClientAuthOnce()
    try {
        return await refreshPromise
    } finally {
        refreshPromise = null
    }
}

export async function clientFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const session = await ensureClientAccessToken()
    const response = await fetch(resolveClientApiInput(input), withClientAuthHeaders(input, init, session.accessToken))
    if (response.status !== 401) return response

    const refreshed = await refreshClientAuth()
    return fetch(resolveClientApiInput(input), withClientAuthHeaders(input, init, refreshed.accessToken))
}

function clientApiFetch(pathname: string, init: RequestInit) {
    return fetch(new URL(pathname, CLIENT_API_BASE_URL), init).catch(() => undefined)
}

async function ensureClientAccessToken() {
    const session = readStoredClientAuthSession()
    if (!session) {
        clearClientAuthSession()
        throw clientAuthError("missing")
    }
    if (!isClientAuthExpiringSoon(session.accessTokenExpire)) return session
    return refreshClientAuth()
}

async function refreshClientAuthOnce() {
    const session = readStoredClientAuthSession()
    if (!session) {
        clearClientAuthSession()
        throw clientAuthError("missing")
    }
    if (Date.parse(session.refreshTokenExpire) <= Date.now()) {
        clearClientAuthSession()
        throw clientAuthError("expired")
    }

    const response = await clientApiFetch("/api/client/token/refresh", {
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        headers: new Headers({ "Content-Type": "application/json" }),
        method: "POST",
    })

    if (!response) {
        clearClientAuthSession()
        throw clientAuthError("network")
    }

    const data = await response.json().catch(() => undefined) as unknown
    if (!response.ok || !isClientTokenRefreshResponse(data)) {
        clearClientAuthSession()
        throw clientAuthError("invalid", responseMessage(data))
    }

    const nextSession = clientAuthSessionFromRefreshResponse(data, session)
    writeClientAuthSession(nextSession)
    return nextSession
}

function withClientAuthHeaders(input: RequestInfo | URL, init: RequestInit, accessToken: string) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    headers.set("Authorization", `Bearer ${accessToken}`)
    return { ...init, headers }
}

function resolveClientApiInput(input: RequestInfo | URL) {
    if (typeof input === "string") return new URL(input, CLIENT_API_BASE_URL)
    return input
}

function clientAuthError(reason: ClientRefreshFailureReason, message?: string) {
    return new Error(message ?? (
        reason === "missing"
            ? "未登录"
            : reason === "expired"
                ? "登录已失效"
                : reason === "network"
                    ? "无法连接登录服务"
                    : "登录已失效"
    ))
}

function responseMessage(input: unknown) {
    if (typeof input !== "object" || input === null) return undefined
    const message = (input as { message?: unknown }).message
    return typeof message === "string" && message.trim() ? message : undefined
}
