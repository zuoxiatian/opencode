import { clipboard, nativeImage } from "electron"
import type { BrowserClipboardEntry, BrowserClipboardItem } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import type { EmbeddedTab } from "./tab"

export function readClipboard(_tab: EmbeddedTab) {
    const entries = clipboard.availableFormats().flatMap((mimeType): BrowserClipboardEntry[] => {
        if (mimeType === "text/plain") return [{ mimeType, text: clipboard.readText() }]
        if (mimeType === "text/html") return [{ mimeType, text: clipboard.readHTML() }]
        if (mimeType === "text/rtf") return [{ mimeType, text: clipboard.readRTF() }]
        if (mimeType === "image/png") {
            const image = clipboard.readImage()
            return image.isEmpty() ? [] : [{ base64: image.toPNG().toString("base64"), mimeType }]
        }
        const value = clipboard.readBuffer(mimeType)
        return value.length ? [{ base64: value.toString("base64"), mimeType }] : []
    })
    return Promise.resolve(entries.length ? [{
        entries,
        presentationStyle: "unspecified" as const,
    }] : [])
}

export function readClipboardText(_tab: EmbeddedTab) {
    return Promise.resolve(clipboard.readText())
}

export function writeClipboard(_tab: EmbeddedTab, items: BrowserClipboardItem[]) {
    const entries = items.flatMap((item) => item.entries)
    if (!entries.length) {
        throw new BrowserRuntimeException("INVALID_COMMAND", "Clipboard items must contain at least one entry")
    }
    const text = entries.find((entry) => entry.mimeType === "text/plain")?.text
    const html = entries.find((entry) => entry.mimeType === "text/html")?.text
    const rtf = entries.find((entry) => entry.mimeType === "text/rtf")?.text
    const image = entries.find((entry) => entry.mimeType === "image/png")?.base64
    const supported = entries.filter((entry) =>
        ["image/png", "text/html", "text/plain", "text/rtf"].includes(entry.mimeType))
    if (!supported.length && entries.length === 1 && entries[0]?.base64) {
        clipboard.writeBuffer(entries[0].mimeType, Buffer.from(entries[0].base64, "base64"))
        return Promise.resolve()
    }
    if (supported.length !== entries.length) {
        throw new BrowserRuntimeException(
            "INVALID_COMMAND",
            "The embedded browser can write text/plain, text/html, text/rtf, image/png, or one custom binary format",
        )
    }
    clipboard.write({
        ...(html === undefined ? {} : { html }),
        ...(image === undefined ? {} : { image: nativeImage.createFromBuffer(Buffer.from(image, "base64")) }),
        ...(rtf === undefined ? {} : { rtf }),
        ...(text === undefined ? {} : { text }),
    })
    return Promise.resolve()
}

export function writeClipboardText(_tab: EmbeddedTab, text: string) {
    clipboard.writeText(text)
    return Promise.resolve()
}
