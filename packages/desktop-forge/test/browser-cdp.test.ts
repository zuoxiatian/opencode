// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import {
    allowedCdpMethod,
    executeRawCdp,
    type CdpSender,
} from "../src/electron/browser/embedded/automation/cdp"
import { BrowserRuntimeException } from "../src/electron/browser/errors"

describe("raw browser CDP policy", () => {
    test("allows Runtime.evaluate and forces JSON-by-value results", async () => {
        const calls: Array<{
            method: string
            params?: Record<string, unknown>
            sessionId?: string
        }> = []
        const send: CdpSender = (method, params, sessionId) => {
            calls.push({ method, params, sessionId })
            return Promise.resolve({ result: { value: ["heading"] } })
        }

        expect(allowedCdpMethod("Runtime.evaluate")).toBe(true)
        await executeRawCdp(send, "Runtime.evaluate", {
            expression: "Array.from(document.querySelectorAll('h1')).map((element) => element.textContent)",
        })

        expect(calls).toEqual([{
            method: "Runtime.evaluate",
            params: {
                expression: "Array.from(document.querySelectorAll('h1')).map((element) => element.textContent)",
                returnByValue: true,
            },
            sessionId: undefined,
        }])
    })

    test("rejects Runtime.evaluate object handles", async () => {
        let called = false
        const error = await executeRawCdp(
            () => {
                called = true
                return Promise.resolve({})
            },
            "Runtime.evaluate",
            { expression: "document.body", returnByValue: false },
        ).catch((failure: unknown) => failure)

        expect(called).toBe(false)
        expect(error).toBeInstanceOf(BrowserRuntimeException)
        expect((error as BrowserRuntimeException).browser).toMatchObject({
            code: "PERMISSION_DENIED",
            message: "Runtime.evaluate requires returnByValue: true",
        })
    })

    test("continues to reject browser-scoped commands", async () => {
        expect(allowedCdpMethod("Browser.close")).toBe(false)
        await expect(executeRawCdp(
            () => Promise.resolve({}),
            "Browser.close",
        )).rejects.toThrow("CDP command is not allowed: Browser.close")
    })
})
