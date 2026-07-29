import { createHash } from "node:crypto"

export type AgentBrowserDiagnosticEvent = {
    activeSessions?: number
    command?: string
    component: "controller" | "gateway" | "process"
    durationMs?: number
    errorCode?: string
    event: string
    outcome?: "cancelled" | "error" | "success"
    pendingCommands?: number
    reconnectCount?: number
    tabHash?: string
    version?: string
}

export type AgentBrowserDiagnosticSink = (event: AgentBrowserDiagnosticEvent) => void

export function writeAgentBrowserDiagnostic(event: AgentBrowserDiagnosticEvent) {
    process.stderr.write(`[agent-browser] ${JSON.stringify({
        ...event,
        timestamp: Date.now(),
    })}\n`)
}

export function diagnosticHash(value: string) {
    return createHash("sha256").update(value).digest("hex").slice(0, 12)
}
