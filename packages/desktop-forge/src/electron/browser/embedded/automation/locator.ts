import type {
    BrowserCommandData,
    BrowserElementInput,
    BrowserLocatorCommandName,
} from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../../errors"
import type { EmbeddedTab } from "../tab"
import { coordinateClick, keypressValue, textInput } from "./input"
import { injectedRuntimeKey, locatorSelector, type PlaywrightRuntime } from "./playwright-runtime"

type LocatorResult = {
    count: number
    error?: "disabled" | "missing" | "multiple" | "not-actionable"
    needsInput?: boolean
    rect?: {
        height: number
        pageX: number
        pageY: number
        width: number
        x: number
        y: number
    }
    value?: unknown
}

export class LocatorService {
    constructor(private readonly playwright: PlaywrightRuntime) {}

    async run(
        tab: EmbeddedTab,
        command: BrowserElementInput & { name: BrowserLocatorCommandName },
        signal?: AbortSignal,
    ): Promise<BrowserCommandData> {
        const operation = command.name.split(".").at(-1) ?? ""
        const selector = locatorSelector(command.locator)
        const result = await this.resolve(tab, selector, operation, command, signal)
        if (result.rect && command.locator.frameSelectors?.length) {
            const offset = await this.playwright.frameOffset(tab, command.locator.frameSelectors)
            result.rect.x += offset.x
            result.rect.y += offset.y
            result.rect.pageX += offset.x
            result.rect.pageY += offset.y
        }
        if (operation === "count") return { value: result.count }
        if (operation === "allTextContents") return { value: result.value ?? [] }
        if (result.error === "multiple") {
            throw new BrowserRuntimeException("AMBIGUOUS_LOCATOR", `Locator matched ${result.count} elements`)
        }
        if (operation === "isVisible" || operation === "isEnabled") return { value: result.value ?? false }
        if (result.error === "missing") {
            throw new BrowserRuntimeException("LOCATOR_NOT_FOUND", "Locator did not match an element")
        }
        if (result.error === "disabled" || result.error === "not-actionable") {
            throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "Matched element is not actionable")
        }
        if (result.needsInput) textInput(tab.view.webContents, command.value ?? "")
        if (operation === "press") {
            keypressValue(tab.view.webContents, command.key ?? command.value ?? "Enter")
        }
        if (operation === "click" || operation === "dblclick") {
            if (!result.rect) throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "Element has no visible bounds")
            coordinateClick(tab.view.webContents, {
                button: command.button,
                clickCount: operation === "dblclick" ? 2 : 1,
                modifiers: command.modifiers ? [...command.modifiers] : undefined,
                x: result.rect.x + result.rect.width / 2,
                y: result.rect.y + result.rect.height / 2,
            })
        }
        if (operation === "check" || operation === "uncheck" || operation === "setChecked") {
            const checked = operation === "setChecked" ? command.checked === true : operation === "check"
            const rect = result.rect
            if (rect) {
                coordinateClick(tab.view.webContents, {
                    button: command.button,
                    modifiers: command.modifiers ? [...command.modifiers] : undefined,
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2,
                })
                await this.verifyChecked(
                    tab,
                    selector,
                    checked,
                    command.timeout,
                    command.locator.frameSelectors,
                    signal,
                )
            }
        }
        return { value: result.value }
    }

    private async resolve(
        tab: EmbeddedTab,
        selector: string,
        operation: string,
        command: BrowserElementInput,
        signal?: AbortSignal,
    ) {
        const timeout = command.timeout ?? 10_000
        const deadline = Date.now() + timeout
        for (;;) {
            ensureNotAborted(signal)
            const result = await this.playwright.evaluate(
                tab,
                locatorOperationScript(
                    selector,
                    operation,
                    operation === "setChecked"
                        ? String(command.checked)
                        : operation === "waitFor"
                            ? command.state
                            : command.value,
                    command.attribute,
                    command.options,
                    command.force,
                ),
                command.locator.frameSelectors,
            ) as LocatorResult
            if (
                operation === "allTextContents"
                || operation === "count"
                || operation === "isVisible"
                || operation === "isEnabled"
            ) return result
            if (result.error === "multiple") return result
            if (!result.error) return result
            if (Date.now() >= deadline) {
                throw new BrowserRuntimeException(
                    "TIMEOUT",
                    `Timed out waiting for locator: ${selector}`,
                    true,
                )
            }
            await waitForRetry(signal)
        }
    }

    private async verifyChecked(
        tab: EmbeddedTab,
        selector: string,
        checked: boolean,
        timeout = 10_000,
        frameSelectors: readonly string[] = [],
        signal?: AbortSignal,
    ) {
        const deadline = Date.now() + timeout
        for (;;) {
            ensureNotAborted(signal)
            const result = await this.playwright.evaluate(
                tab,
                locatorCheckedScript(selector),
                frameSelectors,
            ) as LocatorResult
            if (result.count === 1 && result.value === checked) return
            if (result.count > 1) {
                throw new BrowserRuntimeException("AMBIGUOUS_LOCATOR", `Locator matched ${result.count} elements`)
            }
            if (Date.now() >= deadline) {
                throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "Checkbox did not change state")
            }
            await waitForRetry(signal)
        }
    }

}

function ensureNotAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new BrowserRuntimeException("CANCELLED", "Locator action was cancelled", true)
    }
}

