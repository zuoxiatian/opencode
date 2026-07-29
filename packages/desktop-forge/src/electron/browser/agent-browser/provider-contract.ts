export const AGENT_BROWSER_PLUGIN_PROTOCOL = "agent-browser.plugin.v1" as const
export const DESKTOP_FORGE_AGENT_BROWSER_PROVIDER = "desktop-forge" as const
export const DESKTOP_FORGE_AGENT_BROWSER_CDP_URL = "DESKTOP_FORGE_AGENT_BROWSER_CDP_URL" as const

export type AgentBrowserProviderRequest = {
    capability: "browser.provider"
    protocol: typeof AGENT_BROWSER_PLUGIN_PROTOCOL
    request: {
        launchOptions: {
            colorScheme: string | null
            engine: string
            headed: boolean
            userAgent: string | null
        }
        provider: typeof DESKTOP_FORGE_AGENT_BROWSER_PROVIDER
        session: string
    }
    type: "browser.launch"
}

export type AgentBrowserProviderResponse = {
    browser: {
        cdpUrl: string
        directPage: true
    }
    protocol: typeof AGENT_BROWSER_PLUGIN_PROTOCOL
    success: true
}

export function parseAgentBrowserProviderRequest(input: string): AgentBrowserProviderRequest {
    return validateAgentBrowserProviderRequest(JSON.parse(input))
}

export function validateAgentBrowserProviderRequest(input: unknown): AgentBrowserProviderRequest {
    const request = asRecord(input)
    const payload = asRecord(request.request)
    const launchOptions = asRecord(payload.launchOptions)
    if (
        request.protocol !== AGENT_BROWSER_PLUGIN_PROTOCOL
        || request.capability !== "browser.provider"
        || request.type !== "browser.launch"
        || payload.provider !== DESKTOP_FORGE_AGENT_BROWSER_PROVIDER
        || typeof payload.session !== "string"
        || !payload.session
        || typeof launchOptions.engine !== "string"
        || typeof launchOptions.headed !== "boolean"
        || !isOptionalString(launchOptions.colorScheme)
        || !isOptionalString(launchOptions.userAgent)
    ) {
        throw new Error("Invalid agent-browser provider request")
    }
    return input as AgentBrowserProviderRequest
}

export function agentBrowserProviderResponse(cdpUrl: string): AgentBrowserProviderResponse {
    const url = new URL(cdpUrl)
    if (url.protocol !== "ws:" || !isLoopback(url.hostname) || !url.pathname.startsWith("/cdp/")) {
        throw new Error("Invalid desktop-forge CDP Gateway URL")
    }
    return {
        browser: {
            cdpUrl,
            directPage: true,
        },
        protocol: AGENT_BROWSER_PLUGIN_PROTOCOL,
        success: true,
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function isOptionalString(value: unknown) {
    return value === null || typeof value === "string"
}

function isLoopback(hostname: string) {
    return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}
