import { BROWSER_PROTOCOL_VERSION } from "./browser"
import type { BrowserCommand, BrowserCommandInput } from "./commands"
import type { BrowserCommandRequest } from "./results"

export const BROWSER_COMMAND_NAMES = [
  "browser.hide",
  "browser.list",
  "browser.nameSession",
  "browser.show",
  "browser.state",
  "browser.user.claimTab",
  "browser.user.history",
  "browser.user.openTabs",
  "browser.viewport.reset",
  "browser.viewport.set",
  "tab.activate",
  "tab.back",
  "tab.clipboard.read",
  "tab.clipboard.readText",
  "tab.clipboard.write",
  "tab.clipboard.writeText",
  "tab.close",
  "tab.cua.click",
  "tab.cua.downloadMedia",
  "tab.cua.doubleClick",
  "tab.cua.drag",
  "tab.cua.keypress",
  "tab.cua.move",
  "tab.cua.scroll",
  "tab.cua.type",
  "tab.dev.cdp",
  "tab.dev.cdp.events",
  "tab.dev.logs",
  "tab.dialog.get",
  "tab.dialog.handle",
  "tab.dialog.wait",
  "tab.domCua.click",
  "tab.domCua.downloadMedia",
  "tab.domCua.doubleClick",
  "tab.domCua.getVisibleDom",
  "tab.domCua.keypress",
  "tab.domCua.scroll",
  "tab.domCua.type",
  "tab.download.get",
  "tab.download.wait",
  "tab.fileChooser.setFiles",
  "tab.fileChooser.wait",
  "tab.forward",
  "tab.goto",
  "tab.mark",
  "tab.playwright.locator.allTextContents",
  "tab.playwright.locator.check",
  "tab.playwright.locator.click",
  "tab.playwright.locator.count",
  "tab.playwright.locator.dblclick",
  "tab.playwright.locator.downloadMedia",
  "tab.playwright.locator.evaluate",
  "tab.playwright.locator.fill",
  "tab.playwright.locator.getAttribute",
  "tab.playwright.locator.innerText",
  "tab.playwright.locator.isEnabled",
  "tab.playwright.locator.isVisible",
  "tab.playwright.locator.press",
  "tab.playwright.locator.selectOption",
  "tab.playwright.locator.setChecked",
  "tab.playwright.locator.textContent",
  "tab.playwright.locator.type",
  "tab.playwright.locator.uncheck",
  "tab.playwright.locator.waitFor",
  "tab.playwright.expectNavigation",
  "tab.playwright.evaluate",
  "tab.playwright.domSnapshot",
  "tab.playwright.html",
  "tab.playwright.elementInfo",
  "tab.playwright.elementScreenshot",
  "tab.playwright.waitForLoadState",
  "tab.playwright.waitForTimeout",
  "tab.playwright.waitForURL",
  "tab.reload",
  "tab.screenshot",
  "tab.state",
  "tab.stop",
  "tabs.finalize",
  "tabs.get",
  "tabs.list",
  "tabs.new",
  "tabs.selected",
] as const satisfies readonly BrowserCommand["name"][]

type MissingBrowserCommandName = Exclude<BrowserCommand["name"], (typeof BROWSER_COMMAND_NAMES)[number]>
const browserCommandNamesAreComplete: [MissingBrowserCommandName] extends [never] ? true : never = true
void browserCommandNamesAreComplete

const commandNames = new Set<string>(BROWSER_COMMAND_NAMES)

export function parseBrowserCommandRequest(input: unknown): BrowserCommandRequest {
  const request = readRecord(input, "request")
  if (request.protocolVersion !== BROWSER_PROTOCOL_VERSION) throw new Error("Unsupported browser protocol version")
  return {
    browserId: readString(request.browserId, "browserId"),
    callId: readOptionalString(request.callId, "callId"),
    command: parseBrowserCommand(request.command),
    expectedOrigin: readOptionalString(request.expectedOrigin, "expectedOrigin"),
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    requestId: readString(request.requestId, "requestId"),
    sessionId: readString(request.sessionId, "sessionId"),
    tabId: readOptionalString(request.tabId, "tabId"),
  }
}

export function parseBrowserCommandInput(input: unknown): BrowserCommandInput {
  const request = readRecord(input, "input")
  return {
    browserId: readOptionalString(request.browserId, "browserId"),
    command: parseBrowserCommand(request.command),
    expectedOrigin: readOptionalString(request.expectedOrigin, "expectedOrigin"),
    tabId: readOptionalString(request.tabId, "tabId"),
  }
}

