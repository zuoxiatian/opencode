import type {
  BrowserCommandData,
  BrowserElementInput,
  BrowserLoadState,
  BrowserLocator,
  BrowserLocatorCommandName,
  BrowserMouseButton,
  BrowserNavigationResult,
  BrowserSelectOption,
  BrowserWaitUntil,
} from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"
import { requireBrowserResult } from "./result"

type TextMatcher = string | RegExp
type LocatorOptions = { exact?: boolean }
type RoleOptions = LocatorOptions & { name?: TextMatcher }
type LocatorWaitState = "attached" | "detached" | "hidden" | "visible"
type LocatorModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift"
type LocatorActionOptions = {
  button?: BrowserMouseButton
  force?: boolean
  modifiers?: LocatorModifier[]
  timeoutMs?: number
}
type PageFunction<TArg, TResult> = string | ((arg: TArg) => TResult | Promise<TResult>)
type LocatorFunction<TArg, TResult> = string | ((element: Element, arg: TArg) => TResult | Promise<TResult>)

export class PlaywrightAPI {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
  ) {}

  domSnapshot() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.playwright.domSnapshot" },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.dom, "DOM snapshot"))
  }

  html() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.playwright.html" },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.html, "page HTML"))
  }

  evaluate<TResult, TArg = unknown>(
    pageFunction: PageFunction<TArg, TResult>,
    arg?: TArg,
    options: { timeoutMs?: number } = {},
  ) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        arg,
        expression: functionSource(pageFunction),
        name: "tab.playwright.evaluate",
        timeout: options.timeoutMs,
      },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.value as TResult | undefined, "evaluate result"))
  }

  elementInfo(options: { includeNonInteractable?: boolean; x: number; y: number }) {
    requireCoordinates("playwright.elementInfo", options)
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.playwright.elementInfo", ...options },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.elements, "element info"))
  }

  elementScreenshot(options: { includeNonInteractable?: boolean; x: number; y: number }) {
    requireCoordinates("playwright.elementScreenshot", options)
    return this.elementScreenshotResult(options).then((screenshot) => {
      if (!screenshot.data) throw new Error("Element screenshot did not include image data")
      return Uint8Array.from(Buffer.from(screenshot.data, "base64"))
    })
  }

  elementScreenshotResult(options: { includeNonInteractable?: boolean; x: number; y: number }) {
    requireCoordinates("playwright.elementScreenshot", options)
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.playwright.elementScreenshot", ...options },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.screenshot, "element screenshot"))
  }

  expectNavigation<T>(
    action: () => Promise<T>,
    options?: { timeoutMs?: number; url?: string; waitUntil?: BrowserLoadState },
  ): Promise<T>
  expectNavigation<T>(
    action: () => Promise<T>,
    options: { timeoutMs?: number; url?: string; waitUntil?: BrowserLoadState } = {},
  ) {
    const wait = options.url
      ? this.waitForURL(options.url, options)
      : this.waitForLoadState({ state: options.waitUntil, timeoutMs: options.timeoutMs })
    const result = action()
    return Promise.all([result, wait]).then(([value]) => value)
  }

  expectNavigationResult(
    options: { timeoutMs?: number; trigger?: BrowserLocator; url?: string; waitUntil?: BrowserWaitUntil } = {},
  ): Promise<BrowserNavigationResult> {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        name: "tab.playwright.expectNavigation",
        timeout: options.timeoutMs,
        trigger: options.trigger,
        url: options.url,
        waitUntil: options.waitUntil,
      },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.navigation, "navigation result"))
  }

  waitForURL(url: string, options: { timeoutMs?: number; waitUntil?: BrowserWaitUntil } = {}) {
    if (!url) throw new Error("playwright.waitForURL requires a url")
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        name: "tab.playwright.waitForURL",
        timeout: options.timeoutMs,
        url,
        waitUntil: options.waitUntil,
      },
      tabId: this.tabId,
    }).then(() => undefined)
  }

  waitForLoadState(options: { state?: BrowserLoadState; timeoutMs?: number } = {}) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        name: "tab.playwright.waitForLoadState",
        state: options.state ?? "load",
        timeout: options.timeoutMs,
      },
      tabId: this.tabId,
    }).then(() => undefined)
  }

  waitForEvent(event: "download", options?: { timeoutMs?: number }): Promise<PlaywrightDownload>
  waitForEvent(event: "filechooser", options?: { timeoutMs?: number }): Promise<PlaywrightFileChooser>
  waitForEvent(event: "download" | "filechooser", options: { timeoutMs?: number } = {}) {
    if (event !== "download" && event !== "filechooser") {
      throw new Error("playwright.waitForEvent only supports 'download' and 'filechooser'")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        name: event === "download" ? "tab.download.wait" : "tab.fileChooser.wait",
        timeout: options.timeoutMs,
      },
      tabId: this.tabId,
    }).then((result) => {
      if (event === "download") {
        return new PlaywrightDownload(
          this.transport,
          this.browserId,
          this.tabId,
          requireBrowserResult(result.data.download, "download").id,
        )
      }
      const chooser = requireBrowserResult(result.data.fileChooser, "file chooser")
      return new PlaywrightFileChooser(
        this.transport,
        this.browserId,
        this.tabId,
        chooser.id,
        chooser.multiple,
      )
    })
  }

  waitForTimeout(timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("playwright.waitForTimeout requires a non-negative integer")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "tab.playwright.waitForTimeout", timeout: timeoutMs },
      tabId: this.tabId,
    }).then(() => undefined)
  }

  locator(selector: string | BrowserLocator) {
    if (typeof selector === "string" && !selector) {
      throw new Error("playwright.locator requires a selector")
    }
    return new LocatorHandle(
      this.transport,
      this.browserId,
      this.tabId,
      typeof selector === "string" ? { selector } : selector,
    )
  }

  frameLocator(frameSelector: string) {
    if (!frameSelector) throw new Error("playwright.frameLocator requires a selector")
    return new FrameLocatorHandle(this.transport, this.browserId, this.tabId, [frameSelector])
  }

  getByLabel(text: TextMatcher, options: LocatorOptions = {}) {
    return this.locator(semanticSelector("label", text, options))
  }

  getByPlaceholder(text: TextMatcher, options: LocatorOptions = {}) {
    return this.locator(semanticSelector("placeholder", text, options))
  }

  getByRole(role: string, options: RoleOptions = {}) {
    return this.locator(roleSelector(role, options))
  }

  getByTestId(testId: string) {
    return this.locator(testIdSelector(testId))
  }

  getByText(text: TextMatcher, options: LocatorOptions = {}) {
    return this.locator(semanticSelector("text", text, options))
  }
}

