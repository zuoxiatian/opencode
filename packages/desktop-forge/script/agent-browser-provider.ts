import { readFileSync } from "node:fs"
import {
    DESKTOP_FORGE_AGENT_BROWSER_CDP_URL,
    agentBrowserProviderResponse,
    parseAgentBrowserProviderRequest,
} from "../src/electron/browser/agent-browser/provider-contract"

parseAgentBrowserProviderRequest(readFileSync(0, "utf8"))

const cdpUrl = process.env[DESKTOP_FORGE_AGENT_BROWSER_CDP_URL]
if (!cdpUrl) throw new Error("Desktop browser Gateway is unavailable")

process.stdout.write(JSON.stringify(agentBrowserProviderResponse(cdpUrl)))
