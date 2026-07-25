import type {
  BrowserCdpTarget,
  BrowserElementInput,
  BrowserKeyModifier,
  BrowserLocator,
  BrowserMouseButton,
  BrowserNodeInput,
  BrowserScreenshotInput,
} from "./automation"
import type { BrowserBounds } from "./browser"
import type {
  BrowserFinalizeTabStatus,
  BrowserLoadState,
  BrowserReadFormat,
  BrowserTabsContentType,
  BrowserWaitUntil,
} from "./tab"
import type { BrowserClipboardItem } from "./files"

export type BrowserLocatorCommandName =
  | "tab.playwright.locator.allTextContents"
  | "tab.playwright.locator.check"
  | "tab.playwright.locator.click"
  | "tab.playwright.locator.count"
  | "tab.playwright.locator.dblclick"
  | "tab.playwright.locator.downloadMedia"
  | "tab.playwright.locator.evaluate"
  | "tab.playwright.locator.fill"
  | "tab.playwright.locator.getAttribute"
  | "tab.playwright.locator.innerText"
  | "tab.playwright.locator.isEnabled"
  | "tab.playwright.locator.isVisible"
  | "tab.playwright.locator.press"
  | "tab.playwright.locator.selectOption"
  | "tab.playwright.locator.setChecked"
  | "tab.playwright.locator.textContent"
  | "tab.playwright.locator.type"
  | "tab.playwright.locator.uncheck"
  | "tab.playwright.locator.waitFor"

export type BrowserCommand =
  | { name: "browser.list" | "browser.state" | "browser.show" | "browser.hide" | "browser.viewport.reset" }
  | { bounds: BrowserBounds; name: "browser.viewport.set" }
  | { name: "browser.nameSession"; value: string }
  | { name: "browser.user.openTabs" }
  | { claimId: string; name: "browser.user.claimTab" }
  | { from?: string; limit?: number; name: "browser.user.history"; queries?: string[]; to?: string }
  | { name: "tabs.list" | "tabs.selected" }
  | { name: "tabs.get"; targetTabId: string }
  | { contentType: BrowserTabsContentType; name: "tabs.content"; timeout?: number; urls: string[] }
  | { name: "tabs.new" }
  | {
      keep?: Array<{ status: BrowserFinalizeTabStatus; tabId: string }>
      name: "tabs.finalize"
    }
  | {
      disposition: "deliverable" | "handoff" | "temporary"
      name: "tab.mark"
    }
  | {
      name:
        | "tab.activate"
        | "tab.back"
        | "tab.close"
        | "tab.forward"
        | "tab.reload"
        | "tab.state"
        | "tab.stop"
    }
  | { name: "tab.goto"; url: string }
  | ({ name: "tab.screenshot" } & BrowserScreenshotInput)
  | { format?: BrowserReadFormat; name: "tab.content.read" }
  | { name: "tab.content.export" }
  | { format: "csv" | "docx" | "md" | "pdf" | "pptx" | "xlsx"; name: "tab.content.exportGsuite" }
  | { name: "tab.playwright.domSnapshot" }
  | { includeNonInteractable?: boolean; name: "tab.playwright.elementInfo"; x: number; y: number }
  | { includeNonInteractable?: boolean; name: "tab.playwright.elementScreenshot"; x: number; y: number }
  | { arg?: unknown; expression: string; name: "tab.playwright.evaluate"; timeout?: number }
  | { name: "tab.domCua.getVisibleDom" }
  | {
      name: "tab.playwright.expectNavigation"
      timeout?: number
      trigger?: BrowserLocator
      url?: string
      waitUntil?: BrowserWaitUntil
    }
  | { name: "tab.playwright.waitForURL"; timeout?: number; url: string; waitUntil?: BrowserWaitUntil }
  | { name: "tab.playwright.waitForLoadState"; state: BrowserLoadState; timeout?: number }
  | { name: "tab.playwright.waitForTimeout"; timeout: number }
  | ({ name: BrowserLocatorCommandName } & BrowserElementInput)
  | ({ name: "tab.domCua.click" | "tab.domCua.doubleClick" } & BrowserNodeInput)
  | {
      deltaX: number
      deltaY: number
      name: "tab.domCua.scroll"
      nodeId?: string
      snapshotId?: string
    }
  | { keys: string[]; name: "tab.domCua.keypress" }
  | { name: "tab.domCua.type"; text: string }
  | ({ name: "tab.domCua.downloadMedia"; timeout?: number } & BrowserNodeInput)
  | {
      button?: number
      modifiers?: BrowserKeyModifier[]
      name: "tab.cua.click"
      x: number
      y: number
    }
  | {
      modifiers?: BrowserKeyModifier[]
      name: "tab.cua.doubleClick"
      x: number
      y: number
    }
  | { modifiers?: BrowserKeyModifier[]; name: "tab.cua.move"; x: number; y: number }
  | {
      modifiers?: BrowserKeyModifier[]
      name: "tab.cua.drag"
      path: Array<{ x: number; y: number }>
    }
  | {
      deltaX?: number
      deltaY: number
      modifiers?: BrowserKeyModifier[]
      name: "tab.cua.scroll"
      x: number
      y: number
    }
  | { name: "tab.cua.type"; text: string }
  | { keys: string[]; name: "tab.cua.keypress" }
  | { name: "tab.cua.downloadMedia"; timeout?: number; x: number; y: number }
  | { name: "tab.dialog.get" }
  | { name: "tab.dialog.wait"; timeout?: number; trigger?: BrowserLocator }
  | { accept: boolean; dialogId: string; name: "tab.dialog.handle"; promptText?: string }
  | { name: "tab.fileChooser.wait"; timeout?: number; trigger?: BrowserLocator }
  | { chooserId: string; filePaths: string[]; name: "tab.fileChooser.setFiles"; timeout?: number }
  | { name: "tab.download.wait"; timeout?: number; trigger?: BrowserLocator }
  | { downloadId: string; name: "tab.download.get" }
  | { name: "tab.clipboard.read" | "tab.clipboard.readText" }
  | { name: "tab.clipboard.write"; items: BrowserClipboardItem[] }
  | { name: "tab.clipboard.writeText"; text: string }
  | {
      method: string
      name: "tab.dev.cdp"
      params?: Record<string, unknown>
      target?: BrowserCdpTarget
      timeout?: number
    }
  | {
      afterSequence?: number
      limit?: number
      methods?: string[]
      name: "tab.dev.cdp.events"
      target?: BrowserCdpTarget
      timeout?: number
    }
  | {
      filter?: string
      levels?: Array<"debug" | "error" | "info" | "log" | "warn" | "warning">
      limit?: number
      name: "tab.dev.logs"
    }

export interface BrowserCommandInput {
  browserId?: string
  command: BrowserCommand
  expectedOrigin?: string
  tabId?: string
}
