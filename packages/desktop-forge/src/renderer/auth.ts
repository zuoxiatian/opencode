export const CLIENT_AUTH_STORAGE_KEY = "desktop-lxz.clientAuth"
const CLIENT_AUTH_CHANGED_EVENT = "desktop-lxz.clientAuth.changed"

export type ClientUser = {
    id: number
    username: string
    name: string | null
    department: string | null
    role: string
    quotaLimit: number | null
    quotaUsed: number
}

export type ClientAuthSession = {
    accessToken: string
    accessTokenExpire: string
    refreshToken: string
    refreshTokenExpire: string
    user: ClientUser
}

export type ClientAuthResponse = ClientAuthSession & {
    ok: true
}

export type ClientTokenRefreshResponse = Omit<ClientAuthSession, "user"> & {
    ok: true
    user?: unknown
}

export function readStoredClientAuthSession() {
    const raw = localStorage.getItem(CLIENT_AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = parseStoredSession(raw)
    if (!isClientAuthSession(parsed)) {
        clearClientAuthSession()
        return null
    }
    if (Date.parse(parsed.refreshTokenExpire) <= Date.now()) {
        clearClientAuthSession()
        return null
    }
    return parsed
}

export function writeClientAuthSession(session: ClientAuthSession) {
    localStorage.setItem(CLIENT_AUTH_STORAGE_KEY, JSON.stringify(session))
    notifyClientAuthSessionChange(session)
}

export function clearClientAuthSession() {
    localStorage.removeItem(CLIENT_AUTH_STORAGE_KEY)
    notifyClientAuthSessionChange(null)
}

export function subscribeClientAuthSession(callback: (session: ClientAuthSession | null) => void) {
    const handler = (event: Event) => {
        callback((event as CustomEvent<{ session: ClientAuthSession | null }>).detail.session)
    }
    window.addEventListener(CLIENT_AUTH_CHANGED_EVENT, handler)
    return () => window.removeEventListener(CLIENT_AUTH_CHANGED_EVENT, handler)
}

export function isClientAuthResponse(input: unknown): input is ClientAuthResponse {
    if (!isRecord(input)) return false
    return input.ok === true && isClientAuthSession(input)
}

export function isClientTokenRefreshResponse(input: unknown): input is ClientTokenRefreshResponse {
    if (!isRecord(input)) return false
    return input.ok === true && hasValidClientTokens(input)
}

export function clientAuthSessionFromResponse(response: ClientAuthResponse): ClientAuthSession {
    return {
        accessToken: response.accessToken,
        accessTokenExpire: response.accessTokenExpire,
        refreshToken: response.refreshToken,
        refreshTokenExpire: response.refreshTokenExpire,
        user: response.user,
    }
}

export function clientAuthSessionFromRefreshResponse(response: ClientTokenRefreshResponse, current: ClientAuthSession): ClientAuthSession {
    return {
        accessToken: response.accessToken,
        accessTokenExpire: response.accessTokenExpire,
        refreshToken: response.refreshToken,
        refreshTokenExpire: response.refreshTokenExpire,
        user: isClientUser(response.user) ? response.user : current.user,
    }
}

export function isClientAuthExpiringSoon(expireAt: string) {
    return Date.parse(expireAt) - Date.now() < 60_000
}

function isClientAuthSession(input: unknown): input is ClientAuthSession {
    if (!isRecord(input)) return false
    return hasValidClientTokens(input) && isClientUser(input.user)
}

function isClientUser(input: unknown): input is ClientUser {
    if (!isRecord(input)) return false
    return (
        typeof input.id === "number"
        && typeof input.username === "string"
        && (typeof input.name === "string" || input.name === null)
        && (typeof input.department === "string" || input.department === null)
        && typeof input.role === "string"
        && (typeof input.quotaLimit === "number" || input.quotaLimit === null)
        && typeof input.quotaUsed === "number"
    )
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null
}

function hasValidClientTokens(input: Record<string, unknown>) {
    return (
        typeof input.accessToken === "string"
        && input.accessToken.length > 0
        && typeof input.accessTokenExpire === "string"
        && Number.isFinite(Date.parse(input.accessTokenExpire))
        && typeof input.refreshToken === "string"
        && input.refreshToken.length > 0
        && typeof input.refreshTokenExpire === "string"
        && Number.isFinite(Date.parse(input.refreshTokenExpire))
    )
}

function parseStoredSession(raw: string) {
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return null
    }
}

function notifyClientAuthSessionChange(session: ClientAuthSession | null) {
    window.dispatchEvent(new CustomEvent(CLIENT_AUTH_CHANGED_EVENT, { detail: { session } }))
}
