import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import manifest from "../../resources/agent-browser/manifest.json"
import { bun, packageDir, relativeRepo } from "./paths.ts"
import { run } from "./run.ts"
import type { RuntimeTargetId } from "./targets.ts"

type Artifact = {
  file: string
  sha256: string
}

export async function prepareAgentBrowser(ids: readonly RuntimeTargetId[]) {
  const artifacts = ids.map((id) => ({
    artifact: manifest.artifacts[id],
    id,
  }))
  const providerSourceSha256 = digest(
    await readFile(path.join(packageDir, "script", "agent-browser-provider.ts")),
  )
  if (await prepared(artifacts, providerSourceSha256)) return

  const response = await fetch(manifest.npm.url)
  if (!response.ok) throw new Error(`Unable to download agent-browser ${manifest.version}: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  verify(archive, manifest.npm.sha256, "agent-browser npm archive")
  const tar = gunzipSync(archive)
  await mkdir(path.join(packageDir, "resources", "agent-browser", ".prepared"), {
    recursive: true,
  })

    await Promise.all(artifacts.map(async (input) => {
        const binary = tarEntry(tar, `package/bin/${input.artifact.file}`)
        verify(binary, input.artifact.sha256, `agent-browser ${input.id}`)
        const directory = path.join(packageDir, "resources", "agent-browser", input.id)
        const executable = input.id === "win32-x64" ? "agent-browser.exe" : "agent-browser"
        const executablePath = path.join(directory, executable)
        const provider = path.join(
          directory,
          input.id === "win32-x64"
            ? "desktop-forge-agent-browser-provider.exe"
            : "desktop-forge-agent-browser-provider",
        )
        await mkdir(directory, { recursive: true })
        if (
          !existsSync(executablePath)
          || digest(await readFile(executablePath)) !== input.artifact.sha256
        ) {
          await writeFile(executablePath, binary, { mode: 0o755 })
        }
        await run([
      bun,
      "build",
      "--compile",
          "--target",
          bunTarget(input.id),
          ...providerBuildFlags(input.id),
          "--outfile",
          provider,
          path.join(packageDir, "script", "agent-browser-provider.ts"),
        ], { cwd: packageDir })
        if (input.id === "win32-x64") await setWindowsGuiSubsystem(provider)
        if (process.platform === "darwin" && input.id.startsWith("darwin-")) {
      await run([
        "codesign",
            "--force",
            "--sign",
            "-",
            provider,
          ])
        }
        if (input.id !== "win32-x64") {
          await Promise.all([
            chmod(executablePath, 0o755),
            chmod(provider, 0o755),
          ])
        }
        await writeFile(
      path.join(
        packageDir,
        "resources",
        "agent-browser",
        ".prepared",
        `${input.id}.json`,
      ),
      `${JSON.stringify({
        providerSha256: digest(await readFile(provider)),
        ...providerBuildFingerprint(input.id),
        providerSourceSha256,
        version: manifest.version,
      }, null, 2)}\n`,
    )
    console.log(`Prepared ${relativeRepo(directory)}`)
  }))
}

async function prepared(
  inputs: Array<{ artifact: Artifact; id: RuntimeTargetId }>,
  providerSourceSha256: string,
) {
  const valid = await Promise.all(inputs.map(async (input) => {
    const directory = path.join(packageDir, "resources", "agent-browser", input.id)
    const executable = path.join(
      directory,
      input.id === "win32-x64" ? "agent-browser.exe" : "agent-browser",
    )
    const provider = path.join(
      directory,
      input.id === "win32-x64"
        ? "desktop-forge-agent-browser-provider.exe"
        : "desktop-forge-agent-browser-provider",
    )
    if (!existsSync(executable) || !existsSync(provider)) return false
    const fingerprint = await readFile(
      path.join(
        packageDir,
        "resources",
        "agent-browser",
        ".prepared",
        `${input.id}.json`,
      ),
      "utf8",
    ).then((value) => JSON.parse(value) as Record<string, unknown>)
      .catch(() => undefined)
    return digest(await readFile(executable)) === input.artifact.sha256
      && fingerprint?.version === manifest.version
      && fingerprint.providerSourceSha256 === providerSourceSha256
      && (!providerBuildFingerprint(input.id).providerBuild
        || fingerprint.providerBuild === providerBuildFingerprint(input.id).providerBuild)
      && typeof fingerprint.providerSha256 === "string"
      && digest(await readFile(provider)) === fingerprint.providerSha256
  }))
  return valid.every(Boolean)
}

function tarEntry(archive: Buffer, expected: string) {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = tarString(header.subarray(0, 100))
    const prefix = tarString(header.subarray(345, 500))
    const file = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(tarString(header.subarray(124, 136)).trim() || "0", 8)
    const start = offset + 512
    if (file === expected) return archive.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
  }
  throw new Error(`agent-browser archive is missing ${expected}`)
}

export function providerBuildFlags(id: RuntimeTargetId, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32" && id === "win32-x64") return ["--windows-hide-console"]
  return []
}

function providerBuildFingerprint(id: RuntimeTargetId) {
  if (id === "win32-x64") return { providerBuild: "windows-gui-subsystem" }
  return {}
}

async function setWindowsGuiSubsystem(file: string) {
  const binary = await readFile(file)
  const peOffset = binary.readUInt32LE(0x3c)
  const subsystemOffset = peOffset + 24 + 68
  const subsystem = binary.readUInt16LE(subsystemOffset)
  if (binary.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`${path.basename(file)} is not a PE executable`)
  }
  if (subsystem === 2) return
  if (subsystem !== 3) {
    throw new Error(`${path.basename(file)} has unsupported Windows subsystem ${subsystem}`)
  }
  binary.writeUInt16LE(2, subsystemOffset)
  await writeFile(file, binary)
}

function tarString(value: Buffer) {
  const end = value.indexOf(0)
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8")
}

function verify(value: Uint8Array, expected: string, label: string) {
  const actual = digest(value)
  if (actual !== expected) throw new Error(`${label} checksum mismatch: expected ${expected}, received ${actual}`)
}

function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function bunTarget(id: RuntimeTargetId) {
  if (id === "win32-x64") return "bun-windows-x64"
  return `bun-${id}`
}
