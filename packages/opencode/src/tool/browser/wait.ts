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

export const BROWSER_WAIT_COMMANDS = [
  "tab.automation.waitFor",
  "tab.dialog.wait",
  "tab.download.wait",
  "tab.fileChooser.wait",
] as const satisfies readonly BrowserCommand["name"][]

const WaitOperation = {
  ...TabScope,
  command: Schema.Literal("tab.automation.waitFor"),
  expression: Schema.optional(Schema.Never),
  loadState: Schema.optional(Schema.Never),
  milliseconds: Schema.optional(Schema.Never),
  state: Schema.optional(Schema.Never),
  target: Schema.optional(Schema.Never),
  text: Schema.optional(Schema.Never),
  timeout: Timeout,
  url: Schema.optional(Schema.Never),
}

const Operation = Schema.Union([
  Schema.Struct({
    ...WaitOperation,
    state: Schema.optional(Schema.Literals(["attached", "detached", "hidden", "visible"])).annotate({
      description: "Optional element state; visible is the agent-browser default",
    }),
    target: AutomationSelector,
  }),
  Schema.Struct({
    ...WaitOperation,
    text: Schema.String,
  }),
  Schema.Struct({
    ...WaitOperation,
    url: Schema.String,
  }),
  Schema.Struct({
    ...WaitOperation,
    loadState: Schema.Literals(["domcontentloaded", "load", "networkidle"]).annotate({
      description:
        "Page lifecycle state passed to agent-browser wait --load; prefer load for normal pages and use networkidle only when specifically required",
    }),
  }),
  Schema.Struct({
    ...WaitOperation,
    expression: Schema.String.annotate({
      description: "JavaScript expression passed to agent-browser wait --fn until it becomes truthy",
    }),
  }),
  Schema.Struct({
    ...WaitOperation,
    milliseconds: Schema.Number.check(Schema.isInt())
      .check(Schema.isBetween({ minimum: 0, maximum: 120_000 }))
      .annotate({
        description:
          "Fixed delay passed to agent-browser wait in milliseconds; use only without an observable condition",
      }),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals(["tab.dialog.wait", "tab.download.wait", "tab.fileChooser.wait"]),
    target: Schema.optional(AutomationTarget).annotate({
      description: "Optional triggering element; waiting and clicking are performed atomically",
    }),
    timeout: Timeout,
  }),
])

export const BrowserWaitParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One wait operation",
  }),
})

export const BrowserWaitTool = defineBrowserTool(
  "browser_wait",
  [
    "Wait for a browser condition, dialog, file chooser, or download.",
    browserOperationGuidance,
    "tab.automation.waitFor matches agent-browser wait and requires exactly one of target, text, url, loadState, expression, or milliseconds.",
    "Element waits accept a fresh snapshot ref or advanced CSS selector.",
    "After navigation, use loadState load for page lifecycle completion, then wait for a target or text when application readiness matters.",
    "Use networkidle only when explicitly required because persistent background traffic may prevent it from completing.",
    "Expression waits execute page JavaScript and require browser_cdp permission.",
    "For dialog, file chooser, or download waits, pass the optional triggering target so waiting and clicking are atomic.",
    "A TIMEOUT means the requested condition was not observed before timeout.",
  ].join(" "),
  BrowserWaitParametersSchema,
)
