import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

export async function signingEnv(packageDir: string) {
    return normalizeSigningEnv({
        ...(await readLocalEnv(process.env.OPENCODE_DESKTOP_SIGNING_ENV ?? path.join(packageDir, "signing.local.env"), packageDir)),
        ...process.env,
    })
}

async function readLocalEnv(file: string, packageDir: string): Promise<NodeJS.ProcessEnv> {
    if (!existsSync(file)) return {}

    console.log(`Loading local signing config: ${path.relative(packageDir, file)}`)

    return Object.fromEntries(
        (await readFile(file, "utf8"))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"))
            .map((line) => parseLine(line.replace(/^export\s+/, ""))),
    )
}

function parseLine(line: string): [string, string] {
    const separator = line.indexOf("=")
    if (separator < 1) throw new Error(`Invalid signing config line: ${line}`)

    return [
        line.slice(0, separator).trim(),
        unquote(line.slice(separator + 1).trim()),
    ]
}

function normalizeSigningEnv(env: NodeJS.ProcessEnv) {
    if (!env.CSC_NAME) return env

    return {
        ...env,
        CSC_NAME: trimCertificatePrefix(env.CSC_NAME),
    }
}

function trimCertificatePrefix(value: string) {
    const prefix = "Developer ID Application:"
    if (!value.startsWith(prefix)) return value

    console.log("Removing Developer ID Application prefix from CSC_NAME for electron-builder")
    return value.slice(prefix.length).trim()
}

function unquote(value: string) {
    if (value.length < 2) return value
    if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return value
}
