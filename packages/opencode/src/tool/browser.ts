import type {
  BrowserClipboardItem,
  BrowserLocatorCommandName,
  BrowserRuntimeError,
  BrowserScreenshot,
} from "@opencode-ai/browser-protocol"
import { BROWSER_COMMAND_NAMES } from "@opencode-ai/browser-protocol"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Schema } from "effect"
import path from "path"
import { BrowserClient, BrowserClientError, CdpCapability, type BrowserTransportOptions } from "../browser"
import { desktopBrowserConnection } from "../browser/config"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

const Locator = Schema.Struct({
  css: Schema.optional(Schema.String),
  exact: Schema.optional(Schema.Boolean),
  frameId: Schema.optional(Schema.String),
  frameSelectors: Schema.optional(Schema.Array(Schema.String)),
  href: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  selector: Schema.optional(Schema.String),
  testId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
})

const Parameters = Schema.Struct({
  command: Schema.Literals(BROWSER_COMMAND_NAMES).annotate({
    description: "Namespaced browser command",
  }),
  browserId: Schema.optional(Schema.String),
  claimId: Schema.optional(Schema.String),
  sessionName: Schema.optional(Schema.String),
  tabId: Schema.optional(Schema.String),
  targetTabId: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  urls: Schema.optional(Schema.Array(Schema.String)),
  contentType: Schema.optional(Schema.Literals(["html", "text", "domSnapshot"])),
  format: Schema.optional(Schema.Literals(["metadata", "text", "html"])),
  exportFormat: Schema.optional(Schema.Literals(["csv", "docx", "md", "pdf", "pptx", "xlsx"])),
  historyFrom: Schema.optional(Schema.String),
  historyTo: Schema.optional(Schema.String),
  queries: Schema.optional(Schema.Array(Schema.String)),
  waitUntil: Schema.optional(
    Schema.Literals(["commit", "domcontentloaded", "load", "networkidle"]).annotate({
      description:
        "Used only by tab.playwright.expectNavigation and tab.playwright.waitForURL; never pass it to tab.goto",
    }),
  ),
  timeout: Schema.optional(Schema.Number),
  disposition: Schema.optional(Schema.Literals(["temporary", "deliverable", "handoff"])),
  keep: Schema.optional(Schema.Array(Schema.Struct({
    status: Schema.Literals(["deliverable", "handoff"]),
    tabId: Schema.String,
  }))),
  bounds: Schema.optional(
    Schema.Struct({
      height: Schema.Number,
      width: Schema.Number,
      x: Schema.Number,
      y: Schema.Number,
    }),
  ),
  imageFormat: Schema.optional(Schema.Literals(["png", "jpeg"])),
  quality: Schema.optional(Schema.Number),
  fullPage: Schema.optional(Schema.Boolean),
  includeNonInteractable: Schema.optional(Schema.Boolean),
  savePath: Schema.optional(
    Schema.String.annotate({
      description: "Absolute path or workspace-relative path where tab.screenshot should save the PNG or JPEG",
    }),
  ),
  clip: Schema.optional(
    Schema.Struct({
      height: Schema.Number,
      width: Schema.Number,
      x: Schema.Number,
      y: Schema.Number,
    }),
  ),
  locator: Schema.optional(Locator),
  snapshotId: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  arg: Schema.optional(Schema.Unknown),
  checked: Schema.optional(Schema.Boolean),
  expression: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  loadState: Schema.optional(Schema.Literals(["domcontentloaded", "load", "networkidle"]).annotate({
    description: "Load state used only by tab.playwright.waitForLoadState",
  })),
  locatorState: Schema.optional(Schema.Literals(["attached", "detached", "hidden", "visible"]).annotate({
    description: "Element state used only by tab.playwright.locator.waitFor",
  })),
  options: Schema.optional(Schema.Array(Schema.Struct({
    index: Schema.optional(Schema.Number),
    label: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
  }))),
  attribute: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  keys: Schema.optional(Schema.Array(Schema.String)),
  filePaths: Schema.optional(Schema.Array(Schema.String)),
  chooserId: Schema.optional(Schema.String),
  downloadId: Schema.optional(Schema.String),
  dialogId: Schema.optional(Schema.String),
  accept: Schema.optional(Schema.Boolean),
  promptText: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  fromX: Schema.optional(Schema.Number),
  fromY: Schema.optional(Schema.Number),
  toX: Schema.optional(Schema.Number),
  toY: Schema.optional(Schema.Number),
  deltaX: Schema.optional(Schema.Number),
  deltaY: Schema.optional(Schema.Number),
  scrollX: Schema.optional(Schema.Number),
  scrollY: Schema.optional(Schema.Number),
  dragPath: Schema.optional(Schema.Array(Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
  }))),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  cuaButton: Schema.optional(Schema.Number.annotate({
    description: "CUA mouse button: 1-left, 2-middle, 3-right, 4-back, or 5-forward",
  })),
  text: Schema.optional(Schema.String),
  clipboardItems: Schema.optional(Schema.Array(Schema.Struct({
    entries: Schema.Array(Schema.Struct({
      base64: Schema.optional(Schema.String),
      mimeType: Schema.String,
      text: Schema.optional(Schema.String),
    })),
    presentationStyle: Schema.optional(Schema.Literals(["attachment", "inline", "unspecified"])),
  }))),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["alt", "control", "meta", "shift"]))),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  targetId: Schema.optional(Schema.String),
  targetSessionId: Schema.optional(Schema.String),
  afterSequence: Schema.optional(Schema.Number),
  methods: Schema.optional(Schema.Array(Schema.String)),
  logFilter: Schema.optional(Schema.String),
  logLevels: Schema.optional(Schema.Array(Schema.Literals(["debug", "error", "info", "log", "warn", "warning"]))),
  limit: Schema.optional(Schema.Number),
})

