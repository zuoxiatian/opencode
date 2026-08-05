import type {
  BrowserAutomationSelector,
  BrowserAutomationTarget,
  BrowserAutomationWait,
  BrowserClipboardItem,
  BrowserPdf,
  BrowserScreenshot,
} from "@opencode-ai/browser-protocol"
import { BROWSER_COMMAND_NAMES } from "@opencode-ai/browser-protocol"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Schema } from "effect"
import path from "path"
import { BrowserClient, BrowserClientError, CdpCapability, type BrowserTransportOptions } from "../../browser"
import { desktopBrowserConnection } from "../../browser/config"
import { Bus } from "../../bus"
import { File } from "../../file"
import { FileWatcher } from "../../file/watcher"
import { Instance } from "../../project/instance"
import { assertExternalDirectoryEffect } from "../external-directory"
import * as Tool from "../tool"

export const AutomationSelector = Schema.Union([
  Schema.Struct({
    ref: Schema.String.check(Schema.isPattern(/^e[0-9]+$/)).annotate({
      description:
        "Exact e<number> ref copied from the latest tab.automation.snapshot content; never use a tag, CSS selector, role, or tab ID",
    }),
    snapshotId: Schema.String.annotate({
      description:
        "Exact snapshot.snapshotId returned by the same latest tab.automation.snapshot call; this is not tabId",
    }),
  }),
  Schema.Struct({
    advanced: Schema.Literal(true),
    css: Schema.String.annotate({
      description: "Advanced CSS selector fallback, for example html or h1.article-title; do not put CSS in ref",
    }),
  }),
])

export const AutomationTarget = Schema.Union([
  AutomationSelector,
  Schema.Struct({
    exact: Schema.optional(Schema.Boolean),
    name: Schema.optional(Schema.String),
    role: Schema.String,
  }),
  Schema.Struct({
    exact: Schema.optional(Schema.Boolean),
    label: Schema.String,
  }),
  Schema.Struct({
    exact: Schema.optional(Schema.Boolean),
    placeholder: Schema.String,
  }),
  Schema.Struct({
    exact: Schema.optional(Schema.Boolean),
    text: Schema.String,
  }),
  Schema.Struct({
    alt: Schema.String,
    exact: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    exact: Schema.optional(Schema.Boolean),
    title: Schema.String,
  }),
  Schema.Struct({
    testId: Schema.String,
  }),
  Schema.Struct({
    advanced: Schema.Literal(true),
    first: Schema.String,
  }),
  Schema.Struct({
    advanced: Schema.Literal(true),
    last: Schema.String,
  }),
  Schema.Struct({
    advanced: Schema.Literal(true),
    nth: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
    selector: Schema.String,
  }),
])

const TimeoutValue = Schema.Number.check(Schema.isInt()).check(Schema.isBetween({
  minimum: 1,
  maximum: 600_000,
}))

