const clientApiBaseUrl = import.meta.env.VITE_CLIENT_API_BASE_URL?.trim()
const clientOfficialUrl = importMetaValue(import.meta.env.VITE_CLIENT_OFFICIAL_URL)

if (!clientApiBaseUrl) {
    throw new Error("Missing VITE_CLIENT_API_BASE_URL")
}

export const CLIENT_API_BASE_URL = clientApiBaseUrl
export const CLIENT_DEBUG_LOGS_ENABLED = import.meta.env.DEV
export const CLIENT_OFFICIAL_URL = clientOfficialUrlValue(clientOfficialUrl)
export const CLIENT_UPDATE_CHANNEL = clientUpdateChannelValue(importMetaValue(import.meta.env.VITE_CLIENT_UPDATE_CHANNEL))

function importMetaValue(value: string | undefined) {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function isClientUpdateChannel(value: string): value is "stable" | "beta" | "dev" {
    return value === "stable" || value === "beta" || value === "dev"
}

function clientUpdateChannelValue(value: string | undefined) {
    if (!value) return "stable"
    if (isClientUpdateChannel(value)) return value
    throw new Error("VITE_CLIENT_UPDATE_CHANNEL must be stable, beta, or dev")
}

function clientOfficialUrlValue(value: string | undefined) {
    return new URL(value ?? "/#download", clientApiBaseUrl).toString()
}