function waitForRetry(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            cleanup()
            resolve()
        }
        const cancel = () => {
            cleanup()
            reject(new BrowserRuntimeException("CANCELLED", "Locator action was cancelled", true))
        }
        const timer = setTimeout(finish, 50)
        const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", cancel)
        }
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted) cancel()
    })
}

function locatorOperationScript(
    selector: string,
    operation: string,
    value = "",
    attribute = "",
    options: BrowserElementInput["options"] = [],
    force = false,
) {
    const key = JSON.stringify(injectedRuntimeKey())
    return `(async () => {
        const injected = globalThis[${key}]
        const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document)
        const operation = ${JSON.stringify(operation)}
        if (operation === "count") return { count: elements.length, value: elements.length }
        if (operation === "allTextContents") {
            return { count: elements.length, value: elements.map((element) => element.textContent || "") }
        }
        if (operation === "waitFor") {
            const state = ${JSON.stringify(value)}
            if (state === "detached") {
                return elements.length ? { count: elements.length, error: "not-actionable" } : { count: 0, value: true }
            }
            if (state === "hidden" && !elements.length) return { count: 0, value: true }
            if (!elements.length) return { count: 0, error: "missing" }
            if (elements.length > 1) return { count: elements.length, error: "multiple" }
            if (state === "attached") return { count: 1, value: true }
            const visible = injected.elementState(elements[0], "visible").matches
            if ((state === "visible" && visible) || (state === "hidden" && !visible)) {
                return { count: 1, value: true }
            }
            return { count: 1, error: "not-actionable" }
        }
        if (!elements.length) {
            if (operation === "isVisible" || operation === "isEnabled") return { count: 0, value: false }
            return { count: 0, error: "missing" }
        }
        if (elements.length > 1) return { count: elements.length, error: "multiple" }
        const target = elements[0]
        const visible = injected.elementState(target, "visible")
        const enabled = injected.elementState(target, "enabled")
        if (operation === "isVisible") return { count: 1, value: visible.matches }
        if (operation === "isEnabled") return { count: 1, value: enabled.matches }
        if (operation === "innerText") return { count: 1, value: target.innerText || "" }
        if (operation === "textContent") return { count: 1, value: target.textContent }
        if (operation === "getAttribute") {
            return { count: 1, value: target.getAttribute(${JSON.stringify(attribute)}) }
        }
        const states = operation === "fill" || operation === "type"
            ? ["visible", "stable", "enabled", "editable"]
            : ["visible", "stable", "enabled"]
        const state = ${force} ? undefined : await injected.checkElementStates(target, states)
        if (state === "error:notconnected") return { count: 1, error: "missing" }
        if (state?.missingState === "enabled") return { count: 1, error: "disabled" }
        if (state?.missingState) return { count: 1, error: "not-actionable" }
        target.scrollIntoView({ block: "center", inline: "nearest" })
        const actionTarget = injected.retarget(target, "follow-label") || target
        const rect = actionTarget.getBoundingClientRect()
        const result = {
            count: 1,
            rect: {
                height: rect.height,
                pageX: rect.x + window.scrollX,
                pageY: rect.y + window.scrollY,
                width: rect.width,
                x: rect.x,
                y: rect.y,
            },
        }
        if (
            operation === "click"
            || operation === "dblclick"
            || operation === "check"
            || operation === "uncheck"
            || operation === "setChecked"
        ) {
            if (operation === "check" || operation === "uncheck" || operation === "setChecked") {
                const desired = operation === "setChecked"
                    ? ${JSON.stringify(value)} === "true"
                    : operation === "check"
                const checked = injected.elementState(target, "checked")
                if (checked.received === "error:notconnected") return { count: 1, error: "missing" }
                if (checked.matches === desired) return { ...result, rect: undefined, value: checked.matches }
            }
            const hit = target.ownerDocument.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
            )
            if (!${force} && (!hit || !(actionTarget === hit || actionTarget.contains(hit) || hit.contains(actionTarget)))) {
                return { count: 1, error: "not-actionable" }
            }
            return result
        }
        if (operation === "press" || operation === "type") {
            actionTarget.focus()
            return operation === "type" ? { ...result, needsInput: true } : result
        }
        if (operation === "fill") {
            const fill = injected.fill(target, ${JSON.stringify(value)})
            if (fill === "error:notconnected") return { count: 1, error: "missing" }
            if (fill === "done") return { ...result, value: ${JSON.stringify(value)} }
            return { ...result, needsInput: true, value: ${JSON.stringify(value)} }
        }
        if (operation === "selectOption") {
            const selected = injected.selectOptions(
                target,
                ${JSON.stringify(options)},
            )
            if (typeof selected === "string" && selected.startsWith("error:")) {
                return { count: 1, error: "not-actionable" }
            }
            return { ...result, value: selected }
        }
        return { count: 1, error: "not-actionable" }
    })()`
}

function locatorCheckedScript(selector: string) {
    const key = JSON.stringify(injectedRuntimeKey())
    return `(() => {
        const injected = globalThis[${key}]
        const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(selector)}), document)
        if (elements.length !== 1) return { count: elements.length }
        const checked = injected.elementState(elements[0], "checked")
        return { count: 1, value: checked.matches }
    })()`
}
