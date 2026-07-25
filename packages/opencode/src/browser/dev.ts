import type { BrowserCommandData, BrowserDevLogEntry } from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"

export class DevAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  logs(options: {
    filter?: string
    levels?: Array<BrowserDevLogEntry["level"] | "warning">
    limit?: number
  } = {}) {
    if (options.filter !== undefined && typeof options.filter !== "string") {
      throw new Error("tab.dev.logs received an invalid filter")
    }
    if (
      options.levels !== undefined
      && (
        !Array.isArray(options.levels)
        || !options.levels.length
        || options.levels.some((level) =>
          !["debug", "error", "info", "log", "warn", "warning"].includes(level))
      )
    ) {
      throw new Error("tab.dev.logs received invalid levels")
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
      throw new Error("tab.dev.logs received an invalid limit")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        filter: options.filter,
        levels: options.levels?.map((level) => level === "warning" ? "warn" : level),
        limit: options.limit,
        name: "tab.dev.logs",
      },
      tabId: this.tabId,
    }).then((result) => result.data.logs ?? [])
  }
}

export { DevAPI as TabDevAPI }
