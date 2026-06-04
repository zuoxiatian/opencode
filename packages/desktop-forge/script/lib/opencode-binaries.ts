import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { opencodeDir, packageDir, relativeRepo } from "./paths.ts"
import type { RuntimeTargetId } from "./targets.ts"

type OpencodeBinary = {
  destination: string
  executable?: boolean
  id: RuntimeTargetId
  source: string
}

const opencodeBinaries = [
  {
    id: "win32-x64",
    destination: path.join(packageDir, "bin", "opencode.exe"),
    executable: false,
    source: path.join(opencodeDir, "dist", "opencode-windows-x64", "bin", "opencode.exe"),
  },
  {
    id: "darwin-arm64",
    destination: path.join(packageDir, "bin", "mac", "arm64", "opencode"),
    executable: true,
    source: path.join(opencodeDir, "dist", "opencode-darwin-arm64", "bin", "opencode"),
  },
  {
    id: "darwin-x64",
    destination: path.join(packageDir, "bin", "mac", "x64", "opencode"),
    executable: true,
    source: path.join(opencodeDir, "dist", "opencode-darwin-x64", "bin", "opencode"),
  },
  {
    id: "linux-x64",
    destination: path.join(packageDir, "bin", "linux", "x64", "opencode"),
    executable: true,
    source: path.join(opencodeDir, "dist", "opencode-linux-x64", "bin", "opencode"),
  },
] as const satisfies readonly OpencodeBinary[]

export async function copyOpencodeBinaries(ids: readonly RuntimeTargetId[], reuseExistingBin: boolean) {
  await Promise.all(
    opencodeBinaries
      .filter((binary) => ids.includes(binary.id))
      .map(async (binary) => {
        if (!existsSync(binary.source)) {
          if (reuseExistingBin && existsSync(binary.destination)) {
            if (binary.executable) await chmod(binary.destination, 0o755)
            console.log(`Reusing ${relativeRepo(binary.destination)}`)
            return
          }

          throw new Error(`Missing opencode binary: ${binary.source}`)
        }

        await mkdir(path.dirname(binary.destination), { recursive: true })
        await copyFile(binary.source, binary.destination)
        if (binary.executable) await chmod(binary.destination, 0o755)
        console.log(`Copied ${relativeRepo(binary.source)} -> ${relativeRepo(binary.destination)}`)
      }),
  )
}
