import { source as injectedSource } from "opencode-playwright-injected-source"
import * as locatorUtils from "opencode-playwright-locator-utils"
import type { BrowserElementInfo, BrowserLocator } from "@opencode-ai/browser-protocol"
import type { WebFrameMain } from "electron"
import { BrowserRuntimeException } from "../../errors"
import type { EmbeddedTab } from "../tab"

const runtimeKey = "__opencodePlaywrightInjected"
const injectedFactorySource = `
    const module = {}
    ${injectedSource}
    return new (module.exports.InjectedScript())(targetWindow, options)
`
const bootstrap = `(() => {
    Object.defineProperty(globalThis, ${JSON.stringify(runtimeKey)}, {
        configurable: true,
        value: new Function("targetWindow", "options", ${JSON.stringify(injectedFactorySource)})(window, {
            browserName: "chromium",
            customEngines: [],
            isUnderTest: false,
            isUtilityWorld: false,
            sdkLanguage: "javascript",
            stableRafCount: 1,
            testIdAttributeName: "data-testid",
        }),
    })
    return true
})()`

export class PlaywrightRuntime {
    private readonly frames = new Set<string>()

    async ensure(tab: EmbeddedTab) {
        await this.ensureFrame(tab, tab.view.webContents.mainFrame)
    }

    async ensureFrame(tab: EmbeddedTab, frame: WebFrameMain) {
        const key = `${tab.id}:${tab.generation}:${frame.frameToken}`
        if (this.frames.has(key)) return
        const generation = tab.generation
        await frame.executeJavaScript(bootstrap, true).catch((error: unknown) => {
            if (tab.view.webContents.isDestroyed() || frame.isDestroyed()) {
                throw new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed while loading Playwright")
            }
            if (tab.generation !== generation) {
                throw new BrowserRuntimeException("NAVIGATION_REPLACED", "Page changed while loading Playwright", true)
            }
            throw new BrowserRuntimeException(
                "CAPABILITY_UNAVAILABLE",
                `Unable to initialize Playwright: ${error instanceof Error ? error.message : String(error)}`,
                true,
            )
        })
        if (tab.generation !== generation) {
            throw new BrowserRuntimeException("NAVIGATION_REPLACED", "Page changed while loading Playwright", true)
        }
        this.frames.add(key)
    }

    async domSnapshot(tab: EmbeddedTab) {
        const generation = tab.generation
        const snapshot = await this.snapshotFrame(tab, tab.view.webContents.mainFrame)
        if (tab.generation !== generation) {
            throw new BrowserRuntimeException("NAVIGATION_REPLACED", "Page changed during DOM snapshot", true)
        }
        return snapshot
    }

    async html(tab: EmbeddedTab, frameSelectors: readonly string[] = []) {
        const result = await this.evaluate(tab, pageHtmlScript, frameSelectors)
        if (typeof result === "string") return result
        throw new BrowserRuntimeException("INVALID_COMMAND", "Unable to serialize the page for read-only evaluation")
    }

    async locatorHtml(tab: EmbeddedTab, locator: BrowserLocator) {
        const selector = locatorSelector(locator)
        const result = await this.evaluate(tab, `(() => {
            const injected = globalThis[${JSON.stringify(runtimeKey)}]
            const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document)
            if (elements.length !== 1) return { count: elements.length }
            return { count: 1, html: elements[0].outerHTML }
        })()`, locator.frameSelectors) as { count: number; html?: string }
        if (result.count > 1) {
            throw new BrowserRuntimeException("AMBIGUOUS_LOCATOR", `Locator matched ${result.count} elements`)
        }
        if (!result.count || !result.html) {
            throw new BrowserRuntimeException("LOCATOR_NOT_FOUND", "Locator did not match an element")
        }
        return result.html
    }

