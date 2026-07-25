import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserCommand,
  parseBrowserCommandRequest,
} from "@opencode-ai/browser-protocol"

describe("browser protocol v2", () => {
  test("accepts the generic serialized HTML command", () => {
    expect(BROWSER_PROTOCOL_VERSION).toBe(2)
    expect(parseBrowserCommand({ name: "tab.playwright.html" })).toEqual({
      name: "tab.playwright.html",
    })
  })

  test("rejects removed content commands", () => {
    for (const name of [
      "tabs.content",
      "tab.content.read",
      "tab.content.export",
      "tab.content.exportGsuite",
    ]) {
      expect(() => parseBrowserCommand({ name })).toThrow(`Unsupported browser command: ${name}`)
    }
  })

  test("fails fast on v1 requests and accepts v2 requests", () => {
    const request = {
      browserId: "embedded",
      command: { name: "browser.list" as const },
      requestId: "request-test",
      sessionId: "session-test",
    }

    expect(() => parseBrowserCommandRequest({ ...request, protocolVersion: 1 }))
      .toThrow("Unsupported browser protocol version")
    expect(parseBrowserCommandRequest({ ...request, protocolVersion: 2 })).toEqual({
      ...request,
      protocolVersion: 2,
    })
  })

  test("keeps generic browser reads, interactions, downloads, dialogs, and lifecycle commands", () => {
    const commands = [
      { name: "tab.playwright.domSnapshot" },
      { expression: "() => document.title", name: "tab.playwright.evaluate" },
      { locator: { selector: "main" }, name: "tab.playwright.locator.count" },
      { name: "tab.screenshot" },
      { name: "tab.download.wait" },
      { name: "tab.dialog.get" },
      { name: "browser.user.openTabs" },
      { claimId: "claim-test", name: "browser.user.claimTab" },
      { name: "tabs.finalize" },
    ] as const

    expect(commands.map((command) => parseBrowserCommand(command).name)).toEqual(
      commands.map((command) => command.name),
    )
  })
})