export function parseBrowserCommand(input: unknown): BrowserCommand {
  const command = readRecord(input, "command")
  const name = readString(command.name, "command.name")
  if (!commandNames.has(name)) throw new Error(`Unsupported browser command: ${name}`)
  validateCommand(command, name)
  return command as unknown as BrowserCommand
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function readRecord(input: unknown, name: string) {
  if (isRecord(input)) return input
  throw new Error(`${name} must be an object`)
}

function readString(input: unknown, name: string) {
  if (typeof input === "string" && input.length > 0) return input
  throw new Error(`${name} must be a non-empty string`)
}

function readOptionalString(input: unknown, name: string) {
  if (input === undefined) return undefined
  return readString(input, name)
}

function validateCommand(command: Record<string, unknown>, name: string) {
  if (name === "browser.nameSession") {
    readString(command.value, "command.value")
    return
  }
  if (name === "browser.user.claimTab") {
    readString(command.claimId, "command.claimId")
    return
  }
  if (name === "browser.user.history") {
    const queries = readStringArray(command.queries, "command.queries")
    if (queries !== undefined && !queries.length) throw new Error("command.queries must not be empty")
    const limit = readOptionalNumber(command.limit, "command.limit")
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("command.limit must be a positive integer")
    }
    readOptionalDate(command.from, "command.from")
    readOptionalDate(command.to, "command.to")
    return
  }
  if (name === "browser.viewport.set") {
    const bounds = readRecord(command.bounds, "command.bounds")
    const values = [
      readNumber(bounds.height, "command.bounds.height"),
      readNumber(bounds.width, "command.bounds.width"),
      readNumber(bounds.x, "command.bounds.x"),
      readNumber(bounds.y, "command.bounds.y"),
    ]
    if (values.some((value) => value < 0 || value > 32_768)) {
      throw new Error("command.bounds values must be between 0 and 32768")
    }
    return
  }
  if (name === "tabs.get") {
    readString(command.targetTabId, "command.targetTabId")
    return
  }
  if (name === "tabs.finalize") {
    if (command.keep === undefined) return
    if (!Array.isArray(command.keep)) throw new Error("command.keep must be an array")
    command.keep.forEach((input, index) => {
      const item = readRecord(input, `command.keep[${index}]`)
      readString(item.tabId, `command.keep[${index}].tabId`)
      if (item.status !== "deliverable" && item.status !== "handoff") {
        throw new Error(`command.keep[${index}].status is invalid`)
      }
    })
    return
  }
  if (name === "tab.mark") {
    if (!readDisposition(command.disposition)) throw new Error("command.disposition is required")
    return
  }
  if (name === "tab.goto") {
    readString(command.url, "command.url")
    return
  }
  if (name === "tab.screenshot") {
    readScreenshot(command)
    return
  }
  if (name === "tab.playwright.waitForURL") {
    readString(command.url, "command.url")
    readLoadState(command.waitUntil, "command.waitUntil", true)
    readTimeout(command.timeout)
    return
  }
  if (name === "tab.playwright.evaluate") {
    readString(command.expression, "command.expression")
    readTimeout(command.timeout)
    return
  }
  if (name === "tab.playwright.elementInfo" || name === "tab.playwright.elementScreenshot") {
    readNumber(command.x, "command.x")
    readNumber(command.y, "command.y")
    if (command.includeNonInteractable !== undefined) {
      readBoolean(command.includeNonInteractable, "command.includeNonInteractable")
    }
    return
  }
  if (name === "tab.playwright.expectNavigation") {
    readTimeout(command.timeout)
    readOptionalString(command.url, "command.url")
    readLoadState(command.waitUntil, "command.waitUntil", true)
    if (command.trigger !== undefined) readLocator(command.trigger)
    return
  }
  if (name === "tab.playwright.waitForLoadState") {
    if (!readLoadState(command.state, "command.state")) throw new Error("command.state is required")
    readTimeout(command.timeout)
    return
  }
  if (name === "tab.playwright.waitForTimeout") {
    if (command.timeout === undefined) throw new Error("command.timeout is required")
    readTimeout(command.timeout)
    return
  }
  if (name.startsWith("tab.playwright.locator.")) {
    readLocator(command.locator)
    readTimeout(command.timeout)
    readOptionalString(command.attribute, "command.attribute")
    readOptionalString(command.expression, "command.expression")
    readStringArray(command.filePaths, "command.filePaths")
    readButton(command.button)
    if (command.force !== undefined) readBoolean(command.force, "command.force")
    readOptionalString(command.key, "command.key")
    const modifiers = readStringArray(command.modifiers, "command.modifiers")
    if (modifiers?.some((modifier) => !["alt", "control", "meta", "shift"].includes(modifier))) {
      throw new Error("command.modifiers contains an unsupported key")
    }
    if (command.options !== undefined) {
      if (!Array.isArray(command.options) || !command.options.length || command.options.length > 100) {
        throw new Error("command.options must contain between 1 and 100 items")
      }
      command.options.forEach((input, index) => {
        const option = readRecord(input, `command.options[${index}]`)
        const label = readOptionalString(option.label, `command.options[${index}].label`)
        const value = readOptionalString(option.value, `command.options[${index}].value`)
        const optionIndex = readOptionalNumber(option.index, `command.options[${index}].index`)
        if (optionIndex !== undefined && (!Number.isInteger(optionIndex) || optionIndex < 0)) {
          throw new Error(`command.options[${index}].index must be a non-negative integer`)
        }
        if (label === undefined && value === undefined && optionIndex === undefined) {
          throw new Error(`command.options[${index}] requires value, label, or index`)
        }
      })
    }
    if (command.checked !== undefined) readBoolean(command.checked, "command.checked")
    if (
      command.state !== undefined
      && command.state !== "attached"
      && command.state !== "detached"
      && command.state !== "hidden"
      && command.state !== "visible"
    ) {
      throw new Error("command.state is invalid")
    }
    if (command.value !== undefined && typeof command.value !== "string") {
      throw new Error("command.value must be a string")
    }
    if (name === "tab.playwright.locator.getAttribute") {
      readString(command.attribute, "command.attribute")
    }
    if (name === "tab.playwright.locator.evaluate") {
      readString(command.expression, "command.expression")
    }
    if (name === "tab.playwright.locator.setChecked") {
      readBoolean(command.checked, "command.checked")
    }
    if (name === "tab.playwright.locator.waitFor" && command.state === undefined) {
      throw new Error("command.state is required")
    }
    return
  }
  if (name === "tab.domCua.getVisibleDom") return
  if (
    name === "tab.domCua.click"
    || name === "tab.domCua.doubleClick"
    || name === "tab.domCua.downloadMedia"
  ) {
    readString(command.nodeId, "command.nodeId")
    readOptionalString(command.snapshotId, "command.snapshotId")
    if (name === "tab.domCua.downloadMedia") readTimeout(command.timeout)
    return
  }
  if (name === "tab.domCua.scroll") {
    readOptionalString(command.nodeId, "command.nodeId")
    readOptionalString(command.snapshotId, "command.snapshotId")
    readNumber(command.deltaX, "command.deltaX")
    readNumber(command.deltaY, "command.deltaY")
    return
  }
  if (name === "tab.domCua.type") {
    readStringAllowEmpty(command.text, "command.text")
    return
  }
  if (name === "tab.domCua.keypress") {
    const keys = readStringArray(command.keys, "command.keys")
    if (!keys?.length) throw new Error("command.keys must not be empty")
    return
  }
  if (
    name === "tab.cua.click"
    || name === "tab.cua.doubleClick"
    || name === "tab.cua.downloadMedia"
    || name === "tab.cua.move"
  ) {
    readNumber(command.x, "command.x")
    readNumber(command.y, "command.y")
    if (name === "tab.cua.downloadMedia") {
      readTimeout(command.timeout)
      return
    }
    if (name === "tab.cua.click") {
      const button = readOptionalNumber(command.button, "command.button")
      if (button !== undefined && (!Number.isInteger(button) || button < 1 || button > 5)) {
        throw new Error("command.button must be an integer between 1 and 5")
      }
    }
    readModifiers(command.modifiers)
    return
  }
  if (name === "tab.cua.drag") {
    if (!Array.isArray(command.path) || command.path.length < 1 || command.path.length > 1_000) {
      throw new Error("command.path must contain between 1 and 1000 points")
    }
    command.path.forEach((input, index) => {
      const point = readRecord(input, `command.path[${index}]`)
      readNumber(point.x, `command.path[${index}].x`)
      readNumber(point.y, `command.path[${index}].y`)
    })
    readModifiers(command.modifiers)
    return
  }
  if (name === "tab.cua.scroll") {
    readNumber(command.deltaY, "command.deltaY")
    readOptionalNumber(command.deltaX, "command.deltaX")
    readNumber(command.x, "command.x")
    readNumber(command.y, "command.y")
    readModifiers(command.modifiers)
    return
  }
  if (name === "tab.cua.type" || name === "tab.clipboard.writeText") {
    readStringAllowEmpty(command.text, "command.text")
    return
  }
  if (name === "tab.clipboard.write") {
    readClipboardItems(command.items)
    return
  }
  if (name === "tab.cua.keypress") {
    const keys = readStringArray(command.keys, "command.keys")
    if (!keys?.length) throw new Error("command.keys must not be empty")
    return
  }
  if (name === "tab.dialog.handle") {
    readString(command.dialogId, "command.dialogId")
    readBoolean(command.accept, "command.accept")
    readOptionalString(command.promptText, "command.promptText")
    return
  }
  if (name === "tab.dialog.wait" || name === "tab.fileChooser.wait" || name === "tab.download.wait") {
    readTimeout(command.timeout)
    if (command.trigger !== undefined) readLocator(command.trigger)
    return
  }
  if (name === "tab.fileChooser.setFiles") {
    readString(command.chooserId, "command.chooserId")
    const files = readStringArray(command.filePaths, "command.filePaths")
    if (!files?.length) throw new Error("command.filePaths must not be empty")
    if (files.length > 100) throw new Error("command.filePaths must contain at most 100 files")
    readTimeout(command.timeout)
    return
  }
  if (name === "tab.download.get") {
    readString(command.downloadId, "command.downloadId")
    return
  }
  if (name === "tab.dev.cdp") {
    readString(command.method, "command.method")
    if (command.params !== undefined) readRecord(command.params, "command.params")
    readCdpTarget(command.target)
    readTimeout(command.timeout)
    if (command.timeout === 0) throw new Error("command.timeout must be a positive integer")
    return
  }
  if (name === "tab.dev.cdp.events") {
    const afterSequence = readOptionalNumber(command.afterSequence, "command.afterSequence")
    if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      throw new Error("command.afterSequence must be a non-negative integer")
    }
    const limit = readOptionalNumber(command.limit, "command.limit")
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > 1_000)) {
      throw new Error("command.limit must be an integer between 1 and 1000")
    }
    const methods = readStringArray(command.methods, "command.methods")
    if (methods !== undefined && !methods.length) throw new Error("command.methods must not be empty")
    readCdpTarget(command.target)
    readTimeout(command.timeout)
    return
  }
  if (name === "tab.dev.logs") {
    readOptionalString(command.filter, "command.filter")
    const levels = readStringArray(command.levels, "command.levels")
    if (levels?.some((level) => !["debug", "error", "info", "log", "warn", "warning"].includes(level))) {
      throw new Error("command.levels contains an unsupported log level")
    }
    const limit = readOptionalNumber(command.limit, "command.limit")
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1_000)) {
      throw new Error("command.limit must be an integer between 1 and 1000")
    }
  }
}

