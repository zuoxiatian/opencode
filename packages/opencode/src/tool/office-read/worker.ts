type Request = {
  input: ArrayBuffer
  extension: string
  sheet?: string
}

type ParseResult = {
  format: string
  text: string
  metadata: unknown
}

type ZipEntry = {
  name: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

type ZipFile = {
  bytes: Uint8Array
  entries: Map<string, ZipEntry>
}

type XmlPart = {
  tag: string
  body: string
}

const decoder = new TextDecoder()
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const XML_NAMESPACE = "[A-Za-z_][\\w.-]*:"

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const parserError = (detail: string) =>
  [
    "Office document XML could not be parsed. The file may be damaged or contain invalid Office XML.",
    "",
    "Parser diagnostics:",
    detail,
  ].join("\n")

const readUint16 = (view: DataView, offset: number) => view.getUint16(offset, true)
const readUint32 = (view: DataView, offset: number) => view.getUint32(offset, true)

const findEndOfCentralDirectory = (view: DataView) => {
  const start = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (readUint32(view, offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error("Office document ZIP directory could not be found")
}

const readZip = (input: ArrayBuffer): ZipFile => {
  const bytes = new Uint8Array(input)
  const view = new DataView(input)
  const eocd = findEndOfCentralDirectory(view)
  const centralSize = readUint32(view, eocd + 12)
  const centralOffset = readUint32(view, eocd + 16)
  if (centralOffset + centralSize > bytes.length) throw new Error("Office document ZIP directory is out of range")

  const entries = new Map<string, ZipEntry>()
  for (let offset = centralOffset; offset < centralOffset + centralSize; ) {
    if (readUint32(view, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Office document ZIP central directory is invalid")
    }

    const nameLength = readUint16(view, offset + 28)
    const extraLength = readUint16(view, offset + 30)
    const commentLength = readUint16(view, offset + 32)
    const compressedSize = readUint32(view, offset + 20)
    const uncompressedSize = readUint32(view, offset + 24)
    const localOffset = readUint32(view, offset + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Zip64 Office documents are not supported by office_read")
    }

    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    entries.set(name, {
      name,
      flags: readUint16(view, offset + 8),
      method: readUint16(view, offset + 10),
      compressedSize,
      uncompressedSize,
      localOffset,
    })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return { bytes, entries }
}

const readZipEntry = (zip: ZipFile, name: string) => {
  const entry = zip.entries.get(name)
  if (!entry) return undefined
  if (entry.flags & 1) throw new Error(`Encrypted Office ZIP entry is not supported: ${entry.name}`)

  const view = new DataView(zip.bytes.buffer, zip.bytes.byteOffset, zip.bytes.byteLength)
  if (readUint32(view, entry.localOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Office ZIP local header is invalid for ${entry.name}`)
  }

  const start =
    entry.localOffset + 30 + readUint16(view, entry.localOffset + 26) + readUint16(view, entry.localOffset + 28)
  const compressed = zip.bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return compressed
  if (entry.method === 8) return Bun.inflateSync(compressed as Uint8Array<ArrayBuffer>)
  throw new Error(`Unsupported Office ZIP compression method ${entry.method} for ${entry.name}`)
}

const xmlTagName = (tag: string) => /^<\/?\s*([^\s/>]+)/.exec(tag)?.[1]

const assertXml = (xml: string, partName: string) => {
  const stack: string[] = []
  for (const match of xml.matchAll(/<[^>]+>/g)) {
    const tag = match[0].trim()
    if (tag.startsWith("<?") || tag.startsWith("<!")) continue

    const tagName = xmlTagName(tag)
    if (!tagName) continue
    if (tag.startsWith("</")) {
      const current = stack.pop()
      if (current !== tagName) {
        throw new Error(
          parserError(`${partName}: expected closing tag for ${current ?? "document root"} before ${tagName}`),
        )
      }
      continue
    }
    if (tag.endsWith("/>")) continue
    stack.push(tagName)
  }

  if (stack.length > 0) throw new Error(parserError(`${partName}: unclosed XML tag ${stack.at(-1)}`))
}

const readXml = (zip: ZipFile, name: string) => {
  const entry = readZipEntry(zip, name)
  if (!entry) return undefined
  const xml = decoder.decode(entry)
  assertXml(xml, name)
  return xml
}

const requiredXml = (zip: ZipFile, name: string) => {
  const xml = readXml(zip, name)
  if (!xml) throw new Error(`Office document is missing required XML part: ${name}`)
  return xml
}

const decodeXmlEntities = (value: string) =>
  value.replace(/&(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity) => {
    if (entity === "&amp;") return "&"
    if (entity === "&lt;") return "<"
    if (entity === "&gt;") return ">"
    if (entity === "&quot;") return '"'
    if (entity === "&apos;") return "'"
    if (entity.startsWith("&#x")) {
      const code = Number.parseInt(entity.slice(3, -1), 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    if (entity.startsWith("&#")) {
      const code = Number.parseInt(entity.slice(2, -1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return entity
  })

const cleanLine = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \f\v]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")

const localPattern = (name: string) => `(?:${XML_NAMESPACE})?${name}`

const elements = (xml: string, localName: string) => {
  const matches: XmlPart[] = []
  const matcher = new RegExp(`<(${localPattern(localName)})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "g")
  for (const match of xml.matchAll(matcher)) {
    matches.push({ tag: `<${match[1]}${match[2]}>`, body: match[3] })
  }
  return matches
}

const tags = (xml: string, localName: string) =>
  Array.from(xml.matchAll(new RegExp(`<${localPattern(localName)}\\b[^>]*\\/?>`, "g")), (match) => match[0])

const attributes = (tag: string) =>
  Object.fromEntries(
    Array.from(tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g), (match) => [
      match[1],
      decodeXmlEntities(match[3]),
    ]),
  )

const textRuns = (xml: string, names: string[]) => {
  const matcher = new RegExp(`<((?:${names.map(localPattern).join("|")}))\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "g")
  return Array.from(xml.matchAll(matcher), (match) => decodeXmlEntities(match[2]))
}

const wordText = (xml: string) => {
  const matcher = new RegExp(
    `<((?:${localPattern("t")}|${localPattern("instrText")}|${localPattern("delText")}))\\b[^>]*>([\\s\\S]*?)<\\/\\1>|<${localPattern("tab")}\\b[^>]*\\/?>|<${localPattern("(?:br|cr)")}\\b[^>]*\\/?>`,
    "g",
  )
  const output: string[] = []
  for (const match of xml.matchAll(matcher)) {
    if (match[2] !== undefined) {
      output.push(decodeXmlEntities(match[2]))
      continue
    }
    output.push(/:?(?:br|cr)\b/.test(match[0]) ? "\n" : "\t")
  }
  return cleanLine(output.join(""))
}

const genericXmlText = (xml: string) =>
  cleanLine(
    decodeXmlEntities(
      xml
        .replace(new RegExp(`<${localPattern("tab")}\\b[^>]*\\/?>`, "g"), "\t")
        .replace(new RegExp(`<${localPattern("line-break")}\\b[^>]*\\/?>`, "g"), "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  )

const firstElementText = (xml: string, localName: string) => elements(xml, localName).at(0)?.body

const parseDocx = (zip: ZipFile): ParseResult => {
  const document = requiredXml(zip, "word/document.xml")
  const lines = elements(document, "p")
    .map((part) => wordText(part.body))
    .filter((line) => line.length > 0)

  return {
    format: "docx",
    text: lines.length > 0 ? lines.join("\n") : cleanLine(textRuns(document, ["t"]).join("")),
    metadata: { paragraphs: lines.length },
  }
}

const slideNumber = (name: string) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)

const parsePptx = (zip: ZipFile): ParseResult => {
  const slides = Array.from(zip.entries.keys())
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))

  const lines = slides.flatMap((name) =>
    elements(requiredXml(zip, name), "p")
      .map((part) => cleanLine(textRuns(part.body, ["t"]).join("")))
      .filter((line) => line.length > 0),
  )

  return {
    format: "pptx",
    text: lines.join("\n"),
    metadata: { slides: slides.length },
  }
}

const relationshipTarget = (base: string, target: string) => {
  if (target.startsWith("/")) return target.slice(1)
  return `${base}/${target}`.split("/").reduce((parts, part) => {
    if (!part || part === ".") return parts
    if (part === "..") return parts.slice(0, -1)
    return [...parts, part]
  }, [] as string[]).join("/")
}

const workbookSheets = (zip: ZipFile) => {
  const workbook = requiredXml(zip, "xl/workbook.xml")
  const rels = readXml(zip, "xl/_rels/workbook.xml.rels")
  const relationships = new Map(
    rels
      ? tags(rels, "Relationship").map((tag) => {
          const attrs = attributes(tag)
          return [attrs.Id, relationshipTarget("xl", attrs.Target ?? "")]
        })
      : [],
  )

  return tags(workbook, "sheet").map((tag) => {
    const attrs = attributes(tag)
    return {
      name: attrs.name ?? `Sheet${attrs.sheetId ?? ""}`,
      path: relationships.get(attrs["r:id"]) ?? `xl/worksheets/sheet${attrs.sheetId ?? 1}.xml`,
    }
  })
}

const sharedStrings = (zip: ZipFile) => {
  const xml = readXml(zip, "xl/sharedStrings.xml")
  if (!xml) return []
  return elements(xml, "si").map((part) => cleanLine(textRuns(part.body, ["t"]).join("")))
}

const columnIndex = (reference: string | undefined) => {
  const letters = /^[A-Z]+/i.exec(reference ?? "")?.[0].toUpperCase()
  if (!letters) return undefined
  return Array.from(letters).reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1
}

const cellValue = (body: string, attrs: Record<string, string>, strings: string[]) => {
  const value = firstElementText(body, "v")
  if (attrs.t === "s") return strings[Number(value)] ?? ""
  if (attrs.t === "b") return value === "1" ? "TRUE" : value === "0" ? "FALSE" : ""
  if (attrs.t === "inlineStr") return cleanLine(textRuns(body, ["t"]).join(""))
  if (value !== undefined) return cleanLine(decodeXmlEntities(value))
  return cleanLine(textRuns(body, ["t"]).join(""))
}

const sheetRows = (xml: string, strings: string[]) =>
  elements(xml, "row")
    .map((row) => {
      const values = elements(row.body, "c").reduce((cells, cell) => {
        const attrs = attributes(cell.tag)
        const value = cellValue(cell.body, attrs, strings)
        if (!value) return cells
        const index = columnIndex(attrs.r) ?? cells.length
        return Object.assign(cells, { [index]: value })
      }, [] as string[])
      return values.join("\t").trimEnd()
    })
    .filter((line) => line.trim().length > 0)

const parseXlsx = (zip: ZipFile, sheet: string | undefined): ParseResult => {
  const sheets = workbookSheets(zip)
  const selected = sheet
    ? sheets.filter((item) => item.name.toLowerCase() === sheet.toLowerCase())
    : sheets

  if (selected.length === 0) {
    return {
      format: "xlsx",
      text: `No worksheet matched "${sheet}". Available sheets: ${sheets.map((item) => item.name).join(", ")}`,
      metadata: { sheets: sheets.map((item) => item.name) },
    }
  }

  const strings = sharedStrings(zip)
  return {
    format: "xlsx",
    text: selected
      .flatMap((item) => [`[Sheet: ${item.name}]`, ...sheetRows(requiredXml(zip, item.path), strings)])
      .join("\n"),
    metadata: { sheets: sheets.map((item) => item.name), selected: selected.map((item) => item.name) },
  }
}

const parseOpenDocument = (zip: ZipFile, extension: string): ParseResult => {
  const content = requiredXml(zip, "content.xml")
  const lines = elements(content, "p")
    .map((part) => genericXmlText(part.body))
    .filter((line) => line.length > 0)

  return {
    format: extension,
    text: lines.length > 0 ? lines.join("\n") : genericXmlText(content),
    metadata: { paragraphs: lines.length },
  }
}

const parse = (request: Request): ParseResult => {
  const zip = readZip(request.input)
  if (request.extension === ".docx") return parseDocx(zip)
  if (request.extension === ".pptx") return parsePptx(zip)
  if (request.extension === ".xlsx") return parseXlsx(zip, request.sheet)
  if (request.extension === ".odt" || request.extension === ".ods" || request.extension === ".odp") {
    return parseOpenDocument(zip, request.extension.slice(1))
  }
  throw new Error(`Unsupported Office file type: ${request.extension || "(none)"}`)
}

onmessage = (event) => {
  try {
    postMessage({ ok: true, result: parse(event.data as Request) })
  } catch (error) {
    postMessage({ ok: false, error: formatError(error) })
  }
}
