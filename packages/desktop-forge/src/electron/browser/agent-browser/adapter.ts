import type {
    BrowserAutomationBox,
    BrowserAutomationSelector,
    BrowserAutomationTarget,
    BrowserCommand,
    BrowserCommandData,
    BrowserReadableContent,
    BrowserScreenshotAnnotation,
} from "@opencode-ai/browser-protocol"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EmbeddedTab } from "../embedded/tab"
import { browserOrigin } from "../embedded/navigation"
import { BrowserRuntimeException } from "../errors"
import {
    AgentBrowserTabController,
    type AgentBrowserTransaction,
} from "./controller"
import type { AgentBrowserJsonResult } from "./process-manager"

type NativeCommand =
    | Extract<BrowserCommand, { name: `tab.automation.${string}` }>
    | Extract<BrowserCommand, { name: "tab.screenshot" }>
type ElementActionCommand = Extract<
    BrowserCommand,
    {
        name:
            | "tab.automation.check"
            | "tab.automation.click"
            | "tab.automation.dblclick"
            | "tab.automation.fill"
            | "tab.automation.focus"
            | "tab.automation.hover"
            | "tab.automation.scrollIntoView"
            | "tab.automation.select"
            | "tab.automation.type"
            | "tab.automation.uncheck"
    }
>

const MAX_PAGE_CONTENT = 1_000_000
const ELEMENT_WAIT_POLL_INTERVAL = 100
const ELEMENT_WAIT_PROBE_TIMEOUT = 2_000
const NATIVE_COMMAND_TIMEOUT_MARGIN = 10_000
const NATIVE_COMMAND_MINIMUM_TIMEOUT = 30_000

export class AgentBrowserCommandAdapter {
    constructor(private readonly controller: AgentBrowserTabController) {}