export const BrowserParametersSchema = Schema.Struct({
  command: Schema.Literals(BROWSER_COMMAND_NAMES).annotate({
    description: "Namespaced browser command",
  }),
  browserId: Schema.optional(Schema.String),
  claimId: Schema.optional(Schema.String),
  sessionName: Schema.optional(Schema.String),
  tabId: Schema.optional(Schema.String),
  targetTabId: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  historyFrom: Schema.optional(Schema.String),
  historyTo: Schema.optional(Schema.String),
  queries: Schema.optional(Schema.Array(Schema.String)),
  timeout: Schema.optional(TimeoutValue).annotate({
    description: "Top-level browser command timeout in milliseconds",
  }),
  expression: Schema.optional(Schema.String),
  loadState: Schema.optional(Schema.Literals(["domcontentloaded", "load", "networkidle"])),
  milliseconds: Schema.optional(Schema.Number),
  state: Schema.optional(Schema.Literals(["attached", "detached", "hidden", "visible"])),
  disposition: Schema.optional(Schema.Literals(["temporary", "deliverable", "handoff"])),
  keep: Schema.optional(
    Schema.Array(
      Schema.Struct({
        status: Schema.Literals(["deliverable", "handoff"]),
        tabId: Schema.String,
      }),
    ),
  ),
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
  annotate: Schema.optional(Schema.Boolean),
  savePath: Schema.optional(
    Schema.String.annotate({
      description: "Absolute path or workspace-relative path where a screenshot or PDF should be saved",
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
  target: Schema.optional(AutomationTarget),
  sourceTarget: Schema.optional(AutomationTarget),
  interactive: Schema.optional(Schema.Boolean),
  interactiveOnly: Schema.optional(Schema.Boolean),
  compact: Schema.optional(Schema.Boolean),
  depth: Schema.optional(Schema.Number),
  selector: Schema.optional(Schema.String),
  urls: Schema.optional(Schema.Boolean),
  raw: Schema.optional(Schema.Boolean),
  requireMd: Schema.optional(Schema.Boolean),
  llms: Schema.optional(Schema.Literals(["index", "full"])),
  outline: Schema.optional(Schema.Boolean),
  filter: Schema.optional(Schema.String),
  snapshotId: Schema.optional(Schema.String).annotate({
    description:
      "Legacy DOM-CUA snapshot ID used with nodeId; automation ref targets must put snapshotId inside target",
  }),
  nodeId: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Array(Schema.String)),
  attribute: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.Literals(["down", "left", "right", "up"])),
  amount: Schema.optional(Schema.Number),
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
  dragPath: Schema.optional(
    Schema.Array(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
      }),
    ),
  ),
  cuaButton: Schema.optional(
    Schema.Number.annotate({
      description: "CUA mouse button: 1-left, 2-middle, 3-right, 4-back, or 5-forward",
    }),
  ),
  text: Schema.optional(Schema.String),
  clipboardItems: Schema.optional(
    Schema.Array(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            base64: Schema.optional(Schema.String),
            mimeType: Schema.String,
            text: Schema.optional(Schema.String),
          }),
        ),
        presentationStyle: Schema.optional(Schema.Literals(["attachment", "inline", "unspecified"])),
      }),
    ),
  ),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["alt", "control", "meta", "shift"]))),
  method: Schema.optional(Schema.String).annotate({
    description: "Required top-level Chrome DevTools Protocol method for tab.dev.cdp, for example Runtime.evaluate",
  }),
  params: Schema.optional(Schema.Unknown).annotate({
    description:
      "Chrome DevTools Protocol method parameters; for Runtime.evaluate put expression and returnByValue here",
  }),
  targetId: Schema.optional(Schema.String),
  targetSessionId: Schema.optional(Schema.String),
  afterSequence: Schema.optional(Schema.Number),
  methods: Schema.optional(Schema.Array(Schema.String)),
  logFilter: Schema.optional(Schema.String),
  logLevels: Schema.optional(Schema.Array(Schema.Literals(["debug", "error", "info", "log", "warn", "warning"]))),
  limit: Schema.optional(Schema.Number),
})

export type BrowserParameters = Schema.Schema.Type<typeof BrowserParametersSchema>
const decodeBrowserParameters = Schema.decodeUnknownSync(BrowserParametersSchema)

export const BrowserScope = {
  browserId: Schema.optional(Schema.String),
}

export const TabScope = {
  ...BrowserScope,
  tabId: Schema.optional(Schema.String),
}

export const Timeout = Schema.optional(TimeoutValue).annotate({
  description: "Browser command timeout in milliseconds",
})

export const browserOperationGuidance =
  "Put exactly one command and all of its arguments inside the required operation object."

