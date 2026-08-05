import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserCommand,
  parseBrowserCommandRequest,
} from "@opencode-ai/browser-protocol"

describe("browser protocol v3", () => {
  test("accepts the typed live HTML getter", () => {
    expect(BROWSER_PROTOCOL_VERSION).toBe(3)
    expect(
      parseBrowserCommand({
        name: "tab.automation.getHtml",
        target: { advanced: true, css: "main" },
      }),
    ).toEqual({
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

    expect(() => parseBrowserCommandRequest({ ...request, protocolVersion: 2 })).toThrow(
      "Unsupported browser protocol version",
    )
    expect(parseBrowserCommandRequest({ ...request, protocolVersion: 3 })).toEqual({
      ...request,
      protocolVersion: 3,
    })
  })

  test("keeps typed automation, downloads, dialogs, and lifecycle commands", () => {
    const commands = [
      { name: "tab.automation.snapshot" },
      { name: "tab.automation.getBox", target: { advanced: true, css: "main" } },
      { name: "tab.automation.count", target: { advanced: true, css: "button" } },
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
          css: 'h1, .article-title, [data-testid="article-title"]',
        },
        timeout: 5_000,
      },
      {
        name: "tab.automation.waitFor",
        target: { ref: "e2", snapshotId: "snapshot-test" },
      },
      {
        name: "tab.automation.waitFor",
        state: "hidden",
        target: { advanced: true, css: "#spinner" },
      },
      { name: "tab.automation.waitFor", text: "Article title" },
      { name: "tab.automation.waitFor", url: "https://example.com/article" },
      { loadState: "networkidle", name: "tab.automation.waitFor" },
      { expression: "window.appReady === true", name: "tab.automation.waitFor" },
      { milliseconds: 250, name: "tab.automation.waitFor" },
    ] as const

    expect(commands.map((command) => parseBrowserCommand(command))).toEqual([...commands])
    expect(() =>
      parseBrowserCommand({
        name: "tab.automation.waitFor",
      }),
    ).toThrow("command requires exactly one of target, text, url, loadState, expression, or milliseconds")
    expect(() =>
      parseBrowserCommand({
        loadState: "load",
        name: "tab.automation.waitFor",
        text: "Article title",
      }),
    ).toThrow("command requires exactly one of target, text, url, loadState, expression, or milliseconds")
    expect(() =>
      parseBrowserCommand({
        name: "tab.automation.waitFor",
        target: {
          ref: "html",
          snapshotId: "browser-tab-8e674396-274a-4e6f-abd7-afea4a06e406",
        },
      }),
    ).toThrow("command.target.ref must be an e<number> ref copied from the latest automation snapshot")
    expect(() =>
      parseBrowserCommand({
        name: "tab.automation.waitFor",
        state: "hidden",
        text: "Loading",
      }),
    ).toThrow("command.state requires command.target")
    expect(() =>
      parseBrowserCommand({
        loadState: "commit",
        name: "tab.automation.waitFor",
      }),
    ).toThrow("command.loadState must be domcontentloaded, load, or networkidle")
    expect(() =>
      parseBrowserCommand({
        milliseconds: -1,
        name: "tab.automation.waitFor",
      }),
    ).toThrow("command.milliseconds must be an integer between 0 and 120000")
  })

  test("matches native locator and capability boundaries", () => {
    const accepted = [
      {
        name: "tab.automation.click",
        target: { alt: "Company logo" },
      },
      {
        name: "tab.automation.getText",
        target: { advanced: true, nth: 2, selector: ".item" },
      },
      { name: "tab.automation.keyboard.type", text: "hello" },
      { amount: 400, direction: "down", name: "tab.automation.scroll" },
      {
        compact: true,
        depth: 4,
        interactive: true,
        name: "tab.automation.snapshot",
        selector: "main",
        urls: true,
      },
      { llms: "index", name: "tab.automation.read", outline: true },
      { annotate: true, name: "tab.screenshot" },
      { name: "tab.pdf" },
    ] as const

    expect(accepted.map((command) => parseBrowserCommand(command).name)).toEqual(
      accepted.map((command) => command.name),
    )
    expect(() => parseBrowserCommand({
      name: "tab.automation.count",
      target: { role: "button" },
    })).toThrow("requires a snapshot ref or advanced CSS selector")
    expect(() => parseBrowserCommand({
      key: "Enter",
      name: "tab.automation.press",
      target: { advanced: true, css: "input" },
    })).toThrow("command.target is not supported for tab.automation.press")
    expect(() => parseBrowserCommand({
      annotate: true,
      name: "tab.screenshot",
      target: { ref: "e1", snapshotId: "snapshot-test" },
    })).toThrow("command.annotate cannot be combined with a ref target")
    expect(() => parseBrowserCommand({
      name: "tab.automation.click",
      target: { advanced: true, css: "button" },
      timeout: 0,
    })).toThrow("command.timeout must be an integer between 1 and 600000 milliseconds")
  })
})
