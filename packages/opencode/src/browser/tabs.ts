import type {
  BrowserCommandData,
  BrowserCapabilityInfo,
  BrowserFinalizeTabsInput,
} from "@opencode-ai/browser-protocol"
import { TabHandle } from "./tab"
import { requireBrowserResult } from "./result"
import type { BrowserTransport } from "./transport"

export class Tabs {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly capabilities: BrowserCapabilityInfo[] = [],
  ) {}

  capabilityInfo() {
    return Promise.resolve(this.capabilities.map((capability) => ({ ...capability })))
  }

  finalize(input: BrowserFinalizeTabsInput = {}) {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new Error("browser.tabs.finalize expects an options object")
    }
    const keep = input.keep ?? []
    if (!Array.isArray(keep)) throw new Error("browser.tabs.finalize keep must be an array")
    return this.transport.command({
      browserId: this.browserId,
      command: {
        keep: keep.map((item) => ({
          status: finalizeStatus(item.status),
          tabId: finalizeTabId(item.tab),
        })),
        name: "tabs.finalize",
      },
    }).then(() => undefined)
  }

  get(tabId: string) {
    if (!tabId) throw new Error("tabs.get requires a tab id")
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tabs.get", targetTabId: tabId },
    }).then((result) => {
      const tab = requireBrowserResult(result.data.tab, "tab")
      return new TabHandle(this.transport, this.browserId, tab.id, this.tabCapabilities(tab.capabilities))
    })
  }

  list() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tabs.list" },
    }).then((result) => requireBrowserResult(result.data.tabs, "tab list").map((tab) => ({
      id: tab.id,
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.url ? { url: tab.url } : {}),
    })))
  }

  new() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tabs.new" },
    }).then((result) => {
      if (!result.data.tab) throw new Error("Browser did not return the new tab")
      return new TabHandle(
        this.transport,
        this.browserId,
        result.data.tab.id,
        this.tabCapabilities(result.data.tab.capabilities),
      )
    })
  }

  selected() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tabs.selected" },
    }).then((result) => result.data.tab
      ? new TabHandle(
          this.transport,
          this.browserId,
          result.data.tab.id,
          this.tabCapabilities(result.data.tab.capabilities),
        )
      : undefined)
  }

  private tabCapabilities(ids: string[]) {
    return this.capabilities.filter((capability) => ids.includes(capability.id))
  }
}

function finalizeTabId(tab: string | { id: string }) {
  if (typeof tab === "string") {
    if (!tab) throw new Error("browser.tabs.finalize received an empty tab id")
    return tab
  }
  if (tab && typeof tab.id === "string" && tab.id) return tab.id
  throw new Error("browser.tabs.finalize keep entries must be objects like { tab, status }")
}

function finalizeStatus(status: string) {
  if (status === "deliverable" || status === "handoff") return status
  throw new Error(`browser.tabs.finalize received invalid status ${String(status)}`)
}