export class BrowserCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`)
    this.name = "BrowserCapabilityError"
  }
}

export const AuthorizedBrowserCapability = {
  execute(input: BrowserParameters, ctx: Tool.Context) {
    return Effect.gen(function* () {
      const params = decodeBrowserParameters(input)
      const options = transportOptions(ctx)
      const initialClient = new BrowserClient(options)
      const currentOrigin = yield* authorizeBrowserCommand(params, ctx, () =>
        resolveCurrentOrigin(initialClient, params),
      )

      const client = new BrowserClient({ ...options, expectedOrigin: currentOrigin })
      const data = yield* Effect.promise(() =>
        executeBrowserCommand(client, params, currentOrigin).catch((error: unknown) => {
          throw browserToolError(error)
        }),
      )
      return { data, events: client.events() }
    })
  },
}

export function authorizeBrowserCommand(
  params: BrowserParameters,
  ctx: Tool.Context,
  resolveOrigin: () => Promise<string | undefined>,
) {
  return Effect.gen(function* () {
    if (params.command === "tab.dev.cdp" && !params.method?.trim()) {
      throw new Error("tab.dev.cdp requires a top-level method such as Runtime.evaluate")
    }
    const targetUrl = navigationUrl(params)
    if (targetUrl) {
      yield* ctx.ask({
        permission: "webfetch",
        patterns: [targetUrl],
        always: [`${new URL(targetUrl).origin}/*`],
        metadata: { command: params.command, url: targetUrl },
      })
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

    const automation = params.command.startsWith("tab.automation.")
    const devCdp =
      params.command === "tab.dev.cdp" ||
      params.command === "tab.dev.cdp.events" ||
      (params.command === "tab.automation.waitFor" && params.expression !== undefined)
    const passiveNative =
      params.command === "tab.pdf"
      || (params.command === "tab.screenshot" && (params.annotate === true || params.target !== undefined))
    const originRequired = automation || passiveNative || isMutating(params) || devCdp
    if (!originRequired) return undefined

    const currentOrigin = yield* Effect.promise(resolveOrigin)
    if (!currentOrigin) throw new Error("The current browser tab does not have an HTTP or HTTPS origin")
    if ((!automation && !passiveNative) || isMutating(params) || devCdp) {
      yield* ctx.ask({
        permission: devCdp ? "browser_cdp" : "browser_interaction",
        patterns: [currentOrigin],
        always: [currentOrigin],
        metadata: {
          command: params.command,
          origin: currentOrigin,
          ...(params.command === "tab.dev.cdp" && params.method ? { method: params.method } : {}),
        },
      })
    }
    return currentOrigin
  })
}

export function defineBrowserTool<ID extends string, Parameters extends Schema.Decoder<unknown>>(
  id: ID,
  description: string,
  parameters: Parameters,
) {
  return Tool.define(
    id,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const bus = yield* Bus.Service
      return {
        description,
        parameters,
        execute: (input: Schema.Schema.Type<Parameters>, ctx: Tool.Context) =>
          executeBrowserTool((input as unknown as { operation: BrowserParameters }).operation, ctx, fs, bus),
      }
    }),
  )
}

function executeBrowserTool(
  params: BrowserParameters,
  ctx: Tool.Context,
  fs: AppFileSystem.Interface,
  bus: Bus.Interface,
) {
  return Effect.gen(function* () {
    if (params.savePath && params.command !== "tab.screenshot" && params.command !== "tab.pdf") {
      throw new Error("savePath is only supported by tab.screenshot and tab.pdf")
    }
    const result = yield* AuthorizedBrowserCapability.execute(params, ctx)
    const response = result.events.length ? { data: result.data, events: result.events } : result.data
    const screenshot = findScreenshot(result.data)
    const pdf = findPdf(result.data)
    const savedPath = params.savePath
      ? screenshot
        ? yield* saveScreenshot(params.savePath, screenshot, ctx, fs, bus)
        : yield* savePdf(params.savePath, pdf, ctx, fs, bus)
      : undefined
    const output = screenshot?.data
      ? stripScreenshotData(response, savedPath)
      : pdf?.data
        ? stripPdfData(response, savedPath)
        : response

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
  })
}

/*
 * Keep the model-facing tools above small and command-specific. The shared
 * executor below remains the only translation layer to Browser Protocol.
 */

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
  expectedOrigin?: string,
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
  const tab = selected ?? (params.command === "tab.goto" ? await browser.tabs.new() : undefined)
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
  if (params.command === "tab.screenshot") {
    return {
      screenshot: await tab.screenshotResult({
        annotate: params.annotate,
        clip: params.clip,
        fullPage: params.fullPage,
        imageFormat: params.imageFormat,
        quality: params.quality,
        target: params.target ? automationSelector(params.target) : undefined,
      }),
    }
  }
  if (params.command === "tab.pdf") return { pdf: await tab.pdfResult() }
  if (params.command === "tab.automation.snapshot") {
    return {
      snapshot: await tab.automation.snapshot({
        compact: params.compact,
        depth: params.depth,
        interactive: params.interactive,
        interactiveOnly: params.interactiveOnly,
        selector: params.selector,
        urls: params.urls,
      }),
    }
  }
  if (params.command === "tab.automation.read") {
    return {
      readable: await tab.automation.read({
        filter: params.filter,
        llms: params.llms,
        outline: params.outline,
        raw: params.raw,
        requireMd: params.requireMd,
        timeoutMs: params.timeout,
        url: params.url ? normalizeUrl(params.url) : undefined,
      }),
    }
  }
  if (params.command === "tab.automation.waitFor") {
    const wait: BrowserAutomationWait | undefined = params.target
      ? {
          state: params.state,
          target: automationSelector(params.target),
        }
      : params.text !== undefined
        ? { text: params.text }
        : params.url !== undefined
          ? { url: params.url }
          : params.loadState !== undefined
            ? { loadState: params.loadState }
            : params.expression !== undefined
              ? { expression: params.expression }
              : params.milliseconds !== undefined
                ? { milliseconds: params.milliseconds }
                : undefined
    if (!wait) {
      throw new Error("tab.automation.waitFor requires target, text, url, loadState, expression, or milliseconds")
    }
    await tab.automation.waitFor(wait, { timeoutMs: params.timeout })
    return { value: true }
  }
  if (params.command === "tab.automation.drag") {
    if (!params.target || !params.sourceTarget) {
      throw new Error("tab.automation.drag requires sourceTarget and target")
    }
    await tab.automation.drag(automationSelector(params.sourceTarget), automationSelector(params.target), {
      timeoutMs: params.timeout,
    })
    return { value: true }
  }
  if (params.command === "tab.automation.press") {
    if (!params.key) throw new Error("tab.automation.press requires key")
    await tab.automation.press(params.key, {
      timeoutMs: params.timeout,
    })
    return { value: true }
  }
  if (params.command === "tab.automation.keydown" || params.command === "tab.automation.keyup") {
    if (!params.key) throw new Error(`${params.command} requires key`)
    await (params.command === "tab.automation.keydown"
      ? tab.automation.keydown(params.key, { timeoutMs: params.timeout })
      : tab.automation.keyup(params.key, { timeoutMs: params.timeout }))
    return { value: true }
  }
  if (
    params.command === "tab.automation.keyboard.type"
    || params.command === "tab.automation.keyboard.insertText"
  ) {
    if (params.text === undefined) throw new Error(`${params.command} requires text`)
    await (params.command === "tab.automation.keyboard.type"
      ? tab.automation.keyboardType(params.text, { timeoutMs: params.timeout })
      : tab.automation.insertText(params.text, { timeoutMs: params.timeout }))
    return { value: true }
  }
  if (params.command === "tab.automation.scroll") {
    await tab.automation.scroll({
      amount: params.amount,
      direction: params.direction,
      target: params.target ? automationSelector(params.target) : undefined,
      timeoutMs: params.timeout,
    })
    return { value: true }
  }
  if (params.command.startsWith("tab.automation.")) {
    if (!params.target) throw new Error(`${params.command} requires target`)
    const target = automationTarget(params.target)
    const selector = () => automationSelector(params.target)
    const options = { timeoutMs: params.timeout }
    if (params.command === "tab.automation.click") await tab.automation.click(target, options)
    else if (params.command === "tab.automation.dblclick") await tab.automation.dblclick(selector(), options)
    else if (params.command === "tab.automation.focus") await tab.automation.focus(selector(), options)
    else if (params.command === "tab.automation.fill") {
      if (params.value === undefined) throw new Error("tab.automation.fill requires value")
      await tab.automation.fill(target, params.value, options)
    } else if (params.command === "tab.automation.type") {
      if (params.value === undefined) throw new Error("tab.automation.type requires value")
      await tab.automation.type(selector(), params.value, options)
    } else if (params.command === "tab.automation.hover") await tab.automation.hover(target, options)
    else if (params.command === "tab.automation.select") {
      const values = params.values ?? (params.value === undefined ? [] : [params.value])
      if (!values.length) throw new Error("tab.automation.select requires values")
      await tab.automation.select(selector(), [...values], options)
    } else if (params.command === "tab.automation.check") await tab.automation.check(target, options)
    else if (params.command === "tab.automation.uncheck") await tab.automation.uncheck(selector(), options)
    else if (params.command === "tab.automation.scrollIntoView") {
      await tab.automation.scrollIntoView(selector(), options)
    } else if (params.command === "tab.automation.getText") {
      return tab.automation.getTextResult(target, options)
    } else if (params.command === "tab.automation.getHtml") {
      return tab.automation.getHtmlResult(selector(), options)
    } else if (params.command === "tab.automation.getValue") {
      return { value: await tab.automation.getValue(selector(), options) }
    } else if (params.command === "tab.automation.getAttribute") {
      if (!params.attribute) throw new Error("tab.automation.getAttribute requires attribute")
      return { value: await tab.automation.getAttribute(selector(), params.attribute, options) }
    } else if (params.command === "tab.automation.getBox") {
      return { box: await tab.automation.getBox(selector(), options) }
    } else if (params.command === "tab.automation.getStyles") {
      return { styles: await tab.automation.getStyles(selector(), options) }
    } else if (params.command === "tab.automation.count") {
      return { count: await tab.automation.count(selector(), options) }
    } else if (params.command === "tab.automation.isVisible") {
      return { value: await tab.automation.isVisible(selector(), options) }
    } else if (params.command === "tab.automation.isEnabled") {
      return { value: await tab.automation.isEnabled(selector(), options) }
    } else if (params.command === "tab.automation.isChecked") {
      return { value: await tab.automation.isChecked(selector(), options) }
    } else {
      throw new Error(`Unsupported browser automation command: ${params.command}`)
    }
    return { value: true }
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
    const path =
      params.dragPath?.map((point) => ({ ...point })) ??
      ([params.fromX, params.fromY, params.toX, params.toY].every((value) => value !== undefined)
        ? [
            { x: params.fromX!, y: params.fromY! },
            { x: params.toX!, y: params.toY! },
          ]
        : [])
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
    return {
      dialog: await tab.waitForDialog(params.timeout, params.target ? automationTarget(params.target) : undefined),
    }
  }
  if (params.command === "tab.dialog.handle") {
    if (!params.dialogId || params.accept === undefined) {
      throw new Error("tab.dialog.handle requires dialogId and accept")
    }
    await tab.handleDialog({ accept: params.accept, dialogId: params.dialogId, promptText: params.promptText })
    return { handled: true }
  }
  if (params.command === "tab.fileChooser.wait") {
    return {
      fileChooser: await tab.waitForFileChooser(
        params.timeout,
        params.target ? automationTarget(params.target) : undefined,
      ),
    }
  }
  if (params.command === "tab.fileChooser.setFiles") {
    if (!params.chooserId || !params.filePaths?.length) {
      throw new Error("tab.fileChooser.setFiles requires chooserId and filePaths")
    }
    return { value: await tab.setFiles(params.chooserId, [...params.filePaths]) }
  }
  if (params.command === "tab.download.wait") {
    return {
      download: await tab.waitForDownload(params.timeout, params.target ? automationTarget(params.target) : undefined),
    }
  }
  if (params.command === "tab.download.get") {
    if (!params.downloadId) throw new Error("tab.download.get requires downloadId")
    return { download: await tab.download(params.downloadId) }
  }
  if (params.command === "tab.clipboard.read") return { items: await tab.clipboard.read() }
  if (params.command === "tab.clipboard.readText") return { text: await tab.clipboard.readText() }
  if (params.command === "tab.clipboard.write") {
    if (!params.clipboardItems?.length) throw new Error("tab.clipboard.write requires clipboardItems")
    await tab.clipboard.write(
      params.clipboardItems.map((item) => ({
        entries: item.entries.map((entry) => ({ ...entry })),
        presentationStyle: item.presentationStyle,
      })) satisfies BrowserClipboardItem[],
    )
    return { written: true }
  }
  if (params.command === "tab.clipboard.writeText") {
    if (params.text === undefined) throw new Error("tab.clipboard.writeText requires text")
    await tab.clipboard.writeText(params.text)
    return { written: true }
  }
  if (params.command === "tab.dev.cdp") {
    if (!params.method) throw new Error("tab.dev.cdp requires a top-level method such as Runtime.evaluate")
    if (!expectedOrigin) throw new Error("tab.dev.cdp requires an HTTP or HTTPS page origin")
    const capability = await tab.capabilities.get("cdp")
    if (!(capability instanceof CdpCapability)) throw new Error("The current browser tab does not support CDP")
    return {
      cdp: await capability.send(params.method, isRecord(params.params) ? params.params : undefined, {
        target: cdpTarget(params),
        timeoutMs: params.timeout,
      }),
    }
  }
  if (params.command === "tab.dev.cdp.events") {
    if (!expectedOrigin) throw new Error("tab.dev.cdp.events requires an HTTP or HTTPS page origin")
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
  if (params.command !== "tab.goto" && params.command !== "tab.automation.read") return
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
  if (command.startsWith("tab.automation.")) {
    return ![
      "tab.automation.count",
      "tab.automation.getAttribute",
      "tab.automation.getBox",
      "tab.automation.getHtml",
      "tab.automation.getStyles",
      "tab.automation.getText",
      "tab.automation.getValue",
      "tab.automation.isChecked",
      "tab.automation.isEnabled",
      "tab.automation.isVisible",
      "tab.automation.read",
      "tab.automation.snapshot",
      "tab.automation.waitFor",
    ].includes(command)
  }
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
    (command === "tab.dialog.wait" && params.target) ||
    command === "tab.fileChooser.setFiles" ||
    (command === "tab.fileChooser.wait" && params.target) ||
    (command === "tab.download.wait" && params.target)
  ) {
    return true
  }
  return false
}

