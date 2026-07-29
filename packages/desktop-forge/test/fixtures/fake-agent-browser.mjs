if (process.argv.includes("--version")) {
    process.stdout.write("agent-browser 0.33.0\n")
    process.exit(0)
}

const command = process.argv.slice(process.argv.indexOf("--json") + 1)
if (command[0] === "hang") {
    setInterval(() => undefined, 1_000)
} else if (command[0] === "fail-auth") {
    process.stdout.write(JSON.stringify({
        error: "CDP WebSocket connect failed: HTTP error: 401 Unauthorized",
        success: false,
    }))
    process.exit(1)
} else if (command[0] === "fail-locator") {
    process.stdout.write(JSON.stringify({
        error: "No element found: #private-account-selector",
        success: false,
    }))
    process.exit(1)
} else if (command[0] === "fail-cdp-policy") {
    process.stdout.write(JSON.stringify({
        error: "CDP method is not allowed",
        success: false,
    }))
    process.exit(1)
} else if (command[0] === "fail-actionable") {
    process.stdout.write(JSON.stringify({
        error: "Element is not visible: #private-hidden-selector",
        success: false,
    }))
    process.exit(1)
} else if (command[0] === "fail-timeout") {
    process.stdout.write(JSON.stringify({
        error: "Timed out waiting for selector: #private-late-selector",
        success: false,
    }))
    process.exit(1)
} else {
    process.stdout.write(JSON.stringify({
        data: {
            cdpUrl: process.env.DESKTOP_FORGE_AGENT_BROWSER_CDP_URL,
            command,
            config: process.env.AGENT_BROWSER_CONFIG,
            noAutoDialog: process.env.AGENT_BROWSER_NO_AUTO_DIALOG,
            plugins: JSON.parse(process.env.AGENT_BROWSER_PLUGINS ?? "[]"),
            profilePresent: process.env.AGENT_BROWSER_PROFILE !== undefined,
            provider: process.env.AGENT_BROWSER_PROVIDER,
            socketDir: process.env.AGENT_BROWSER_SOCKET_DIR,
        },
        error: null,
        success: true,
    }))
}
