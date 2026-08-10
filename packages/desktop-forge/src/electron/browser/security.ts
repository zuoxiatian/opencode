import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { BrowserCommand, BrowserCommandRequest, BrowserState } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "./errors"

const tablessCommands = new Set<BrowserCommand["name"]>([
    "browser.hide",
    "browser.list",
    "browser.nameSession",
    "browser.show",
    "browser.state",
    "browser.user.claimTab",
    "browser.user.history",
    "browser.user.openTabs",
    "tabs.finalize",
    "tabs.get",
    "tabs.list",
    "tabs.new",
    "tabs.selected",
])

const errorPageCommands = new Set<BrowserCommand["name"]>([
    "tab.activate",
    "tab.back",
    "tab.close",
    "tab.download.get",
    "tab.forward",
    "tab.goto",
    "tab.mark",
    "tab.reload",
    "tab.screenshot",
    "tab.state",
    "tab.stop",
])

const blockingDialogCommands = new Set<BrowserCommand["name"]>([
    "tab.activate",
    "tab.close",
    "tab.dialog.get",
    "tab.dialog.handle",
    "tab.dialog.wait",
    "tab.state",
])

const emptyTabCommands = new Set<BrowserCommand["name"]>([
    "tab.activate",
    "tab.close",
    "tab.goto",
    "tab.mark",
    "tab.state",
])

export class BrowserSecurityGate {
    ensureAllowed(request: BrowserCommandRequest, state: BrowserState) {
        if (!request.requestId || !request.sessionId) {
            throw new BrowserRuntimeException("INVALID_COMMAND", "Browser request identity is missing")
        }
        if (!tablessCommands.has(request.command.name) && !request.tabId) {
            throw new BrowserRuntimeException("INVALID_COMMAND", `${request.command.name} requires a tabId`)
        }

        const tab = request.tabId ? state.tabs.find((candidate) => candidate.id === request.tabId) : undefined
        if (request.tabId && !tab) {
            throw new BrowserRuntimeException("TAB_NOT_FOUND", `Browser tab not found: ${request.tabId}`)
        }
        if (
            request.sessionId !== "renderer"
            && tab
            && tab.ownership.ownerSessionId !== request.sessionId
        ) {
            throw new BrowserRuntimeException("TAB_NOT_OWNED", "Browser tab is controlled by another session")
        }
        if (tab?.error && !errorPageCommands.has(request.command.name)) {
            throw new BrowserRuntimeException("NAVIGATION_FAILED", `Page failed to load: ${tab.error.description}`, true)
        }
        if (tab && !tab.url && !emptyTabCommands.has(request.command.name)) {
            throw new BrowserRuntimeException("NAVIGATION_FAILED", "Browser tab has not opened a page")
        }
        if (tab?.dialog && !blockingDialogCommands.has(request.command.name)) {
            throw new BrowserRuntimeException("DIALOG_REQUIRED", "The page has a blocking JavaScript dialog")
        }
        if (
            (request.command.name === "tab.dev.cdp" || request.command.name === "tab.dev.cdp.events")
            && !request.expectedOrigin
        ) {
            throw new BrowserRuntimeException("PERMISSION_DENIED", "CDP commands require an approved page origin")
        }
        if (
            (
                request.command.name.startsWith("tab.automation.")
                || request.command.name === "tab.pdf"
                || (
                    request.command.name === "tab.screenshot"
                    && (request.command.annotate === true || request.command.target !== undefined)
                )
            )
            && !request.expectedOrigin
        ) {
            throw new BrowserRuntimeException(
                "PERMISSION_DENIED",
                "Browser automation requires an approved page origin",
            )
        }

        if (request.expectedOrigin) {
            const origin = browserOrigin(tab?.url ?? "")
            if (!origin || origin !== request.expectedOrigin) {
                throw new BrowserRuntimeException("ORIGIN_CHANGED", "The page origin changed after permission was granted", true, {
                    actualOrigin: origin,
                    expectedOrigin: request.expectedOrigin,
                })
            }
        }

        if (request.command.name === "tab.fileChooser.setFiles") {
            const invalid = request.command.filePaths.find((file) => !isAbsolute(file) || !existsSync(file))
            if (invalid) {
                throw new BrowserRuntimeException("PERMISSION_DENIED", `Upload file does not exist: ${invalid}`)
            }
        }
        if (request.command.name === "tab.goto") validateWebUrl(request.command.url)
        if (request.command.name === "tab.automation.read" && request.command.url) {
            validateWebUrl(request.command.url)
        }
        if (request.command.name === "tab.screenshot" && request.command.clip) {
            if (
                request.command.clip.width <= 0
                || request.command.clip.height <= 0
                || request.command.clip.x < 0
                || request.command.clip.y < 0
            ) {
                throw new BrowserRuntimeException("INVALID_COMMAND", "Screenshot clip must have a positive size")
            }
        }
        if (
            request.command.name === "tab.cua.click"
            || request.command.name === "tab.cua.doubleClick"
            || request.command.name === "tab.cua.downloadMedia"
            || request.command.name === "tab.cua.move"
        ) {
            validatePoint(request.command.x, request.command.y, state)
        }
        if (request.command.name === "tab.cua.drag") {
            request.command.path.forEach((point) => validatePoint(point.x, point.y, state))
        }
        if (
            request.command.name === "tab.cua.scroll"
            && request.command.x !== undefined
            && request.command.y !== undefined
        ) {
            validatePoint(request.command.x, request.command.y, state)
        }
    }
}

function validatePoint(x: number, y: number, state: BrowserState) {
    if (
        x < 0
        || y < 0
        || x >= state.viewport.width
        || y >= state.viewport.height
    ) {
        throw new BrowserRuntimeException("INVALID_COMMAND", "Coordinate is outside the current browser viewport")
    }
}

function validateWebUrl(input: string) {
    try {
        const value = input.trim()
        const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new BrowserRuntimeException("INVALID_COMMAND", `Unsupported browser URL protocol: ${url.protocol}`)
        }
    } catch (error) {
        if (error instanceof BrowserRuntimeException) throw error
        throw new BrowserRuntimeException("INVALID_COMMAND", `Invalid browser URL: ${input}`)
    }
}

function browserOrigin(input: string) {
    try {
        const url = new URL(input)
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
    } catch {
        return undefined
    }
}
