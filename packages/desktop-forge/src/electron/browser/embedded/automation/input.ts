import type {
    BrowserKeyModifier,
    BrowserMouseButton,
} from "@opencode-ai/browser-protocol"
import type { CdpSender } from "./cdp"

export async function coordinateClick(
    send: CdpSender,
    input: {
        button?: BrowserMouseButton
        clickCount?: number
        modifiers?: BrowserKeyModifier[]
        x: number
        y: number
    },
) {
    const button = input.button ?? "left"
    const clickCount = Math.max(1, Math.min(3, Math.round(input.clickCount ?? 1)))
    const point = { x: Math.max(0, Math.round(input.x)), y: Math.max(0, Math.round(input.y)) }
    const modifiers = modifierMask(input.modifiers)
    await send("Input.dispatchMouseEvent", {
        button,
        buttons: buttonMask(button),
        clickCount,
        modifiers,
        type: "mousePressed",
        ...point,
    })
    await send("Input.dispatchMouseEvent", {
        button,
        buttons: 0,
        clickCount,
        modifiers,
        type: "mouseReleased",
        ...point,
    })
}

export function coordinateMove(
    send: CdpSender,
    input: { modifiers?: BrowserKeyModifier[]; x: number; y: number },
) {
    return send("Input.dispatchMouseEvent", {
        modifiers: modifierMask(input.modifiers),
        type: "mouseMoved",
        x: Math.max(0, Math.round(input.x)),
        y: Math.max(0, Math.round(input.y)),
    })
}

export async function coordinateDrag(
    send: CdpSender,
    input: {
        button?: BrowserMouseButton
        modifiers?: BrowserKeyModifier[]
        path: Array<{ x: number; y: number }>
    },
) {
    const button = input.button ?? "left"
    const start = input.path[0]
    const end = input.path.at(-1)
    if (!start || !end) return
    const modifiers = modifierMask(input.modifiers)
    await coordinateMove(send, { modifiers: input.modifiers, ...start })
    await send("Input.dispatchMouseEvent", {
        button,
        buttons: buttonMask(button),
        clickCount: 1,
        modifiers,
        type: "mousePressed",
        x: Math.round(start.x),
        y: Math.round(start.y),
    })
    for (const point of input.path.slice(1)) {
        await send("Input.dispatchMouseEvent", {
            button,
            buttons: buttonMask(button),
            modifiers,
            type: "mouseMoved",
            x: Math.round(point.x),
            y: Math.round(point.y),
        })
    }
    await send("Input.dispatchMouseEvent", {
        button,
        buttons: 0,
        clickCount: 1,
        modifiers,
        type: "mouseReleased",
        x: Math.round(end.x),
        y: Math.round(end.y),
    })
}

export function textInput(send: CdpSender, value: string) {
    return send("Input.insertText", { text: value })
}

export async function keypress(
    send: CdpSender,
    input: { key: string; modifiers?: BrowserKeyModifier[] },
) {
    const modifiers = modifierMask(input.modifiers)
    const key = keyboardKey(input.key, modifiers)
    await send("Input.dispatchKeyEvent", {
        code: key.code,
        key: key.key,
        modifiers,
        nativeVirtualKeyCode: key.keyCode,
        type: key.text ? "keyDown" : "rawKeyDown",
        windowsVirtualKeyCode: key.keyCode,
        ...(key.text ? { text: key.text, unmodifiedText: key.unmodifiedText } : {}),
    })
    await send("Input.dispatchKeyEvent", {
        code: key.code,
        key: key.key,
        modifiers,
        nativeVirtualKeyCode: key.keyCode,
        type: "keyUp",
        windowsVirtualKeyCode: key.keyCode,
    })
}

export function keypressKeys(send: CdpSender, keys: readonly string[]) {
    if (!keys.length) return Promise.resolve()
    return keypress(send, {
        key: normalizeKey(keys.at(-1) ?? "Enter"),
        modifiers: Array.from(new Set(keys.slice(0, -1).flatMap((value) => {
            const modifier = normalizeModifier(value)
            return modifier ? [modifier] : []
        }))),
    })
}

export function keypressValue(send: CdpSender, value: string) {
    return keypressKeys(send, value.split("+").filter(Boolean))
}

export function coordinateScroll(
    send: CdpSender,
    input: {
        deltaX?: number
        deltaY: number
        modifiers?: BrowserKeyModifier[]
        x?: number
        y?: number
    },
) {
    return send("Input.dispatchMouseEvent", {
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY,
        modifiers: modifierMask(input.modifiers),
        type: "mouseWheel",
        x: Math.max(0, Math.round(input.x ?? 1)),
        y: Math.max(0, Math.round(input.y ?? 1)),
    })
}

function modifierMask(input: readonly BrowserKeyModifier[] = []) {
    return input.reduce((mask, modifier) => mask | {
        alt: 1,
        control: 2,
        meta: 4,
        shift: 8,
    }[modifier], 0)
}

function buttonMask(input: BrowserMouseButton) {
    return {
        left: 1,
        middle: 4,
        right: 2,
    }[input]
}

function normalizeModifier(input: string): BrowserKeyModifier | undefined {
    const value = input.toLowerCase()
    if (value === "alt" || value === "option") return "alt"
    if (value === "control" || value === "ctrl") return "control"
    if (value === "meta" || value === "command" || value === "cmd") return "meta"
    if (value === "controlormeta") return process.platform === "darwin" ? "meta" : "control"
    if (value === "shift") return "shift"
}

function normalizeKey(input: string) {
    const aliases: Record<string, string> = {
        arrowdown: "ArrowDown",
        arrowleft: "ArrowLeft",
        arrowright: "ArrowRight",
        arrowup: "ArrowUp",
        backspace: "Backspace",
        delete: "Delete",
        down: "ArrowDown",
        end: "End",
        enter: "Enter",
        escape: "Escape",
        home: "Home",
        left: "ArrowLeft",
        pagedown: "PageDown",
        pageup: "PageUp",
        right: "ArrowRight",
        space: " ",
        tab: "Tab",
        up: "ArrowUp",
    }
    return aliases[input.toLowerCase()] ?? input
}

function keyboardKey(input: string, modifiers: number) {
    const key = normalizeKey(input)
    const special = {
        ArrowDown: { code: "ArrowDown", keyCode: 40 },
        ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
        ArrowRight: { code: "ArrowRight", keyCode: 39 },
        ArrowUp: { code: "ArrowUp", keyCode: 38 },
        Backspace: { code: "Backspace", keyCode: 8 },
        Delete: { code: "Delete", keyCode: 46 },
        End: { code: "End", keyCode: 35 },
        Enter: { code: "Enter", keyCode: 13, text: "\r" },
        Escape: { code: "Escape", keyCode: 27 },
        Home: { code: "Home", keyCode: 36 },
        PageDown: { code: "PageDown", keyCode: 34 },
        PageUp: { code: "PageUp", keyCode: 33 },
        Tab: { code: "Tab", keyCode: 9 },
    }[key]
    if (special) return { key, unmodifiedText: special.text, ...special }
    const shifted = Boolean(modifiers & 8)
    const text = key.length === 1 && !(modifiers & 6)
        ? shifted ? key.toUpperCase() : key
        : undefined
    return {
        code: /^[a-z]$/i.test(key)
            ? `Key${key.toUpperCase()}`
            : /^\d$/.test(key)
                ? `Digit${key}`
                : key === " " ? "Space" : key,
        key: text ?? key,
        keyCode: key === " " ? 32 : key.toUpperCase().charCodeAt(0),
        text,
        unmodifiedText: key,
    }
}
