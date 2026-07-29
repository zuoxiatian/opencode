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
    output: (input: { args: string[]; operation: string }) => AgentBrowserJsonResult =
        () => ({ data: {}, success: true })

    transaction<T>(
        _input: unknown,
        task: (transaction: AgentBrowserTransaction) => Promise<T>,
    ) {
        return task({
            run: (input) => {
                this.calls.push(input)
                return Promise.resolve({
                    ...(this.childSessionId ? { childSessionId: this.childSessionId } : {}),
                    output: this.output(input),
                    sessionGeneration: 1,
                })
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
            interactiveOnly: true,
            snapshotId: "snapshot-1",
            tabGeneration: 7,
            tabId: "tab-1",
        })
        expect(controller.calls).toEqual([{
            args: ["snapshot", "-i"],
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

    test("preflights semantic targets and maps typed locator errors", async () => {
        const controller = new FakeController()
        controller.output = () => ({ data: { count: 2 }, success: true })

        const error = await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.fill",
                target: { name: "Search", role: "textbox" },
                value: "query",
            }),
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "AMBIGUOUS_LOCATOR",
            details: { operation: "fill", selectorKind: "role" },
        })
        expect(controller.calls).toHaveLength(1)
        expect(controller.calls[0].args.slice(0, 3)).toEqual(["get", "count", expect.stringContaining("xpath=")])
        expect(controller.calls[0].args[2]).toContain("//label[")
    })

    test("returns LOCATOR_NOT_FOUND without running an action when preflight finds no target", async () => {
        const controller = new FakeController()
        controller.output = () => ({ data: { count: 0 }, success: true })

        const error = await adapter(controller).run(
            tab(),
            "owner",
            automation({
                name: "tab.automation.click",
                target: { placeholder: "Search" },
            }),
        ).catch((failure: unknown) => failure)

        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "LOCATOR_NOT_FOUND",
            details: { operation: "click", selectorKind: "placeholder" },
        })
        expect(controller.calls).toHaveLength(1)
        expect(controller.calls[0].operation).toBe("count")
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
        },
    } as EmbeddedTab
}

function automation(command: Extract<BrowserCommand, { name: `tab.automation.${string}` }>) {
    return command
}