    run(
        tab: EmbeddedTab,
        ownerSessionId: string,
        command: NativeCommand,
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
        command: NativeCommand,
    ): Promise<BrowserCommandData> {
        if (command.name === "tab.screenshot") {
            return withTemporaryFile(command.imageFormat === "jpeg" ? ".jpg" : ".png", async (filepath) => {
                const target = command.target
                    ? this.selector(tab, ownerSessionId, command.target)
                    : undefined
                const result = await transaction.run({
                    args: [
                        "screenshot",
                        ...(target ? [target] : []),
                        filepath,
                        ...(command.fullPage ? ["--full"] : []),
                        ...(command.annotate ? ["--annotate"] : []),
                        ...(command.imageFormat ? ["--screenshot-format", command.imageFormat] : []),
                        ...(command.quality === undefined ? [] : ["--screenshot-quality", String(command.quality)]),
                    ],
                    operation: "screenshot",
                })
                requireOutputPath(result.output, "screenshot", filepath)
                const data = await readFile(filepath)
                const dimensions = imageDimensions(data)
                const annotations = screenshotAnnotations(resultData(result.output, "screenshot").annotations)
                const snapshot = command.annotate
                    ? this.controller.recordSnapshot(
                        tab.id,
                        ownerSessionId,
                        annotations.map((annotation) => annotation.ref),
                    )
                    : undefined
                return {
                    screenshot: {
                        ...dimensions,
                        ...(annotations.length ? { annotations } : {}),
                        data: data.toString("base64"),
                        mimeType: command.imageFormat === "jpeg" ? "image/jpeg" : "image/png",
                        ...(snapshot
                            ? {
                                snapshotId: snapshot.snapshotId,
                                tabGeneration: snapshot.tabGeneration,
                            }
                            : {}),
                    },
                }
            })
        }

        if (command.name === "tab.automation.snapshot") {
            const interactive = command.interactive ?? command.interactiveOnly ?? false
            const result = await transaction.run({
                args: [
                    "snapshot",
                    ...(interactive ? ["--interactive"] : []),
                    ...(command.urls ? ["--urls"] : []),
                    ...(command.compact ? ["--compact"] : []),
                    ...(command.depth === undefined ? [] : ["--depth", String(command.depth)]),
                    ...(command.selector ? ["--selector", command.selector] : []),
                ],
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
                    interactiveOnly: interactive,
                    snapshotId: snapshot.snapshotId,
                    tabGeneration: snapshot.tabGeneration,
                    tabId: tab.id,
                    ...(content.truncated ? { truncated: true } : {}),
                },
            }
        }

        if (command.name === "tab.automation.waitFor") {
            if ("target" in command) {
                await waitForElement(
                    transaction,
                    this.selector(tab, ownerSessionId, command.target),
                    "ref" in command.target,
                    command.state ?? "visible",
                    command.timeout,
                )
                return { value: true }
            }
            const args = "text" in command
                ? ["wait", "--text", command.text]
                : "url" in command
                    ? ["wait", "--url", command.url]
                    : "loadState" in command
                        ? ["wait", "--load", command.loadState]
                        : "expression" in command
                            ? ["wait", "--fn", command.expression]
                            : ["wait", String(command.milliseconds)]
            if (command.timeout !== undefined && !("milliseconds" in command)) {
                args.push("--timeout", String(command.timeout))
            }
            await transaction.run({
                args,
                operation: "waitFor",
                timeout: "milliseconds" in command
                    ? command.timeout ?? command.milliseconds + 1_000
                    : nativeCommandTimeout(command.timeout),
            })
            return { value: true }
        }

        if (command.name === "tab.automation.read") {
            const output = await transaction.run({
                args: [
                    "read",
                    ...(command.url ? [command.url] : []),
                    ...(command.raw ? ["--raw"] : []),
                    ...(command.requireMd ? ["--require-md"] : []),
                    ...(command.llms ? ["--llms", command.llms] : []),
                    ...(command.outline ? ["--outline"] : []),
                    ...(command.filter ? ["--filter", command.filter] : []),
                    ...(command.timeout === undefined ? [] : ["--timeout", String(command.timeout)]),
                ],
                operation: "read",
                timeout: command.timeout,
            }).then((result) => result.output)
            const data = readableContent(resultData(output, "read"))
            const content = boundedPageContent(output, data.content)
            return {
                readable: {
                    ...data,
                    content: content.value,
                    truncated: data.truncated || content.truncated,
                },
            }
        }

        if (
            command.name === "tab.automation.keyboard.type"
            || command.name === "tab.automation.keyboard.insertText"
        ) {
            await transaction.run({
                args: [
                    "keyboard",
                    command.name === "tab.automation.keyboard.type" ? "type" : "inserttext",
                    command.text,
                ],
                operation: command.name.slice("tab.automation.".length),
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (command.name === "tab.automation.keydown" || command.name === "tab.automation.keyup") {
            await transaction.run({
                args: [command.name.slice("tab.automation.".length), command.key],
                operation: command.name.slice("tab.automation.".length),
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (command.name === "tab.automation.scroll") {
            await transaction.run({
                args: [
                    "scroll",
                    command.direction ?? "down",
                    String(command.amount ?? 300),
                    ...(command.target
                        ? ["--selector", this.selector(tab, ownerSessionId, command.target)]
                        : []),
                ],
                operation: "scroll",
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (command.name === "tab.automation.drag") {
            await transaction.run({
                args: [
                    "drag",
                    this.selector(tab, ownerSessionId, command.source),
                    this.selector(tab, ownerSessionId, command.target),
                ],
                operation: "drag",
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (command.name === "tab.automation.press") {
            await transaction.run({
                args: ["press", command.key],
                operation: "press",
                timeout: command.timeout,
            })
            return { value: true }
        }

        if (!("target" in command)) throw invalidOutput(command.name)
        const locatorAction = command.name === "tab.automation.click"
            ? "click"
            : command.name === "tab.automation.fill"
                ? "fill"
                : command.name === "tab.automation.hover"
                    ? "hover"
                    : command.name === "tab.automation.check"
                        ? "check"
                        : command.name === "tab.automation.getText"
                            ? "text"
                            : undefined
        const find = locatorAction && isAutomationLocator(command.target)
            ? findArgs(
                command.target,
                locatorAction,
                command.name === "tab.automation.fill" ? command.value : undefined,
            )
            : undefined
        const target = find
            ? undefined
            : this.selector(tab, ownerSessionId, command.target as BrowserAutomationSelector)
        const selector = () => {
            if (target === undefined) throw invalidOutput(command.name)
            return target
        }
        const timeout = command.timeout

        if (command.name === "tab.automation.count") {
            if ("ref" in command.target) {
                return {
                    count: await elementAttached(
                        transaction,
                        selector(),
                        true,
                        "count",
                        timeout,
                    ) ? 1 : 0,
                }
            }
            return {
                count: numberField(
                    await transaction.run({
                        args: ["get", "count", selector()],
                        operation: "count",
                        timeout,
                    }).then((result) => result.output),
                    "count",
                ),
            }
        }

        if (command.name === "tab.automation.getText") {
            const output = await transaction.run({
                args: find ?? ["get", "text", selector()],
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
                args: ["get", "html", selector()],
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
            return { value: await field(transaction, ["get", "value", selector()], "getValue", "value", timeout) }
        }
        if (command.name === "tab.automation.getAttribute") {
            return {
                value: await field(
                    transaction,
                    ["get", "attr", selector(), command.attribute],
                    "getAttribute",
                    "value",
                    timeout,
                ),
            }
        }
        if (command.name === "tab.automation.getBox") {
            const result = await transaction.run({
                args: ["get", "box", selector()],
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
                    args: ["get", "styles", selector()],
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
                    ["is", property, selector()],
                    property,
                    property,
                    timeout,
                ),
            }
        }

        const args = find ?? actionArgs(command as ElementActionCommand, selector())
        await transaction.run({
            args,
            operation: command.name.slice("tab.automation.".length),
            timeout,
        })
        return { value: true }
    }

    private selector(
        tab: EmbeddedTab,
        ownerSessionId: string,
        target: BrowserAutomationSelector,
    ) {
        if ("ref" in target) {
            const ref = target.ref.replace(/^@/, "")
            if (!/^e\d+$/.test(ref)) {
                throw new BrowserRuntimeException("INVALID_COMMAND", "Browser automation ref is invalid")
            }
            this.controller.validateSnapshot(tab.id, ownerSessionId, target.snapshotId, ref)
            return `@${ref}`
        }
        return target.css
    }
}

async function waitForElement(
    transaction: AgentBrowserTransaction,
    target: string,
    ref: boolean,
    state: "attached" | "detached" | "hidden" | "visible",
    timeout = 10_000,
) {
    const deadline = Date.now() + timeout
    do {
        const probeTimeout = Math.max(
            ELEMENT_WAIT_POLL_INTERVAL,
            Math.min(ELEMENT_WAIT_PROBE_TIMEOUT, deadline - Date.now()),
        )
        if (state === "hidden" || state === "visible") {
            if (
                await elementVisible(transaction, target, probeTimeout)
                === (state === "visible")
            ) {
                return
            }
        } else {
            const attached = await elementAttached(
                transaction,
                target,
                ref,
                "waitFor",
                probeTimeout,
            )
            if (attached === (state === "attached")) return
        }
        if (Date.now() >= deadline) {
            break
        }
        await delay(Math.min(ELEMENT_WAIT_POLL_INTERVAL, deadline - Date.now()))
    } while (Date.now() <= deadline)
    throw new BrowserRuntimeException(
        "TIMEOUT",
        "Browser automation condition timed out",
        true,
        { causeCategory: "element_wait", operation: "waitFor" },
    )
}

async function elementAttached(
    transaction: AgentBrowserTransaction,
    target: string,
    ref: boolean,
    operation: "count" | "waitFor",
    timeout?: number,
) {
    try {
        if (ref) {
            // agent-browser can still resolve a detached ref object, but Chromium
            // returns an empty computed-style declaration once it leaves the document.
            const styles = resultData(
                await transaction.run({
                    args: ["get", "styles", target],
                    operation,
                    timeout,
                }).then((result) => result.output),
                operation,
            ).styles
            if (!isStringRecord(styles)) throw invalidOutput(operation)
            return Object.keys(styles).length > 0
        }
        return numberField(
            await transaction.run({
                args: ["get", "count", target],
                operation,
                timeout,
            }).then((result) => result.output),
            "count",
        ) > 0
    } catch (error) {
        if (locatorMissing(error)) return false
        throw error
    }
}

async function elementVisible(
    transaction: AgentBrowserTransaction,
    target: string,
    timeout?: number,
) {
    try {
        const visible = await field(
            transaction,
            ["is", "visible", target],
            "waitFor",
            "visible",
            timeout,
        )
        if (typeof visible !== "boolean") throw invalidOutput("waitFor")
        return visible
    } catch (error) {
        if (locatorMissing(error)) return false
        throw error
    }
}

function locatorMissing(error: unknown) {
    return error instanceof BrowserRuntimeException
        && error.browser.code === "LOCATOR_NOT_FOUND"
}

function nativeCommandTimeout(timeout = 10_000) {
    return Math.max(
        NATIVE_COMMAND_MINIMUM_TIMEOUT,
        timeout + NATIVE_COMMAND_TIMEOUT_MARGIN,
    )
}

function delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
}

function actionArgs(
    command: ElementActionCommand,
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

function isAutomationLocator(
    target: BrowserAutomationTarget,
): target is Exclude<BrowserAutomationTarget, BrowserAutomationSelector> {
    return !("ref" in target) && !("css" in target)
}

function findArgs(
    target: Exclude<BrowserAutomationTarget, BrowserAutomationSelector>,
    action: "check" | "click" | "fill" | "hover" | "text",
    value?: string,
) {
    if ("nth" in target) {
        return ["find", "nth", String(target.nth), target.selector, action, ...(value === undefined ? [] : [value])]
    }
    const kind = locatorKind(target)
    const locator = locatorValue(target)
    return [
        "find",
        kind,
        locator,
        action,
        ...(value === undefined ? [] : [value]),
        ...("name" in target && target.name ? ["--name", target.name] : []),
        ...("exact" in target && target.exact ? ["--exact"] : []),
    ]
}

function locatorKind(target: Exclude<BrowserAutomationTarget, BrowserAutomationSelector>) {
    if ("testId" in target) return "testid"
    if ("first" in target) return "first"
    if ("last" in target) return "last"
    if ("role" in target) return "role"
    if ("text" in target) return "text"
    if ("label" in target) return "label"
    if ("placeholder" in target) return "placeholder"
    if ("alt" in target) return "alt"
    return "title"
}

function locatorValue(target: Exclude<BrowserAutomationTarget, BrowserAutomationSelector>) {
    if ("nth" in target) return target.selector
    if ("testId" in target) return target.testId
    if ("first" in target) return target.first
    if ("last" in target) return target.last
    if ("role" in target) return target.role
    if ("text" in target) return target.text
    if ("label" in target) return target.label
    if ("placeholder" in target) return target.placeholder
    if ("alt" in target) return target.alt
    return target.title
}

function readableContent(data: Record<string, unknown>): BrowserReadableContent {
    if (
        typeof data.content !== "string"
        || typeof data.contentType !== "string"
        || typeof data.finalUrl !== "string"
        || typeof data.source !== "string"
        || typeof data.truncated !== "boolean"
        || typeof data.url !== "string"
        || (
            data.status !== undefined
            && (typeof data.status !== "number" || !Number.isInteger(data.status))
        )
    ) {
        throw invalidOutput("read")
    }
    return {
        content: data.content,
        contentType: data.contentType,
        finalUrl: data.finalUrl,
        source: data.source,
        ...(typeof data.status === "number" ? { status: data.status } : {}),
        truncated: data.truncated,
        url: data.url,
    }
}

function screenshotAnnotations(input: unknown): BrowserScreenshotAnnotation[] {
    if (input === undefined) return []
    if (!Array.isArray(input)) throw invalidOutput("screenshot")
    return input.map((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw invalidOutput("screenshot")
        }
        const annotation = value as Record<string, unknown>
        const annotationBox = annotation.box
        if (
            typeof annotation.ref !== "string"
            || !/^e\d+$/.test(annotation.ref)
            || typeof annotation.number !== "number"
            || !Number.isInteger(annotation.number)
            || typeof annotation.role !== "string"
            || (annotation.name !== undefined && typeof annotation.name !== "string")
            || typeof annotationBox !== "object"
            || annotationBox === null
            || Array.isArray(annotationBox)
        ) {
            throw invalidOutput("screenshot")
        }
        const box = annotationBox as Record<string, unknown>
        if (
            ![box.x, box.y, box.width, box.height]
                .every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
        ) {
            throw invalidOutput("screenshot")
        }
        return {
            box: {
                height: box.height as number,
                width: box.width as number,
                x: box.x as number,
                y: box.y as number,
            },
            ...(typeof annotation.name === "string" ? { name: annotation.name } : {}),
            number: annotation.number,
            ref: annotation.ref,
            role: annotation.role,
        }
    })
}

function requireOutputPath(output: AgentBrowserJsonResult, operation: string, filepath: string) {
    const value = resultData(output, operation).path
    if (typeof value !== "string" || path.resolve(value) !== path.resolve(filepath)) {
        throw invalidOutput(operation)
    }
}

async function withTemporaryFile<T>(extension: string, task: (filepath: string) => Promise<T>) {
    const directory = await mkdtemp(path.join(tmpdir(), "desktop-forge-agent-browser-"))
    try {
        return await task(path.join(directory, `output${extension}`))
    } finally {
        await rm(directory, { force: true, recursive: true })
    }
}

function imageDimensions(data: Buffer) {
    if (
        data.length >= 24
        && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
        return {
            height: data.readUInt32BE(20),
            width: data.readUInt32BE(16),
        }
    }
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw invalidOutput("screenshot")
    for (let offset = 2; offset + 8 < data.length;) {
        if (data[offset] !== 0xff) throw invalidOutput("screenshot")
        const marker = data[offset + 1]
        if (marker === 0xd8 || marker === 0xd9) {
            offset += 2
            continue
        }
        const length = data.readUInt16BE(offset + 2)
        if (length < 2 || offset + length + 2 > data.length) throw invalidOutput("screenshot")
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            return {
                height: data.readUInt16BE(offset + 5),
                width: data.readUInt16BE(offset + 7),
            }
        }
        offset += length + 2
    }
    throw invalidOutput("screenshot")
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
    const actualOrigin = browserOrigin(tab.webContents.getURL())
    if (actualOrigin === expectedOrigin) return
    throw new BrowserRuntimeException(
        "ORIGIN_CHANGED",
        "The page origin changed after browser automation was approved",
        true,
        { actualOrigin, expectedOrigin },
    )
}