export class FrameLocatorHandle {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
    private readonly frameSelectors: readonly string[],
  ) {}

  frameLocator(frameSelector: string) {
    if (!frameSelector) throw new Error("frameLocator.frameLocator requires a selector")
    return new FrameLocatorHandle(
      this.transport,
      this.browserId,
      this.tabId,
      [...this.frameSelectors, frameSelector],
    )
  }

  locator(selector: string) {
    if (!selector) throw new Error("frameLocator.locator requires a selector")
    return this.create(selector)
  }

  getByLabel(text: TextMatcher, options: LocatorOptions = {}) {
    return this.create(semanticSelector("label", text, options))
  }

  getByPlaceholder(text: TextMatcher, options: LocatorOptions = {}) {
    return this.create(semanticSelector("placeholder", text, options))
  }

  getByRole(role: string, options: RoleOptions = {}) {
    return this.create(roleSelector(role, options))
  }

  getByTestId(testId: string) {
    return this.create(testIdSelector(testId))
  }

  getByText(text: TextMatcher, options: LocatorOptions = {}) {
    return this.create(semanticSelector("text", text, options))
  }

  private create(selector: string) {
    return new LocatorHandle(
      this.transport,
      this.browserId,
      this.tabId,
      { frameSelectors: this.frameSelectors, selector },
    )
  }
}

