import { Browsers } from "./browsers"
import { Documentation } from "./documentation"
import { BrowserTransport, type BrowserTransportOptions } from "./transport"

export class BrowserClient {
  readonly browsers: Browsers
  readonly documentation = new Documentation()
  private readonly transport: BrowserTransport

  constructor(options: BrowserTransportOptions) {
    this.transport = new BrowserTransport(options)
    this.browsers = new Browsers(this.transport)
  }

  events() {
    return this.transport.recentEvents()
  }
}

export { BrowserClient as Agent }
