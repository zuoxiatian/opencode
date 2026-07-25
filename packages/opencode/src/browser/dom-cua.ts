import type { BrowserCommandData } from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"
import { requireBrowserResult } from "./result"

export class DomCuaAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  get_visible_dom() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.domCua.getVisibleDom" },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.visibleDom, "visible DOM"))
  }

  click(input: { node_id: string }) {
    return this.run({ name: "tab.domCua.click", nodeId: requireNodeId(input?.node_id, "dom_cua.click") })
  }

  double_click(input: { node_id: string }) {
    return this.run({
      name: "tab.domCua.doubleClick",
      nodeId: requireNodeId(input?.node_id, "dom_cua.double_click"),
    })
  }

  downloadMedia(input: { node_id: string; timeoutMs?: number }) {
    return this.transport.command({
      browserId: this.browserId,
      command: {
        name: "tab.domCua.downloadMedia",
        nodeId: requireNodeId(input?.node_id, "dom_cua.downloadMedia"),
        timeout: input.timeoutMs,
      },
      tabId: this.tabId,
    }).then(() => undefined)
  }

  scroll(input: {
    node_id?: string
    x: number
    y: number
  }) {
    if (typeof input?.x !== "number" || typeof input?.y !== "number") {
      throw new Error("dom_cua.scroll requires x and y numbers")
    }
    return this.run({
      deltaX: input.x,
      deltaY: input.y,
      name: "tab.domCua.scroll",
      nodeId: input.node_id === undefined
        ? undefined
        : requireNodeId(input.node_id, "dom_cua.scroll"),
    })
  }

  type(input: { text: string }) {
    if (typeof input?.text !== "string") throw new Error("dom_cua.type requires text")
    return this.run({ name: "tab.domCua.type", text: input.text })
  }

  keypress(input: { keys: string[] }) {
    if (!Array.isArray(input?.keys) || !input.keys.length) {
      throw new Error("dom_cua.keypress requires a non-empty keys array")
    }
    return this.run({ keys: input.keys, name: "tab.domCua.keypress" })
  }

  private run(command: Extract<
    import("@opencode-ai/browser-protocol").BrowserCommand,
    { name: `tab.domCua.${string}` }
  >) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command,
      tabId: this.tabId,
    }).then((result) => {
      requireBrowserResult(result.data.value, "DOM action result")
    })
  }
}

export { DomCuaAPI as DomCUAAPI }

function requireNodeId(value: string | undefined, operation: string) {
  if (value === undefined) throw new Error(`${operation} requires a node_id`)
  if (typeof value !== "string") throw new Error(`${operation} node_id must be a string`)
  if (!value) throw new Error(`${operation} node_id must not be empty`)
  return value
}
