import type { BrowserCommand } from "@opencode-ai/browser-protocol"
import { Schema } from "effect"
import { TabScope, Timeout, browserOperationGuidance, defineBrowserTool } from "./common"

export const BROWSER_CDP_COMMANDS = [
  "tab.dev.cdp",
  "tab.dev.cdp.events",
] as const satisfies readonly BrowserCommand["name"][]

const Operation = Schema.Union([
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.dev.cdp"),
    method: Schema.String.annotate({
      description: "Required top-level Chrome DevTools Protocol method, for example Runtime.evaluate",
    }),
    params: Schema.optional(Schema.Unknown).annotate({
      description: "CDP parameters; Runtime.evaluate always uses returnByValue: true",
    }),
    targetId: Schema.optional(Schema.String),
    targetSessionId: Schema.optional(Schema.String),
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    afterSequence: Schema.optional(Schema.Number),
    command: Schema.Literal("tab.dev.cdp.events"),
    limit: Schema.optional(Schema.Number),
    methods: Schema.optional(Schema.Array(Schema.String)),
    targetId: Schema.optional(Schema.String),
    targetSessionId: Schema.optional(Schema.String),
    timeout: Timeout,
  }),
])

export const BrowserCdpParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One developer CDP operation",
  }),
})

export const BrowserCdpTool = defineBrowserTool(
  "browser_cdp",
  [
    "Run approved developer-only Chrome DevTools Protocol commands or read their events.",
    browserOperationGuidance,
    "Use this only when the typed browser read and action tools cannot express the operation.",
    "operation.method is required beside operation.command for tab.dev.cdp; never put method inside operation.params.",
    "Runtime.evaluate forces returnByValue: true and must return bounded JSON-safe data.",
    "This tool requires browser_cdp permission and remains bound to the current HTTP/HTTPS origin or exact local file URL.",
  ].join(" "),
  BrowserCdpParametersSchema,
)