function requirePoint(params: BrowserParameters) {
  if (params.x === undefined || params.y === undefined) {
    throw new Error(`${params.command} requires x and y`)
  }
}

function automationTarget(target: BrowserParameters["target"]): BrowserAutomationTarget {
  if (!target) throw new Error("Browser automation target is required")
  return target as BrowserAutomationTarget
}

function automationSelector(target: BrowserParameters["target"]): BrowserAutomationSelector {
  if (!target || (!("ref" in target) && !("css" in target))) {
    throw new Error("This command requires a snapshot ref or advanced CSS selector")
  }
  return target as BrowserAutomationSelector
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

function findPdf(input: unknown): BrowserPdf | undefined {
  if (!isRecord(input)) return
  if (isPdf(input.pdf)) return input.pdf
  return isRecord(input.data) && isPdf(input.data.pdf) ? input.data.pdf : undefined
}

function isPdf(input: unknown): input is BrowserPdf {
  return isRecord(input) && input.mimeType === "application/pdf"
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
      ...(input.screenshot.annotations ? { annotations: input.screenshot.annotations } : {}),
      attached: true,
      height: input.screenshot.height,
      mimeType: input.screenshot.mimeType,
      ...(savedPath ? { savedPath } : {}),
      ...(input.screenshot.snapshotId ? { snapshotId: input.screenshot.snapshotId } : {}),
      ...(input.screenshot.tabGeneration === undefined
        ? {}
        : { tabGeneration: input.screenshot.tabGeneration }),
      width: input.screenshot.width,
    },
  }
}

