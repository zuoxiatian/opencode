import { app, type Session } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrowserRuntimeException } from "../errors"
import type { EmbeddedTab } from "./tab"

type GsuiteFormat = "csv" | "docx" | "md" | "pdf" | "pptx" | "xlsx"

export async function exportPage(tab: EmbeddedTab) {
    const target = await exportPath(tab, "mhtml")
    await tab.view.webContents.savePage(target, "MHTML")
    return target
}

export async function exportGsuitePage(
    browserSession: Session,
    tab: EmbeddedTab,
    format: GsuiteFormat,
) {
    const source = gsuiteExportUrl(tab.view.webContents.getURL(), format)
    const response = await browserSession.fetch(source, {
        credentials: "include",
        signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
        throw new BrowserRuntimeException(
            "BROWSER_UNAVAILABLE",
            `Google Workspace export failed with HTTP ${response.status}`,
            true,
        )
    }
    const target = await exportPath(tab, format)
    await writeFile(target, Buffer.from(await response.arrayBuffer()))
    return target
}

async function exportPath(tab: EmbeddedTab, extension: string) {
    const directory = path.join(app.getPath("temp"), "LongwiseTechAgent", "browser-exports")
    await mkdir(directory, { recursive: true })
    const title = (tab.view.webContents.getTitle() || "page")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "page"
    return path.join(directory, `${title}-${Date.now()}.${extension}`)
}

function gsuiteExportUrl(input: string, format: GsuiteFormat) {
    const url = new URL(input)
    if (url.hostname !== "docs.google.com") {
        throw new BrowserRuntimeException(
            "INVALID_COMMAND",
            "content.exportGsuite requires a docs.google.com tab",
        )
    }
    const match = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/)
    if (!match) {
        throw new BrowserRuntimeException(
            "INVALID_COMMAND",
            "Unable to determine the Google Workspace document id",
        )
    }
    const [, kind, id] = match
    if (kind === "document" && ["docx", "md", "pdf"].includes(format)) {
        return `https://docs.google.com/document/d/${id}/export?format=${format === "md" ? "txt" : format}`
    }
    if (kind === "spreadsheets" && ["csv", "pdf", "xlsx"].includes(format)) {
        return `https://docs.google.com/spreadsheets/d/${id}/export?format=${format}`
    }
    if (kind === "presentation" && ["pdf", "pptx"].includes(format)) {
        return `https://docs.google.com/presentation/d/${id}/export/${format}`
    }
    throw new BrowserRuntimeException(
        "INVALID_COMMAND",
        `The ${format} format is not supported for this Google Workspace document`,
    )
}
