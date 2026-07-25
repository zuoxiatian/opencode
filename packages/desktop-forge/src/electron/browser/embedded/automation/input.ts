import type {
    BrowserKeyModifier,
    BrowserMouseButton,
} from "@opencode-ai/browser-protocol"
import type { WebContents } from "electron"

export function coordinateClick(
    webContents: WebContents,
    input: {
        button?: BrowserMouseButton
        clickCount?: number
        modifiers?: BrowserKeyModifier[]
        x: number
        y: number
    },
) {
    webContents.focus()
    const button = input.button ?? "left"
    const clickCount = Math.max(1, Math.min(3, Math.round(input.clickCount ?? 1)))
    const point = { x: Math.max(0, Math.round(input.x)), y: Math.max(0, Math.round(input.y)) }
    webContents.sendInputEvent({ button, clickCount, modifiers: input.modifiers, type: "mouseDown", ...point })
    webContents.sendInputEvent({ button, clickCount, modifiers: input.modifiers, type: "mouseUp", ...point })
}

export function coordinateMove(
    webContents: WebContents,
    input: { modifiers?: BrowserKeyModifier[]; x: number; y: number },
) {
    webContents.focus()
    webContents.sendInputEvent({
        modifiers: input.modifiers,
        type: "mouseMove",
        x: Math.max(0, Math.round(input.x)),
        y: Math.max(0, Math.round(input.y)),
    })
}

export function coordinateDrag(
    webContents: WebContents,
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
    coordinateMove(webContents, { modifiers: input.modifiers, ...start })
    webContents.sendInputEvent({
        button,
        clickCount: 1,
        modifiers: input.modifiers,
        type: "mouseDown",
        x: Math.round(start.x),
        y: Math.round(start.y),
    })
    input.path.slice(1).forEach((point) =>
        webContents.sendInputEvent({
            button,
            modifiers: input.modifiers,
            type: "mouseMove",
            x: Math.round(point.x),
            y: Math.round(point.y),
        }))
    webContents.sendInputEvent({
        button,
        clickCount: 1,
        modifiers: input.modifiers,
        type: "mouseUp",
        x: Math.round(end.x),
        y: Math.round(end.y),
    })
}

export function textInput(webContents: WebContents, text: string) {
    webContents.focus()
    webContents.insertText(text)
}

export function keypress(
    webContents: WebContents,
    input: { key: string; modifiers?: BrowserKeyModifier[] },
) {
    webContents.focus()
    const modifiers = input.modifiers ?? []
    webContents.sendInputEvent({ keyCode: input.key, modifiers, type: "keyDown" })
    if (input.key.length === 1 && !modifiers.some((modifier) => modifier === "control" || modifier === "meta")) {
        webContents.sendInputEvent({ keyCode: input.key, modifiers, type: "char" })
    }
    webContents.sendInputEvent({ keyCode: input.key, modifiers, type: "keyUp" })
}

export function keypressKeys(webContents: WebContents, keys: readonly string[]) {
    if (!keys.length) return
    const key = keys.at(-1) ?? "Enter"
    keypress(webContents, {
        key: normalizeKey(key),
        modifiers: Array.from(new Set(keys.slice(0, -1).flatMap((value) => {
            const modifier = normalizeModifier(value)
            return modifier ? [modifier] : []
        }))),
    })
}

export function keypressValue(webContents: WebContents, value: string) {
    keypressKeys(webContents, value.split("+").filter(Boolean))
}

export function coordinateScroll(
    webContents: WebContents,
    input: {
        deltaX?: number
        deltaY: number
        modifiers?: BrowserKeyModifier[]
        x?: number
        y?: number
    },
) {
    webContents.focus()
    webContents.sendInputEvent({
        canScroll: true,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
        type: "mouseWheel",
        x: Math.max(0, Math.round(input.x ?? 1)),
        y: Math.max(0, Math.round(input.y ?? 1)),
    })
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
        arrowdown: "Down",
        arrowleft: "Left",
        arrowright: "Right",
        arrowup: "Up",
        backspace: "Backspace",
        delete: "Delete",
        end: "End",
        enter: "Enter",
        escape: "Escape",
        home: "Home",
        pagedown: "PageDown",
        pageup: "PageUp",
        space: "Space",
        tab: "Tab",
    }
    return aliases[input.toLowerCase()] ?? input
}