function stripPdfData(input: unknown, savedPath?: string): unknown {
  if (!isRecord(input)) return input
  if (!isPdf(input.pdf)) {
    return isRecord(input.data) && isPdf(input.data.pdf)
      ? { ...input, data: stripPdfData(input.data, savedPath) }
      : input
  }
  return {
    ...input,
    pdf: {
      mimeType: input.pdf.mimeType,
      ...(savedPath ? { savedPath } : {}),
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

function savePdf(
  input: string,
  pdf: BrowserPdf | undefined,
  ctx: Tool.Context,
  fs: AppFileSystem.Interface,
  bus: Bus.Interface,
) {
  return Effect.gen(function* () {
    if (!pdf?.data) throw new Error("tab.pdf did not return PDF data to save")
    const initial = path.isAbsolute(input) ? input : path.join(Instance.directory, input)
    const filepath = path.extname(initial) ? initial : `${initial}.pdf`
    if (path.extname(filepath).toLowerCase() !== ".pdf") {
      throw new Error("savePath extension must be .pdf")
    }

    yield* assertExternalDirectoryEffect(ctx, filepath)
    yield* ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        binary: true,
        filepath,
        mime: pdf.mimeType,
      },
    })

    const existed = yield* fs.existsSafe(filepath)
    yield* fs.writeWithDirs(filepath, Buffer.from(pdf.data, "base64"))
    yield* bus.publish(File.Event.Edited, { file: filepath })
    yield* bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: existed ? "change" : "add",
    })
    return filepath
  }).pipe(Effect.orDie)
}

function browserToolError(error: unknown) {
  if (error instanceof BrowserClientError) {
    return new BrowserCapabilityError(error.browser.code, error.browser.message, error.browser.retryable)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
