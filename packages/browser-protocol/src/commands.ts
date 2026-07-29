import type {
  BrowserAutomationTarget,
  BrowserAutomationWait,
  BrowserCdpTarget,
  BrowserKeyModifier,
  BrowserNodeInput,
  BrowserScreenshotInput,
} from "./automation"
import type { BrowserBounds } from "./browser"
import type { BrowserFinalizeTabStatus } from "./tab"
import type { BrowserClipboardItem } from "./files"

export type BrowserCommand =
  | { name: "browser.list" | "browser.state" | "browser.show" | "browser.hide" | "browser.viewport.reset" }
  | { bounds: BrowserBounds; name: "browser.viewport.set" }
  | { name: "browser.nameSession"; value: string }
  | { name: "browser.user.openTabs" }
  | { claimId: string; name: "browser.user.claimTab" }
  | { from?: string; limit?: number; name: "browser.user.history"; queries?: string[]; to?: string }
  | { name: "tabs.list" | "tabs.selected" }
  | { name: "tabs.get"; targetTabId: string }
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
  | { interactiveOnly?: boolean; name: "tab.automation.snapshot" }
  | {
      name:
        | "tab.automation.click"
        | "tab.automation.dblclick"
        | "tab.automation.focus"
        | "tab.automation.hover"
        | "tab.automation.check"
        | "tab.automation.uncheck"
        | "tab.automation.scrollIntoView"
      target: BrowserAutomationTarget
      timeout?: number
    }
  | {
      name: "tab.automation.fill" | "tab.automation.type"
      target: BrowserAutomationTarget
      timeout?: number
      value: string
    }
  | {
      key: string
      name: "tab.automation.press"
      target?: BrowserAutomationTarget
      timeout?: number
    }
  | {
      name: "tab.automation.select"
      target: BrowserAutomationTarget
      timeout?: number
      values: string[]
    }
  | {
      name: "tab.automation.drag"
      source: BrowserAutomationTarget
      target: BrowserAutomationTarget
      timeout?: number
    }
  | ({ name: "tab.automation.waitFor"; timeout?: number } & BrowserAutomationWait)
  | {
      name:
        | "tab.automation.getText"
        | "tab.automation.getHtml"
        | "tab.automation.getValue"
        | "tab.automation.getBox"
        | "tab.automation.getStyles"
        | "tab.automation.count"
        | "tab.automation.isVisible"
        | "tab.automation.isEnabled"
        | "tab.automation.isChecked"
      target: BrowserAutomationTarget
      timeout?: number
    }
  | {
      attribute: string
      name: "tab.automation.getAttribute"
      target: BrowserAutomationTarget
      timeout?: number
    }
  | { name: "tab.domCua.getVisibleDom" }
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
  | { name: "tab.dialog.wait"; timeout?: number; trigger?: BrowserAutomationTarget }
  | { accept: boolean; dialogId: string; name: "tab.dialog.handle"; promptText?: string }
  | { name: "tab.fileChooser.wait"; timeout?: number; trigger?: BrowserAutomationTarget }
  | { chooserId: string; filePaths: string[]; name: "tab.fileChooser.setFiles"; timeout?: number }
  | { name: "tab.download.wait"; timeout?: number; trigger?: BrowserAutomationTarget }
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
