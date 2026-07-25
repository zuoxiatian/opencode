import type { BrowserCommandData, BrowserReadFormat } from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"
import { requireBrowserResult } from "./result"

export class ContentAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  read(format: BrowserReadFormat = "text") {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { format, name: "tab.content.read" },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.snapshot, "page snapshot"))
  }

  export() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.content.export" },
      tabId: this.tabId,
    }).then((result) => requireExportPath(result.data.path, "content export path"))
  }

  exportGsuite(format: "csv" | "docx" | "md" | "pdf" | "pptx" | "xlsx") {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { format, name: "tab.content.exportGsuite" },
      tabId: this.tabId,
    }).then((result) => requireExportPath(result.data.path, "Google Workspace export path"))
  }
}

function requireExportPath(value: string | null | undefined, name: string) {
  const path = requireBrowserResult(value, name)
  if (path) return path
  throw new Error(`Browser response is missing ${name}`)
}