function readLocator(input: unknown) {
  const locator = readRecord(input, "command.locator")
  const values = ["css", "frameId", "href", "label", "name", "placeholder", "role", "selector", "testId", "text"]
    .map((key) => readOptionalString(locator[key], `command.locator.${key}`))
  readStringArray(locator.frameSelectors, "command.locator.frameSelectors")
  if (!values.some(Boolean)) throw new Error("command.locator requires at least one locator field")
  if (locator.exact !== undefined) readBoolean(locator.exact, "command.locator.exact")
}

function readScreenshot(command: Record<string, unknown>) {
  if (command.clip !== undefined && command.fullPage === true) {
    throw new Error("command.clip and command.fullPage cannot be used together")
  }
  if (command.clip !== undefined) {
    const clip = readRecord(command.clip, "command.clip")
    const height = readNumber(clip.height, "command.clip.height")
    const width = readNumber(clip.width, "command.clip.width")
    const x = readNumber(clip.x, "command.clip.x")
    const y = readNumber(clip.y, "command.clip.y")
    if (height <= 0 || width <= 0 || x < 0 || y < 0) {
      throw new Error("command.clip must have positive dimensions and non-negative coordinates")
    }
    if (height > 32_768 || width > 32_768 || x > 1_000_000 || y > 1_000_000) {
      throw new Error("command.clip exceeds the supported bounds")
    }
  }
  if (command.fullPage !== undefined) readBoolean(command.fullPage, "command.fullPage")
  if (command.imageFormat !== undefined && command.imageFormat !== "jpeg" && command.imageFormat !== "png") {
    throw new Error("command.imageFormat must be jpeg or png")
  }
  const quality = readOptionalNumber(command.quality, "command.quality")
  if (quality !== undefined && (quality < 0 || quality > 100)) {
    throw new Error("command.quality must be between 0 and 100")
  }
}

