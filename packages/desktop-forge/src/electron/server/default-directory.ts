import { app } from "electron"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

export async function ensureDefaultDirectory() {
    const directory = join(app.getPath("documents"), "LongwiseTechAgent")
    await mkdir(directory, { recursive: true })
    return directory
}
