import { CLIENT_API_BASE_URL } from "../config"
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
    return window.electronAPI.clientApiRequest(clientApiRequest(input, init))
        .then(clientApiResponse)
        .catch(() => undefined)
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