export class LocatorHandle {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
    private readonly input: BrowserLocator,
  ) {}

  all() {
    return this.count().then((count) => Array.from({ length: count }, (_value, index) => this.nth(index)))
  }

  allTextContents(options: { timeoutMs?: number } = {}) {
    return this.value<string[]>("tab.playwright.locator.allTextContents", { timeout: options.timeoutMs })
  }

  and(locator: LocatorHandle) {
    this.requireCompatibleLocator(locator, "locator.and")
    return this.withSelector(`${this.selector()} >> internal:and=${JSON.stringify(locator.selector())}`)
  }

  check(options: { force?: boolean; timeoutMs?: number } = {}) {
    return this.action("tab.playwright.locator.check", {
      force: options.force,
      timeout: options.timeoutMs,
    })
  }

  click(options: LocatorActionOptions = {}) {
    return this.action("tab.playwright.locator.click", {
      button: options.button,
      force: options.force,
      modifiers: options.modifiers?.map(locatorModifier),
      timeout: options.timeoutMs,
    })
  }

  count() {
    return this.value<number>("tab.playwright.locator.count")
  }

  dblclick(options: LocatorActionOptions = {}) {
    return this.action("tab.playwright.locator.dblclick", {
      button: options.button,
      force: options.force,
      modifiers: options.modifiers?.map(locatorModifier),
      timeout: options.timeoutMs,
    })
  }

  downloadMedia(options: { timeoutMs?: number } = {}) {
    return this.run("tab.playwright.locator.downloadMedia", { timeout: options.timeoutMs })
      .then(() => undefined)
  }

  fill(value: string, options: { timeoutMs?: number } = {}) {
    if (value == null) throw new Error("locator.fill requires a value")
    return this.action("tab.playwright.locator.fill", { timeout: options.timeoutMs, value })
  }

  evaluate<TResult, TArg = unknown>(
    pageFunction: LocatorFunction<TArg, TResult>,
    arg?: TArg,
    options: { timeoutMs?: number } = {},
  ) {
    return this.value<TResult>("tab.playwright.locator.evaluate", {
      arg,
      expression: functionSource(pageFunction),
      timeout: options.timeoutMs,
    })
  }

  filter(options: {
    has?: LocatorHandle
    hasNot?: LocatorHandle
    hasNotText?: TextMatcher
    hasText?: TextMatcher
    visible?: boolean
  }) {
    if (options.has !== undefined) this.requireCompatibleLocator(options.has, "locator.filter has")
    if (options.hasNot !== undefined) this.requireCompatibleLocator(options.hasNot, "locator.filter hasNot")
    if (options.visible !== undefined && typeof options.visible !== "boolean") {
      throw new Error("locator.filter visible must be a boolean")
    }
    return this.withSelector([
      this.selector(),
      options.has !== undefined ? `internal:has=${JSON.stringify(options.has.selector())}` : undefined,
      options.hasNot !== undefined ? `internal:has-not=${JSON.stringify(options.hasNot.selector())}` : undefined,
      options.hasText !== undefined ? `internal:has-text=${textSelector(options.hasText, false)}` : undefined,
      options.hasNotText !== undefined ? `internal:has-not-text=${textSelector(options.hasNotText, false)}` : undefined,
      options.visible === undefined ? undefined : `visible=${String(options.visible)}`,
    ].filter((value): value is string => Boolean(value)).join(" >> "))
  }

  first() {
    return this.withSelector(`${this.selector()} >> nth=0`)
  }

  getAttribute(name: string, options: { timeoutMs?: number } = {}) {
    if (!name) throw new Error("locator.getAttribute requires a name")
    return this.value<null | string>("tab.playwright.locator.getAttribute", {
      attribute: name,
      timeout: options.timeoutMs,
    })
  }

  getByLabel(text: TextMatcher, options: LocatorOptions = {}) {
    return this.descendant(semanticSelector("label", text, options))
  }

  getByPlaceholder(text: TextMatcher, options: LocatorOptions = {}) {
    return this.descendant(semanticSelector("placeholder", text, options))
  }

  getByRole(role: string, options: RoleOptions = {}) {
    return this.descendant(roleSelector(role, options))
  }

  getByTestId(testId: string) {
    return this.descendant(testIdSelector(testId))
  }

  getByText(text: TextMatcher, options: LocatorOptions = {}) {
    return this.descendant(semanticSelector("text", text, options))
  }

  innerText(options: { timeoutMs?: number } = {}) {
    return this.value<string>("tab.playwright.locator.innerText", { timeout: options.timeoutMs })
  }

  isEnabled() {
    return this.value<boolean>("tab.playwright.locator.isEnabled")
  }

  isVisible() {
    return this.value<boolean>("tab.playwright.locator.isVisible")
  }

  last() {
    return this.withSelector(`${this.selector()} >> nth=-1`)
  }

  locator(selector: string, options: {
    has?: LocatorHandle
    hasNot?: LocatorHandle
    hasNotText?: TextMatcher
    hasText?: TextMatcher
  } = {}) {
    if (!selector) throw new Error("locator.locator requires a selector")
    return this.descendant(selector).filter(options)
  }

  nth(index: number) {
    if (!Number.isInteger(index)) throw new Error("Locator index must be an integer")
    return this.withSelector(`${this.selector()} >> nth=${index}`)
  }

  or(locator: LocatorHandle) {
    this.requireCompatibleLocator(locator, "locator.or")
    return this.withSelector(`${this.selector()} >> internal:or=${JSON.stringify(locator.selector())}`)
  }

  press(value: string, options: { timeoutMs?: number } = {}) {
    if (value == null) throw new Error("locator.press requires a value")
    return this.action("tab.playwright.locator.press", {
      key: value,
      timeout: options.timeoutMs,
    })
  }

  selectOption(
    value: string | BrowserSelectOption | Array<string | BrowserSelectOption>,
    options: { timeoutMs?: number } = {},
  ) {
    const values = Array.isArray(value) ? value : [value]
    if (!values.length) throw new Error("locator.selectOption requires at least one value")
    const selections = values.map((item) => {
      if (typeof item === "string") return { value: item }
      if (!item || typeof item !== "object") {
        throw new Error("locator.selectOption requires a string or { value?, label?, index? }")
      }
      if (item.value !== undefined && typeof item.value !== "string") {
        throw new Error("locator.selectOption value must be a string")
      }
      if (item.label !== undefined && typeof item.label !== "string") {
        throw new Error("locator.selectOption label must be a string")
      }
      if (item.index !== undefined && (!Number.isInteger(item.index) || item.index < 0)) {
        throw new Error("locator.selectOption index must be a non-negative integer")
      }
      if (item.value === undefined && item.label === undefined && item.index === undefined) {
        throw new Error("locator.selectOption requires value, label, or index for each selection")
      }
      return item
    })
    return this.action("tab.playwright.locator.selectOption", {
      options: selections,
      timeout: options.timeoutMs,
    })
  }

  setChecked(checked: boolean, options: { force?: boolean; timeoutMs?: number } = {}) {
    if (typeof checked !== "boolean") throw new Error("locator.setChecked requires a boolean")
    return this.action("tab.playwright.locator.setChecked", {
      checked,
      force: options.force,
      timeout: options.timeoutMs,
    })
  }

  textContent(options: { timeoutMs?: number } = {}) {
    return this.value<null | string>("tab.playwright.locator.textContent", { timeout: options.timeoutMs })
  }

  type(value: string, options: { timeoutMs?: number } = {}) {
    if (value == null) throw new Error("locator.type requires a value")
    return this.action("tab.playwright.locator.type", { timeout: options.timeoutMs, value })
  }

  uncheck(options: { force?: boolean; timeoutMs?: number } = {}) {
    return this.action("tab.playwright.locator.uncheck", {
      force: options.force,
      timeout: options.timeoutMs,
    })
  }

  waitFor(options: { state: LocatorWaitState; timeoutMs?: number }) {
    if (!options?.state) throw new Error("locator.waitFor requires a state")
    return this.action("tab.playwright.locator.waitFor", {
      state: options.state,
      timeout: options.timeoutMs,
    })
  }

  run(name: BrowserLocatorCommandName, input: Omit<BrowserElementInput, "locator"> = {}) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { locator: this.input, name, ...input },
      tabId: this.tabId,
    }).then((result) => result.data)
  }

  private action(name: BrowserLocatorCommandName, input: Omit<BrowserElementInput, "locator"> = {}) {
    return this.run(name, input).then(() => undefined)
  }

  private value<T>(name: BrowserLocatorCommandName, input: Omit<BrowserElementInput, "locator"> = {}) {
    return this.run(name, input).then((result) => requireBrowserResult(result.value as T | undefined, "locator result"))
  }

  private descendant(selector: string) {
    return this.withSelector(`${this.selector()} >> ${selector}`)
  }

  private withSelector(selector: string) {
    return new LocatorHandle(this.transport, this.browserId, this.tabId, {
      frameSelectors: this.input.frameSelectors,
      selector,
    })
  }

  private selector() {
    if (this.input.selector) return this.input.selector
    if (this.input.css) return this.input.css
    if (this.input.href) return `[href=${JSON.stringify(this.input.href)}]`
    if (this.input.label) return semanticSelector("label", this.input.label, this.input)
    if (this.input.placeholder) return semanticSelector("placeholder", this.input.placeholder, this.input)
    if (this.input.role) return roleSelector(this.input.role, this.input)
    if (this.input.testId) return `internal:testid=[data-testid=${textSelector(this.input.testId, true)}]`
    if (this.input.text) return semanticSelector("text", this.input.text, this.input)
    throw new Error("Playwright locator is empty")
  }

  private requireCompatibleLocator(locator: LocatorHandle, operation: string) {
    if (!(locator instanceof LocatorHandle)) {
      throw new Error(`${operation} requires a PlaywrightLocator`)
    }
    if (locator.browserId === this.browserId && locator.tabId === this.tabId) return
    throw new Error("Locators must belong to the same tab")
  }
}