    async elementInfo(tab: EmbeddedTab, x: number, y: number, includeNonInteractable = false) {
        const result = await this.evaluate(tab, `(() => {
            const injected = globalThis[${JSON.stringify(runtimeKey)}]
            const roleFor = (element) => element.getAttribute("role") || ({
                A: "link",
                BUTTON: "button",
                INPUT: element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox",
                OPTION: "option",
                SELECT: "combobox",
                TEXTAREA: "textbox",
            })[element.tagName] || null
            const interactable = (element) => {
                const role = roleFor(element)
                return ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(element.tagName)
                    || Boolean(role && ["button", "checkbox", "combobox", "link", "menuitem", "option", "radio", "slider", "spinbutton", "switch", "tab", "textbox"].includes(role))
                    || element.isContentEditable
                    || element.tabIndex >= 0
            }
            return document.elementsFromPoint(${x}, ${y})
                .filter((element) => ${includeNonInteractable} || interactable(element))
                .slice(0, 12)
                .map((element) => {
                    const rect = element.getBoundingClientRect()
                    const testId = element.getAttribute("data-testid")
                    const ariaName = element.getAttribute("aria-label")
                        || element.getAttribute("alt")
                        || element.getAttribute("title")
                        || (element.innerText || "").trim().slice(0, 300)
                        || null
                    const primary = injected.generateSelectorSimple(element)
                    const candidates = [
                        testId ? 'internal:testid=[data-testid=' + JSON.stringify(testId) + 's]' : null,
                        element.id ? "#" + CSS.escape(element.id) : null,
                        element.getAttribute("href") ? '[href=' + JSON.stringify(element.getAttribute("href")) + ']' : null,
                        primary,
                    ].filter(Boolean)
                    const classes = Array.from(element.classList).slice(0, 3).map((name) => "." + CSS.escape(name)).join("")
                    return {
                        ariaName,
                        boundingBox: rect.width > 0 && rect.height > 0 ? {
                            height: rect.height,
                            width: rect.width,
                            x: rect.x,
                            y: rect.y,
                        } : null,
                        nodeId: null,
                        preview: "<" + element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") + classes + ">",
                        role: roleFor(element),
                        selector: { candidates, primary },
                        tagName: element.tagName.toLowerCase(),
                        testId,
                        visibleText: ("value" in element && typeof element.value === "string" ? element.value : element.innerText || "").trim().slice(0, 500) || null,
                    }
                })
        })()`)
        return Array.isArray(result) ? result as BrowserElementInfo[] : []
    }

