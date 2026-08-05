import type { BrowserCommand } from "@opencode-ai/browser-protocol"
import { Schema } from "effect"
import {
  AutomationSelector,
  AutomationTarget,
  TabScope,
  Timeout,
  browserOperationGuidance,
  defineBrowserTool,
} from "./common"

export const BROWSER_READ_COMMANDS = [
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
  "tab.clipboard.read",
  "tab.clipboard.readText",
  "tab.dev.logs",
  "tab.dialog.get",
  "tab.domCua.getVisibleDom",
  "tab.download.get",
  "tab.state",
] as const satisfies readonly BrowserCommand["name"][]

const Operation = Schema.Union([
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals([
      "tab.clipboard.read",
      "tab.clipboard.readText",
      "tab.dialog.get",
      "tab.domCua.getVisibleDom",
      "tab.state",
    ]),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals([
      "tab.automation.count",
      "tab.automation.getBox",
      "tab.automation.getHtml",
      "tab.automation.getStyles",
      "tab.automation.getValue",
      "tab.automation.isChecked",
      "tab.automation.isEnabled",
      "tab.automation.isVisible",
    ]),
    target: AutomationSelector,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.getText"),
    target: AutomationTarget,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.read"),
    filter: Schema.optional(Schema.String),
    llms: Schema.optional(Schema.Literals(["index", "full"])),
    outline: Schema.optional(Schema.Boolean),
    raw: Schema.optional(Schema.Boolean),
    requireMd: Schema.optional(Schema.Boolean),
    timeout: Timeout,
    url: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TabScope,
    attribute: Schema.String,
    command: Schema.Literal("tab.automation.getAttribute"),
    target: AutomationSelector,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.download.get"),
    downloadId: Schema.String,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.dev.logs"),
    limit: Schema.optional(Schema.Number),
    logFilter: Schema.optional(Schema.String),
    logLevels: Schema.optional(Schema.Array(Schema.Literals(["debug", "error", "info", "log", "warn", "warning"]))),
  }),
])

export const BrowserReadParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One read-only browser operation",
  }),
})

export const BrowserReadTool = defineBrowserTool(
  "browser_read",
  [
    "Read live browser or element state without changing the page.",
    browserOperationGuidance,
    "Element reads require target. Prefer a ref and snapshotId from the latest browser_snapshot result.",
    "Only getText supports native role, label, placeholder, text, alt, title, testId, first, last, and nth locators; other element reads require ref or advanced CSS.",
    "CSS is an advanced fallback and requires { css, advanced: true }.",
    "Use read for agent-browser readable page content and getBox, getHtml, getText, getValue, or getAttribute for elements.",
  ].join(" "),
  BrowserReadParametersSchema,
)
