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
  "tab.activate",
  "tab.automation.check",
  "tab.automation.click",
  "tab.automation.count",
  "tab.automation.dblclick",
  "tab.automation.drag",
  "tab.automation.fill",
  "tab.automation.focus",
  "tab.automation.getAttribute",
  "tab.automation.getBox",
  "tab.automation.getHtml",
  "tab.automation.getStyles",
  "tab.automation.getText",
  "tab.automation.getValue",
  "tab.automation.hover",
  "tab.automation.isChecked",
  "tab.automation.isEnabled",
  "tab.automation.isVisible",
  "tab.automation.keydown",
  "tab.automation.keyboard.insertText",
  "tab.automation.keyboard.type",
  "tab.automation.keyup",
  "tab.automation.press",
  "tab.automation.read",
  "tab.automation.scroll",
  "tab.automation.scrollIntoView",
  "tab.automation.select",
  "tab.automation.snapshot",
  "tab.automation.type",
  "tab.automation.uncheck",
  "tab.automation.waitFor",
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
  "tab.pdf",
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
  if (name === "tab.pdf") return
  if (name === "tab.automation.snapshot") {
    if (command.interactive !== undefined) {
      readBoolean(command.interactive, "command.interactive")
    }
    if (command.interactiveOnly !== undefined) {
      readBoolean(command.interactiveOnly, "command.interactiveOnly")
    }
    if (command.interactive !== undefined && command.interactiveOnly !== undefined) {
      throw new Error("command.interactive and command.interactiveOnly cannot be used together")
    }
    if (command.urls !== undefined) readBoolean(command.urls, "command.urls")
    if (command.compact !== undefined) readBoolean(command.compact, "command.compact")
    if (command.selector !== undefined) readString(command.selector, "command.selector")
    const depth = readOptionalNumber(command.depth, "command.depth")
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0 || depth > 1_000)) {
      throw new Error("command.depth must be an integer between 0 and 1000")
    }
    return
  }
  if (name.startsWith("tab.automation.")) {
    readTimeout(command.timeout)
    if (name === "tab.automation.read") {
      readOptionalString(command.url, "command.url")
      if (command.raw !== undefined) readBoolean(command.raw, "command.raw")
      if (command.requireMd !== undefined) readBoolean(command.requireMd, "command.requireMd")
      if (command.outline !== undefined) readBoolean(command.outline, "command.outline")
      readOptionalString(command.filter, "command.filter")
      if (command.llms !== undefined && command.llms !== "index" && command.llms !== "full") {
        throw new Error("command.llms must be index or full")
      }
      return
    }
    if (name === "tab.automation.waitFor") {
      if (typeof command.timeout === "number" && command.timeout > 120_000) {
        throw new Error("command.timeout must not exceed 120000 milliseconds for automation waits")
      }
      if (
        [command.expression, command.loadState, command.milliseconds, command.target, command.text, command.url].filter(
          (value) => value !== undefined,
        ).length !== 1
      ) {
        throw new Error("command requires exactly one of target, text, url, loadState, expression, or milliseconds")
      }
      if (command.target !== undefined) readAutomationSelector(command.target)
      if (command.state !== undefined) {
        if (command.target === undefined) throw new Error("command.state requires command.target")
        if (!["attached", "detached", "hidden", "visible"].includes(readString(command.state, "command.state"))) {
          throw new Error("command.state must be attached, detached, hidden, or visible")
        }
      }
      if (command.expression !== undefined) readString(command.expression, "command.expression")
      if (command.loadState !== undefined) {
        if (!["domcontentloaded", "load", "networkidle"].includes(readString(command.loadState, "command.loadState"))) {
          throw new Error("command.loadState must be domcontentloaded, load, or networkidle")
        }
      }
      if (command.milliseconds !== undefined) {
        const milliseconds = readNumber(command.milliseconds, "command.milliseconds")
        if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 120_000) {
          throw new Error("command.milliseconds must be an integer between 0 and 120000")
        }
      }
      if (command.text !== undefined) readString(command.text, "command.text")
      if (command.url !== undefined) readString(command.url, "command.url")
      return
    }
    if (name === "tab.automation.press") {
      readString(command.key, "command.key")
      if (command.target !== undefined) throw new Error("command.target is not supported for tab.automation.press")
      return
    }
    if (name === "tab.automation.keydown" || name === "tab.automation.keyup") {
      readString(command.key, "command.key")
      return
    }
    if (name === "tab.automation.keyboard.type" || name === "tab.automation.keyboard.insertText") {
      readStringAllowEmpty(command.text, "command.text")
      return
    }
    if (name === "tab.automation.scroll") {
      if (
        command.direction !== undefined
        && !["down", "left", "right", "up"].includes(readString(command.direction, "command.direction"))
      ) {
        throw new Error("command.direction must be down, left, right, or up")
      }
      const amount = readOptionalNumber(command.amount, "command.amount")
      if (amount !== undefined && (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000)) {
        throw new Error("command.amount must be an integer between 0 and 1000000")
      }
      if (command.target !== undefined) readAutomationSelector(command.target)
      return
    }
    if (name === "tab.automation.drag") {
      readAutomationSelector(command.source, "command.source")
      readAutomationSelector(command.target)
      return
    }
    if (
      name === "tab.automation.click"
      || name === "tab.automation.fill"
      || name === "tab.automation.hover"
      || name === "tab.automation.check"
      || name === "tab.automation.getText"
    ) {
      readAutomationTarget(command.target)
    } else {
      readAutomationSelector(command.target)
    }
    if (name === "tab.automation.fill" || name === "tab.automation.type") {
      readStringAllowEmpty(command.value, "command.value")
    }
    if (name === "tab.automation.select") {
      const values = readStringArray(command.values, "command.values")
      if (!values?.length || values.length > 100) {
        throw new Error("command.values must contain between 1 and 100 values")
      }
    }
    if (name === "tab.automation.getAttribute") {
      readString(command.attribute, "command.attribute")
    }
    return
  }
  if (name === "tab.domCua.getVisibleDom") return
  if (name === "tab.domCua.click" || name === "tab.domCua.doubleClick" || name === "tab.domCua.downloadMedia") {
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
    name === "tab.cua.click" ||
    name === "tab.cua.doubleClick" ||
    name === "tab.cua.downloadMedia" ||
    name === "tab.cua.move"
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
    if (command.trigger !== undefined) readAutomationTarget(command.trigger, "command.trigger")
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

function readAutomationTarget(input: unknown, name = "command.target") {
  const target = readRecord(input, name)
  const keys = ["ref", "role", "label", "placeholder", "text", "alt", "title", "testId", "css", "first", "last", "nth"].filter(
    (key) => target[key] !== undefined,
  )
  if (keys.length !== 1) throw new Error(`${name} requires exactly one locator kind`)
  const key = keys[0]
  const value = key === "nth" ? undefined : readString(target[key], `${name}.${key}`)
  if (key === "ref" && (value === undefined || !/^@?e[0-9]+$/.test(value))) {
    throw new Error(`${name}.ref must be an e<number> ref copied from the latest automation snapshot`)
  }
  if (key === "ref") readString(target.snapshotId, `${name}.snapshotId`)
  if (key !== "ref" && target.snapshotId !== undefined) {
    throw new Error(`${name}.snapshotId is only supported for ref`)
  }
  if (["css", "first", "last", "nth"].includes(key) && target.advanced !== true) {
    throw new Error(`${name}.${key} requires advanced: true`)
  }
  if (!["css", "first", "last", "nth"].includes(key) && target.advanced !== undefined) {
    throw new Error(`${name}.advanced is only supported for css, first, last, or nth`)
  }
  if (target.exact !== undefined) {
    if (!["role", "label", "placeholder", "text", "alt", "title"].includes(key)) {
      throw new Error(`${name}.exact is not supported for ${key}`)
    }
    readBoolean(target.exact, `${name}.exact`)
  }
  if (key === "role") readOptionalString(target.name, `${name}.name`)
  if (key !== "role" && target.name !== undefined) {
    throw new Error(`${name}.name is only supported for role`)
  }
  if (key === "nth") {
    const nth = readNumber(target.nth, `${name}.nth`)
    if (!Number.isInteger(nth) || nth < 0) throw new Error(`${name}.nth must be a non-negative integer`)
    readString(target.selector, `${name}.selector`)
  } else if (target.selector !== undefined) {
    throw new Error(`${name}.selector is only supported for nth`)
  }
}

function readAutomationSelector(input: unknown, name = "command.target") {
  const target = readRecord(input, name)
  if (!("ref" in target) && !("css" in target)) {
    throw new Error(`${name} requires a snapshot ref or advanced CSS selector`)
  }
  readAutomationTarget(target, name)
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
  if (command.target !== undefined) {
    if (command.clip !== undefined) throw new Error("command.target and command.clip cannot be used together")
    readAutomationSelector(command.target)
  }
  if (command.annotate !== undefined) {
    readBoolean(command.annotate, "command.annotate")
    if (command.clip !== undefined) throw new Error("command.annotate and command.clip cannot be used together")
    if (
      command.annotate === true
      && isRecord(command.target)
      && command.target.ref !== undefined
    ) {
      throw new Error("command.annotate cannot be combined with a ref target; use advanced CSS")
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
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 10 * 60_000) {
    throw new Error("command.timeout must be an integer between 1 and 600000 milliseconds")
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
  if (Array.isArray(input) && input.length <= 1_000 && input.every((value) => typeof value === "string")) return input
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
      item.presentationStyle !== undefined &&
      item.presentationStyle !== "attachment" &&
      item.presentationStyle !== "inline" &&
      item.presentationStyle !== "unspecified"
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
      if (entry.text !== undefined)
        readStringAllowEmpty(entry.text, `command.items[${itemIndex}].entries[${entryIndex}].text`)
      if (entry.base64 !== undefined) {
        const base64 = readStringAllowEmpty(entry.base64, `command.items[${itemIndex}].entries[${entryIndex}].base64`)
        try {
          atob(base64)
        } catch {
          throw new Error(`command.items[${itemIndex}].entries[${entryIndex}].base64 must be valid base64`)
        }
      }
    })
  })
}