export class PlaywrightDownload {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
    private readonly downloadId: string,
  ) {}

  path(options: { timeoutMs?: number } = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    const read = (): Promise<null | string> => this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { downloadId: this.downloadId, name: "tab.download.get" },
      tabId: this.tabId,
    }).then((result) => {
      const download = requireBrowserResult(result.data.download, "download")
      if (download.state === "completed") return download.path ?? null
      if (download.state === "cancelled" || download.state === "failed") return null
      if (Date.now() >= deadline) return null
      return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(read)
    })
    return read()
  }
}

export class PlaywrightFileChooser {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
    private readonly chooserId: string,
    private readonly multiple: boolean,
  ) {}

  isMultiple() {
    return this.multiple
  }

  setFiles(files: string | string[], options: { timeoutMs?: number } = {}) {
    const values = Array.isArray(files) ? files : [files]
    if (!values.length) throw new Error("fileChooser.setFiles requires at least one file")
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        chooserId: this.chooserId,
        filePaths: values,
        name: "tab.fileChooser.setFiles",
        timeout: options.timeoutMs,
      },
      tabId: this.tabId,
    }).then(() => undefined)
  }
}

export {
  FrameLocatorHandle as PlaywrightFrameLocator,
  LocatorHandle as PlaywrightLocator,
}

