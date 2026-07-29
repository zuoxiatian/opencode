// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import {
    AGENT_BROWSER_PLUGIN_PROTOCOL,
    DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
    agentBrowserProviderResponse,
    parseAgentBrowserProviderRequest,
} from "../src/electron/browser/agent-browser/provider-contract"

const launch = {
    capability: "browser.provider",
    protocol: AGENT_BROWSER_PLUGIN_PROTOCOL,
    request: {
        launchOptions: {
            colorScheme: null,
            engine: "chrome",
            headed: false,
            userAgent: null,
        },
        provider: DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
        session: "desktop-forge-tab",
    },
    type: "browser.launch",
}

describe("agent-browser provider contract", () => {
    test("accepts the pinned browser.launch wire shape", () => {
        expect(parseAgentBrowserProviderRequest(JSON.stringify(launch))).toEqual(launch)
    })

    test("rejects unrelated plugin requests", () => {
        expect(() => parseAgentBrowserProviderRequest(JSON.stringify({
            ...launch,
            type: "browser.close",
        }))).toThrow("Invalid agent-browser provider request")
    })

    test("returns a loopback direct-page connection", () => {
        expect(agentBrowserProviderResponse("ws://127.0.0.1:43127/cdp/opaque")).toEqual({
            browser: {
                cdpUrl: "ws://127.0.0.1:43127/cdp/opaque",
                directPage: true,
            },
            protocol: AGENT_BROWSER_PLUGIN_PROTOCOL,
            success: true,
        })
    })

    test("rejects non-loopback and discovery endpoints", () => {
        expect(() => agentBrowserProviderResponse("ws://example.com/cdp/opaque"))
            .toThrow("Invalid desktop-forge CDP Gateway URL")
        expect(() => agentBrowserProviderResponse("ws://127.0.0.1:43127/json/list"))
            .toThrow("Invalid desktop-forge CDP Gateway URL")
    })
})
