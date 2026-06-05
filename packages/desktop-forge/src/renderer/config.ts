const clientApiBaseUrl = import.meta.env.VITE_CLIENT_API_BASE_URL?.trim()

if (!clientApiBaseUrl) {
    throw new Error("Missing VITE_CLIENT_API_BASE_URL")
}

export const CLIENT_API_BASE_URL = clientApiBaseUrl
