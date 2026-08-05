// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import type { BrowserCommand } from "@opencode-ai/browser-protocol"
import { AgentBrowserCommandAdapter } from "../src/electron/browser/agent-browser/adapter"
import type {
    AgentBrowserTabController,
    AgentBrowserTransaction,
} from "../src/electron/browser/agent-browser/controller"
import type { AgentBrowserJsonResult } from "../src/electron/browser/agent-browser/process-manager"
import type { EmbeddedTab } from "../src/electron/browser/embedded/tab"
import { BrowserRuntimeException } from "../src/electron/browser/errors"

class FakeController {
    childSessionId?: string
    readonly calls: Array<{ args: string[]; operation: string; timeout?: number }> = []
    readonly recordedRefs: string[][] = []
    readonly validated: Array<{ ref?: string; snapshotId: string }> = []
    output: (input: { args: string[]; operation: string }) => AgentBrowserJsonResult | Promise<AgentBrowserJsonResult> =
        () => ({ data: {}, success: true })

    transaction<T>(
        _input: unknown,
        task: (transaction: AgentBrowserTransaction) => Promise<T>,
    ) {
        return task({
            run: (input) => {
                this.calls.push(input)
                return Promise.resolve(this.output(input)).then((output) => ({
                    ...(this.childSessionId ? { childSessionId: this.childSessionId } : {}),
                    output,
                    sessionGeneration: 1,
                }))
            },
        })
    }

    recordSnapshot(_tabId: string, _ownerSessionId: string, refs: string[] = []) {
        this.recordedRefs.push(refs)
        return { snapshotId: "snapshot-1", tabGeneration: 7 }
    }

    validateSnapshot(_tabId: string, _ownerSessionId: string, snapshotId: string, ref?: string) {
        this.validated.push({ ref, snapshotId })
    }
}

