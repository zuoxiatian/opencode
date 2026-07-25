import type {
  BrowserCommandData,
  BrowserCapabilityInfo,
  BrowserHistoryOptions,
  BrowserUserTabInfo,
} from "@opencode-ai/browser-protocol"
import { requireBrowserResult } from "./result"
import { TabHandle } from "./tab"
import type { BrowserTransport } from "./transport"

export class BrowserUser {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly capabilities: BrowserCapabilityInfo[] = [],
  ) {}

  claimTab(tab: string | BrowserUserTabInfo) {
    const claimId = typeof tab === "string"
      ? tab
      : tab && typeof tab === "object" && typeof tab.id === "string"
        ? tab.id
        : undefined
    if (claimId === "") throw new Error("browser.user.claimTab received an empty tab id")
    if (!claimId) {
      throw new Error("browser.user.claimTab expects a tab returned by browser.user.openTabs() or a tab id")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { claimId, name: "browser.user.claimTab" },
    }).then((result) => {
      const tab = requireBrowserResult(result.data.tab, "claimed tab")
      return new TabHandle(
        this.transport,
        this.browserId,
        tab.id,
        this.capabilities.filter((capability) => tab.capabilities.includes(capability.id)),
      )
    })
  }

  openTabs() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "browser.user.openTabs" },
    }).then((result) => requireBrowserResult(result.data.userTabs, "user tab list"))
  }

  history(options: BrowserHistoryOptions = {}) {
    if (options === null || Array.isArray(options) || typeof options !== "object") {
      throw new Error("browser.user.history expects an options object")
    }
    if (options.queries !== undefined && !options.queries.length) {
      throw new Error("browser.user.history received invalid queries")
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
      throw new Error("browser.user.history received an invalid limit")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        from: browserHistoryDate(options.from, "from"),
        limit: options.limit,
        name: "browser.user.history",
        queries: options.queries,
        to: browserHistoryDate(options.to, "to"),
      },
    }).then((result) => requireBrowserResult(result.data.history, "browser history"))
  }
}

function browserHistoryDate(input: string | Date | undefined, name: string) {
  if (input === undefined) return
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) throw new Error(`browser.user.history received an invalid ${name} date`)
  return date.toISOString()
}
