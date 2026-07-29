import { app } from "electron"
import path from "node:path"
import manifest from "../../../../resources/agent-browser/manifest.json"
import { packageDir } from "../../resources/paths"
import { AgentBrowserTabController } from "./controller"
import { CdpTabGateway } from "./gateway"
import { writeAgentBrowserDiagnostic } from "./diagnostics"
import {
    AgentBrowserProcessManager,
    agentBrowserPlatformKey,
    agentBrowserResourcePaths,
    agentBrowserSocketDir,
} from "./process-manager"

export function createAgentBrowserTabController() {
    const key = agentBrowserPlatformKey()
    const artifact = manifest.artifacts[key]
    const resources = agentBrowserResourcePaths(
        app.isPackaged ? process.resourcesPath : path.join(packageDir(), "resources"),
    )
    const runtimeDir = path.join(app.getPath("userData"), "agent-browser")
    return new AgentBrowserTabController(
        new CdpTabGateway(Date.now, 10_000, writeAgentBrowserDiagnostic),
        new AgentBrowserProcessManager({
            binary: resources.binary,
            diagnostic: writeAgentBrowserDiagnostic,
            expectedSha256: app.isPackaged && process.platform === "darwin"
                ? undefined
                : artifact.sha256,
            expectedVersion: manifest.version,
            provider: {
                command: resources.provider,
            },
            runtimeDir,
            socketDir: agentBrowserSocketDir(runtimeDir),
        }),
        4,
        writeAgentBrowserDiagnostic,
    )
}
