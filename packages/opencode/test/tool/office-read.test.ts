import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { TextReader, Uint8ArrayWriter, ZipWriter, configure } from "@zip.js/zip.js"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { OfficeReadTool } from "../../src/tool/office-read/index"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

configure({ useWebWorkers: false })

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

const init = Effect.fn("OfficeReadToolTest.init")(function* () {
  const info = yield* OfficeReadTool
  return yield* info.init()
})

const run = Effect.fn("OfficeReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof OfficeReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("OfficeReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof OfficeReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("OfficeReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof OfficeReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected office_read to fail")
})

const zip = Effect.fn("OfficeReadToolTest.zip")(function* (filepath: string, entries: Record<string, string>) {
  yield* Effect.promise(async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await Object.entries(entries).reduce(async (previous, entry) => {
      await previous
      await writer.add(entry[0], new TextReader(entry[1]))
    }, Promise.resolve())
    await Bun.write(filepath, await writer.close())
  })
})

const docx = (body: string) => ({
  "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
})

const pptx = (body: string) => ({
  "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
})

const xlsx = {
  "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Name</t></si><si><t>Alice</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
}

describe("tool.office_read", () => {
  it.live("reads docx text through the fast OOXML reader", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* zip(
        path.join(dir, "sample.docx"),
        docx("<w:p><w:r><w:t>Hello Word</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>"),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "sample.docx") })
      expect(result.output).toContain("<type>office:docx</type>")
      expect(result.output).toContain("1: Hello Word")
      expect(result.output).toContain("2: Second paragraph")
    }),
  )

  it.live("reads pptx slide text through the fast OOXML reader", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* zip(
        path.join(dir, "deck.pptx"),
        pptx("<a:p><a:r><a:t>Deck title</a:t></a:r></a:p><a:p><a:r><a:t>Bullet one</a:t></a:r></a:p>"),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "deck.pptx") })
      expect(result.output).toContain("<type>office:pptx</type>")
      expect(result.output).toContain("Deck title")
      expect(result.output).toContain("Bullet one")
    }),
  )

  it.live("asks for external directory permission before reading files outside the project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const external = yield* tmpdirScoped()
      const asked: string[] = []
      yield* zip(
        path.join(external, "outside.pptx"),
        pptx("<a:p><a:r><a:t>Outside deck</a:t></a:r></a:p>"),
      )

      const result = yield* exec(dir, { filePath: path.join(external, "outside.pptx") }, {
        ...ctx,
        ask: (input) =>
          Effect.sync(() => {
            asked.push(input.permission)
          }),
      })

      expect(asked.slice(0, 2)).toEqual(["external_directory", "read"])
      expect(result.output).toContain("Outside deck")
    }),
  )

  it.live("fails malformed pptx XML without leaking xmldom logs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const logs: string[] = []
      const originalError = console.error
      console.error = (...values: unknown[]) => {
        logs.push(values.join(" "))
      }
      try {
        yield* zip(path.join(dir, "broken.pptx"), {
          "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Broken</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:timing><p:tnLst><p:par>`,
        })

        const err = yield* fail(dir, { filePath: path.join(dir, "broken.pptx") })
        expect(err.message).toContain("Office document XML could not be parsed")
        expect(logs.some((log) => log.includes("[xmldom"))).toBe(false)
      } finally {
        console.error = originalError
      }
    }),
  )

  it.live("reads xlsx text and supports sheet filtering", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* zip(path.join(dir, "book.xlsx"), xlsx)

      const result = yield* exec(dir, { filePath: path.join(dir, "book.xlsx"), sheet: "Sheet1" })
      expect(result.output).toContain("<type>office:xlsx</type>")
      expect(result.output).toContain("[Sheet: Sheet1]")
      expect(result.output).toContain("Name")
      expect(result.output).toContain("Alice")
    }),
  )

  it.live("supports offset and limit over extracted text lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* zip(
        path.join(dir, "paged.docx"),
        docx(Array.from({ length: 5 }, (_, i) => `<w:p><w:r><w:t>Line ${i + 1}</w:t></w:r></w:p>`).join("")),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "paged.docx"), offset: 3, limit: 2 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("3: Line 3")
      expect(result.output).toContain("4: Line 4")
      expect(result.output).not.toContain("2: Line 2")
      expect(result.output).not.toContain("5: Line 5")
    }),
  )
})
