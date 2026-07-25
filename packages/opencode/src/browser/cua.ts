import type {
  BrowserCommandData,
  BrowserKeyModifier,
} from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"
import { requireBrowserResult } from "./result"

export class CuaAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  click(input: {
    button?: number
    keypress?: string[]
    x: number
    y: number
  }) {
    if (typeof input?.x !== "number" || typeof input?.y !== "number") {
      throw new Error("cua.click requires x and y")
    }
    return this.run({
      button: browserButton(input.button),
      modifiers: browserModifiers(input.keypress),
      name: "tab.cua.click",
      x: input.x,
      y: input.y,
    })
  }

  double_click(input: {
    keypress?: string[]
    x: number
    y: number
  }) {
    if (typeof input?.x !== "number" || typeof input?.y !== "number") {
      throw new Error("cua.double_click requires x and y")
    }
    return this.run({
      modifiers: browserModifiers(input.keypress),
      name: "tab.cua.doubleClick",
      x: input.x,
      y: input.y,
    })
  }

  downloadMedia(input: { timeoutMs?: number; x: number; y: number }) {
    if (typeof input?.x !== "number" || typeof input?.y !== "number") {
      throw new Error("cua.downloadMedia requires x and y")
    }
    return this.transport.command({
      browserId: this.browserId,
      command: {
        name: "tab.cua.downloadMedia",
        timeout: input.timeoutMs,
        x: input.x,
        y: input.y,
      },
      tabId: this.tabId,
    }).then(() => undefined)
  }

  drag(input: {
    keys?: string[]
    path: Array<{ x: number; y: number }>
  }) {
    if (
      !Array.isArray(input?.path)
      || !input.path.length
      || input.path.some((point) => typeof point?.x !== "number" || typeof point?.y !== "number")
    ) {
      throw new Error("cua.drag requires a non-empty path of {x, y} points")
    }
    return this.run({
      modifiers: browserModifiers(input.keys),
      name: "tab.cua.drag",
      path: input.path,
    })
  }

  move(input: { keys?: string[]; x: number; y: number }) {
    if (typeof input?.x !== "number" || typeof input?.y !== "number") {
      throw new Error("cua.move requires x and y")
    }
    return this.run({
      modifiers: browserModifiers(input.keys),
      name: "tab.cua.move",
      x: input.x,
      y: input.y,
    })
  }

  scroll(input: {
    keypress?: string[]
    scrollX: number
    scrollY: number
    x: number
    y: number
  }) {
    if (
      typeof input?.x !== "number"
      || typeof input?.y !== "number"
      || typeof input?.scrollX !== "number"
      || typeof input?.scrollY !== "number"
    ) {
      throw new Error("cua.scroll requires x, y, scrollX, and scrollY")
    }
    return this.run({
      deltaX: input.scrollX,
      deltaY: input.scrollY,
      modifiers: browserModifiers(input.keypress),
      name: "tab.cua.scroll",
      x: input.x,
      y: input.y,
    })
  }

  type(input: { text: string }) {
    if (typeof input?.text !== "string") throw new Error("cua.type requires text")
    return this.run({ name: "tab.cua.type", text: input.text })
  }

  keypress(input: { keys: string[] }) {
    if (!Array.isArray(input?.keys) || !input.keys.length) {
      throw new Error("cua.keypress requires a non-empty keys array")
    }
    return this.run({ keys: input.keys, name: "tab.cua.keypress" })
  }

  private run(command: Extract<
    import("@opencode-ai/browser-protocol").BrowserCommand,
    { name: `tab.cua.${string}` }
  >) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command,
      tabId: this.tabId,
    }).then((result) => {
      requireBrowserResult(result.data.value, "coordinate action result")
    })
  }
}

function browserButton(button: number | undefined) {
  if (button === undefined) return
  if (Number.isInteger(button) && button >= 1 && button <= 5) return button
  throw new Error("cua.click button must be an integer between 1 and 5")
}

function browserModifiers(keys: string[] | undefined) {
  return keys?.map((key) => {
    const value = key.toLowerCase()
    if (value === "alt" || value === "option") return "alt"
    if (value === "control" || value === "ctrl") return "control"
    if (value === "meta" || value === "command" || value === "cmd") return "meta"
    if (value === "controlormeta") return process.platform === "darwin" ? "meta" : "control"
    if (value === "shift") return "shift"
    throw new Error(`Unsupported modifier key: ${key}`)
  }) satisfies BrowserKeyModifier[] | undefined
}

export { CuaAPI as CUAAPI }
