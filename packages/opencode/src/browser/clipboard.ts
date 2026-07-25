import type { BrowserClipboardItem, BrowserCommandData } from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"
import { requireBrowserResult } from "./result"

export class ClipboardAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  read() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.clipboard.read" },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.clipboardItems, "clipboard content"))
  }

  readText() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.clipboard.readText" },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.clipboardText, "clipboard text"))
  }

  write(items: BrowserClipboardItem[]) {
    if (!Array.isArray(items) || !items.length) {
      throw new Error("tab.clipboard.write requires at least one clipboard item")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { items, name: "tab.clipboard.write" },
      tabId: this.tabId,
    }).then(() => undefined)
  }

  writeText(text: string) {
    if (text == null) throw new Error("tab.clipboard.writeText requires text")
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.clipboard.writeText", text },
      tabId: this.tabId,
    }).then(() => undefined)
  }
}

export { ClipboardAPI as TabClipboardAPI }
