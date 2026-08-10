import type { BrowserCommand } from "@opencode-ai/browser-protocol"
import { Schema } from "effect"
import { TabScope, browserOperationGuidance, defineBrowserTool } from "./common"

export const BROWSER_NAVIGATE_COMMANDS = [
  "tab.back",
  "tab.forward",
  "tab.goto",
  "tab.reload",
  "tab.stop",
] as const satisfies readonly BrowserCommand["name"][]

const Operation = Schema.Union([
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals(["tab.back", "tab.forward", "tab.reload", "tab.stop"]),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.goto"),
    url: Schema.String.annotate({
      description: "HTTP, HTTPS, or file URL; absolute local paths become file URLs and hostnames default to HTTPS",
    }),
  }),
])

export const BrowserNavigateParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One navigation operation",
  }),
})

export const BrowserNavigateTool = defineBrowserTool(
  "browser_navigate",
  [
    "Navigate the selected embedded browser tab with goto, back, forward, reload, or stop.",
    browserOperationGuidance,
    "tab.goto accepts HTTP, HTTPS, file URLs, or absolute local paths and returns after navigation commits. Local files require read permission and cannot load sibling files implicitly.",
    "When page lifecycle completion matters, follow it with browser_wait tab.automation.waitFor using loadState load; then wait for a target or text when application readiness matters.",
    "After navigation, call browser_snapshot with tab.automation.snapshot before using semantic targets.",
  ].join(" "),
  BrowserNavigateParametersSchema,
)
