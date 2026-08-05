import type {
  BrowserCommandData,
  BrowserAutomationTarget,
  BrowserCapabilityInfo,
  BrowserScreenshotInput,
  BrowserTabCapabilityId,
  BrowserTabState,
} from "@opencode-ai/browser-protocol"
import { CapabilityCollection, tabCapabilities } from "./capabilities"
import { AutomationAPI } from "./automation"
import { ClipboardAPI } from "./clipboard"
import { CuaAPI } from "./cua"
import { DevAPI } from "./dev"
import { createDialog } from "./dialog"
import { DomCuaAPI } from "./dom-cua"
import { requireBrowserResult } from "./result"
import type { BrowserTransport } from "./transport"

export class TabHandle {
  readonly automation: AutomationAPI
  readonly capabilities: CapabilityCollection
  readonly clipboard: ClipboardAPI
  readonly cua: CuaAPI
  readonly dev: DevAPI
  readonly domCua: DomCuaAPI
  readonly dom_cua: DomCuaAPI

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
    this.automation = new AutomationAPI(transport, browserId, id)
    this.clipboard = new ClipboardAPI(transport, browserId, id)
    this.cua = new CuaAPI(transport, browserId, id)
    this.dev = new DevAPI(transport, browserId, id)
    this.domCua = new DomCuaAPI(transport, browserId, id)
    this.dom_cua = this.domCua
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

  screenshot(input: BrowserScreenshotInput = {}) {
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

  pdf() {
    return this.pdfResult().then((pdf) => {
      if (!pdf.data) throw new Error("Browser PDF did not include data")
      return Uint8Array.from(Buffer.from(pdf.data, "base64"))
    })
  }

  pdfResult() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.pdf" },
      tabId: this.id,
    }).then((result) => requireBrowserResult(result.data.pdf, "PDF"))
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

  waitForDialog(timeout?: number, trigger?: BrowserAutomationTarget) {
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

  waitForFileChooser(timeout?: number, trigger?: BrowserAutomationTarget) {
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

  waitForDownload(timeout?: number, trigger?: BrowserAutomationTarget) {
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