type BrowserParameters = Schema.Schema.Type<typeof Parameters>

export const BrowserTool = Tool.define(
  "browser",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    return {
      description: [
        "Control the desktop client's embedded browser through namespaced commands.",
        "For screenshot requests, call tab.screenshot once: it returns an image attachment rendered directly in chat.",
        "To also save a screenshot, pass savePath to the same tab.screenshot call; the tool writes the image directly and returns savedPath.",
        "Do not use shell commands, curl, temporary files, tab.dev.cdp, or the screenshot asset reference to retrieve or save screenshots.",
        "Before every click, fill, press, check, or select action, use the latest relevant tab.playwright.domSnapshot as locator ground truth.",
        "A DOM snapshot reference such as [ref=e36] must be used as selector aria-ref=e36 (the compatibility form [ref=e36] is also accepted); it is not a CSS attribute.",
        "Do not guess selectors, labels, roles, or accessible names that are absent from the latest snapshot.",
        "If locator uniqueness is not obvious, call count first and act only when it is exactly 1.",
        "After a locator timeout, strict-mode error, or selector error, take a fresh DOM snapshot and rebuild the locator; never retry the same stale locator.",
        "Prefer data-testid, stable data attributes or href, then scoped role/name or text, then scoped CSS.",
        "Use one bounded read-only evaluate for targeted bulk DOM reads; it runs against a detached page copy and cannot mutate the live page.",
        "Do not use networkidle; the official Browser runtime does not support it.",
        "tab.goto accepts url only; never pass waitUntil. Any legacy waitUntil field on tab.goto is ignored.",
        "Do not call waitForLoadState after routine goto; goto already waits for navigation readiness.",
        "Use tab.cua commands only when page geometry matters or semantic targeting is unavailable.",
        "Tabs share the user's persistent browser session.",
        "Use browser.user.openTabs followed by browser.user.claimTab to take over an existing user tab; never pass a user-tab claim ID as tabId.",
        "Agent-created tabs are temporary unless marked deliverable or handoff.",
        "Call tabs.finalize after the browser task to close temporary tabs and release claimed user tabs.",
        "For navigation, dialog, file chooser, or download waits, pass the triggering locator so waiting and clicking are atomic.",
        "tab.download.wait returns a download ID; use tab.download.get to refresh its state and obtain the completed path.",
        "Server-provided HTTP error pages remain visible; transport failures use the desktop error view.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: BrowserParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.savePath && params.command !== "tab.screenshot") {
            throw new Error("savePath is only supported by tab.screenshot")
          }
          const options = transportOptions(ctx)
          const initialClient = new BrowserClient(options)
          const targetUrl = navigationUrl(params)
          if (targetUrl) {
            yield* ctx.ask({
              permission: "webfetch",
              patterns: [targetUrl],
              always: [`${new URL(targetUrl).origin}/*`],
              metadata: { command: params.command, url: targetUrl },
            })
          }
          if (params.command === "tabs.content") {
            if (!params.urls?.length) throw new Error("tabs.content requires urls")
            for (const input of params.urls) {
              const url = normalizeUrl(input)
              yield* ctx.ask({
                permission: "webfetch",
                patterns: [url],
                always: [`${new URL(url).origin}/*`],
                metadata: { command: params.command, url },
              })
            }
          }

          if (params.command === "tab.fileChooser.setFiles") {
            if (!params.filePaths?.length) throw new Error("tab.fileChooser.setFiles requires filePaths")
            for (const filePath of params.filePaths) {
              yield* ctx.ask({
                permission: "read",
                patterns: [filePath],
                always: [filePath],
                metadata: {},
              })
            }
          }

          const mutating = isMutating(params)
          const currentOrigin =
            mutating || params.command === "tab.dev.cdp" || params.command === "tab.dev.cdp.events"
              ? yield* Effect.promise(() => resolveCurrentOrigin(initialClient, params))
              : undefined
          if (mutating || params.command === "tab.dev.cdp" || params.command === "tab.dev.cdp.events") {
            if (!currentOrigin) throw new Error("The current browser tab does not have an HTTP or HTTPS origin")
            yield* ctx.ask({
              permission: params.command === "tab.dev.cdp" || params.command === "tab.dev.cdp.events"
                ? "browser_cdp"
                : "browser_interaction",
              patterns: [currentOrigin],
              always: [currentOrigin],
              metadata: { command: params.command, origin: currentOrigin },
            })
          }

          const client = new BrowserClient({ ...options, expectedOrigin: currentOrigin })
          const result = yield* Effect.promise(() =>
            executeBrowserCommand(client, params, currentOrigin).catch((error: unknown) => {
              throw browserToolError(error)
            }),
          )
          const response = client.events().length ? { data: result, events: client.events() } : result
          const screenshot = findScreenshot(result)
          const savedPath = params.savePath
            ? yield* saveScreenshot(params.savePath, screenshot, ctx, fs, bus)
            : undefined
          const output = screenshot?.data ? stripScreenshotData(response, savedPath) : response

          return {
            metadata: {
              command: params.command,
              savedPath,
              tabId: params.tabId,
              url: params.url,
            },
            output: JSON.stringify(output ?? {}, null, 2),
            title: params.url ? `内嵌浏览器：${params.url}` : `内嵌浏览器：${params.command}`,
            ...(screenshot?.data
              ? {
                  attachments: [
                    {
                      type: "file" as const,
                      filename: `browser-${Date.now()}.${screenshot.mimeType === "image/jpeg" ? "jpg" : "png"}`,
                      mime: screenshot.mimeType,
                      url: `data:${screenshot.mimeType};base64,${screenshot.data}`,
                    },
                  ],
                }
              : {}),
          }
        }),
    }
  }),
)