function readCdpTarget(input: unknown) {
  if (input === undefined) return
  const target = readRecord(input, "command.target")
  const sessionId = readOptionalString(target.sessionId, "command.target.sessionId")
  const targetId = readOptionalString(target.targetId, "command.target.targetId")
  if (Boolean(sessionId) === Boolean(targetId)) {
    throw new Error("command.target requires exactly one of sessionId or targetId")
  }
}

function readDisposition(input: unknown) {
  if (input === undefined) return undefined
  if (input === "deliverable" || input === "handoff" || input === "temporary") return input
  throw new Error("command.disposition is invalid")
}

function readLoadState(input: unknown, name: string, allowCommit = false) {
  if (input === undefined) return undefined
  if (allowCommit && input === "commit") return input
  if (input === "domcontentloaded" || input === "load" || input === "networkidle") return input
  throw new Error(`${name} is invalid`)
}

function readButton(input: unknown) {
  if (input === undefined || input === "left" || input === "middle" || input === "right") return
  throw new Error("command.button is invalid")
}

function readModifiers(input: unknown) {
  const modifiers = readStringArray(input, "command.modifiers")
  if (modifiers?.some((modifier) => !["alt", "control", "meta", "shift"].includes(modifier))) {
    throw new Error("command.modifiers contains an unsupported key")
  }
}

