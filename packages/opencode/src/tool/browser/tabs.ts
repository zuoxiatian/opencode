import type { BrowserCommand } from "@opencode-ai/browser-protocol"
import { Schema } from "effect"
import { BrowserScope, TabScope, browserOperationGuidance, defineBrowserTool } from "./common"

export const BROWSER_TABS_COMMANDS = [
  "browser.hide",
  "browser.list",
  "browser.nameSession",
  "browser.show",
  "browser.state",
  "browser.user.claimTab",
  "browser.user.history",
  "browser.user.openTabs",
  "browser.viewport.reset",
  "browser.viewport.set",
  "tab.activate",
  "tab.close",
  "tab.mark",
  "tabs.finalize",
  "tabs.get",
  "tabs.list",
  "tabs.new",
  "tabs.selected",
] as const satisfies readonly BrowserCommand["name"][]

const Operation = Schema.Union([
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals([
      "browser.hide",
      "browser.list",
      "browser.show",
      "browser.state",
      "browser.user.openTabs",
      "browser.viewport.reset",
      "tab.activate",
      "tab.close",
      "tabs.list",
      "tabs.new",
      "tabs.selected",
    ]),
  }),
  Schema.Struct({
    ...BrowserScope,
    command: Schema.Literal("browser.nameSession"),
    sessionName: Schema.String,
  }),
  Schema.Struct({
    ...BrowserScope,
    bounds: Schema.Struct({
      height: Schema.Number,
      width: Schema.Number,
      x: Schema.Number,
      y: Schema.Number,
    }),
    command: Schema.Literal("browser.viewport.set"),
  }),
  Schema.Struct({
    ...BrowserScope,
    command: Schema.Literal("browser.user.history"),
    historyFrom: Schema.optional(Schema.String),
    historyTo: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    queries: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...BrowserScope,
    claimId: Schema.String,
    command: Schema.Literal("browser.user.claimTab"),
  }),
  Schema.Struct({
    ...BrowserScope,
    command: Schema.Literal("tabs.get"),
    targetTabId: Schema.String,
  }),
  Schema.Struct({
    ...BrowserScope,
    command: Schema.Literal("tabs.finalize"),
    keep: Schema.optional(
      Schema.Array(
        Schema.Struct({
          status: Schema.Literals(["deliverable", "handoff"]),
          tabId: Schema.String,
        }),
      ),
    ),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.mark"),
    disposition: Schema.Literals(["temporary", "deliverable", "handoff"]),
  }),
])

export const BrowserTabsParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One tabs or browser-lifecycle operation",
  }),
})

const browserGuidance = [
  "Tabs share the user's persistent browser session.",
  "Use browser.user.openTabs followed by browser.user.claimTab to take over an existing user tab; never pass a claim ID as tabId.",
  "Agent-created tabs are temporary unless marked deliverable or handoff.",
  "Call tabs.finalize after the browser task to close temporary tabs and release claimed user tabs.",
].join(" ")

export const BrowserTabsTool = defineBrowserTool(
  "browser_tabs",
  [
    "Manage embedded browser instances, user-tab claims, tabs, viewport, activation, disposition, and finalization.",
    browserOperationGuidance,
    browserGuidance,
  ].join(" "),
  BrowserTabsParametersSchema,
)