function transportOptions(ctx: Tool.Context): BrowserTransportOptions {
  const connection = desktopBrowserConnection()
  if (!connection) throw new Error("The desktop embedded browser is not available")
  return {
    abort: ctx.abort,
    callId: ctx.callID,
    endpoint: connection.endpoint,
    sessionId: ctx.sessionID,
    token: connection.token,
  }
}

async function executeBrowserCommand(
  client: BrowserClient,
  params: BrowserParameters,
  approvedOrigin?: string,
): Promise<unknown> {
  if (params.command === "browser.list") return { browsers: await client.browsers.list() }
  const browser = params.browserId ? await client.browsers.get(params.browserId) : await client.browsers.getDefault()
  if (params.command === "browser.nameSession") {
    if (!params.sessionName) throw new Error("browser.nameSession requires sessionName")
    await browser.nameSession(params.sessionName)
    return { named: params.sessionName.trim() }
  }
  if (params.command === "browser.show") return { state: await browser.show() }
  if (params.command === "browser.hide") return { state: await browser.hide() }
  if (params.command === "browser.state") return { state: await browser.state() }
  if (params.command === "browser.viewport.set") {
    if (!params.bounds) throw new Error("browser.viewport.set requires bounds")
    return { state: await browser.setViewport(params.bounds) }
  }
  if (params.command === "browser.viewport.reset") return { state: await browser.resetViewport() }
  if (params.command === "browser.user.openTabs") return { tabs: await browser.user.openTabs() }
  if (params.command === "browser.user.history") {
    return {
      history: await browser.user.history({
        from: params.historyFrom,
        limit: params.limit,
        queries: params.queries ? [...params.queries] : undefined,
        to: params.historyTo,
      }),
    }
  }
  if (params.command === "browser.user.claimTab") {
    if (!params.claimId) throw new Error("browser.user.claimTab requires claimId")
    const tab = await browser.user.claimTab(params.claimId)
    return { tabId: tab.id, state: await tab.state() }
  }
  if (params.command === "tabs.list") return { tabs: await browser.tabs.list() }
  if (params.command === "tabs.get") {
    if (!params.targetTabId) throw new Error("tabs.get requires targetTabId")
    const tab = await browser.tabs.get(params.targetTabId)
    return { tabId: tab.id, state: await tab.state() }
  }
  if (params.command === "tabs.content") {
    if (!params.urls || !params.contentType) throw new Error("tabs.content requires urls and contentType")
    return {
      results: await browser.tabs.content({
        contentType: params.contentType,
        timeoutMs: params.timeout,
        urls: [...params.urls].map(normalizeUrl),
      }),
    }
  }
  if (params.command === "tabs.selected") {
    const tab = await browser.tabs.selected()
    return { tabId: tab?.id }
  }
  if (params.command === "tabs.new") {
    const tab = await browser.tabs.new()
    return { tabId: tab.id, state: await tab.state() }
  }
  if (params.command === "tabs.finalize") {
    await browser.tabs.finalize({
      keep: params.keep?.map((item) => ({ status: item.status, tab: item.tabId })),
    })
    return { finalized: true }
  }

  const selected = params.tabId ? await browser.tabs.get(params.tabId) : await browser.tabs.selected()
  const tab =
    selected ?? (params.command === "tab.goto" ? await browser.tabs.new() : undefined)
  if (!tab) throw new Error(`${params.command} requires an active browser tab`)
  if (params.command === "tab.state") return { tab: await tab.state() }
  if (params.command === "tab.activate") return { tab: await tab.activate() }
  if (params.command === "tab.close") {
    await tab.close()
    return { closed: true }
  }
  if (params.command === "tab.mark") {
    if (!params.disposition) throw new Error("tab.mark requires disposition")
    await tab.mark(params.disposition)
    return { marked: params.disposition }
  }
  if (params.command === "tab.goto") {
    if (!params.url) throw new Error("tab.goto requires url")
    return { navigation: await tab.gotoResult(normalizeUrl(params.url)) }
  }
  if (params.command === "tab.back") return { navigation: await tab.backResult() }
  if (params.command === "tab.forward") return { navigation: await tab.forwardResult() }
  if (params.command === "tab.reload") return { navigation: await tab.reloadResult() }
  if (params.command === "tab.stop") return { tab: await tab.stop() }
  if (params.command === "tab.content.read") return { snapshot: await tab.content.read(params.format) }
  if (params.command === "tab.content.export") return { path: await tab.content.export() }
  if (params.command === "tab.content.exportGsuite") {
    if (!params.exportFormat) throw new Error("tab.content.exportGsuite requires exportFormat")
    return { path: await tab.content.exportGsuite(params.exportFormat) }
  }
  if (params.command === "tab.screenshot") {
    return {
      screenshot: await tab.screenshotResult({
        clip: params.clip,
        fullPage: params.fullPage,
        imageFormat: params.imageFormat,
        quality: params.quality,
      }),
    }
  }
  if (params.command === "tab.playwright.domSnapshot") return { dom: await tab.playwright.domSnapshot() }
  if (params.command === "tab.playwright.evaluate") {
    if (!params.expression) throw new Error("tab.playwright.evaluate requires expression")
    return {
      value: await tab.playwright.evaluate(params.expression, params.arg, {
        timeoutMs: params.timeout,
      }),
    }
  }
  if (params.command === "tab.playwright.elementInfo") {
    requirePoint(params)
    return {
      elements: await tab.playwright.elementInfo({
        includeNonInteractable: params.includeNonInteractable,
        x: params.x!,
        y: params.y!,
      }),
    }
  }
  if (params.command === "tab.playwright.elementScreenshot") {
    requirePoint(params)
    return {
      screenshot: await tab.playwright.elementScreenshotResult({
        includeNonInteractable: params.includeNonInteractable,
        x: params.x!,
        y: params.y!,
      }),
    }
  }
  if (params.command === "tab.playwright.expectNavigation") {
    return {
      navigation: await tab.playwright.expectNavigationResult({
        timeoutMs: params.timeout,
        trigger: params.locator,
        url: params.url,
        waitUntil: params.waitUntil,
      }),
    }
  }
  if (params.command === "tab.playwright.waitForURL") {
    if (!params.url) throw new Error("tab.playwright.waitForURL requires url")
    return {
      value: await tab.playwright.waitForURL(params.url, {
        timeoutMs: params.timeout,
        waitUntil: params.waitUntil,
      }),
    }
  }
  if (params.command === "tab.playwright.waitForLoadState") {
    return {
      value: await tab.playwright.waitForLoadState({
        state: params.loadState,
        timeoutMs: params.timeout,
      }),
    }
  }
  if (params.command === "tab.playwright.waitForTimeout") {
    if (params.timeout === undefined) throw new Error("tab.playwright.waitForTimeout requires timeout")
    return { value: await tab.playwright.waitForTimeout(params.timeout) }
  }
  if (params.command.startsWith("tab.playwright.locator.")) {
    if (!params.locator) throw new Error(`${params.command} requires locator`)
    return tab.playwright.locator(params.locator).run(params.command as BrowserLocatorCommandName, {
      arg: params.arg,
      attribute: params.attribute,
      button: params.button,
      checked: params.checked,
      expression: params.expression,
      filePaths: params.filePaths ? [...params.filePaths] : undefined,
      force: params.force,
      key: params.key,
      modifiers: params.modifiers ? [...params.modifiers] : undefined,
      options: params.options ? params.options.map((option) => ({ ...option })) : undefined,
      state: params.locatorState,
      timeout: params.timeout,
      value: params.value ?? params.text,
    })
  }
  if (params.command.startsWith("tab.domCua.")) {
    if (params.command === "tab.domCua.getVisibleDom") return { dom: await tab.dom_cua.get_visible_dom() }
    if (params.command === "tab.domCua.type") {
      return { value: await tab.dom_cua.type({ text: params.text ?? params.value ?? "" }) }
    }
    if (params.command === "tab.domCua.keypress") {
      const keys = params.keys ?? (params.key ? [params.key] : [])
      if (!keys.length) throw new Error("tab.domCua.keypress requires keys")
      return { value: await tab.dom_cua.keypress({ keys: [...keys] }) }
    }
    if (params.command === "tab.domCua.scroll") {
      const x = params.deltaX ?? params.x
      const y = params.deltaY ?? params.y
      if (x === undefined || y === undefined) throw new Error("tab.domCua.scroll requires x and y deltas")
      return {
        value: await tab.dom_cua.scroll({
          node_id: params.nodeId,
          x,
          y,
        }),
      }
    }
    if (params.command === "tab.domCua.downloadMedia") {
      if (!params.nodeId) throw new Error("tab.domCua.downloadMedia requires nodeId")
      await tab.dom_cua.downloadMedia({
        node_id: params.nodeId,
        timeoutMs: params.timeout,
      })
      return { downloaded: true }
    }
    if (!params.nodeId) throw new Error(`${params.command} requires nodeId`)
    const input = { node_id: params.nodeId }
    if (params.command === "tab.domCua.click") return { value: await tab.dom_cua.click(input) }
    if (params.command === "tab.domCua.doubleClick") return { value: await tab.dom_cua.double_click(input) }
  }
  if (params.command === "tab.cua.click" || params.command === "tab.cua.doubleClick") {
    requirePoint(params)
    return {
      value:
        params.command === "tab.cua.click"
          ? await tab.cua.click({
              button: params.cuaButton,
              keypress: params.keys ? [...params.keys] : undefined,
              x: params.x!,
              y: params.y!,
            })
          : await tab.cua.double_click({
              keypress: params.keys ? [...params.keys] : undefined,
              x: params.x!,
              y: params.y!,
            }),
    }
  }
  if (params.command === "tab.cua.move") {
    requirePoint(params)
    return {
      value: await tab.cua.move({
        keys: params.keys ? [...params.keys] : undefined,
        x: params.x!,
        y: params.y!,
      }),
    }
  }
  if (params.command === "tab.cua.drag") {
    const path = params.dragPath?.map((point) => ({ ...point }))
      ?? (
        [params.fromX, params.fromY, params.toX, params.toY].every((value) => value !== undefined)
          ? [
              { x: params.fromX!, y: params.fromY! },
              { x: params.toX!, y: params.toY! },
            ]
          : []
      )
    if (!path.length) throw new Error("tab.cua.drag requires a non-empty dragPath")
    return {
      value: await tab.cua.drag({
        keys: params.keys ? [...params.keys] : undefined,
        path,
      }),
    }
  }
  if (params.command === "tab.cua.scroll") {
    requirePoint(params)
    const scrollY = params.scrollY ?? params.deltaY
    if (scrollY === undefined) throw new Error("tab.cua.scroll requires scrollY")
    return {
      value: await tab.cua.scroll({
        keypress: params.keys ? [...params.keys] : undefined,
        scrollX: params.scrollX ?? params.deltaX ?? 0,
        scrollY,
        x: params.x!,
        y: params.y!,
      }),
    }
  }
  if (params.command === "tab.cua.type") return { value: await tab.cua.type({ text: params.text ?? "" }) }
  if (params.command === "tab.cua.keypress") {
    const keys = params.keys ?? [
      ...(params.modifiers ?? []).map((modifier) => modifier),
      ...(params.key ? [params.key] : []),
    ]
    if (!keys.length) throw new Error("tab.cua.keypress requires keys")
    return { value: await tab.cua.keypress({ keys: [...keys] }) }
  }
  if (params.command === "tab.cua.downloadMedia") {
    requirePoint(params)
    await tab.cua.downloadMedia({
      timeoutMs: params.timeout,
      x: params.x!,
      y: params.y!,
    })
    return { downloaded: true }
  }
  if (params.command === "tab.dialog.get") return { dialog: await tab.dialog() }
  if (params.command === "tab.dialog.wait") {
    return { dialog: await tab.waitForDialog(params.timeout, params.locator) }
  }
  if (params.command === "tab.dialog.handle") {
    if (!params.dialogId || params.accept === undefined) {
      throw new Error("tab.dialog.handle requires dialogId and accept")
    }
    await tab.handleDialog({ accept: params.accept, dialogId: params.dialogId, promptText: params.promptText })
    return { handled: true }
  }
  if (params.command === "tab.fileChooser.wait") {
    return { fileChooser: await tab.waitForFileChooser(params.timeout, params.locator) }
  }
  if (params.command === "tab.fileChooser.setFiles") {
    if (!params.chooserId || !params.filePaths?.length) {
      throw new Error("tab.fileChooser.setFiles requires chooserId and filePaths")
    }
    return { value: await tab.setFiles(params.chooserId, [...params.filePaths]) }
  }
  if (params.command === "tab.download.wait") {
    return { download: await tab.waitForDownload(params.timeout, params.locator) }
  }
  if (params.command === "tab.download.get") {
    if (!params.downloadId) throw new Error("tab.download.get requires downloadId")
    return { download: await tab.download(params.downloadId) }
  }
  if (params.command === "tab.clipboard.read") return { items: await tab.clipboard.read() }
  if (params.command === "tab.clipboard.readText") return { text: await tab.clipboard.readText() }
  if (params.command === "tab.clipboard.write") {
    if (!params.clipboardItems?.length) throw new Error("tab.clipboard.write requires clipboardItems")
    await tab.clipboard.write(params.clipboardItems.map((item) => ({
      entries: item.entries.map((entry) => ({ ...entry })),
      presentationStyle: item.presentationStyle,
    })) satisfies BrowserClipboardItem[])
    return { written: true }
  }
  if (params.command === "tab.clipboard.writeText") {
    if (params.text === undefined) throw new Error("tab.clipboard.writeText requires text")
    await tab.clipboard.writeText(params.text)
    return { written: true }
  }
  if (params.command === "tab.dev.cdp") {
    if (!params.method || !approvedOrigin) throw new Error("tab.dev.cdp requires method and an approved origin")
    const capability = await tab.capabilities.get("cdp")
    if (!(capability instanceof CdpCapability)) throw new Error("The current browser tab does not support CDP")
    return {
      cdp: await capability.send(
        params.method,
        isRecord(params.params) ? params.params : undefined,
        {
          target: cdpTarget(params),
          timeoutMs: params.timeout,
        },
      ),
    }
  }
  if (params.command === "tab.dev.cdp.events") {
    if (!approvedOrigin) throw new Error("tab.dev.cdp.events requires an approved origin")
    const capability = await tab.capabilities.get("cdp")
    if (!(capability instanceof CdpCapability)) throw new Error("The current browser tab does not support CDP")
    return {
      events: await capability.readEvents({
        afterSequence: params.afterSequence,
        limit: params.limit,
        methods: params.methods ? [...params.methods] : undefined,
        target: cdpTarget(params),
        timeoutMs: params.timeout,
      }),
    }
  }
  if (params.command === "tab.dev.logs") {
    return {
      logs: await tab.dev.logs({
        filter: params.logFilter,
        levels: params.logLevels ? [...params.logLevels] : undefined,
        limit: params.limit,
      }),
    }
  }
  throw new Error(`Unsupported browser command: ${params.command}`)
}

