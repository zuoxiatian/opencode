// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import type { CdpSender } from "../src/electron/browser/embedded/automation/cdp"
import {
    coordinateClick,
    coordinateDrag,
    coordinateMove,
    coordinateScroll,
    keypressKeys,
    textInput,
} from "../src/electron/browser/embedded/automation/input"

describe("background browser input", () => {
    test("dispatches pointer actions through CDP without focusing the Electron window", async () => {
        const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
        const send: CdpSender = (method, params) => {
            calls.push({ method, params })
            return Promise.resolve({})
        }

        await coordinateClick(send, {
            button: "right",
            clickCount: 2,
            modifiers: ["alt", "shift"],
            x: 20.6,
            y: -2,
        })
        await coordinateMove(send, { x: 4.4, y: 5.6 })
        await coordinateDrag(send, {
            modifiers: ["control"],
            path: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
        })
        await coordinateScroll(send, { deltaX: 2, deltaY: 50, x: 7, y: 8 })

        expect(calls).toEqual([
            {
                method: "Input.dispatchMouseEvent",
                params: {
                    button: "right",
                    buttons: 2,
                    clickCount: 2,
                    modifiers: 9,
                    type: "mousePressed",
                    x: 21,
                    y: 0,
                },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: {
                    button: "right",
                    buttons: 0,
                    clickCount: 2,
                    modifiers: 9,
                    type: "mouseReleased",
                    x: 21,
                    y: 0,
                },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: { modifiers: 0, type: "mouseMoved", x: 4, y: 6 },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: { modifiers: 2, type: "mouseMoved", x: 1, y: 2 },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: {
                    button: "left",
                    buttons: 1,
                    clickCount: 1,
                    modifiers: 2,
                    type: "mousePressed",
                    x: 1,
                    y: 2,
                },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: {
                    button: "left",
                    buttons: 1,
                    modifiers: 2,
                    type: "mouseMoved",
                    x: 3,
                    y: 4,
                },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: {
                    button: "left",
                    buttons: 0,
                    clickCount: 1,
                    modifiers: 2,
                    type: "mouseReleased",
                    x: 3,
                    y: 4,
                },
            },
            {
                method: "Input.dispatchMouseEvent",
                params: {
                    deltaX: 2,
                    deltaY: 50,
                    modifiers: 0,
                    type: "mouseWheel",
                    x: 7,
                    y: 8,
                },
            },
        ])
    })

    test("dispatches text and keyboard actions through CDP", async () => {
        const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
        const send: CdpSender = (method, params) => {
            calls.push({ method, params })
            return Promise.resolve({})
        }

        await textInput(send, "background text")
        await keypressKeys(send, ["Control", "a"])
        await keypressKeys(send, ["Enter"])

        expect(calls).toEqual([
            {
                method: "Input.insertText",
                params: { text: "background text" },
            },
            {
                method: "Input.dispatchKeyEvent",
                params: {
                    code: "KeyA",
                    key: "a",
                    modifiers: 2,
                    nativeVirtualKeyCode: 65,
                    type: "rawKeyDown",
                    windowsVirtualKeyCode: 65,
                },
            },
            {
                method: "Input.dispatchKeyEvent",
                params: {
                    code: "KeyA",
                    key: "a",
                    modifiers: 2,
                    nativeVirtualKeyCode: 65,
                    type: "keyUp",
                    windowsVirtualKeyCode: 65,
                },
            },
            {
                method: "Input.dispatchKeyEvent",
                params: {
                    code: "Enter",
                    key: "Enter",
                    modifiers: 0,
                    nativeVirtualKeyCode: 13,
                    text: "\r",
                    type: "keyDown",
                    unmodifiedText: "\r",
                    windowsVirtualKeyCode: 13,
                },
            },
            {
                method: "Input.dispatchKeyEvent",
                params: {
                    code: "Enter",
                    key: "Enter",
                    modifiers: 0,
                    nativeVirtualKeyCode: 13,
                    type: "keyUp",
                    windowsVirtualKeyCode: 13,
                },
            },
        ])
    })
})
