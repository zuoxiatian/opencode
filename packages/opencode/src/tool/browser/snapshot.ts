import type { BrowserCommand } from "@opencode-ai/browser-protocol"
import { Schema } from "effect"
import { AutomationSelector, TabScope, browserOperationGuidance, defineBrowserTool } from "./common"

export const BROWSER_SNAPSHOT_COMMANDS = [
  "tab.automation.snapshot",
  "tab.pdf",
  "tab.screenshot",
] as const satisfies readonly BrowserCommand["name"][]

const Operation = Schema.Union([
  Schema.Struct({
    ...TabScope,
    compact: Schema.optional(Schema.Boolean),
    command: Schema.Literal("tab.automation.snapshot"),
    depth: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isBetween({
      minimum: 0,
      maximum: 1_000,
    }))),
    interactive: Schema.optional(Schema.Boolean),
    selector: Schema.optional(Schema.String),
    urls: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...TabScope,
    annotate: Schema.optional(Schema.Boolean),
    clip: Schema.optional(
      Schema.Struct({
        height: Schema.Number,
        width: Schema.Number,
        x: Schema.Number,
        y: Schema.Number,
      }),
    ),
    command: Schema.Literal("tab.screenshot"),
    fullPage: Schema.optional(Schema.Boolean),
    imageFormat: Schema.optional(Schema.Literals(["png", "jpeg"])),
    quality: Schema.optional(Schema.Number),
    savePath: Schema.optional(
      Schema.String.annotate({
        description: "Absolute path or workspace-relative destination for the same screenshot",
      }),
    ),
    target: Schema.optional(AutomationSelector),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.pdf"),
    savePath: Schema.String.annotate({
      description: "Absolute path or workspace-relative PDF destination",
    }),
  }),
])

export const BrowserSnapshotParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One semantic snapshot or screenshot operation",
  }),
})

export const BrowserSnapshotTool = defineBrowserTool(
  "browser_snapshot",
  [
    "Capture a semantic automation snapshot, screenshot, or PDF of the selected embedded browser tab.",
    browserOperationGuidance,
    "Before every semantic action, call tab.automation.snapshot and use its latest e<number> ref together with the matching snapshotId.",
    "A ref is never an HTML tag, CSS selector, or tab ID.",
    "Snapshots default to the full accessibility tree; set interactive true for agent-browser --interactive.",
    "tab.screenshot returns an image attachment and supports ref/CSS target capture or numbered annotations.",
    "tab.pdf requires savePath and writes the page PDF.",
  ].join(" "),
  BrowserSnapshotParametersSchema,
)
