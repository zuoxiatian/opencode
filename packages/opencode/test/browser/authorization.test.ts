import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  authorizeBrowserCommand,
} from "../../src/tool/browser"
import type { Tool } from "../../src/tool/tool"

describe("authorized browser capability policy", () => {
  test("uses webfetch for navigation and no permission for generic HTML reads", async () => {
    const navigation = context()
    let resolved = false

    const origin = await Effect.runPromise(authorizeBrowserCommand(
      { command: "tab.goto", url: "example.com/article" },
      navigation.ctx,
      async () => {
        resolved = true
        return "https://example.com"
      },
    ))
    const html = context()
    await Effect.runPromise(authorizeBrowserCommand(
      { command: "tab.playwright.html", tabId: "tab-test" },
      html.ctx,
      async () => {
        throw new Error("Read-only HTML must not resolve an interaction origin")
      },
    ))

    expect(origin).toBeUndefined()
    expect(resolved).toBeFalse()
    expect(navigation.requests).toEqual([{
      permission: "webfetch",
      patterns: ["https://example.com/article"],
      always: ["https://example.com/*"],
      metadata: {
        command: "tab.goto",
        url: "https://example.com/article",
      },
    }])
    expect(html.requests).toEqual([])
  })

  test("uses browser_interaction and returns the origin used for expectedOrigin", async () => {
    const fixture = context()

    const origin = await Effect.runPromise(authorizeBrowserCommand(
      {
        command: "tab.playwright.locator.click",
        locator: { text: "Continue" },
        tabId: "tab-test",
      },
      fixture.ctx,
      async () => "https://account.example",
    ))

    expect(origin).toBe("https://account.example")
    expect(fixture.requests).toEqual([{
      permission: "browser_interaction",
      patterns: ["https://account.example"],
      always: ["https://account.example"],
      metadata: {
        command: "tab.playwright.locator.click",
        origin: "https://account.example",
      },
    }])
  })

  test("uses browser_cdp for CDP and rejects commands without a web origin", async () => {
    const cdp = context()

    await Effect.runPromise(authorizeBrowserCommand(
      { command: "tab.dev.cdp", method: "Runtime.evaluate", tabId: "tab-test" },
      cdp.ctx,
      async () => "https://example.com",
    ))

    expect(cdp.requests[0]).toMatchObject({
      permission: "browser_cdp",
      patterns: ["https://example.com"],
      metadata: { command: "tab.dev.cdp", origin: "https://example.com" },
    })
    await expect(Effect.runPromise(authorizeBrowserCommand(
      {
        command: "tab.playwright.locator.fill",
        locator: { selector: "input" },
        tabId: "tab-test",
        value: "value",
      },
      context().ctx,
      async () => undefined,
    ))).rejects.toThrow("does not have an HTTP or HTTPS origin")
  })

  test("uses read for every upload path before interaction authorization", async () => {
    const fixture = context()

    await Effect.runPromise(authorizeBrowserCommand(
      {
        chooserId: "chooser-test",
        command: "tab.fileChooser.setFiles",
        filePaths: ["/tmp/one.txt", "/tmp/two.txt"],
        tabId: "tab-test",
      },
      fixture.ctx,
      async () => "https://upload.example",
    ))

    expect(fixture.requests.map((request) => request.permission)).toEqual([
      "read",
      "read",
      "browser_interaction",
    ])
    expect(fixture.requests[0].patterns).toEqual(["/tmp/one.txt"])
    expect(fixture.requests[1].patterns).toEqual(["/tmp/two.txt"])
    expect(fixture.requests[2].patterns).toEqual(["https://upload.example"])
  })
})

function context() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    abort: AbortSignal.any([]),
    agent: "build",
    callID: "call-test",
    messageID: MessageID.make("message-test"),
    messages: [],
    metadata: () => Effect.void,
    sessionID: SessionID.make("session-test"),
    ask: (request) => Effect.sync(() => {
      requests.push(request)
    }),
  }
  return { ctx, requests }
}
