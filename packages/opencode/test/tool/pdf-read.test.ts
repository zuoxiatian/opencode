import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { PdfReadTool } from "../../src/tool/pdf-read/index"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const init = Effect.fn("PdfReadToolTest.init")(function* () {
  const info = yield* PdfReadTool
  return yield* info.init()
})

const run = Effect.fn("PdfReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof PdfReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("PdfReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof PdfReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("PdfReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof PdfReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected pdf_read to fail")
})

const escapePdfText = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")

const pdf = (pages: string[][]) => {
  const encoder = new TextEncoder()
  const font = pages.length + 3
  const content = font + 1
  const stream = (lines: string[]) =>
    [
      "BT",
      "/F1 24 Tf",
      "72 720 Td",
      ...lines.flatMap((line, index) => [...(index === 0 ? [] : ["0 -32 Td"]), `(${escapePdfText(line)}) Tj`]),
      "ET",
    ].join("\n")
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
    ...pages.map(
      (_, index) =>
        `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content + index} 0 R >>\nendobj\n`,
    ),
    `${font} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    ...pages.map((lines, index) => {
      const body = stream(lines)
      return `${content + index} 0 obj\n<< /Length ${encoder.encode(body).length} >>\nstream\n${body}\nendstream\nendobj\n`
    }),
  ]

  const offsets = [0]
  const body = objects.reduce((output, object) => {
    offsets.push(encoder.encode(output).length)
    return output + object
  }, "%PDF-1.4\n")
  const xref = encoder.encode(body).length
  return encoder.encode(
    [
      body,
      `xref\n0 ${objects.length + 1}`,
      "0000000000 65535 f ",
      offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
        .join("\n"),
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
      `startxref\n${xref}`,
      "%%EOF\n",
    ].join("\n"),
  )
}

const writePdf = Effect.fn("PdfReadToolTest.writePdf")(function* (filepath: string, pages: string[][]) {
  yield* Effect.promise(() => Bun.write(filepath, pdf(pages)))
})

describe("tool.pdf_read", () => {
  it.live("reads text from a selected PDF page", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writePdf(path.join(dir, "sample.pdf"), [["First page"], ["Second page"]])

      const result = yield* exec(dir, { filePath: path.join(dir, "sample.pdf"), page: 2 })
      expect(result.output).toContain("<type>pdf</type>")
      expect(result.output).toContain("<page>2 of 2</page>")
      expect(result.output).toContain("1: Second page")
      expect(result.output).not.toContain("First page")
      expect(result.metadata.pages).toBe(2)
      expect(result.metadata.page).toBe(2)
    }),
  )

  it.live("reads all pages by default with page markers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writePdf(path.join(dir, "all.pdf"), [["Alpha"], ["Beta"]])

      const result = yield* exec(dir, { filePath: path.join(dir, "all.pdf") })
      expect(result.output).toContain("<pages>2</pages>")
      expect(result.output).toContain("[Page 1]")
      expect(result.output).toContain("Alpha")
      expect(result.output).toContain("[Page 2]")
      expect(result.output).toContain("Beta")
    }),
  )

  it.live("supports offset and limit over extracted PDF text lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writePdf(path.join(dir, "lines.pdf"), [["Line 1", "Line 2", "Line 3"]])

      const result = yield* exec(dir, { filePath: path.join(dir, "lines.pdf"), page: 1, offset: 2, limit: 1 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("2: Line 2")
      expect(result.output).not.toContain("1: Line 1")
      expect(result.output).not.toContain("3: Line 3")
    }),
  )

  it.live("fails when a selected PDF page is out of range", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writePdf(path.join(dir, "short.pdf"), [["Only page"]])

      const err = yield* fail(dir, { filePath: path.join(dir, "short.pdf"), page: 2 })
      expect(err.message).toContain("Page 2 is out of range for this PDF (1 pages)")
    }),
  )
})
