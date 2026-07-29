import type {
    BrowserAutomationBox,
    BrowserAutomationTarget,
    BrowserCommand,
    BrowserCommandData,
} from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "../embedded/tab"
import { BrowserRuntimeException } from "../errors"
import {
    AgentBrowserTabController,
    type AgentBrowserTransaction,
} from "./controller"
import type { AgentBrowserJsonResult } from "./process-manager"

type AutomationCommand = Extract<
    BrowserCommand,
    { name: `tab.automation.${string}` }
>

const MAX_PAGE_CONTENT = 1_000_000

export class AgentBrowserCommandAdapter {
    constructor(private readonly controller: AgentBrowserTabController) {}

    run(
        tab: EmbeddedTab,
        ownerSessionId: string,
        command: AutomationCommand,
        signal?: AbortSignal,
        expectedOrigin?: string,
    ) {
        return this.controller.transaction(
            { ownerSessionId, signal, tab },
            (transaction) => {
                const guarded: AgentBrowserTransaction = {
                    run: (input) => {
                        if (expectedOrigin) ensureOrigin(tab, expectedOrigin)
                        return transaction.run(input)
                    },
                }
                return this.execute(guarded, tab, ownerSessionId, command)
            },
        )
    }

    private async execute(
        transaction: AgentBrowserTransaction,
        tab: EmbeddedTab,
        ownerSessionId: string,
        command: AutomationCommand,
    ): Promise<BrowserCommandData> {
        if (command.name === "tab.automation.snapshot") {
            const result = await transaction.run({
                args: ["snapshot", ...(command.interactiveOnly === false ? [] : ["-i"])],
                operation: "snapshot",
                timeout: 10_000,
            })
            const data = resultData(result.output, "snapshot")
            if (typeof data.snapshot !== "string") {
                throw invalidOutput("snapshot")
            }
            const content = boundedPageContent(result.output, data.snapshot)
            const visibleRefs = snapshotRefs(content.value)
            const refs = recordKeys(data.refs).filter((ref) => visibleRefs.has(ref))
            const snapshot = this.controller.recordSnapshot(tab.id, ownerSessionId, refs)
            return {
                automationSnapshot: {
                    content: content.value,
                    createdAt: new Date().toISOString(),
                    interactiveOnly: command.interactiveOnly !== false,
                    snapshotId: snapshot.snapshotId,
                    tabGeneration: snapshot.tabGeneration,
                    tabId: tab.id,
                    ...(content.truncated ? { truncated: true } : {}),
                },
            }
        }

        if (command.name === "tab.automation.waitFor") {
            const args = "target" in command
                ? ["wait", await this.selector(transaction, tab, ownerSessionId, command.target)]
                : "text" in command
                    ? ["wait", "--text", command.text]
                    : ["wait", "--url", command.url]
            if (command.timeout !== undefined) args.push("--timeout", String(command.timeout))
            await transaction.run({
                args,
                operation: "waitFor",
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (command.name === "tab.automation.drag") {
            const source = await this.uniqueSelector(
                transaction,
                tab,
                ownerSessionId,
                command.source,
                "drag",
            )
            const target = await this.uniqueSelector(
                transaction,
                tab,
                ownerSessionId,
                command.target,
                "drag",
            )
            await transaction.run({
                args: ["drag", source, target],
                operation: "drag",
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (command.name === "tab.automation.press") {
            if (command.target) {
                await transaction.run({
                    args: [
                        "focus",
                        await this.uniqueSelector(
                            transaction,
                            tab,
                            ownerSessionId,
                            command.target,
                            "press",
                        ),
                    ],
                    operation: "focus",
                    timeout: command.timeout,
                })
            }
            await transaction.run({
                args: ["press", command.key],
                operation: "press",
                timeout: command.timeout,
            })
            return { value: true }
        }

        const target = await this.uniqueSelector(
            transaction,
            tab,
            ownerSessionId,
            command.target,
            command.name.slice("tab.automation.".length),
            command.name === "tab.automation.count",
        )
        const timeout = command.timeout

        if (command.name === "tab.automation.count") {
            return {
                count: numberField(
                    await transaction.run({
                        args: ["get", "count", target],
                        operation: "count",
                        timeout,
                    }).then((result) => result.output),
                    "count",
                ),
            }
        }

        if (command.name === "tab.automation.getText") {
            const output = await transaction.run({
                args: ["get", "text", target],
                operation: "getText",
                timeout,
            }).then((result) => result.output)
            const text = resultData(output, "getText").text
            if (typeof text !== "string") throw invalidOutput("getText")
            const content = boundedPageContent(output, text)
            return {
                value: content.value,
                ...(content.truncated ? { truncated: true } : {}),
            }
        }
        if (command.name === "tab.automation.getHtml") {
            const output = await transaction.run({
                args: ["get", "html", target],
                operation: "getHtml",
                timeout,
            }).then((result) => result.output)
            const html = resultData(output, "getHtml").html
            if (typeof html !== "string") throw invalidOutput("getHtml")
            const content = boundedPageContent(output, html)
            return {
                html: content.value,
                ...(content.truncated ? { truncated: true } : {}),
            }
        }
        if (command.name === "tab.automation.getValue") {
            return { value: await field(transaction, ["get", "value", target], "getValue", "value", timeout) }
        }
        if (command.name === "tab.automation.getAttribute") {
            return {
                value: await field(
                    transaction,
                    ["get", "attr", target, command.attribute],
                    "getAttribute",
                    "value",
                    timeout,
                ),
            }
        }
        if (command.name === "tab.automation.getBox") {
            const result = await transaction.run({
                args: ["get", "box", target],
                operation: "getBox",
                timeout,
            })
            return {
                box: await viewportBox(tab, box(result.output), result.childSessionId),
            }
        }
        if (command.name === "tab.automation.getStyles") {
            const styles = resultData(
                await transaction.run({
                    args: ["get", "styles", target],
                    operation: "getStyles",
                    timeout,
                }).then((result) => result.output),
                "getStyles",
            ).styles
            if (!isStringRecord(styles)) throw invalidOutput("getStyles")
            return { styles }
        }
        if (
            command.name === "tab.automation.isVisible"
            || command.name === "tab.automation.isEnabled"
            || command.name === "tab.automation.isChecked"
        ) {
            const property = command.name === "tab.automation.isVisible"
                ? "visible"
                : command.name === "tab.automation.isEnabled"
                    ? "enabled"
                    : "checked"
            return {
                value: await field(
                    transaction,
                    ["is", property, target],
                    property,
                    property,
                    timeout,
                ),
            }
        }

        const args = actionArgs(command, target)
        await transaction.run({
            args,
            operation: command.name.slice("tab.automation.".length),
            timeout,
        })
        return { value: true }
    }

    private async uniqueSelector(
        transaction: AgentBrowserTransaction,
        tab: EmbeddedTab,
        ownerSessionId: string,
        target: BrowserAutomationTarget,
        operation: string,
        allowMany = false,
    ) {
        const selector = await this.selector(transaction, tab, ownerSessionId, target)
        if ("ref" in target || allowMany) return selector
        const count = numberField(
            await transaction.run({
                args: ["get", "count", selector],
                operation: "count",
                timeout: 10_000,
            }).then((result) => result.output),
            "count",
        )
        if (count === 0) {
            throw new BrowserRuntimeException(
                "LOCATOR_NOT_FOUND",
                "Browser automation target was not found",
                true,
                { operation, selectorKind: targetKind(target) },
            )
        }
        if (count > 1) {
            throw new BrowserRuntimeException(
                "AMBIGUOUS_LOCATOR",
                `Browser automation target matched ${count} elements`,
                false,
                { operation, selectorKind: targetKind(target) },
            )
        }
        return selector
    }

    private selector(
        _transaction: AgentBrowserTransaction,
        tab: EmbeddedTab,
        ownerSessionId: string,
        target: BrowserAutomationTarget,
    ) {
        if ("ref" in target) {
            const ref = target.ref.replace(/^@/, "")
            if (!/^e\d+$/.test(ref)) {
                throw new BrowserRuntimeException("INVALID_COMMAND", "Browser automation ref is invalid")
            }
            this.controller.validateSnapshot(tab.id, ownerSessionId, target.snapshotId, ref)
            return Promise.resolve(`@${ref}`)
        }
        if ("css" in target) return Promise.resolve(target.css)
        if ("testId" in target) {
            return Promise.resolve(`[data-testid=${JSON.stringify(target.testId)}]`)
        }
        if ("placeholder" in target) {
            return Promise.resolve(`xpath=//input[${textPredicate("@placeholder", target.placeholder, target.exact)}] | //textarea[${textPredicate("@placeholder", target.placeholder, target.exact)}]`)
        }
        if ("label" in target) {
            const label = textPredicate("normalize-space(.)", target.label, target.exact)
            const aria = textPredicate("@aria-label", target.label, target.exact)
            return Promise.resolve(`xpath=//*[@id = //label[${label}]/@for] | //label[${label}]//*[self::input or self::textarea or self::select or self::button] | //*[${aria}]`)
        }
        if ("text" in target) {
            return Promise.resolve(`xpath=//*[not(*) and ${textPredicate("normalize-space(.)", target.text, target.exact)}]`)
        }
        return Promise.resolve(roleSelector(target))
    }
}

function actionArgs(
    command: Exclude<
        AutomationCommand,
        { name: "tab.automation.snapshot" | "tab.automation.waitFor" | "tab.automation.drag" | "tab.automation.press" }
    >,
    target: string,
) {
    const action = command.name.slice("tab.automation.".length)
    if (command.name === "tab.automation.fill" || command.name === "tab.automation.type") {
        return [action, target, command.value]
    }
    if (command.name === "tab.automation.select") return ["select", target, ...command.values]
    return [action === "scrollIntoView" ? "scrollintoview" : action, target]
}

async function field(
    transaction: AgentBrowserTransaction,
    args: string[],
    operation: string,
    name: string,
    timeout?: number,
) {
    const value = resultData(
        await transaction.run({ args, operation, timeout }).then((result) => result.output),
        operation,
    )[name]
    if (value === undefined) throw invalidOutput(operation)
    return value
}

function box(output: AgentBrowserJsonResult): BrowserAutomationBox {
    const data = resultData(output, "getBox")
    const values = [data.x, data.y, data.width, data.height]
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw invalidOutput("getBox")
    }
    return {
        height: data.height as number,
        width: data.width as number,
        x: data.x as number,
        y: data.y as number,
    }
}

async function viewportBox(
    tab: EmbeddedTab,
    value: BrowserAutomationBox,
    childSessionId?: string,
) {
    if (!childSessionId) return value
    const frameId = nestedString(
        await tab.debuggerTransport.sendCommand("Page.getFrameTree", {}, childSessionId),
        ["frameTree", "frame", "id"],
    )
    if (!frameId) throw invalidOutput("getBox")
    const backendNodeId = nestedNumber(
        await tab.debuggerTransport.sendCommand("DOM.getFrameOwner", { frameId }),
        ["backendNodeId"],
    )
    if (backendNodeId === undefined) throw invalidOutput("getBox")
    const content = nestedNumberArray(
        await tab.debuggerTransport.sendCommand("DOM.getBoxModel", { backendNodeId }),
        ["model", "content"],
    )
    if (!content || content.length < 8) throw invalidOutput("getBox")
    return {
        ...value,
        x: value.x + Math.min(...content.filter((_coordinate, index) => index % 2 === 0)),
        y: value.y + Math.min(...content.filter((_coordinate, index) => index % 2 === 1)),
    }
}

function nestedValue(value: unknown, path: string[]) {
    return path.reduce<unknown>((current, key) =>
        typeof current === "object" && current !== null && !Array.isArray(current)
            ? (current as Record<string, unknown>)[key]
            : undefined, value)
}

function nestedString(value: unknown, path: string[]) {
    const result = nestedValue(value, path)
    return typeof result === "string" ? result : undefined
}

function nestedNumber(value: unknown, path: string[]) {
    const result = nestedValue(value, path)
    return typeof result === "number" && Number.isFinite(result) ? result : undefined
}

function nestedNumberArray(value: unknown, path: string[]) {
    const result = nestedValue(value, path)
    return Array.isArray(result)
        && result.every((item) => typeof item === "number" && Number.isFinite(item))
        ? result as number[]
        : undefined
}

function numberField(output: AgentBrowserJsonResult, name: string) {
    const value = resultData(output, name)[name]
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalidOutput(name)
    return value
}

function resultData(output: AgentBrowserJsonResult, operation: string) {
    if (typeof output.data === "object" && output.data !== null && !Array.isArray(output.data)) {
        return output.data as Record<string, unknown>
    }
    throw invalidOutput(operation)
}

function invalidOutput(operation: string) {
    return new BrowserRuntimeException(
        "AGENT_SESSION_FAILED",
        "Browser automation returned an invalid response",
        true,
        { causeCategory: "invalid_output", operation },
    )
}

function recordKeys(value: unknown) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.keys(value)
        : []
}

function snapshotRefs(content: string) {
    return new Set(
        [...content.matchAll(/\bref=(e\d+)(?=[,\]\s])/g)]
            .map((match) => match[1]),
    )
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.values(value).every((item) => typeof item === "string")
}

function targetKind(target: BrowserAutomationTarget) {
    return ["ref", "role", "label", "placeholder", "text", "testId", "css"]
        .find((key) => key in target)
}

function textPredicate(expression: string, value: string, exact = false) {
    return exact
        ? `${expression} = ${xpathLiteral(value)}`
        : `contains(translate(${expression}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), ${xpathLiteral(value.toLowerCase())})`
}

function xpathLiteral(value: string) {
    if (!value.includes("'")) return `'${value}'`
    if (!value.includes("\"")) return `"${value}"`
    return `concat(${value.split("'").flatMap((part, index) =>
        index ? [`"'"`, `'${part}'`] : [`'${part}'`]).join(", ")})`
}

function roleSelector(target: Extract<BrowserAutomationTarget, { role: string }>) {
    const explicit = `//*[translate(@role, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') = ${xpathLiteral(target.role.toLowerCase())}]`
    const implicit: Record<string, string> = {
        button: "//button | //input[@type='button' or @type='submit' or @type='reset']",
        checkbox: "//input[@type='checkbox']",
        combobox: "//select | //input[@list]",
        heading: "//h1 | //h2 | //h3 | //h4 | //h5 | //h6",
        link: "//a[@href]",
        radio: "//input[@type='radio']",
        textbox: "//textarea | //input[not(@type) or @type='text' or @type='search' or @type='email' or @type='tel' or @type='url' or @type='password']",
    }
    const selector = `(${[explicit, implicit[target.role]].filter(Boolean).join(" | ")})`
    if (!target.name) return `xpath=${selector}`
    const name = [
        textPredicate("@aria-label", target.name, target.exact),
        textPredicate("normalize-space(.)", target.name, target.exact),
        textPredicate("@value", target.name, target.exact),
        `@id = //label[${textPredicate("normalize-space(.)", target.name, target.exact)}]/@for`,
        `ancestor::label[${textPredicate("normalize-space(.)", target.name, target.exact)}]`,
    ].join(" or ")
    return `xpath=${selector}[${name}]`
}

function boundedPageContent(output: AgentBrowserJsonResult, value: string) {
    const characters = [...value]
    const truncated = characters.length > MAX_PAGE_CONTENT
    const content = truncated
        ? `${characters.slice(0, MAX_PAGE_CONTENT).join("")}\n[truncated]`
        : value
    const nonce = output._boundary?.nonce
    if (!nonce) return { truncated, value: content }
    return {
        truncated,
        value: [
            `--- AGENT_BROWSER_PAGE_CONTENT nonce=${nonce} origin=${output._boundary?.origin ?? "unknown"} ---`,
            content,
            `--- END_AGENT_BROWSER_PAGE_CONTENT nonce=${nonce} ---`,
        ].join("\n"),
    }
}

function ensureOrigin(tab: EmbeddedTab, expectedOrigin: string) {
    let actualOrigin: string | undefined
    try {
        const url = new URL(tab.webContents.getURL())
        actualOrigin = url.protocol === "http:" || url.protocol === "https:"
            ? url.origin
            : undefined
    } catch {
        actualOrigin = undefined
    }
    if (actualOrigin === expectedOrigin) return
    throw new BrowserRuntimeException(
        "ORIGIN_CHANGED",
        "The page origin changed after browser automation was approved",
        true,
        { actualOrigin, expectedOrigin },
    )
}
