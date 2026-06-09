import { CLIENT_API_BASE_URL, CLIENT_DEBUG_LOGS_ENABLED } from "../config"
import type { ClientApiRequest, ClientApiResponse } from "../../shared/client-api"
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

export async function checkClientStatus() {
    const response = await clientFetch("/api/client/status").catch((error: unknown) => ({
        error,
        ok: false,
        reason: readStoredClientAuthSession() ? "network" : "invalid",
    }) as const)

    if (!(response instanceof Response)) {
        return {
            message: errorMessage(response.error),
            ok: false,
            reason: response.reason,
        } as const
    }

    const data = await response.json().catch(() => undefined) as unknown
    if (CLIENT_DEBUG_LOGS_ENABLED) console.log("[client-status] response", {
        body: data,
        ok: response.ok,
        status: response.status,
    })
    if (response.ok && isOkResponse(data)) return { ok: true } as const
    if (response.status === 401) {
        return {
            message: responseMessage(data),
            ok: false,
            reason: "invalid",
        } as const
    }

    return {
        message: responseMessage(data),
        ok: false,
        reason: "network",
    } as const
}

export async function clientFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const session = await ensureClientLoginToken()
    const response = await clientApiFetch(input, withClientAuthHeaders(input, init, session.loginToken))
    if (!response) throw clientAuthError("network")
    if (response.status !== 401) return response
    if (!session.refreshToken || !session.refreshTokenExpire) return response

    const refreshed = await refreshClientAuth()
    const retryResponse = await clientApiFetch(input, withClientAuthHeaders(input, init, refreshed.loginToken))
    if (!retryResponse) throw clientAuthError("network")
    return retryResponse
}

function clientApiFetch(input: RequestInfo | URL, init: RequestInit) {
    const request = clientApiRequest(input, init)
    if (CLIENT_DEBUG_LOGS_ENABLED) console.log("[client-api] request", {
        method: request.method ?? "GET",
        url: request.url,
    })
    return window.electronAPI.clientApiRequest(request)
        .then((response) => {
            if (CLIENT_DEBUG_LOGS_ENABLED) console.log("[client-api] response", {
                body: safeClientApiLogBody(response.body),
                method: request.method ?? "GET",
                ok: response.ok,
                status: response.status,
                url: request.url,
            })
            return clientApiResponse(response)
        })
        .catch((error: unknown) => {
            if (CLIENT_DEBUG_LOGS_ENABLED) console.warn("[client-api] request failed", {
                error: errorMessage(error),
                method: request.method ?? "GET",
                url: request.url,
            })
            return undefined
        })
}

async function ensureClientLoginToken() {
    const session = readStoredClientAuthSession()
    if (!session) {
        clearClientAuthSession()
        throw clientAuthError("missing")
    }
    if (Date.parse(session.loginTokenExpire) <= Date.now()) {
        if (session.refreshToken && session.refreshTokenExpire && Date.parse(session.refreshTokenExpire) > Date.now()) {
            return refreshClientAuth()
        }

        clearClientAuthSession()
        throw clientAuthError("expired")
    }
    if (!isClientAuthExpiringSoon(session.loginTokenExpire)) return session
    if (!session.refreshToken || !session.refreshTokenExpire) return session
    return refreshClientAuth()
}

async function refreshClientAuthOnce() {
    const session = readStoredClientAuthSession()
    if (!session) {
        clearClientAuthSession()
        throw clientAuthError("missing")
    }
    if (!session.refreshToken || !session.refreshTokenExpire) {
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
        throw clientAuthError("network")
    }

    const data = await response.json().catch(() => undefined) as unknown
    if (response.status === 401) {
        clearClientAuthSession()
        throw clientAuthError("invalid", responseMessage(data))
    }
    if (!response.ok || !isClientTokenRefreshResponse(data)) {
        throw clientAuthError("network", responseMessage(data))
    }

    const nextSession = clientAuthSessionFromRefreshResponse(data, session)
    writeClientAuthSession(nextSession)
    return nextSession
}

function withClientAuthHeaders(input: RequestInfo | URL, init: RequestInit, loginToken: string) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    headers.set("Authorization", `Bearer ${loginToken}`)
    return { ...init, headers }
}

function resolveClientApiInput(input: RequestInfo | URL) {
    if (typeof input === "string") return new URL(input, CLIENT_API_BASE_URL)
    return input
}

function clientApiRequest(input: RequestInfo | URL, init: RequestInit): ClientApiRequest {
    return {
        body: clientApiRequestBody(init.body),
        headers: [...new Headers(init.headers).entries()],
        method: init.method,
        url: clientApiUrl(input),
    }
}

function clientApiUrl(input: RequestInfo | URL) {
    const resolved = resolveClientApiInput(input)
    if (resolved instanceof URL) return resolved.toString()
    if (resolved instanceof Request) return resolved.url
    return resolved
}

function clientApiRequestBody(body: BodyInit | null | undefined) {
    if (body === undefined || body === null) return undefined
    if (typeof body === "string") return body
    if (body instanceof URLSearchParams) return body.toString()
    throw new Error("Unsupported client API request body")
}

function clientApiResponse(input: ClientApiResponse) {
    return new Response(input.body, {
        headers: input.headers,
        status: input.status,
        statusText: input.statusText,
    })
}

function safeClientApiLogBody(body: string | null): unknown {
    if (body === null) return null
    const parsed = parseJsonBody(body)
    if (parsed === undefined) return truncateLogString(body)
    return redactClientApiLogValue(parsed)
}

function parseJsonBody(body: string) {
    try {
        return JSON.parse(body) as unknown
    } catch {
        return undefined
    }
}

function redactClientApiLogValue(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(redactClientApiLogValue)
    if (!isRecord(input)) return typeof input === "string" ? truncateLogString(input) : input

    return Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
            key,
            isSensitiveClientApiLogKey(key) ? "[redacted]" : redactClientApiLogValue(value),
        ]),
    )
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null
}

function isSensitiveClientApiLogKey(key: string) {
    return /token|password|authorization|secret|api[_-]?key|apikey|key/i.test(key)
}

function truncateLogString(input: string) {
    return input.length > 500 ? `${input.slice(0, 500)}...` : input
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

function isOkResponse(input: unknown) {
    return typeof input === "object" && input !== null && (input as { ok?: unknown }).ok === true
}

function errorMessage(input: unknown) {
    if (input instanceof Error && input.message.trim()) return input.message
    const message = String(input)
    return message && message !== "[object Object]" ? message : undefined
}

function responseMessage(input: unknown) {
    if (typeof input !== "object" || input === null) return undefined
    const message = (input as { message?: unknown }).message
    return typeof message === "string" && message.trim() ? message : undefined
}