function navigationUrl(params: BrowserParameters) {
  if (params.command !== "tab.goto") return
  if (!params.url) return
  return normalizeUrl(params.url)
}

function cdpTarget(params: BrowserParameters) {
  if (params.targetId && params.targetSessionId) {
    throw new Error("CDP target requires either targetId or targetSessionId, not both")
  }
  if (params.targetId) return { targetId: params.targetId }
  if (params.targetSessionId) return { sessionId: params.targetSessionId }
}

function normalizeUrl(input: string) {
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URL must use HTTP or HTTPS")
  }
  return url.toString()
}

async function resolveCurrentOrigin(client: BrowserClient, params: BrowserParameters) {
  const browser = params.browserId ? await client.browsers.get(params.browserId) : await client.browsers.getDefault()
  const tab = params.tabId ? await browser.tabs.get(params.tabId) : await browser.tabs.selected()
  const state = await tab?.state()
  try {
    const url = new URL(state?.url ?? "")
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
  } catch {
    return undefined
  }
}

function isMutating(params: BrowserParameters) {
  const command = params.command
  if (command.startsWith("tab.cua.")) return true
  if (command.startsWith("tab.domCua.")) return command !== "tab.domCua.getVisibleDom"
  if (
    command === "tab.back" ||
    command === "tab.clipboard.read" ||
    command === "tab.clipboard.readText" ||
    command === "tab.clipboard.write" ||
    command === "tab.clipboard.writeText" ||
    command === "tab.close" ||
    command === "tab.dialog.handle" ||
    command === "tab.forward" ||
    command === "tab.reload" ||
    (command === "tab.dialog.wait" && params.locator) ||
    command === "tab.fileChooser.setFiles" ||
    (command === "tab.fileChooser.wait" && params.locator) ||
    (command === "tab.download.wait" && params.locator) ||
    (command === "tab.playwright.expectNavigation" && params.locator)
  ) {
    return true
  }
  if (!command.startsWith("tab.playwright.locator.")) return false
  return ![
    "tab.playwright.locator.count",
    "tab.playwright.locator.allTextContents",
    "tab.playwright.locator.evaluate",
    "tab.playwright.locator.getAttribute",
    "tab.playwright.locator.innerText",
    "tab.playwright.locator.isEnabled",
    "tab.playwright.locator.isVisible",
    "tab.playwright.locator.textContent",
    "tab.playwright.locator.waitFor",
  ].includes(command)
}