describe("agent-browser command adapter", () => {
    test("normalizes a snapshot and registers its refs", async () => {
        const controller = new FakeController()
        controller.output = () => ({
            data: {
                refs: {
                    e1: { name: "Search", role: "textbox" },
                    e2: { name: "Submit", role: "button" },
                },
                snapshot: "- textbox \"Search\" [ref=e1]\n- button \"Submit\" [ref=e2]",
            },
            success: true,
        })

        const result = await adapter(controller).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.snapshot" }),
        )

        expect(result.automationSnapshot).toMatchObject({
            interactiveOnly: false,
            snapshotId: "snapshot-1",
            tabGeneration: 7,
            tabId: "tab-1",
        })
        expect(controller.calls).toEqual([{
            args: ["snapshot"],
            operation: "snapshot",
            timeout: 10_000,
        }])
        expect(controller.recordedRefs).toEqual([["e1", "e2"]])
    })

    test("registers refs when snapshot attributes surround the ref", async () => {
        const controller = new FakeController()
        controller.output = () => ({
            data: {
                refs: {
                    e2: { name: "Username", role: "textbox" },
                    e3: { name: "Password", role: "textbox" },
                    e4: { name: "Not rendered", role: "textbox" },
                },
                snapshot: [
                    "- textbox \"Username\" [required, ref=e2]",
                    "- textbox \"Password\" [ref=e3, required]",
                ].join("\n"),
            },
            success: true,
        })

        await adapter(controller).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.snapshot" }),
        )

        expect(controller.recordedRefs).toEqual([["e2", "e3"]])
    })

    test("validates snapshot refs before actions", async () => {
        const controller = new FakeController()
        controller.output = () => ({ data: { clicked: "@e12" }, success: true })

        await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.click",
                target: { ref: "e12", snapshotId: "snapshot-1" },
            }),
        )

        expect(controller.validated).toEqual([{ ref: "e12", snapshotId: "snapshot-1" }])
        expect(controller.calls).toEqual([{
            args: ["click", "@e12"],
            operation: "click",
            timeout: undefined,
        }])
    })

    test("implements element state waits with ref-aware native probes", async () => {
        const controller = new FakeController()
        controller.output = (input) => {
            if (input.args[0] === "get" && input.args[1] === "count") {
                return { data: { count: 1 }, success: true }
            }
            if (input.args[0] === "get" && input.args[1] === "styles") {
                return { data: { styles: { display: "block" } }, success: true }
            }
            return { data: { visible: false }, success: true }
        }

        await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.waitFor",
                state: "hidden",
                target: { advanced: true, css: "#spinner" },
                timeout: 5_000,
            }),
        )
        await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.waitFor",
                state: "attached",
                target: { ref: "e12", snapshotId: "snapshot-1" },
                timeout: 5_000,
            }),
        )

        expect(controller.calls.map((call) => ({
            args: call.args,
            operation: call.operation,
        }))).toEqual([
            {
                args: ["is", "visible", "#spinner"],
                operation: "waitFor",
            },
            {
                args: ["get", "styles", "@e12"],
                operation: "waitFor",
            },
        ])
        expect(controller.calls.every((call) =>
            typeof call.timeout === "number"
            && call.timeout > 0
            && call.timeout <= 2_000)).toBe(true)
        expect(controller.validated).toEqual([{ ref: "e12", snapshotId: "snapshot-1" }])
    })

    test("treats a missing ref as detached or hidden", async () => {
        const controller = new FakeController()
        controller.output = () => Promise.reject(new BrowserRuntimeException(
            "LOCATOR_NOT_FOUND",
            "Browser automation target was not found",
            true,
        ))

        for (const state of ["detached", "hidden"] as const) {
            await adapter(controller).run(
                tab(),
                "owner",
                automation({
                    name: "tab.automation.waitFor",
                    state,
                    target: { ref: "e12", snapshotId: "snapshot-1" },
                    timeout: 100,
                }),
            )
        }

        expect(controller.calls.map((call) => call.args)).toEqual([
            ["get", "styles", "@e12"],
            ["is", "visible", "@e12"],
        ])
    })

    test("reports an element wait timeout without racing the final native probe", async () => {
        const controller = new FakeController()
        controller.output = () => ({ data: { visible: true }, success: true })

        const error = await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.waitFor",
                state: "hidden",
                target: { advanced: true, css: "#spinner" },
                timeout: 1,
            }),
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "TIMEOUT",
            details: { causeCategory: "element_wait" },
        })
        expect(controller.calls.every((call) => (call.timeout ?? 0) >= 100)).toBe(true)
    })

    test("maps non-element wait conditions to native agent-browser wait", async () => {
        const controller = new FakeController()
        const waits = [
            {
                command: automation({ name: "tab.automation.waitFor", text: "Ready" }),
                expected: ["wait", "--text", "Ready"],
            },
            {
                command: automation({ name: "tab.automation.waitFor", url: "**/dashboard" }),
                expected: ["wait", "--url", "**/dashboard"],
            },
            {
                command: automation({ loadState: "networkidle", name: "tab.automation.waitFor" }),
                expected: ["wait", "--load", "networkidle"],
            },
            {
                command: automation({
                    expression: "window.appReady === true",
                    name: "tab.automation.waitFor",
                }),
                expected: ["wait", "--fn", "window.appReady === true"],
            },
            {
                command: automation({ milliseconds: 20_000, name: "tab.automation.waitFor" }),
                expected: ["wait", "20000"],
                timeout: 21_000,
            },
        ]

        for (const wait of waits) {
            await adapter(controller).run(tab(), "owner", wait.command)
        }

        expect(controller.calls).toEqual(
            waits.map((wait) => ({
                args: wait.expected,
                operation: "waitFor",
                timeout: "timeout" in wait ? wait.timeout : 30_000,
            })),
        )
    })

    test("counts a ref by probing whether the referenced element is attached", async () => {
        const attached = new FakeController()
        attached.output = () => ({ data: { styles: { display: "block" } }, success: true })
        const missing = new FakeController()
        missing.output = () => ({ data: { styles: {} }, success: true })
        const target = { ref: "e12", snapshotId: "snapshot-1" }

        expect(await adapter(attached).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.count", target }),
        )).toEqual({ count: 1 })
        expect(await adapter(missing).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.count", target }),
        )).toEqual({ count: 0 })
        expect(attached.calls[0]).toEqual({
            args: ["get", "styles", "@e12"],
            operation: "count",
            timeout: undefined,
        })
    })

    test("routes semantic targets through native find without a count preflight", async () => {
        const controller = new FakeController()
        controller.output = () => ({ data: { filled: "@e1" }, success: true })

        await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.fill",
                target: { name: "Search", role: "textbox" },
                value: "query",
            }),
        )

        expect(controller.calls).toEqual([{
            args: ["find", "role", "textbox", "fill", "query", "--name", "Search"],
            operation: "fill",
            timeout: undefined,
        }])
    })

    test("maps every native locator kind directly to agent-browser find", async () => {
        const controller = new FakeController()
        controller.output = () => ({ data: { clicked: "@e1" }, success: true })
        const targets = [
            { expected: ["find", "placeholder", "Search", "click", "--exact"], target: { exact: true, placeholder: "Search" } },
            { expected: ["find", "alt", "Logo", "click"], target: { alt: "Logo" } },
            { expected: ["find", "title", "Settings", "click"], target: { title: "Settings" } },
            { expected: ["find", "testid", "save", "click"], target: { testId: "save" } },
            { expected: ["find", "first", ".item", "click"], target: { advanced: true, first: ".item" } },
            { expected: ["find", "last", ".item", "click"], target: { advanced: true, last: ".item" } },
            {
                expected: ["find", "nth", "2", ".item", "click"],
                target: { advanced: true, nth: 2, selector: ".item" },
            },
        ] as const

        for (const locator of targets) {
            await adapter(controller).run(
                tab(),
                "owner",
                automation({ name: "tab.automation.click", target: locator.target }),
            )
        }

        expect(controller.calls.map((call) => call.args)).toEqual(targets.map((locator) => locator.expected))
    })

    test("maps snapshot, keyboard, read, and semantic scroll options one-to-one", async () => {
        const controller = new FakeController()
        controller.output = (input) => input.operation === "snapshot"
            ? { data: { refs: {}, snapshot: "document" }, success: true }
            : input.operation === "read"
                ? {
                    data: {
                        content: "# Page",
                        contentType: "text/markdown",
                        finalUrl: "https://example.test/docs",
                        source: "http-markdown",
                        status: 200,
                        truncated: false,
                        url: "https://example.test/docs",
                    },
                    success: true,
                }
                : { data: {}, success: true }

        await adapter(controller).run(tab(), "owner", automation({
            compact: true,
            depth: 3,
            interactive: true,
            name: "tab.automation.snapshot",
            selector: "main",
            urls: true,
        }))
        await adapter(controller).run(tab(), "owner", automation({
            name: "tab.automation.keyboard.type",
            text: "hello",
        }))
        await adapter(controller).run(tab(), "owner", automation({
            name: "tab.automation.keyboard.insertText",
            text: " world",
        }))
        await adapter(controller).run(tab(), "owner", automation({
            amount: 600,
            direction: "right",
            name: "tab.automation.scroll",
            target: { advanced: true, css: ".pane" },
        }))
        const readable = await adapter(controller).run(tab(), "owner", automation({
            llms: "full",
            name: "tab.automation.read",
            outline: true,
            requireMd: true,
            timeout: 4_000,
            url: "https://example.test/docs",
        }))

        expect(controller.calls.map((call) => call.args)).toEqual([
            ["snapshot", "--interactive", "--urls", "--compact", "--depth", "3", "--selector", "main"],
            ["keyboard", "type", "hello"],
            ["keyboard", "inserttext", " world"],
            ["scroll", "right", "600", "--selector", ".pane"],
            ["read", "https://example.test/docs", "--require-md", "--llms", "full", "--outline", "--timeout", "4000"],
        ])
        expect(readable.readable).toMatchObject({
            content: "# Page",
            source: "http-markdown",
            status: 200,
        })
    })

    test("returns native annotated screenshots as in-memory assets", async () => {
        const controller = new FakeController()
        const outputPaths: string[] = []
        controller.output = async (input) => {
            const filepath = input.args.find((argument) => /\.(?:jpe?g|png)$/.test(argument))
            if (!filepath) throw new Error("Expected screenshot output path")
            outputPaths.push(filepath)
            if (filepath.endsWith(".jpg")) {
                const jpeg = Buffer.from([
                    0xff, 0xd8,
                    0xff, 0xc0, 0x00, 0x0b, 0x08,
                    0x00, 0x64,
                    0x00, 0xc8,
                    0x03, 0x01, 0x11,
                    0xff, 0xd9,
                ])
                await Bun.write(filepath, jpeg)
                return { data: { path: filepath }, success: true }
            }
            const png = Buffer.alloc(24)
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
            png.writeUInt32BE(320, 16)
            png.writeUInt32BE(180, 20)
            await Bun.write(filepath, png)
            return {
                data: {
                    annotations: [{
                        box: { height: 20, width: 80, x: 10, y: 12 },
                        name: "Save",
                        number: 1,
                        ref: "e1",
                        role: "button",
                    }],
                    path: filepath,
                },
                success: true,
            }
        }

        const screenshot = await adapter(controller).run(tab(), "owner", {
            annotate: true,
            name: "tab.screenshot",
        })
        const jpeg = await adapter(controller).run(tab(), "owner", {
            imageFormat: "jpeg",
            name: "tab.screenshot",
            quality: 80,
            target: { advanced: true, css: ".card" },
        })
        expect(screenshot.screenshot).toMatchObject({
            annotations: [{ number: 1, ref: "e1", role: "button" }],
            height: 180,
            mimeType: "image/png",
            snapshotId: "snapshot-1",
            tabGeneration: 7,
            width: 320,
        })
        expect(Buffer.from(screenshot.screenshot?.data ?? "", "base64")).toHaveLength(24)
        expect(jpeg.screenshot).toMatchObject({
            height: 100,
            mimeType: "image/jpeg",
            width: 200,
        })
        expect(controller.calls[1].args).toEqual([
            "screenshot",
            ".card",
            outputPaths[1],
            "--screenshot-format",
            "jpeg",
            "--screenshot-quality",
            "80",
        ])
        expect(controller.recordedRefs.at(-1)).toEqual(["e1"])
        expect(await Promise.all(outputPaths.map((filepath) => Bun.file(filepath).exists()))).toEqual([false, false])
    })

    test("returns live box and HTML getter results", async () => {
        const controller = new FakeController()
        controller.output = (input) => {
            if (input.operation === "count") return { data: { count: 1 }, success: true }
            if (input.operation === "getBox") {
                return { data: { height: 20, width: 100, x: 4, y: 8 }, success: true }
            }
            return { data: { html: "<button>Save</button>" }, success: true }
        }
        const target = { advanced: true as const, css: "#save" }

        expect(await adapter(controller).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.getBox", target }),
        )).toEqual({ box: { height: 20, width: 100, x: 4, y: 8 } })
        expect(await adapter(controller).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.getHtml", target }),
        )).toEqual({ html: "<button>Save</button>" })
    })

    test("translates an OOPIF box into top-level viewport coordinates", async () => {
        const controller = new FakeController()
        controller.childSessionId = "child-session"
        controller.output = (input) => input.operation === "count"
            ? { data: { count: 1 }, success: true }
            : { data: { height: 20, width: 100, x: 4, y: 8 }, success: true }

        expect(await adapter(controller).run(
            tab("https://approved.test/path", (method, _params, sessionId) => {
                if (method === "Page.getFrameTree") {
                    expect(sessionId).toBe("child-session")
                    return Promise.resolve({
                        frameTree: { frame: { id: "frame-id" } },
                    })
                }
                if (method === "DOM.getFrameOwner") {
                    return Promise.resolve({ backendNodeId: 42 })
                }
                return Promise.resolve({
                    model: {
                        content: [200, 120, 500, 120, 500, 320, 200, 320],
                    },
                })
            }),
            "owner",
            automation({
                name: "tab.automation.getBox",
                target: { advanced: true, css: "#inside-frame" },
            }),
        )).toEqual({ box: { height: 20, width: 100, x: 204, y: 128 } })
    })

    test("bounds untrusted snapshot and text content", async () => {
        const controller = new FakeController()
        controller.output = (input) => input.operation === "snapshot"
            ? {
                _boundary: { nonce: "snapshot-nonce", origin: "https://example.test" },
                data: {
                    refs: { e1: { name: "Search", role: "textbox" } },
                    snapshot: `[ref=e1]${"a".repeat(1_000_001)}`,
                },
                success: true,
            }
            : input.operation === "count"
                ? { data: { count: 1 }, success: true }
                : {
                    _boundary: { nonce: "text-nonce", origin: "https://example.test" },
                    data: { text: "page text" },
                    success: true,
                }

        const snapshot = await adapter(controller).run(
            tab(),
            "owner",
            automation({ name: "tab.automation.snapshot" }),
        )
        const text = await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.getText",
                target: { advanced: true, css: "#content" },
            }),
        )

        expect(snapshot.automationSnapshot?.truncated).toBe(true)
        expect(snapshot.automationSnapshot?.content).toStartWith(
            "--- AGENT_BROWSER_PAGE_CONTENT nonce=snapshot-nonce origin=https://example.test ---",
        )
        expect(snapshot.automationSnapshot?.content).toEndWith(
            "--- END_AGENT_BROWSER_PAGE_CONTENT nonce=snapshot-nonce ---",
        )
        expect(text).toEqual({
            value: [
                "--- AGENT_BROWSER_PAGE_CONTENT nonce=text-nonce origin=https://example.test ---",
                "page text",
                "--- END_AGENT_BROWSER_PAGE_CONTENT nonce=text-nonce ---",
            ].join("\n"),
        })
    })

    test("checks the approved origin immediately before every agent command", async () => {
        const controller = new FakeController()
        const current = tab("https://changed.test/path")
        const error = await adapter(controller).run(
            current,
            "owner",
            automation({ name: "tab.automation.snapshot" }),
            undefined,
            "https://approved.test",
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "ORIGIN_CHANGED",
            details: {
                actualOrigin: "https://changed.test",
                expectedOrigin: "https://approved.test",
            },
        })
        expect(controller.calls).toHaveLength(0)
    })
})

function adapter(controller: FakeController) {
    return new AgentBrowserCommandAdapter(controller as unknown as AgentBrowserTabController)
}

function tab(
    url = "https://approved.test/path",
    sendCommand: (
        method: string,
        params?: Record<string, unknown>,
        sessionId?: string,
    ) => Promise<unknown> = () => Promise.resolve({}),
) {
    return {
        debuggerTransport: { sendCommand },
        generation: 7,
        id: "tab-1",
        webContents: {
            getURL: () => url,
            printToPDF: () => Promise.resolve(Buffer.from("%PDF-1.7\n")),
        },
    } as EmbeddedTab
}

function automation(command: Extract<BrowserCommand, { name: `tab.automation.${string}` }>) {
    return command
}
