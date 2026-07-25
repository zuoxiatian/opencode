import { realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import z from "zod"
import type { BrowserParameters } from "@/tool/browser"

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const Manifest = z.object({
  version: z.literal(1),
  entry: z.string().min(1),
  capabilities: z.array(z.literal("browser")).length(1),
}).strict()

export interface Context {
  abort: AbortSignal
  callID?: string
  directory: string
  sessionID: string
  worktree: string
  browser: {
    execute(input: BrowserParameters, options?: { abort?: AbortSignal }): Promise<unknown>
    finalize(): Promise<void>
  }
}

type RuntimeModule = {
  execute(input: unknown, context: Context): Promise<unknown>
}

export function trustedSkillRoot() {
  const value = process.env.OPENCODE_TRUSTED_SKILLS_DIR?.trim()
  return value ? path.resolve(value) : undefined
}

export function trustedSkillsAvailable() {
  return trustedSkillRoot() !== undefined
}

export async function validateLocation(name: string, location: string) {
  if (!skillName.test(name)) throw new Error(`Invalid executable skill name: ${name}`)
  const root = trustedSkillRoot()
  if (!root) throw new Error("Trusted executable skills are not available")

  const rootReal = await realpath(root)
  const directory = await realpath(path.join(rootReal, name))
  ensureWithin(rootReal, directory, "Executable skill directory is outside the trusted skill root")
  const skillFile = await realpath(location)
  if (path.dirname(skillFile) !== directory || path.basename(skillFile) !== "SKILL.md") {
    throw new Error(`Executable skill "${name}" was not loaded from its trusted directory`)
  }
}

export async function execute(name: string, input: unknown, context: Context) {
  if (!skillName.test(name)) throw new Error(`Invalid executable skill name: ${name}`)
  const root = trustedSkillRoot()
  if (!root) throw new Error("Trusted executable skills are not available")

  const rootReal = await realpath(root)
  const directory = await realpath(path.join(rootReal, name))
  ensureWithin(rootReal, directory, "Executable skill directory is outside the trusted skill root")

  const manifestPath = await realpath(path.join(directory, "agents", "opencode.json"))
  ensureWithin(directory, manifestPath, "Executable skill manifest is outside its skill directory")
  const manifest = Manifest.parse(await Bun.file(manifestPath).json())
  const entry = await realpath(path.resolve(directory, manifest.entry))
  ensureWithin(directory, entry, "Executable skill entry is outside its skill directory")

  const imported = await import(pathToFileURL(entry).href) as {
    default?: unknown
    execute?: unknown
  }
  const runtime = runtimeModule(imported.default) ?? runtimeModule(imported)
  if (!runtime) throw new Error(`Executable skill "${name}" must export an execute function`)
  return runtime.execute(input, context)
}

function ensureWithin(parent: string, child: string, message: string) {
  const relative = path.relative(parent, child)
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return
  throw new Error(message)
}

function runtimeModule(input: unknown): RuntimeModule | undefined {
  if (typeof input !== "object" || input === null) return
  const execute = Reflect.get(input, "execute")
  if (typeof execute !== "function") return
  return { execute: (value, context) => Promise.resolve(Reflect.apply(execute, input, [value, context])) }
}
