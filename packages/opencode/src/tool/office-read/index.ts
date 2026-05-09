import { Effect, Schema } from "effect"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../../project/instance"
import { Instruction } from "../../session/instruction"
import { assertExternalDirectoryEffect } from "../external-directory"
import * as Tool from "../tool"
import DESCRIPTION from "./description.txt"

const DEFAULT_READ_LIMIT = 2000
const PARSE_TIMEOUT = 10 * 60 * 1000
const SUPPORTED = new Set([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"])
const LEGACY = new Set([".doc", ".xls", ".ppt"])

declare global {
  const OPENCODE_OFFICE_READ_WORKER_PATH: string
}

type ParseResult = {
  format: string
  text: string
  metadata: unknown
}

type WorkerResponse = { ok: true; result: ParseResult } | { ok: false; error: string }

async function workerTarget() {
  if (typeof OPENCODE_OFFICE_READ_WORKER_PATH !== "undefined") return OPENCODE_OFFICE_READ_WORKER_PATH
  return new URL("./worker.ts", import.meta.url)
}

async function parseInWorker(
  input: ArrayBuffer,
  extension: string,
  sheet: string | undefined,
  signal: AbortSignal,
): Promise<ParseResult> {
  if (signal.aborted) throw new Error("Office document parsing was cancelled")

  const worker = new Worker(await workerTarget(), { type: "module" })
  return await new Promise<ParseResult>((resolve, reject) => {
    const done = (result: () => void) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      worker.terminate()
      result()
    }
    const abort = () => done(() => reject(new Error("Office document parsing was cancelled")))
    const timeout = setTimeout(
      () =>
        done(() =>
          reject(
            new Error(
              `Office document parsing timed out after ${PARSE_TIMEOUT} ms. The file may be damaged or too complex to parse safely.`,
            ),
          ),
        ),
      PARSE_TIMEOUT,
    )

    signal.addEventListener("abort", abort, { once: true })
    worker.onmessage = (event) => {
      const data = event.data as WorkerResponse
      done(() => {
        if (data.ok) return resolve(data.result)
        reject(new Error(data.error))
      })
    }
    worker.onerror = (event) => {
      done(() => reject(new Error(event.message)))
    }
    worker.postMessage({ input, extension, sheet }, [input])
  })
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the Office document to read" }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "The extracted text line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "The maximum number of extracted text lines to read (defaults to 2000)",
  }),
  sheet: Schema.optional(Schema.String).annotate({
    description: "Optional worksheet name for spreadsheet files, such as Sheet1",
  }),
})

export const OfficeReadTool = Tool.define(
  "office_read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service

    const miss = Effect.fn("OfficeReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    })

    const extractText = Effect.fn("OfficeReadTool.extractText")(function* (
      filepath: string,
      extension: string,
      sheet: string | undefined,
      signal: AbortSignal,
    ) {
      const bytes = yield* fs.readFile(filepath)
      return yield* Effect.promise(() =>
        parseInWorker(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          extension,
          sheet,
          signal,
        ),
      )
    })

    const run = Effect.fn("OfficeReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.offset !== undefined && params.offset < 1) {
        throw new Error("offset must be greater than or equal to 1")
      }
      if (params.limit !== undefined && params.limit < 1) {
        throw new Error("limit must be greater than or equal to 1")
      }

      const filepath = (() => {
        const resolved = path.isAbsolute(params.filePath)
          ? params.filePath
          : path.resolve(Instance.directory, params.filePath)
        if (process.platform === "win32") return AppFileSystem.normalizePath(resolved)
        return resolved
      })()
      const title = path.relative(Instance.worktree, filepath)
      const ext = path.extname(filepath).toLowerCase()

      if (LEGACY.has(ext)) {
        throw new Error(
          `Legacy binary Office files (${ext}) are not supported by this tool. Save the file as .docx, .xlsx, or .pptx and try again.`,
        )
      }
      if (!SUPPORTED.has(ext)) throw new Error(`Unsupported Office file type: ${ext || "(none)"}`)

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      if (!stat) return yield* miss(filepath)
      if (stat.type === "Directory")
        throw new Error(`Cannot read Office document because path is a directory: ${filepath}`)

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const extracted = yield* extractText(filepath, ext, params.sheet, ctx.abort)
      const lines = extracted.text.split(/\r?\n/).map((line) => line.trimEnd())
      const normalized = lines.some((line) => line.length > 0) ? lines : ["(no text found)"]
      const offset = params.offset ?? 1
      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const start = offset - 1
      if (start >= normalized.length && !(normalized.length === 0 && offset === 1)) {
        throw new Error(`Offset ${offset} is out of range for this document (${normalized.length} lines)`)
      }

      const sliced = normalized.slice(start, start + limit)
      const last = offset + sliced.length - 1
      const next = last + 1
      const truncated = start + sliced.length < normalized.length
      const output = [
        `<path>${filepath}</path>`,
        `<type>office:${extracted.format}</type>`,
        "<content>",
        sliced.map((line, index) => `${offset + index}: ${line}`).join("\n"),
        truncated
          ? `\n(Showing lines ${offset}-${last} of ${normalized.length}. Use offset=${next} to continue.)`
          : `\n(End of document - total ${normalized.length} lines)`,
        "</content>",
      ].join("\n")

      return {
        title,
        output:
          loaded.length > 0
            ? `${output}\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
            : output,
        metadata: {
          preview: sliced.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
          format: extracted.format,
          document: extracted.metadata,
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