function semanticSelector(kind: "label" | "placeholder" | "text", text: TextMatcher, options: LocatorOptions) {
  if (typeof text !== "string" && !(text instanceof RegExp)) {
    throw new Error(`getBy${kind[0].toUpperCase()}${kind.slice(1)} requires a string or RegExp`)
  }
  if (kind === "placeholder") return `internal:attr=[placeholder=${textSelector(text, options.exact)}]`
  return `internal:${kind}=${textSelector(text, options.exact)}`
}

function functionSource(input: unknown) {
  if (typeof input === "string" || typeof input === "function") return input.toString()
  throw new Error("Playwright evaluate requires a function")
}

function roleSelector(role: string, options: RoleOptions) {
  if (typeof role !== "string" || !role) throw new Error("getByRole requires a role")
  return `internal:role=${role}${
    options.name !== undefined ? `[name=${textSelector(options.name, options.exact)}]` : ""
  }`
}

function textSelector(text: TextMatcher, exact = false) {
  if (text instanceof RegExp) return String(text).replace(/>>/g, "\\>\\>")
  if (typeof text !== "string") throw new Error("Text matcher must be a string or RegExp")
  return `${JSON.stringify(text)}${exact ? "s" : "i"}`
}

function testIdSelector(testId: string) {
  if (typeof testId !== "string" || !testId) throw new Error("getByTestId requires a testId")
  return `internal:testid=[data-testid=${textSelector(testId, true)}]`
}

function locatorModifier(value: LocatorModifier) {
  if (value === "Alt") return "alt" as const
  if (value === "Shift") return "shift" as const
  if (value === "Control") return "control" as const
  if (value === "Meta") return "meta" as const
  return process.platform === "darwin" ? "meta" as const : "control" as const
}

function requireCoordinates(name: string, input: { x: number; y: number }) {
  if (!Number.isFinite(input?.x) || !Number.isFinite(input?.y)) {
    throw new Error(`${name} requires numeric x and y coordinates`)
  }
}
