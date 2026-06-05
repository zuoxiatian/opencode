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
    loginToken: string
    loginTokenExpire: string
    refreshToken: string | null
    refreshTokenExpire: string | null
    user: ClientUser
}

export type ClientAuthResponse = Record<string, unknown> & {
    ok: true
    user: ClientUser
}

export type ClientTokenRefreshResponse = Record<string, unknown> & {
    ok: true
    user?: unknown
}

export function readStoredClientAuthSession() {
    const raw = localStorage.getItem(CLIENT_AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = parseStoredSession(raw)
    const session = clientAuthSessionFromStored(parsed)
    if (!session) {
        clearClientAuthSession()
        return null
    }
    if (isClientAuthSessionExpired(session)) {
        clearClientAuthSession()
        return null
    }
    return session
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
    return input.ok === true && isClientUser(input.user) && authTokensFromRecord(input) !== null
}

export function isClientTokenRefreshResponse(input: unknown): input is ClientTokenRefreshResponse {
    if (!isRecord(input)) return false
    return input.ok === true && authTokensFromRecord(input) !== null
}

export function clientAuthSessionFromResponse(response: ClientAuthResponse): ClientAuthSession {
    const tokens = authTokensFromRecord(response)
    if (!tokens) throw new Error("登录响应缺少 token")

    return {
        ...tokens,
        user: response.user,
    }
}

export function clientAuthSessionFromRefreshResponse(response: ClientTokenRefreshResponse, current: ClientAuthSession): ClientAuthSession {
    const tokens = authTokensFromRecord(response)
    if (!tokens) throw new Error("刷新登录态响应缺少 token")

    return {
        loginToken: tokens.loginToken,
        loginTokenExpire: tokens.loginTokenExpire,
        refreshToken: tokens.refreshToken ?? current.refreshToken,
        refreshTokenExpire: tokens.refreshTokenExpire ?? current.refreshTokenExpire,
        user: isClientUser(response.user) ? response.user : current.user,
    }
}

export function isClientAuthExpiringSoon(expireAt: string) {
    return Date.parse(expireAt) - Date.now() < 60_000
}

export function isClientAuthSessionExpired(session: ClientAuthSession) {
    if (Date.parse(session.loginTokenExpire) > Date.now()) return false
    if (!session.refreshTokenExpire) return true
    return Date.parse(session.refreshTokenExpire) <= Date.now()
}

function clientAuthSessionFromStored(input: unknown): ClientAuthSession | null {
    if (!isRecord(input)) return null
    const tokens = authTokensFromRecord(input)
    if (!tokens || !isClientUser(input.user)) return null
    return {
        ...tokens,
        user: input.user,
    }
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

function authTokensFromRecord(input: Record<string, unknown>) {
    if (typeof input.loginToken === "string" && input.loginToken.length > 0
        && typeof input.loginTokenExpire === "string" && Number.isFinite(Date.parse(input.loginTokenExpire))) {
        return {
            loginToken: input.loginToken,
            loginTokenExpire: input.loginTokenExpire,
            refreshToken: nullableToken(input.refreshToken),
            refreshTokenExpire: nullableDate(input.refreshTokenExpire),
        }
    }

    if (typeof input.accessToken === "string" && input.accessToken.length > 0
        && typeof input.accessTokenExpire === "string" && Number.isFinite(Date.parse(input.accessTokenExpire))) {
        return {
            loginToken: input.accessToken,
            loginTokenExpire: input.accessTokenExpire,
            refreshToken: nullableToken(input.refreshToken),
            refreshTokenExpire: nullableDate(input.refreshTokenExpire),
        }
    }

    return null
}

function nullableToken(input: unknown) {
    return typeof input === "string" && input.length > 0 ? input : null
}

function nullableDate(input: unknown) {
    return typeof input === "string" && Number.isFinite(Date.parse(input)) ? input : null
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
