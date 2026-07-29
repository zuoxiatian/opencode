import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserCommand,
  parseBrowserCommandRequest,
} from "@opencode-ai/browser-protocol"

describe("browser protocol v3", () => {
  test("accepts the typed live HTML getter", () => {
    expect(BROWSER_PROTOCOL_VERSION).toBe(3)
    expect(parseBrowserCommand({
      name: "tab.automation.getHtml",
      target: { advanced: true, css: "main" },
    })).toEqual({
      name: "tab.automation.getHtml",
      target: { advanced: true, css: "main" },
    })
  })

  test("rejects removed content and Playwright commands", () => {
    for (const name of [
      "tabs.content",
      "tab.content.read",
      "tab.content.export",
      "tab.content.exportGsuite",
      "tab.playwright.html",
      "tab.playwright.evaluate",
      "tab.playwright.locator.click",
    ]) {
      expect(() => parseBrowserCommand({ name })).toThrow(`Unsupported browser command: ${name}`)
    }
  })

  test("fails fast on v2 requests and accepts v3 requests", () => {
    const request = {
      browserId: "embedded",
      command: { name: "browser.list" as const },
      requestId: "request-test",
      sessionId: "session-test",
    }

    expect(() => parseBrowserCommandRequest({ ...request, protocolVersion: 2 }))
      .toThrow("Unsupported browser protocol version")
    expect(parseBrowserCommandRequest({ ...request, protocolVersion: 3 })).toEqual({
      ...request,
      protocolVersion: 3,
    })
  })

  test("keeps typed automation, downloads, dialogs, and lifecycle commands", () => {
    const commands = [
      { name: "tab.automation.snapshot" },
      { name: "tab.automation.getBox", target: { advanced: true, css: "main" } },
      { name: "tab.automation.count", target: { role: "button" } },
      {
        name: "tab.automation.click",
        target: { ref: "e1", snapshotId: "snapshot-test" },
      },
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

  test("accepts exactly one wait condition including structured targets", () => {
    const commands = [
      {
        name: "tab.automation.waitFor",
        target: {
          advanced: true,
          css: "h1, .article-title, [data-testid=\"article-title\"]",
        },
        timeout: 5_000,
      },
      {
        name: "tab.automation.waitFor",
        target: { ref: "e2", snapshotId: "snapshot-test" },
      },
      { name: "tab.automation.waitFor", text: "Article title" },
      { name: "tab.automation.waitFor", url: "https://example.com/article" },
    ] as const

    expect(commands.map((command) => parseBrowserCommand(command))).toEqual([...commands])
    expect(() => parseBrowserCommand({
      name: "tab.automation.waitFor",
    })).toThrow("command requires exactly one of target, text, or url")
    expect(() => parseBrowserCommand({
      name: "tab.automation.waitFor",
      target: { role: "heading" },
      text: "Article title",
    })).toThrow("command requires exactly one of target, text, or url")
    expect(() => parseBrowserCommand({
      name: "tab.automation.waitFor",
      target: {
        ref: "html",
        snapshotId: "browser-tab-8e674396-274a-4e6f-abd7-afea4a06e406",
      },
    })).toThrow("command.target.ref must be an e<number> ref copied from the latest automation snapshot")
  })
})