function readNumber(input: unknown, name: string) {
  if (typeof input === "number" && Number.isFinite(input)) return input
  throw new Error(`${name} must be a finite number`)
}

function readOptionalNumber(input: unknown, name: string) {
  if (input === undefined) return undefined
  return readNumber(input, name)
}

function readTimeout(input: unknown) {
  const timeout = readOptionalNumber(input, "command.timeout")
  if (timeout === undefined) return
  if (timeout < 0 || timeout > 10 * 60_000) {
    throw new Error("command.timeout must be between 0 and 600000 milliseconds")
  }
}

function readBoolean(input: unknown, name: string) {
  if (typeof input === "boolean") return input
  throw new Error(`${name} must be a boolean`)
}

function readStringAllowEmpty(input: unknown, name: string) {
  if (typeof input === "string") return input
  throw new Error(`${name} must be a string`)
}

function readStringArray(input: unknown, name: string) {
  if (input === undefined) return undefined
  if (
    Array.isArray(input)
    && input.length <= 1_000
    && input.every((value) => typeof value === "string")
  ) return input
  throw new Error(`${name} must be a string array`)
}

function readOptionalDate(input: unknown, name: string) {
  if (input === undefined) return
  const value = readString(input, name)
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO date`)
}

function readClipboardItems(input: unknown) {
  if (!Array.isArray(input) || !input.length) {
    throw new Error("command.items must contain at least one clipboard item")
  }
  input.forEach((itemInput, itemIndex) => {
    const item = readRecord(itemInput, `command.items[${itemIndex}]`)
    if (
      item.presentationStyle !== undefined
      && item.presentationStyle !== "attachment"
      && item.presentationStyle !== "inline"
      && item.presentationStyle !== "unspecified"
    ) {
      throw new Error(`command.items[${itemIndex}].presentationStyle is invalid`)
    }
    if (!Array.isArray(item.entries) || !item.entries.length) {
      throw new Error(`command.items[${itemIndex}].entries must not be empty`)
    }
    item.entries.forEach((entryInput, entryIndex) => {
      const entry = readRecord(entryInput, `command.items[${itemIndex}].entries[${entryIndex}]`)
      readString(entry.mimeType, `command.items[${itemIndex}].entries[${entryIndex}].mimeType`)
      if ((entry.text === undefined) === (entry.base64 === undefined)) {
        throw new Error(`command.items[${itemIndex}].entries[${entryIndex}] requires exactly one of text or base64`)
      }
      if (entry.text !== undefined) readStringAllowEmpty(
        entry.text,
        `command.items[${itemIndex}].entries[${entryIndex}].text`,
      )
      if (entry.base64 !== undefined) {
        const base64 = readStringAllowEmpty(
          entry.base64,
          `command.items[${itemIndex}].entries[${entryIndex}].base64`,
        )
        try {
          atob(base64)
        } catch {
          throw new Error(`command.items[${itemIndex}].entries[${entryIndex}].base64 must be valid base64`)
        }
      }
    })
  })
}
