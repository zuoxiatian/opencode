import path from "node:path"
import { fileURLToPath } from "node:url"

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const repoRoot = path.resolve(packageDir, "../..")
export const opencodeDir = path.join(repoRoot, "packages", "opencode")
export const runtimeRoot = path.join(packageDir, "runtimes")
export const bun = process.env.BUN_PATH ?? "bun"

export function relativeRepo(file: string) {
  return path.relative(repoRoot, file)
}
