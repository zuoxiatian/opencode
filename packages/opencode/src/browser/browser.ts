import type {
  BrowserBounds,
  BrowserCapabilityInfo,
  BrowserCommandData,
  BrowserInfo,
  BrowserState,
} from "@opencode-ai/browser-protocol"
import { browserCapabilities, CapabilityCollection } from "./capabilities"
import { BrowserDocumentation, browserDocumentation } from "./documentation"
import { requireBrowserResult } from "./result"
import { Tabs } from "./tabs"
import type { BrowserTransport } from "./transport"
import { BrowserUser } from "./user"

export class BrowserHandle {
  readonly capabilities: CapabilityCollection
  readonly tabs: Tabs
  readonly user: BrowserUser

  constructor(
    private readonly transport: BrowserTransport,
    readonly browserId: string,
    capabilities: BrowserInfo["capabilities"] = {},
    private readonly browserName = "LongwiseTechAgent Browser",
    private readonly browserType: BrowserInfo["type"] = "iab",
  ) {
    this.capabilities = browserCapabilities(transport, browserId, capabilities.browser)
    this.tabs = new Tabs(transport, browserId, capabilities.tab)
    this.user = new BrowserUser(transport, browserId, capabilities.tab)
    this.documentationApi = new BrowserDocumentation()
  }

  private readonly documentationApi: BrowserDocumentation

  get id() {
    return this.browserId
  }

  async documentation() {
    const [api, guidance, browserCapabilities, tabCapabilities] = await Promise.all([
      this.documentationApi.api(),
      this.documentationApi.guidance(),
      this.capabilities.list(),
      this.tabs.capabilityInfo(),
    ])
    return [
      browserDocumentation(this.browserId, this.browserName, this.browserType),
      capabilityDocumentation("Browser Capabilities", "browser", browserCapabilities),
      capabilityDocumentation("Tab Capabilities", "tab", tabCapabilities),
      ...guidance,
      this.documentationApi.lookupCatalog(),
      api,
    ].filter((value) => value != null).join("\n\n")
  }

  hide() {
    return this.stateCommand("browser.hide")
  }

  show() {
    return this.stateCommand("browser.show")
  }

  state() {
    return this.stateCommand("browser.state")
  }

  setViewport(bounds: BrowserBounds) {
    return this.transport.command({
      browserId: this.id,
      command: { bounds, name: "browser.viewport.set" },
    }).then((result) => requireBrowserResult(result.state, "browser state"))
  }

  nameSession(name: string) {
    const value = name.trim()
    if (!value) throw new Error("browser.nameSession requires a name")
    return this.transport.command({
      browserId: this.browserId,
      command: { name: "browser.nameSession", value },
    }).then(() => undefined)
  }

  resetViewport() {
    return this.transport.command({
      browserId: this.id,
      command: { name: "browser.viewport.reset" },
    }).then((result) => requireBrowserResult(result.state, "browser state"))
  }

  private stateCommand(name: "browser.hide" | "browser.show" | "browser.state"): Promise<BrowserState> {
    return this.transport.command<BrowserCommandData>({
      browserId: this.id,
      command: { name },
    }).then((result) => requireBrowserResult(result.state, "browser state"))
  }
}

export { BrowserHandle as Browser }

function capabilityDocumentation(
  heading: string,
  scope: "browser" | "tab",
  capabilities: BrowserCapabilityInfo[],
) {
  return [
    `## ${heading}`,
    ...(capabilities.length
      ? capabilities.map((capability) => [
          `- \`${capability.id}\`: ${capability.description}`,
          `  Read with \`await (await ${scope}.capabilities.get("${capability.id}")).documentation()\`.`,
        ].join("\n"))
      : ["- None"]),
  ].join("\n")
}