function requirePoint(params: BrowserParameters) {
  if (params.x === undefined || params.y === undefined) {
    throw new Error(`${params.command} requires x and y`)
  }
}

function findScreenshot(input: unknown): BrowserScreenshot | undefined {
  if (!isRecord(input)) return
  if (isScreenshot(input.screenshot)) return input.screenshot
  return isRecord(input.data) && isScreenshot(input.data.screenshot) ? input.data.screenshot : undefined
}

function isScreenshot(input: unknown): input is BrowserScreenshot {
  return (
    isRecord(input) &&
    typeof input.mimeType === "string" &&
    typeof input.height === "number" &&
    typeof input.width === "number"
  )
}

function stripScreenshotData(input: unknown, savedPath?: string): unknown {
  if (!isRecord(input)) return input
  if (!isScreenshot(input.screenshot)) {
    return isRecord(input.data) && isScreenshot(input.data.screenshot)
      ? { ...input, data: stripScreenshotData(input.data, savedPath) }
      : input
  }
  return {
    ...input,
    screenshot: {
      attached: true,
      height: input.screenshot.height,
      mimeType: input.screenshot.mimeType,
      ...(savedPath ? { savedPath } : {}),
      width: input.screenshot.width,
    },
  }
}

function saveScreenshot(
  input: string,
  screenshot: BrowserScreenshot | undefined,
  ctx: Tool.Context,
  fs: AppFileSystem.Interface,
  bus: Bus.Interface,
) {
  return Effect.gen(function* () {
    if (!screenshot?.data) throw new Error("tab.screenshot did not return image data to save")
    const extension = screenshot.mimeType === "image/jpeg" ? ".jpg" : ".png"
    const initial = path.isAbsolute(input) ? input : path.join(Instance.directory, input)
    const filepath = path.extname(initial) ? initial : `${initial}${extension}`
    const accepted = screenshot.mimeType === "image/jpeg" ? [".jpg", ".jpeg"] : [".png"]
    if (!accepted.includes(path.extname(filepath).toLowerCase())) {
      throw new Error(`savePath extension must match ${screenshot.mimeType}: ${accepted.join(" or ")}`)
    }

    yield* assertExternalDirectoryEffect(ctx, filepath)
    yield* ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        binary: true,
        filepath,
        mime: screenshot.mimeType,
      },
    })

    const existed = yield* fs.existsSafe(filepath)
    yield* fs.writeWithDirs(filepath, Buffer.from(screenshot.data, "base64"))
    yield* bus.publish(File.Event.Edited, { file: filepath })
    yield* bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: existed ? "change" : "add",
    })
    return filepath
  }).pipe(Effect.orDie)
}

function browserToolError(error: unknown) {
  if (error instanceof BrowserClientError) return new Error(formatBrowserError(error.browser))
  return error instanceof Error ? error : new Error(String(error))
}

function formatBrowserError(error: BrowserRuntimeError) {
  return `${error.code}: ${error.message}`
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
