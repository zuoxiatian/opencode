// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
    BrowserCommand,
    BrowserCommandRequest,
    BrowserState,
} from "@opencode-ai/browser-protocol"
import { BrowserSecurityGate } from "../src/electron/browser/security"
import { BrowserRuntimeException } from "../src/electron/browser/errors"

describe("BrowserSecurityGate", () => {
    test("rejects automation from a session that does not own the tab", () => {
        expect(() => new BrowserSecurityGate().ensureAllowed(
            request(
                { interactiveOnly: true, name: "tab.automation.snapshot" },
                { expectedOrigin: "https://example.com", sessionId: "other-session" },
            ),
            state(),
        )).toThrow("Browser tab is controlled by another session")
    })

    test("requires approved origins for automation and raw CDP", () => {
        const gate = new BrowserSecurityGate()

        expect(() => gate.ensureAllowed(
            request({ interactiveOnly: true, name: "tab.automation.snapshot" }),
            state(),
        )).toThrow("Browser automation requires an approved page origin")
        expect(() => gate.ensureAllowed(
            request({ method: "Runtime.evaluate", name: "tab.dev.cdp" }),
            state(),
        )).toThrow("CDP commands require an approved page origin")
    })

    test("detects an origin change after permission was granted", () => {
        const error = failure(() => new BrowserSecurityGate().ensureAllowed(
            request(
                { interactiveOnly: true, name: "tab.automation.snapshot" },
                { expectedOrigin: "https://approved.example" },
            ),
            state(),
        ))

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect(error.browser).toEqual({
            code: "ORIGIN_CHANGED",
            details: {
                actualOrigin: "https://example.com",
                expectedOrigin: "https://approved.example",
            },
            message: "The page origin changed after permission was granted",
            retryable: true,
        })
    })

    test("only accepts existing absolute upload paths", async () => {
        const directory = await mkdtemp("/tmp/df-browser-security-")
        const file = path.join(directory, "upload.txt")
        await writeFile(file, "safe")
        const gate = new BrowserSecurityGate()

        expect(() => gate.ensureAllowed(
            request({
                chooserId: "chooser",
                filePaths: ["relative.txt"],
                name: "tab.fileChooser.setFiles",
            }),
            state(),
        )).toThrow("Upload file does not exist: relative.txt")
        expect(() => gate.ensureAllowed(
            request({
                chooserId: "chooser",
                filePaths: [path.join(directory, "missing.txt")],
                name: "tab.fileChooser.setFiles",
            }),
            state(),
        )).toThrow("Upload file does not exist")
        expect(() => gate.ensureAllowed(
            request({
                chooserId: "chooser",
                filePaths: [file],
                name: "tab.fileChooser.setFiles",
            }),
            state(),
        )).not.toThrow()
    })
})

function request(
    command: BrowserCommand,
    options: Partial<Omit<BrowserCommandRequest, "command">> = {},
): BrowserCommandRequest {
    return {
        browserId: "embedded",
        command,
        protocolVersion: 3,
        requestId: "request-test",
        sessionId: "owner-session",
        tabId: "tab-test",
        ...options,
    }
}

function state(): BrowserState {
    return {
        activeTabId: "tab-test",
        browserId: "embedded",
        tabs: [{
            canGoBack: false,
            canGoForward: false,
            capabilities: [],
            dialog: null,
            downloadCount: 0,
            error: null,
            favicon: null,
            generation: 1,
            id: "tab-test",
            loading: false,
            ownership: {
                createdBy: "agent",
                disposition: "temporary",
                ownerSessionId: "owner-session",
            },
            title: "Example",
            url: "https://example.com/page",
        }],
        viewport: {
            height: 768,
            width: 1024,
            x: 0,
            y: 0,
        },
        visible: true,
    }
}

function failure(callback: () => void) {
    try {
        callback()
        throw new Error("Expected BrowserSecurityGate to reject the request")
    } catch (error) {
        if (error instanceof BrowserRuntimeException) return error
        throw error
    }
}
