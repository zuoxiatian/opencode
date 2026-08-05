import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { authorizeBrowserCommand, BrowserParametersSchema } from "../../src/tool/browser"
import type { Tool } from "../../src/tool/tool"

describe("authorized browser capability policy", () => {
  test("rejects invented automation refs at the Tool schema boundary", () => {
    const decode = Schema.decodeUnknownSync(BrowserParametersSchema)

    expect(() =>
      decode({
        command: "tab.automation.waitFor",
        target: {
          ref: "html",
          snapshotId: "browser-tab-8e674396-274a-4e6f-abd7-afea4a06e406",
        },
        timeout: 5_000,
      }),
    ).toThrow()
    expect(
      decode({
        command: "tab.automation.waitFor",
        target: { advanced: true, css: "html" },
        timeout: 5_000,
      }),
    ).toMatchObject({
      command: "tab.automation.waitFor",
      target: { advanced: true, css: "html" },
    })
  })

  test("uses webfetch for navigation and no permission for generic HTML reads", async () => {
    const navigation = context()
    let resolved = false

    const origin = await Effect.runPromise(
      authorizeBrowserCommand({ command: "tab.goto", url: "example.com/article" }, navigation.ctx, async () => {
        resolved = true
        return "https://example.com"
      }),
    )
    const html = context()
    await Effect.runPromise(
      authorizeBrowserCommand({ command: "tab.state", tabId: "tab-test" }, html.ctx, async () => {
        throw new Error("Read-only HTML must not resolve an interaction origin")
      }),
    )

    expect(origin).toBeUndefined()
    expect(resolved).toBeFalse()
    expect(navigation.requests).toEqual([
      {
        permission: "webfetch",
        patterns: ["https://example.com/article"],
        always: ["https://example.com/*"],
        metadata: {
          command: "tab.goto",
          url: "https://example.com/article",
        },
      },
    ])
    expect(html.requests).toEqual([])
  })

  test("uses browser_interaction and returns the origin used for expectedOrigin", async () => {
    const fixture = context()

    const origin = await Effect.runPromise(
      authorizeBrowserCommand(
        {
          command: "tab.cua.click",
          tabId: "tab-test",
          x: 10,
          y: 10,
        },
        fixture.ctx,
        async () => "https://account.example",
      ),
    )

    expect(origin).toBe("https://account.example")
    expect(fixture.requests).toEqual([
      {
        permission: "browser_interaction",
        patterns: ["https://account.example"],
        always: ["https://account.example"],
        metadata: {
          command: "tab.cua.click",
          origin: "https://account.example",
        },
      },
    ])
  })

  test("uses browser_cdp for CDP without exposing its expression", async () => {
    const cdp = context()

    await Effect.runPromise(
      authorizeBrowserCommand(
        {
          command: "tab.dev.cdp",
          method: "Runtime.evaluate",
          params: { expression: "document.title" },
          tabId: "tab-test",
        },
        cdp.ctx,
        async () => "https://example.com",
      ),
    )

    expect(cdp.requests.map((request) => request.permission)).toEqual(["browser_cdp"])
    expect(cdp.requests).toEqual([
      {
        permission: "browser_cdp",
        patterns: ["https://example.com"],
        always: ["https://example.com"],
        metadata: {
          command: "tab.dev.cdp",
          method: "Runtime.evaluate",
          origin: "https://example.com",
        },
      },
    ])
    expect(JSON.stringify(cdp.requests)).not.toContain("document.title")

    const expressionWait = context()
    await Effect.runPromise(
      authorizeBrowserCommand(
        {
          command: "tab.automation.waitFor",
          expression: "window.appReady === true",
          tabId: "tab-test",
        },
        expressionWait.ctx,
        async () => "https://example.com",
      ),
    )
    expect(expressionWait.requests.map((request) => request.permission)).toEqual(["browser_cdp"])
    expect(JSON.stringify(expressionWait.requests)).not.toContain("window.appReady")

    await expect(
      Effect.runPromise(
        authorizeBrowserCommand(
          {
            command: "tab.automation.fill",
            tabId: "tab-test",
            target: { role: "textbox" },
            value: "value",
          },
          context().ctx,
          async () => undefined,
        ),
      ),
    ).rejects.toThrow("does not have an HTTP or HTTPS origin")
  })

  test("rejects CDP without a top-level method before resolving origin or asking permission", async () => {
    const cdp = context()
    let resolved = false

    await expect(
      Effect.runPromise(
        authorizeBrowserCommand(
          {
            command: "tab.dev.cdp",
            params: {
              expression: "document.title",
              returnByValue: true,
            },
          },
          cdp.ctx,
          async () => {
            resolved = true
            return "https://example.com"
          },
        ),
      ),
    ).rejects.toThrow("tab.dev.cdp requires a top-level method such as Runtime.evaluate")
    expect(resolved).toBe(false)
    expect(cdp.requests).toEqual([])
  })

  test("binds automation to the current origin and only asks interaction permission for actions", async () => {
    const snapshot = context()
    const snapshotOrigin = await Effect.runPromise(
      authorizeBrowserCommand(
        { command: "tab.automation.snapshot", tabId: "tab-test" },
        snapshot.ctx,
        async () => "https://example.com",
      ),
    )
    const click = context()
    await Effect.runPromise(
      authorizeBrowserCommand(
        {
          command: "tab.automation.click",
          tabId: "tab-test",
          target: { ref: "e1", snapshotId: "snapshot-1" },
        },
        click.ctx,
        async () => "https://example.com",
      ),
    )

    expect(snapshotOrigin).toBe("https://example.com")
    expect(snapshot.requests).toEqual([])
    expect(click.requests.map((request) => request.permission)).toEqual(["browser_interaction"])
  })

  test("authorizes native read URLs and passive capture without interaction permission", async () => {
    const read = context()
    const readOrigin = await Effect.runPromise(
      authorizeBrowserCommand(
        {
          command: "tab.automation.read",
          tabId: "tab-test",
          url: "docs.example/guide",
        },
        read.ctx,
        async () => "https://current.example",
      ),
    )
    const capture = context()
    const captureOrigin = await Effect.runPromise(
      authorizeBrowserCommand(
        {
          annotate: true,
          command: "tab.screenshot",
          tabId: "tab-test",
        },
        capture.ctx,
        async () => "https://current.example",
      ),
    )
    const pdf = context()
    await Effect.runPromise(
      authorizeBrowserCommand(
        { command: "tab.pdf", tabId: "tab-test" },
        pdf.ctx,
        async () => "https://current.example",
      ),
    )

    expect(readOrigin).toBe("https://current.example")
    expect(read.requests).toEqual([{
      always: ["https://docs.example/*"],
      metadata: {
        command: "tab.automation.read",
        url: "https://docs.example/guide",
      },
      patterns: ["https://docs.example/guide"],
      permission: "webfetch",
    }])
    expect(captureOrigin).toBe("https://current.example")
    expect(capture.requests).toEqual([])
    expect(pdf.requests).toEqual([])
  })

  test("uses read for every upload path before interaction authorization", async () => {
    const fixture = context()

    await Effect.runPromise(
      authorizeBrowserCommand(
        {
          chooserId: "chooser-test",
          command: "tab.fileChooser.setFiles",
          filePaths: ["/tmp/one.txt", "/tmp/two.txt"],
          tabId: "tab-test",
        },
        fixture.ctx,
        async () => "https://upload.example",
      ),
    )

    expect(fixture.requests.map((request) => request.permission)).toEqual(["read", "read", "browser_interaction"])
    expect(fixture.requests[0].patterns).toEqual(["/tmp/one.txt"])
    expect(fixture.requests[1].patterns).toEqual(["/tmp/two.txt"])
    expect(fixture.requests[2].patterns).toEqual(["https://upload.example"])
  })

  test("requires origin and interaction permissions for a download trigger", async () => {
    const fixture = context()

    const origin = await Effect.runPromise(
      authorizeBrowserCommand(
        {
          command: "tab.download.wait",
          tabId: "tab-test",
          target: { role: "link", name: "Download invoice" },
        },
        fixture.ctx,
        async () => "https://billing.example",
      ),
    )

    expect(origin).toBe("https://billing.example")
    expect(fixture.requests).toEqual([
      {
        permission: "browser_interaction",
        patterns: ["https://billing.example"],
        always: ["https://billing.example"],
        metadata: {
          command: "tab.download.wait",
          origin: "https://billing.example",
        },
      },
    ])
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
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  }
  return { ctx, requests }
}
