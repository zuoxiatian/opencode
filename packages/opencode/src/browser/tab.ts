import type {
  BrowserCommandData,
  BrowserCapabilityInfo,
  BrowserLocator,
  BrowserScreenshotInput,
  BrowserTabCapabilityId,
  BrowserTabState,
} from "@opencode-ai/browser-protocol"
import { CapabilityCollection, tabCapabilities } from "./capabilities"
import { ClipboardAPI } from "./clipboard"
import { CuaAPI } from "./cua"
import { DevAPI } from "./dev"
import { createDialog } from "./dialog"
import { DomCuaAPI } from "./dom-cua"
import { PlaywrightAPI } from "./playwright"
import { requireBrowserResult } from "./result"
import type { BrowserTransport } from "./transport"

export class TabHandle {
  readonly capabilities: CapabilityCollection
  readonly clipboard: ClipboardAPI
  readonly cua: CuaAPI
  readonly dev: DevAPI
  readonly domCua: DomCuaAPI
  readonly dom_cua: DomCuaAPI
  readonly playwright: PlaywrightAPI

  constructor(
    private readonly transport: BrowserTransport,
    readonly browserId: string,
    readonly id: string,
    capabilities: BrowserTabCapabilityId[] | BrowserCapabilityInfo[] = [],
  ) {
    this.capabilities = tabCapabilities(
      transport,
      browserId,
      id,
      capabilities.map((capability) =>
        typeof capability === "string"
          ? { description: capability, id: capability }
          : capability,
      ),
    )
    this.clipboard = new ClipboardAPI(transport, browserId, id)
    this.cua = new CuaAPI(transport, browserId, id)
    this.dev = new DevAPI(transport, browserId, id)
    this.domCua = new DomCuaAPI(transport, browserId, id)
    this.dom_cua = this.domCua
    this.playwright = new PlaywrightAPI(transport, browserId, id)
  }

  activate() {
    return this.stateCommand("tab.activate")
  }

  back() {
    return this.backResult().then(() => undefined)
  }

  backResult() {
    return this.navigationCommand("tab.back")
  }

  close() {
    return this.transport.command({
      browserId: this.browserId,
      command: { name: "tab.close" },
      tabId: this.id,
    }).then(() => undefined)
  }

  forward() {
    return this.forwardResult().then(() => undefined)
  }

  forwardResult() {
    return this.navigationCommand("tab.forward")
  }

  goto(url: string) {
    return this.gotoResult(url).then(() => undefined)
  }

  gotoResult(url: string) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.goto", url },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.navigation, "navigation result"))
  }

  mark(disposition: "deliverable" | "handoff" | "temporary") {
    return this.transport.command({
      browserId: this.browserId,
      command: { disposition, name: "tab.mark" },
      tabId: this.id,
    }).then(() => undefined)
  }

  markDeliverable() {
    return this.mark("deliverable")
  }

  markHandoff() {
    return this.mark("handoff")
  }

  reload() {
    return this.reloadResult().then(() => undefined)
  }

  reloadResult() {
    return this.navigationCommand("tab.reload")
  }

  screenshot(input: Pick<BrowserScreenshotInput, "clip" | "fullPage"> = {}) {
    return this.screenshotResult(input).then((screenshot) => {
      if (!screenshot.data) throw new Error("Browser screenshot did not include image data")
      return Uint8Array.from(Buffer.from(screenshot.data, "base64"))
    })
  }

  screenshotResult(input: BrowserScreenshotInput = {}) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.screenshot", ...input },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.screenshot, "screenshot"))
  }

  state() {
    return this.stateCommand("tab.state")
  }

  title() {
    return this.state().then((state) => state.title || undefined)
  }

  url() {
    return this.state().then((state) => state.url || undefined)
  }

  stop() {
    return this.stateCommand("tab.stop")
  }

  dialog() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.dialog.get" },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.dialog, "dialog state"))
  }

  getJsDialog() {
    return this.dialog().then((dialog) => dialog
      ? createDialog(this.transport, this.browserId, this.id, dialog)
      : undefined)
  }

  waitForDialog(timeout?: number, trigger?: BrowserLocator) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.dialog.wait", timeout, trigger },
      tabId: this.id,
    }).then((result) => {
      const dialog = requireBrowserResult(result.data.dialog, "dialog")
      if (dialog) return dialog
      throw new Error("Browser returned an empty dialog")
    })
  }

  handleDialog(input: { accept: boolean; dialogId: string; promptText?: string }) {
    return this.transport.command({
      browserId: this.browserId,
      command: { name: "tab.dialog.handle", ...input },
      tabId: this.id,
    }).then(() => undefined)
  }

  waitForFileChooser(timeout?: number, trigger?: BrowserLocator) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.fileChooser.wait", timeout, trigger },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.fileChooser, "file chooser"))
  }

  setFiles(chooserId: string, filePaths: string[]) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { chooserId, filePaths, name: "tab.fileChooser.setFiles" },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.value, "file chooser result"))
  }

  waitForDownload(timeout?: number, trigger?: BrowserLocator) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.download.wait", timeout, trigger },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.download, "download"))
  }

  download(downloadId: string) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { downloadId, name: "tab.download.get" },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.download, "download"))
  }

  private navigationCommand(name: "tab.back" | "tab.forward" | "tab.reload") {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.navigation, "navigation result"))
  }

  private stateCommand(name: "tab.activate" | "tab.state" | "tab.stop"): Promise<BrowserTabState> {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.tab, "tab state"))
  }
}

export { TabHandle as Tab }