    async evaluate(tab: EmbeddedTab, expression: string, frameSelectors: readonly string[] = []) {
        const frame = (await this.resolveFrame(tab, frameSelectors)).frame
        await this.ensureFrame(tab, frame)
        const generation = tab.generation
        return frame.executeJavaScript(expression, true).catch((error: unknown) => {
            if (tab.view.webContents.isDestroyed() || frame.isDestroyed()) {
                throw new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed during Playwright evaluation")
            }
            if (tab.generation !== generation) {
                throw new BrowserRuntimeException("NAVIGATION_REPLACED", "Page changed during Playwright evaluation", true)
            }
            throw new BrowserRuntimeException(
                "INVALID_COMMAND",
                `Playwright evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
    }

    async frameOffset(tab: EmbeddedTab, frameSelectors: readonly string[] = []) {
        const frame = await this.resolveFrame(tab, frameSelectors)
        return { x: frame.x, y: frame.y }
    }

    clear(tabId: string) {
        Array.from(this.frames)
            .filter((key) => key.startsWith(`${tabId}:`))
            .forEach((key) => this.frames.delete(key))
    }

    private async snapshotFrame(tab: EmbeddedTab, frame: WebFrameMain, depth = 0): Promise<string> {
        await this.ensureFrame(tab, frame)
        const result = await frame.executeJavaScript(`(() => {
            const root = document.body || document.documentElement
            if (!root) return ""
            return globalThis[${JSON.stringify(runtimeKey)}]
                .incrementalAriaSnapshot(root, { mode: "ai" }).full
        })()`, true)
        const own = typeof result === "string" ? result : ""
        if (!frame.frames.length || depth >= 8) return own
        const children = await Promise.all(frame.frames.map(async (child, index) => {
            const content = await withTimeout(
                this.snapshotFrame(tab, child, depth + 1),
                500,
            ).catch(() => "")
            if (!content) return ""
            const label = child.name ? ` name=${JSON.stringify(child.name)}` : ""
            const url = child.url ? ` url=${JSON.stringify(child.url)}` : ""
            return [
                `- iframe[${index}]${label}${url}:`,
                ...content.split("\n").map((line) => `  ${line}`),
            ].join("\n")
        }))
        return [own, ...children.filter(Boolean)].filter(Boolean).join("\n")
    }

    private async resolveFrame(tab: EmbeddedTab, selectors: readonly string[]) {
        let frame = tab.view.webContents.mainFrame
        let x = 0
        let y = 0
        for (const selector of selectors) {
            await this.ensureFrame(tab, frame)
            const index = await frame.executeJavaScript(`(() => {
                const injected = globalThis[${JSON.stringify(runtimeKey)}]
                const matches = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document)
                if (matches.length !== 1) return { count: matches.length }
                const target = matches[0]
                if (!(target instanceof HTMLIFrameElement) && !(target instanceof HTMLFrameElement)) {
                    return { count: 1, invalid: true }
                }
                return {
                    count: 1,
                    index: Array.from(document.querySelectorAll("iframe,frame")).indexOf(target),
                    x: target.getBoundingClientRect().x + target.clientLeft,
                    y: target.getBoundingClientRect().y + target.clientTop,
                }
            })()`, true) as { count: number; index?: number; invalid?: boolean; x?: number; y?: number }
            if (index.count > 1) {
                throw new BrowserRuntimeException("AMBIGUOUS_LOCATOR", `Frame locator matched ${index.count} elements`)
            }
            if (index.count === 0) {
                throw new BrowserRuntimeException("LOCATOR_NOT_FOUND", "Frame locator did not match an element")
            }
            if (index.invalid || index.index === undefined || !frame.frames[index.index]) {
                throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "Frame locator did not resolve to a live frame")
            }
            x += index.x ?? 0
            y += index.y ?? 0
            frame = frame.frames[index.index]
        }
        return { frame, x, y }
    }
}

export function locatorSelector(locator: BrowserLocator) {
    if (locator.selector) {
        const snapshotRef = locator.selector.match(/^\[ref=(e\d+)\]$/)
        return snapshotRef ? `aria-ref=${snapshotRef[1]}` : locator.selector
    }
    const strategies = [
        locator.css ? "css" : undefined,
        locator.href ? "href" : undefined,
        locator.label ? "label" : undefined,
        locator.placeholder ? "placeholder" : undefined,
        locator.role ? "role" : undefined,
        locator.testId ? "testId" : undefined,
        locator.text ? "text" : undefined,
    ].filter((value): value is string => Boolean(value))
    if (strategies.length !== 1) {
        throw new BrowserRuntimeException(
            "INVALID_COMMAND",
            "A Playwright locator requires exactly one strategy; role may be combined with name",
        )
    }
    if (locator.css) return locator.css
    if (locator.href) return `[href="${cssAttributeValue(locator.href)}"]`
    if (locator.label) return locatorUtils.getByLabelSelector(locator.label, { exact: locator.exact })
    if (locator.placeholder) {
        return locatorUtils.getByPlaceholderSelector(locator.placeholder, { exact: locator.exact })
    }
    if (locator.role) {
        return locatorUtils.getByRoleSelector(locator.role, {
            exact: locator.exact,
            name: locator.name,
        })
    }
    if (locator.testId) return locatorUtils.getByTestIdSelector("data-testid", locator.testId)
    if (locator.text) return locatorUtils.getByTextSelector(locator.text, { exact: locator.exact })
    throw new BrowserRuntimeException("INVALID_COMMAND", "Playwright locator is empty")
}

export function injectedRuntimeKey() {
    return runtimeKey
}

function cssAttributeValue(value: string) {
    return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")
}

function withTimeout<T>(promise: Promise<T>, timeout: number) {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
            setTimeout(() => reject(new Error("Frame snapshot timed out")), timeout)
        }),
    ])
}

const pageHtmlScript = `(() => {
    if (!document.documentElement) return ""
    const clone = document.documentElement.cloneNode(true)
    const sourceFields = document.querySelectorAll("input,textarea,select,option,details")
    const cloneFields = clone.querySelectorAll("input,textarea,select,option,details")
    sourceFields.forEach((source, index) => {
        const target = cloneFields[index]
        if (!target) return
        if ("value" in source && source.tagName !== "OPTION") target.setAttribute("value", source.value)
        if ("checked" in source) target.toggleAttribute("checked", source.checked)
        if ("selected" in source) target.toggleAttribute("selected", source.selected)
        if ("open" in source) target.toggleAttribute("open", source.open)
    })
    return "<!doctype html>" + clone.outerHTML
})()`
