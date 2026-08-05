import type {
  BrowserAutomationSnapshot,
  BrowserAutomationSelector,
  BrowserAutomationTarget,
  BrowserAutomationWait,
  BrowserCommand,
  BrowserCommandData,
  BrowserReadableContent,
} from "@opencode-ai/browser-protocol"
import { requireBrowserResult } from "./result"
import type { BrowserTransport } from "./transport"

type AutomationCommand = Extract<BrowserCommand, { name: `tab.automation.${string}` }>
type TargetOptions = { timeoutMs?: number }

export class AutomationAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  snapshot(options: {
    compact?: boolean
    depth?: number
    interactive?: boolean
    interactiveOnly?: boolean
    selector?: string
    urls?: boolean
  } = {}): Promise<BrowserAutomationSnapshot> {
    return this.command({
      compact: options.compact,
      depth: options.depth,
      interactive: options.interactive,
      interactiveOnly: options.interactiveOnly,
      name: "tab.automation.snapshot",
      selector: options.selector,
      urls: options.urls,
    }).then((data) => requireBrowserResult(data.automationSnapshot, "automation snapshot"))
  }

  click(target: BrowserAutomationTarget, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.click", target, timeout: options.timeoutMs })
  }

  dblclick(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.dblclick", target, timeout: options.timeoutMs })
  }

  focus(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.focus", target, timeout: options.timeoutMs })
  }

  fill(target: BrowserAutomationTarget, value: string, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.fill", target, timeout: options.timeoutMs, value })
  }

  type(target: BrowserAutomationSelector, value: string, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.type", target, timeout: options.timeoutMs, value })
  }

  press(key: string, options: TargetOptions = {}) {
    return this.action({
      key,
      name: "tab.automation.press",
      timeout: options.timeoutMs,
    })
  }

  keydown(key: string, options: TargetOptions = {}) {
    return this.action({ key, name: "tab.automation.keydown", timeout: options.timeoutMs })
  }

  keyup(key: string, options: TargetOptions = {}) {
    return this.action({ key, name: "tab.automation.keyup", timeout: options.timeoutMs })
  }

  keyboardType(text: string, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.keyboard.type", text, timeout: options.timeoutMs })
  }

  insertText(text: string, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.keyboard.insertText", text, timeout: options.timeoutMs })
  }

  hover(target: BrowserAutomationTarget, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.hover", target, timeout: options.timeoutMs })
  }

  select(target: BrowserAutomationSelector, values: string[], options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.select", target, timeout: options.timeoutMs, values })
  }

  check(target: BrowserAutomationTarget, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.check", target, timeout: options.timeoutMs })
  }

  uncheck(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.uncheck", target, timeout: options.timeoutMs })
  }

  scrollIntoView(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.scrollIntoView", target, timeout: options.timeoutMs })
  }

  scroll(options: TargetOptions & {
    amount?: number
    direction?: "down" | "left" | "right" | "up"
    target?: BrowserAutomationSelector
  } = {}) {
    return this.action({
      amount: options.amount,
      direction: options.direction,
      name: "tab.automation.scroll",
      target: options.target,
      timeout: options.timeoutMs,
    })
  }

  drag(source: BrowserAutomationSelector, target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.action({ name: "tab.automation.drag", source, target, timeout: options.timeoutMs })
  }

  waitFor(wait: BrowserAutomationWait, options: TargetOptions = {}) {
    return this.action({ ...wait, name: "tab.automation.waitFor", timeout: options.timeoutMs })
  }

  getText(target: BrowserAutomationTarget, options: TargetOptions = {}) {
    return this.getTextResult(target, options).then((result) => result.value)
  }

  getTextResult(target: BrowserAutomationTarget, options: TargetOptions = {}) {
    return this.command({
      name: "tab.automation.getText",
      target,
      timeout: options.timeoutMs,
    }).then((data) => ({
      truncated: data.truncated === true,
      value: requireBrowserResult(data.value as string | undefined, "element text"),
    }))
  }

  read(options: {
    filter?: string
    llms?: "full" | "index"
    outline?: boolean
    raw?: boolean
    requireMd?: boolean
    timeoutMs?: number
    url?: string
  } = {}): Promise<BrowserReadableContent> {
    return this.command({
      filter: options.filter,
      llms: options.llms,
      name: "tab.automation.read",
      outline: options.outline,
      raw: options.raw,
      requireMd: options.requireMd,
      timeout: options.timeoutMs,
      url: options.url,
    }).then((data) => requireBrowserResult(data.readable, "readable page content"))
  }

  getHtml(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.getHtmlResult(target, options).then((result) => result.html)
  }

  getHtmlResult(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.command({
      name: "tab.automation.getHtml",
      target,
      timeout: options.timeoutMs,
    }).then((data) => ({
      html: requireBrowserResult(data.html, "element HTML"),
      truncated: data.truncated === true,
    }))
  }

  getValue(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.value<string>({ name: "tab.automation.getValue", target, timeout: options.timeoutMs })
  }

  getAttribute(target: BrowserAutomationSelector, attribute: string, options: TargetOptions = {}) {
    return this.value<null | string>({
      attribute,
      name: "tab.automation.getAttribute",
      target,
      timeout: options.timeoutMs,
    })
  }

  getBox(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.command({
      name: "tab.automation.getBox",
      target,
      timeout: options.timeoutMs,
    }).then((data) => requireBrowserResult(data.box, "element box"))
  }

  getStyles(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.command({
      name: "tab.automation.getStyles",
      target,
      timeout: options.timeoutMs,
    }).then((data) => requireBrowserResult(data.styles, "element styles"))
  }

  count(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.command({
      name: "tab.automation.count",
      target,
      timeout: options.timeoutMs,
    }).then((data) => requireBrowserResult(data.count, "element count"))
  }

  isVisible(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.value<boolean>({ name: "tab.automation.isVisible", target, timeout: options.timeoutMs })
  }

  isEnabled(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.value<boolean>({ name: "tab.automation.isEnabled", target, timeout: options.timeoutMs })
  }

  isChecked(target: BrowserAutomationSelector, options: TargetOptions = {}) {
    return this.value<boolean>({ name: "tab.automation.isChecked", target, timeout: options.timeoutMs })
  }

  private action(command: AutomationCommand) {
    return this.command(command).then(() => undefined)
  }

  private value<T>(command: AutomationCommand) {
    return this.command(command)
      .then((data) => requireBrowserResult(data.value as T | undefined, "automation value"))
  }

  private command(command: AutomationCommand) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command,
      tabId: this.tabId,
    }).then((result) => result.data)
  }
}
