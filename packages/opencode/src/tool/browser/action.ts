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

export const BROWSER_ACTION_COMMANDS = [
  "tab.automation.check",
  "tab.automation.click",
  "tab.automation.dblclick",
  "tab.automation.drag",
  "tab.automation.fill",
  "tab.automation.focus",
  "tab.automation.hover",
  "tab.automation.keydown",
  "tab.automation.keyboard.insertText",
  "tab.automation.keyboard.type",
  "tab.automation.keyup",
  "tab.automation.press",
  "tab.automation.scroll",
  "tab.automation.scrollIntoView",
  "tab.automation.select",
  "tab.automation.type",
  "tab.automation.uncheck",
  "tab.clipboard.write",
  "tab.clipboard.writeText",
  "tab.cua.click",
  "tab.cua.downloadMedia",
  "tab.cua.doubleClick",
  "tab.cua.drag",
  "tab.cua.keypress",
  "tab.cua.move",
  "tab.cua.scroll",
  "tab.cua.type",
  "tab.dialog.handle",
  "tab.domCua.click",
  "tab.domCua.downloadMedia",
  "tab.domCua.doubleClick",
  "tab.domCua.keypress",
  "tab.domCua.scroll",
  "tab.domCua.type",
  "tab.fileChooser.setFiles",
] as const satisfies readonly BrowserCommand["name"][]

const Point = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
})

const Modifiers = Schema.optional(Schema.Array(Schema.Literals(["alt", "control", "meta", "shift"])))

const ClipboardItems = Schema.Array(
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
)

const Operation = Schema.Union([
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals([
      "tab.automation.check",
      "tab.automation.click",
      "tab.automation.hover",
    ]),
    target: AutomationTarget,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals([
      "tab.automation.dblclick",
      "tab.automation.focus",
      "tab.automation.scrollIntoView",
      "tab.automation.uncheck",
    ]),
    target: AutomationSelector,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.fill"),
    target: AutomationTarget,
    timeout: Timeout,
    value: Schema.String,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.type"),
    target: AutomationSelector,
    timeout: Timeout,
    value: Schema.String,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.select"),
    target: AutomationSelector,
    timeout: Timeout,
    values: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.drag"),
    sourceTarget: AutomationSelector,
    target: AutomationSelector,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.automation.press"),
    key: Schema.String,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals(["tab.automation.keydown", "tab.automation.keyup"]),
    key: Schema.String,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals(["tab.automation.keyboard.insertText", "tab.automation.keyboard.type"]),
    text: Schema.String,
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    amount: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isBetween({
      minimum: 0,
      maximum: 1_000_000,
    }))),
    command: Schema.Literal("tab.automation.scroll"),
    direction: Schema.optional(Schema.Literals(["down", "left", "right", "up"])),
    target: Schema.optional(AutomationSelector),
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals(["tab.domCua.click", "tab.domCua.doubleClick"]),
    nodeId: Schema.String,
    snapshotId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.domCua.downloadMedia"),
    nodeId: Schema.String,
    snapshotId: Schema.optional(Schema.String),
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.domCua.scroll"),
    deltaX: Schema.Number,
    deltaY: Schema.Number,
    nodeId: Schema.optional(Schema.String),
    snapshotId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.domCua.type"),
    text: Schema.String,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.domCua.keypress"),
    keys: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literals(["tab.cua.click", "tab.cua.doubleClick", "tab.cua.move"]),
    cuaButton: Schema.optional(Schema.Number),
    keys: Schema.optional(Schema.Array(Schema.String)),
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.cua.drag"),
    dragPath: Schema.Array(Point),
    keys: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.cua.scroll"),
    keys: Schema.optional(Schema.Array(Schema.String)),
    scrollX: Schema.optional(Schema.Number),
    scrollY: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.cua.type"),
    text: Schema.String,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.cua.keypress"),
    keys: Schema.Array(Schema.String),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.cua.downloadMedia"),
    timeout: Timeout,
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.Struct({
    ...TabScope,
    accept: Schema.Boolean,
    command: Schema.Literal("tab.dialog.handle"),
    dialogId: Schema.String,
    promptText: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TabScope,
    chooserId: Schema.String,
    command: Schema.Literal("tab.fileChooser.setFiles"),
    filePaths: Schema.Array(Schema.String),
    timeout: Timeout,
  }),
  Schema.Struct({
    ...TabScope,
    clipboardItems: ClipboardItems,
    command: Schema.Literal("tab.clipboard.write"),
  }),
  Schema.Struct({
    ...TabScope,
    command: Schema.Literal("tab.clipboard.writeText"),
    text: Schema.String,
  }),
])

export const BrowserActionParametersSchema = Schema.Struct({
  operation: Operation.annotate({
    description: "One state-changing browser operation",
  }),
})

export const BrowserActionTool = defineBrowserTool(
  "browser_action",
  [
    "Perform state-changing semantic, coordinate, clipboard, dialog, upload, or DOM-CUA actions in the embedded browser.",
    browserOperationGuidance,
    "Prefer a fresh browser_snapshot ref with its matching snapshotId.",
    "Native role, label, placeholder, text, alt, title, testId, first, last, and nth locators are supported only by click, fill, check, and hover; other element actions require ref or advanced CSS.",
    "After any state-changing action, take a fresh snapshot; never retry a STALE_REF.",
    "Use tab.cua only when page geometry matters or semantic targeting is unavailable.",
  ].join(" "),
  BrowserActionParametersSchema,
)
