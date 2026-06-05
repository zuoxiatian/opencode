import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface SkillMarkdownMetadata {
    name?: string
    description?: string
    version?: string
}

export async function readSkillMetadata(skillDir: string) {
    const file = join(skillDir, "SKILL.md")
    if (!existsSync(file)) return {}

    return parseSkillMarkdown(await readFile(file, "utf8"))
}

export function parseSkillMarkdown(markdown: string): SkillMarkdownMetadata {
    return {
        description: frontmatterValue(markdown, "description"),
        name: frontmatterValue(markdown, "name"),
        version: metadataValue(markdown, "version") ?? frontmatterValue(markdown, "version"),
    }
}

function metadataValue(markdown: string, key: string) {
    const lines = frontmatterLines(markdown)
    if (!lines) return undefined

    const metadataIndex = lines.findIndex((item) => item.trim() === "metadata:")
    if (metadataIndex < 0) return undefined

    const afterMetadata = lines.slice(metadataIndex + 1)
    const nextTopLevel = afterMetadata.findIndex((item) => item.trim() && !item.match(/^\s/))
    const prefix = `${key}:`
    const line = (nextTopLevel < 0 ? afterMetadata : afterMetadata.slice(0, nextTopLevel)).find((item) =>
        item.trimStart().startsWith(prefix),
    )
    if (!line) return undefined

    return cleanFrontmatterValue(line.slice(line.indexOf(":") + 1))
}

function frontmatterValue(markdown: string, key: string) {
    const lines = frontmatterLines(markdown)
    if (!lines) return undefined

    const prefix = `${key}:`
    const index = lines.findIndex((item) => !item.match(/^\s/) && item.startsWith(prefix))
    const line = index >= 0 ? lines[index] : undefined
    if (!line) return undefined

    const value = cleanFrontmatterValue(line.slice(line.indexOf(":") + 1))
    if (value !== ">" && value !== "|") return value

    const afterValue = lines.slice(index + 1)
    const nextTopLevel = afterValue.findIndex((item) => item.trim() && !item.match(/^\s/))
    const block = nextTopLevel < 0 ? afterValue : afterValue.slice(0, nextTopLevel)
    const text = block.map((item) => item.trim()).filter(Boolean).join(" ")
    return text || undefined
}

function frontmatterLines(markdown: string) {
    if (!markdown.startsWith("---")) return undefined

    const end = markdown.indexOf("\n---", 3)
    if (end < 0) return undefined

    return markdown.slice(3, end).split(/\r?\n/)
}

function cleanFrontmatterValue(value: string) {
    return value.trim().replace(/^["']|["']$/g, "")
}
