import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import type { PDFPageProxy } from "pdfjs-dist"
import type { TextItem } from "pdfjs-dist/types/src/display/api"

type Request = {
  input: ArrayBuffer
  page?: number
}

type PageResult = {
  page: number
  text: string
}

type ParseResult = {
  format: "pdf"
  pageCount: number
  pages: PageResult[]
  metadata: {
    fingerprints: Array<string | null>
    selected: number[]
  }
}

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isTextItem = (item: unknown): item is TextItem => {
  if (!item || typeof item !== "object") return false
  const candidate = item as { str?: unknown; hasEOL?: unknown }
  return typeof candidate.str === "string" && typeof candidate.hasEOL === "boolean"
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim()

const pageText = async (page: PDFPageProxy) => {
  try {
    const content = await page.getTextContent()
    const state = content.items.filter(isTextItem).reduce(
      (acc, item) => {
        const text = clean(item.str)
        const line = text ? (acc.line ? `${acc.line} ${text}` : text) : acc.line
        if (!item.hasEOL) return { lines: acc.lines, line }
        return {
          lines: line ? [...acc.lines, line] : acc.lines,
          line: "",
        }
      },
      { lines: [] as string[], line: "" },
    )
    return (state.line ? [...state.lines, state.line] : state.lines).join("\n")
  } finally {
    page.cleanup()
  }
}

const parse = async (request: Request): Promise<ParseResult> => {
  const task = pdfjs.getDocument({
    data: new Uint8Array(request.input),
    isEvalSupported: false,
    useSystemFonts: true,
    useWorkerFetch: false,
  })
  const document = await task.promise
  try {
    if (request.page !== undefined && request.page > document.numPages) {
      throw new Error(`Page ${request.page} is out of range for this PDF (${document.numPages} pages)`)
    }

    const selected =
      request.page === undefined ? Array.from({ length: document.numPages }, (_, index) => index + 1) : [request.page]

    return {
      format: "pdf",
      pageCount: document.numPages,
      pages: await Promise.all(
        selected.map(async (pageNumber) => ({
          page: pageNumber,
          text: await pageText(await document.getPage(pageNumber)),
        })),
      ),
      metadata: {
        fingerprints: document.fingerprints,
        selected,
      },
    }
  } finally {
    await task.destroy()
  }
}

onmessage = (event) => {
  parse(event.data as Request)
    .then((result) => postMessage({ ok: true, result }))
    .catch((error) => postMessage({ ok: false, error: formatError(error) }))
}
