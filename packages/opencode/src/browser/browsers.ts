import { DEFAULT_BROWSER_ID, type BrowserCommandData, type BrowserInfo } from "@opencode-ai/browser-protocol"
import { BrowserHandle } from "./browser"
import { requireBrowserResult } from "./result"
import type { BrowserTransport } from "./transport"

export class Browsers {
  constructor(private readonly transport: BrowserTransport) {}

  get(browserId: string) {
    if (!browserId) throw new Error("browsers.get requires a browser id")
    return this.list().then((browsers) => {
      const info = browsers.find((browser) => browser.id === browserId || browser.type === browserId)
      if (!info) throw new Error(`Browser not found: ${browserId}`)
      return new BrowserHandle(this.transport, info.id, info.capabilities, info.name, info.type)
    })
  }

  getDefault() {
    return this.list().then((browsers) => {
      const browser = browsers.find((item) => item.id === DEFAULT_BROWSER_ID) ?? browsers[0]
      if (!browser) throw new Error("The desktop embedded browser is not available")
      return new BrowserHandle(this.transport, browser.id, browser.capabilities, browser.name, browser.type)
    })
  }

  getForUrl(url: string) {
    if (!url) throw new Error("browsers.getForUrl requires a url")
    new URL(url)
    return this.getDefault()
  }

  list() {
    return this.transport.command<BrowserCommandData>({
      command: { name: "browser.list" },
    }).then((result) => requireBrowserResult(result.data.browsers, "browser list"))
  }
}
