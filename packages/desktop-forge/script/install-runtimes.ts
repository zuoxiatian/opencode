import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runtimeRoot } from "./lib/paths.ts"
import { capture, run } from "./lib/run.ts"
import { runtimeTargetById, runtimeTargets, type RuntimeTarget } from "./lib/targets.ts"

type Download = {
  archive: string
  expectedSha256: string | undefined
  url: string
  version: string
}

type FfmpegExecutable = "ffmpeg" | "ffprobe"

type FfmpegDownload = Download & {
  executables: FfmpegExecutable[]
}

type FfmpegInstall = {
  archives: string[]
  build: string
  version: string
}

type GitHubReleaseAsset = {
  browser_download_url: string
  digest?: string | null
  name: string
}

type GitHubRelease = {
  assets: GitHubReleaseAsset[]
}

type RuntimeMetadata = {
  ffmpegArchives?: string[]
  ffmpegBuild?: string
  ffmpegVersion?: string
  nodeArchive?: string
  nodeVersion?: string
  pythonArchive?: string
  pythonRequestedVersion?: string
  pythonStandaloneRelease?: string
  pythonVersion?: string
  target: string
}

type PythonRuntimeInfo = {
  paths: Record<string, string>
  version: string
}

const nodeVersion = process.env.OPENCODE_DESKTOP_NODE_VERSION ?? "22.22.3"
const pythonVersion = process.env.OPENCODE_DESKTOP_PYTHON_VERSION ?? "3.14.5"
const pythonStandaloneRelease = process.env.OPENCODE_DESKTOP_PYTHON_STANDALONE_RELEASE ?? "20260510"
const ffmpegRelease = process.env.OPENCODE_DESKTOP_FFMPEG_RELEASE ?? "n8.1"
const ffmpegBuild = process.env.OPENCODE_DESKTOP_FFMPEG_BUILD ?? "lgpl-shared"
const args = process.argv.slice(2)
const options = {
  all: args.includes("--all"),
  ffmpegOnly: args.includes("--ffmpeg-only"),
  help: args.includes("--help") || args.includes("-h"),
  installCrossPackages: args.includes("--install-cross-packages"),
  nodeOnly: args.includes("--node-only"),
  pythonOnly: args.includes("--python-only"),
  skipFfmpeg: args.includes("--skip-ffmpeg") || process.env.OPENCODE_DESKTOP_SKIP_FFMPEG === "1",
}

if ([options.nodeOnly, options.pythonOnly, options.ffmpegOnly].filter(Boolean).length > 1) {
  throw new Error("Use only one of --node-only, --python-only, or --ffmpeg-only")
}

if (options.help) {
  console.log([
    "Usage: bun run runtime:install -- [targets...] [options]",
    "",
    "Targets:",
    "  darwin-arm64 darwin-x64 win32-x64 linux-x64",
    "  Defaults to every supported target when no target is provided.",
    "",
    "Options:",
    "  --all                     Install every supported target, same as no targets",
    "  --ffmpeg-only             Install FFmpeg only",
    "  --node-only               Install Node.js only",
    "  --python-only             Install Python only",
    "  --install-cross-packages  On Apple Silicon, run darwin-x64 Python through Rosetta",
    "  --skip-ffmpeg             Do not install bundled FFmpeg",
    "",
    "Version overrides:",
    "  OPENCODE_DESKTOP_NODE_VERSION",
    "  OPENCODE_DESKTOP_PYTHON_VERSION",
    "  OPENCODE_DESKTOP_PYTHON_STANDALONE_RELEASE",
    "  OPENCODE_DESKTOP_FFMPEG_RELEASE",
    "  OPENCODE_DESKTOP_FFMPEG_BUILD",
    "  OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFMPEG_URL",
    "  OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFPROBE_URL",
  ].join("\n"))
  process.exit(0)
}

const requestedTargetIds = args.flatMap((arg) => {
  if (arg.startsWith("--target=")) return [arg.slice("--target=".length)]
  if (arg.startsWith("--")) return []
  return [arg]
})
const selectedTargets = options.all
  ? runtimeTargets
  : requestedTargetIds.length
    ? requestedTargetIds.map((id) => {
        const target = runtimeTargetById(id)
        if (!target) throw new Error(`Unknown runtime target: ${id}`)
        return target
      })
    : runtimeTargets

if (!selectedTargets.length) {
  throw new Error("No runtime targets selected")
}

await rm(path.join(runtimeRoot, ".download"), { force: true, recursive: true })
await mkdir(runtimeRoot, { recursive: true })
await Promise.all(selectedTargets.map((target) => installTarget(target)))

async function installTarget(target: RuntimeTarget) {
  const targetDir = path.join(runtimeRoot, target.id)
  const scratchDir = await mkdtemp(path.join(tmpdir(), `desktop-forge-runtime-${target.id}-`))
  const metadata = await readRuntimeMetadata(targetDir)
  const nextMetadata: RuntimeMetadata = {
    ...metadata,
    target: target.id,
  }

  await mkdir(targetDir, { recursive: true })

  console.log(`Installing runtime: ${target.id}`)

  try {
    if (shouldInstallNode()) {
      const existing = await currentNodeVersion(target, targetDir, metadata)
      if (existing) {
        console.log(`Node.js ${nodeVersion} already installed for ${target.id}; skipping download.`)
        nextMetadata.nodeArchive = metadata?.nodeArchive ?? nodeArchiveName(target)
        nextMetadata.nodeVersion = existing
      } else {
        const download = await installNode(target, targetDir, path.join(scratchDir, "node"))
        nextMetadata.nodeArchive = download.archive
        nextMetadata.nodeVersion = download.version
      }
    }

    if (shouldInstallPython()) {
      const existing = await currentPythonVersion(target, targetDir, metadata)
      if (existing) {
        console.log(`Python ${existing} already installed for ${target.id}; skipping download.`)
        nextMetadata.pythonArchive = metadata?.pythonArchive
        nextMetadata.pythonRequestedVersion = pythonVersion
        nextMetadata.pythonStandaloneRelease = pythonStandaloneRelease
        nextMetadata.pythonVersion = existing
      } else {
        const download = await installPython(target, targetDir, path.join(scratchDir, "python"))
        nextMetadata.pythonArchive = download.archive
        nextMetadata.pythonRequestedVersion = pythonVersion
        nextMetadata.pythonStandaloneRelease = pythonStandaloneRelease
        nextMetadata.pythonVersion = download.version
      }
    }

    if (shouldInstallFfmpeg()) {
      const existing = await currentFfmpegVersion(target, targetDir, metadata)
      if (existing) {
        console.log(`FFmpeg ${existing} already installed for ${target.id}; skipping download.`)
        nextMetadata.ffmpegArchives = metadata?.ffmpegArchives
        nextMetadata.ffmpegBuild = ffmpegBuildKey(target)
        nextMetadata.ffmpegVersion = existing
      } else {
        const install = await installFfmpeg(target, targetDir, path.join(scratchDir, "ffmpeg"))
        if (install) {
          nextMetadata.ffmpegArchives = install.archives
          nextMetadata.ffmpegBuild = install.build
          nextMetadata.ffmpegVersion = install.version
        }
      }
    }

    await writeLaunchers(target, targetDir)
    await verifyRuntime(target, targetDir)
    await writeRuntimeMetadata(targetDir, nextMetadata)
  } finally {
    await rm(scratchDir, { force: true, recursive: true })
  }
}

function shouldInstallNode() {
  return !options.pythonOnly && !options.ffmpegOnly
}

function shouldInstallPython() {
  return !options.nodeOnly && !options.ffmpegOnly
}

function shouldInstallFfmpeg() {
  return !options.nodeOnly && !options.pythonOnly && !options.skipFfmpeg
}

async function readRuntimeMetadata(targetDir: string) {
  if (!existsSync(runtimeMetadataPath(targetDir))) return undefined

  const value = await readFile(runtimeMetadataPath(targetDir), "utf8")
    .then(parseJson)
    .catch(() => undefined)
  if (isRuntimeMetadata(value)) return value
  return undefined
}

async function writeRuntimeMetadata(targetDir: string, metadata: RuntimeMetadata) {
  await writeFile(runtimeMetadataPath(targetDir), `${JSON.stringify(metadata, undefined, 2)}\n`)
}

function runtimeMetadataPath(targetDir: string) {
  return path.join(targetDir, ".runtime.json")
}

function isRuntimeMetadata(value: unknown): value is RuntimeMetadata {
  return !!value && typeof value === "object" && "target" in value && typeof value.target === "string"
}

async function currentNodeVersion(target: RuntimeTarget, targetDir: string, metadata: RuntimeMetadata | undefined) {
  if (!existsSync(nodeExecutable(target, targetDir))) return undefined
  if (metadata?.target === target.id && metadata.nodeVersion === nodeVersion) return metadata.nodeVersion

  const prefix = commandPrefix(target)
  if (!prefix) return undefined

  return await capture([...prefix, nodeExecutable(target, targetDir), "--version"]).then((version) => {
    if (version === `v${nodeVersion}`) return nodeVersion
    return undefined
  })
}

async function currentPythonVersion(target: RuntimeTarget, targetDir: string, metadata: RuntimeMetadata | undefined) {
  if (!existsSync(pythonExecutable(target, targetDir))) return undefined

  if (
    metadata?.target === target.id &&
    metadata.pythonRequestedVersion === pythonVersion &&
    metadata.pythonStandaloneRelease === pythonStandaloneRelease &&
    metadata.pythonVersion &&
    samePythonMinor(metadata.pythonVersion, pythonVersion)
  ) {
    return metadata.pythonVersion
  }

  const prefix = commandPrefix(target)
  if (!prefix) return undefined

  const info = await capture(
    [
      ...prefix,
      pythonExecutable(target, targetDir),
      "-c",
      "import json, sys, sysconfig; print(json.dumps({'version': f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}', 'paths': sysconfig.get_paths()}))",
    ],
    pythonEnv(targetDir),
  )
    .then((text) => (text ? parseJson(text) : undefined))
    .catch(() => undefined)

  if (!isPythonRuntimeInfo(info)) return undefined
  if (!samePythonMinor(info.version, pythonVersion)) return undefined

  if (JSON.stringify(info.paths).includes("/opt/homebrew") || JSON.stringify(info.paths).includes("/usr/local/Cellar")) {
    return undefined
  }

  return info.version
}

async function currentFfmpegVersion(target: RuntimeTarget, targetDir: string, metadata: RuntimeMetadata | undefined) {
  if (!ffmpegSupported(target)) return undefined
  if (!existsSync(ffmpegExecutable(target, targetDir, "ffmpeg"))) return undefined
  if (!existsSync(ffmpegExecutable(target, targetDir, "ffprobe"))) return undefined
  if (metadata?.target === target.id && metadata.ffmpegBuild === ffmpegBuildKey(target) && metadata.ffmpegVersion) {
    return metadata.ffmpegVersion
  }
  if (metadata?.target === target.id && metadata.ffmpegBuild) return undefined

  const prefix = commandPrefix(target)
  if (!prefix) return undefined

  return await capture([...prefix, ffmpegExecutable(target, targetDir, "ffmpeg"), "-version"])
    .then((text) => text?.match(/^ffmpeg version\s+([^\s]+)/)?.[1])
    .catch(() => undefined)
}

function isPythonRuntimeInfo(value: unknown): value is PythonRuntimeInfo {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    isRecord(value.paths) &&
    Object.values(value.paths).every((item) => typeof item === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  return isRecord(value) && Array.isArray(value.assets) && value.assets.every(isGitHubReleaseAsset)
}

function isGitHubReleaseAsset(value: unknown): value is GitHubReleaseAsset {
  return (
    isRecord(value) &&
    typeof value.browser_download_url === "string" &&
    typeof value.name === "string" &&
    (value.digest === undefined || value.digest === null || typeof value.digest === "string")
  )
}

async function installNode(target: RuntimeTarget, targetDir: string, scratchDir: string) {
  const download = await resolveNodeDownload(target)
  const archive = path.join(scratchDir, download.archive)
  const extracted = path.join(scratchDir, "extracted")

  await mkdir(extracted, { recursive: true })
  await downloadFile(download, archive)
  await extractArchive(archive, extracted)

  const source = await findDirectory(
    extracted,
    (dir) => existsSync(target.windows ? path.join(dir, "node.exe") : path.join(dir, "bin", "node")),
    4,
  )

  if (!source) throw new Error(`Could not find Node.js executable in ${download.archive}`)

  await replaceDirectory(source, path.join(targetDir, "node"))
  return download
}

async function installPython(target: RuntimeTarget, targetDir: string, scratchDir: string) {
  const download = await resolvePythonDownload(target)
  const archive = path.join(scratchDir, download.archive)
  const extracted = path.join(scratchDir, "extracted")

  await mkdir(extracted, { recursive: true })
  await downloadFile(download, archive)
  await extractArchive(archive, extracted)

  const source = await findDirectory(
    extracted,
    (dir) => existsSync(target.windows ? path.join(dir, "python.exe") : path.join(dir, "bin", "python3")),
    5,
  )

  if (!source) throw new Error(`Could not find Python executable in ${download.archive}`)

  await replaceDirectory(source, path.join(targetDir, "python"))
  return download
}

async function installFfmpeg(target: RuntimeTarget, targetDir: string, scratchDir: string): Promise<FfmpegInstall | undefined> {
  const downloads = await resolveFfmpegDownloads(target)
  if (!downloads) {
    console.log(`Skipping bundled FFmpeg for ${target.id}.`)
    return undefined
  }

  const binDir = path.join(targetDir, "bin")
  await mkdir(binDir, { recursive: true })
  await rm(path.join(targetDir, "ffmpeg"), { force: true, recursive: true })

  await Promise.all(
    downloads.map(async (download) => {
      const archive = path.join(scratchDir, "archives", download.archive)
      const extracted = path.join(scratchDir, "extracted", download.archive.replace(/[^a-zA-Z0-9._-]/g, "-"))

      await mkdir(extracted, { recursive: true })
      await mkdir(path.dirname(archive), { recursive: true })
      await downloadFile(download, archive)
      await extractArchive(archive, extracted)

      await Promise.all(
        download.executables.map(async (executable) => {
          const source = await findFile(extracted, ffmpegFilename(target, executable), 6)
          if (!source) throw new Error(`Could not find ${ffmpegFilename(target, executable)} in ${download.archive}`)

          const destination = path.join(binDir, ffmpegFilename(target, executable))
          await copyFile(source, destination)
          if (target.windows && executable === download.executables[0]) await copyWindowsDynamicLibraries(path.dirname(source), binDir)
          if (!target.windows) await chmod(destination, 0o755)
        }),
      )
    }),
  )

  return {
    archives: downloads.map((download) => download.archive),
    build: ffmpegBuildKey(target),
    version: downloads.map((download) => download.version).join("+"),
  }
}

async function resolveNodeDownload(target: RuntimeTarget): Promise<Download> {
  const archive = nodeArchiveName(target)
  const shasums = await fetchText(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)
  const line = shasums.split("\n").find((item) => item.trim().endsWith(` ${archive}`))

  if (!line) throw new Error(`Could not find ${archive} in Node.js SHASUMS256.txt`)

  return {
    archive,
    expectedSha256: line.trim().split(/\s+/)[0],
    url: `https://nodejs.org/dist/v${nodeVersion}/${archive}`,
    version: nodeVersion,
  }
}

function nodeArchiveName(target: RuntimeTarget) {
  return `node-v${nodeVersion}-${target.nodePlatform}.${target.windows ? "zip" : "tar.gz"}`
}

async function resolvePythonDownload(target: RuntimeTarget): Promise<Download> {
  const archives = [
    `cpython-${pythonVersion}+${pythonStandaloneRelease}-${target.pythonPlatform}-install_only_stripped.tar.gz`,
    ...(target.windows
      ? [`cpython-${pythonVersion}+${pythonStandaloneRelease}-${target.pythonPlatform}-shared-install_only_stripped.tar.gz`]
      : []),
  ]
  const release = await fetchJson(
    `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${pythonStandaloneRelease}`,
  )
  if (!isGitHubRelease(release)) {
    throw new Error(`Invalid python-build-standalone release response for ${pythonStandaloneRelease}`)
  }

  const exactAsset = release.assets.find((item) => archives.includes(item.name))
  const asset =
    exactAsset ??
    release.assets
      .map((item) => ({
        asset: item,
        version: pythonAssetVersion(item.name, target),
      }))
      .filter((item): item is { asset: GitHubRelease["assets"][number]; version: string } => {
        return !!item.version && samePythonMinor(item.version, pythonVersion)
      })
      .sort((a, b) => compareVersions(b.version, a.version))[0]?.asset

  if (!asset) {
    throw new Error(
      `Could not find ${archives.join(" or ")} or another Python ${pythonMinor(pythonVersion)} asset in python-build-standalone ${pythonStandaloneRelease}`,
    )
  }

  if (!exactAsset) {
    console.log(`Python ${pythonVersion} asset not found; using ${asset.name}.`)
  }

  return {
    archive: asset.name,
    expectedSha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : undefined,
    url: asset.browser_download_url,
    version: pythonAssetVersion(asset.name, target) ?? pythonVersion,
  }
}

async function resolveFfmpegDownloads(target: RuntimeTarget): Promise<FfmpegDownload[] | undefined> {
  if (target.id === "linux-x64") return undefined
  if (target.windows) return [await resolveBtbNFfmpegDownload(target)]
  if (target.id === "darwin-x64") {
    return [
      directFfmpegDownload(target, "ffmpeg", "OPENCODE_DESKTOP_FFMPEG_DARWIN_X64_FFMPEG", "https://evermeet.cx/ffmpeg/getrelease/zip"),
      directFfmpegDownload(target, "ffprobe", "OPENCODE_DESKTOP_FFMPEG_DARWIN_X64_FFPROBE", "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"),
    ]
  }

  if (target.id === "darwin-arm64") {
    const downloads = [
      directFfmpegDownload(target, "ffmpeg", "OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFMPEG"),
      directFfmpegDownload(target, "ffprobe", "OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFPROBE"),
    ]
    if (downloads.every((download) => download.url)) return downloads
    throw new Error(
      [
        "Bundled FFmpeg for darwin-arm64 requires explicit download URLs.",
        "Set OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFMPEG_URL and OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFPROBE_URL.",
      ].join(" "),
    )
  }

  return undefined
}

async function resolveBtbNFfmpegDownload(target: RuntimeTarget): Promise<FfmpegDownload> {
  const release = await fetchJson("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest")
  if (!isGitHubRelease(release)) throw new Error("Invalid BtbN FFmpeg release response")

  const platform = target.windows ? "win64" : undefined
  if (!platform) throw new Error(`No BtbN FFmpeg platform configured for ${target.id}`)

  const asset = release.assets.find((item) =>
    new RegExp(`^ffmpeg-${escapeRegex(ffmpegRelease)}-latest-${platform}-${escapeRegex(ffmpegBuild)}(?:-[0-9.]+)?\\.zip$`).test(item.name),
  )
  if (!asset) throw new Error(`Could not find BtbN FFmpeg asset for ${target.id}: ${ffmpegRelease} ${ffmpegBuild}`)

  return {
    archive: asset.name,
    expectedSha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : undefined,
    executables: ["ffmpeg", "ffprobe"],
    url: asset.browser_download_url,
    version: asset.name,
  }
}

function directFfmpegDownload(
  target: RuntimeTarget,
  executable: FfmpegExecutable,
  envPrefix: string,
  defaultUrl?: string,
): FfmpegDownload {
  const url = process.env[`${envPrefix}_URL`] ?? defaultUrl ?? ""
  return {
    archive: process.env[`${envPrefix}_ARCHIVE`] ?? `${executable}-${target.id}.zip`,
    expectedSha256: process.env[`${envPrefix}_SHA256`],
    executables: [executable],
    url,
    version: process.env[`${envPrefix}_VERSION`] ?? (path.basename(url) || "custom"),
  }
}

function pythonAssetVersion(name: string, target: RuntimeTarget) {
  return name.match(
    new RegExp(
      `^cpython-(\\d+\\.\\d+\\.\\d+)\\+${escapeRegex(pythonStandaloneRelease)}-${escapeRegex(target.pythonPlatform)}-(?:shared-)?install_only_stripped\\.tar\\.gz$`,
    ),
  )?.[1]
}

function pythonMinor(version: string) {
  return version.split(".").slice(0, 2).join(".")
}

function samePythonMinor(left: string, right: string) {
  return pythonMinor(left) === pythonMinor(right)
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)

  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function downloadFile(download: Download, destination: string) {
  console.log(`Downloading ${download.archive}`)

  const response = await fetch(download.url, {
    headers: {
      "User-Agent": "opencode-desktop-runtime-installer",
    },
  })

  if (!response.ok) throw new Error(`Download failed ${response.status}: ${download.url}`)

  const bytes = new Uint8Array(await response.arrayBuffer())
  const sha256 = createHash("sha256").update(bytes).digest("hex")

  if (download.expectedSha256 && sha256 !== download.expectedSha256) {
    throw new Error(`Checksum mismatch for ${download.archive}: expected ${download.expectedSha256}, got ${sha256}`)
  }

  await writeFile(destination, bytes)
}

async function extractArchive(archive: string, destination: string) {
  await run(["tar", archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", destination])
}

async function findDirectory(root: string, predicate: (dir: string) => boolean, depth: number): Promise<string | undefined> {
  if (predicate(root)) return root
  if (depth <= 0) return undefined

  const matches = await Promise.all(
    (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => findDirectory(path.join(root, entry.name), predicate, depth - 1)),
  )

  return matches.find((match): match is string => !!match)
}

async function findFile(root: string, name: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined

  const entries = await readdir(root, { withFileTypes: true })
  const direct = entries.find((entry) => entry.isFile() && entry.name === name)
  if (direct) return path.join(root, direct.name)

  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => findFile(path.join(root, entry.name), name, depth - 1)),
  )

  return matches.find((match): match is string => !!match)
}

async function replaceDirectory(source: string, destination: string) {
  await rm(destination, { force: true, recursive: true })
  await rename(source, destination).catch(async (error: unknown) => {
    if (!isNodeError(error, "EXDEV")) throw error
    await cp(source, destination, {
      force: true,
      recursive: true,
      verbatimSymlinks: true,
    })
    await rm(source, { force: true, recursive: true })
  })
}

function isNodeError(error: unknown, code: string) {
  return !!error && typeof error === "object" && "code" in error && error.code === code
}

async function copyWindowsDynamicLibraries(sourceDir: string, binDir: string) {
  await Promise.all(
    (await readdir(sourceDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".dll")
      .map((entry) => copyFile(path.join(sourceDir, entry.name), path.join(binDir, entry.name))),
  )
}

async function writeLaunchers(target: RuntimeTarget, targetDir: string) {
  const binDir = path.join(targetDir, "bin")
  await mkdir(binDir, { recursive: true })

  if (target.windows) {
    await writeFile(path.join(binDir, "node.cmd"), '@echo off\r\n"%~dp0..\\node\\node.exe" %*\r\n')
    await writeFile(path.join(binDir, "python.cmd"), windowsPythonLauncher('"%RUNTIME_DIR%\\python\\python.exe" %*\r\n'))
    await writeFile(path.join(binDir, "python3.cmd"), windowsPythonLauncher('"%RUNTIME_DIR%\\python\\python.exe" %*\r\n'))
    await writeFile(path.join(binDir, "pip.cmd"), windowsPythonLauncher('"%RUNTIME_DIR%\\python\\python.exe" -m pip %*\r\n'))
    return
  }

  await writeExecutable(
    path.join(binDir, "node"),
    '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$DIR/node/bin/node" "$@"\n',
  )
  await writeExecutable(path.join(binDir, "python"), unixPythonLauncher('exec "$PY" "$@"\n'))
  await writeExecutable(path.join(binDir, "python3"), unixPythonLauncher('exec "$PY" "$@"\n'))
  await writeExecutable(path.join(binDir, "pip"), unixPythonLauncher('exec "$PY" -m pip "$@"\n'))
}

function windowsPythonLauncher(command: string) {
  return [
    "@echo off\r\n",
    'for %%I in ("%~dp0..") do set "RUNTIME_DIR=%%~fI"\r\n',
    'set "PYTHONHOME=%RUNTIME_DIR%\\python"\r\n',
    'set "PYTHONPATH="\r\n',
    'set "PYTHONNOUSERSITE=1"\r\n',
    command,
  ].join("")
}

function unixPythonLauncher(command: string) {
  return [
    "#!/usr/bin/env sh\n",
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\n',
    'export PYTHONHOME="$DIR/python"\n',
    "export PYTHONPATH=\n",
    "export PYTHONNOUSERSITE=1\n",
    'PY="$DIR/python/bin/python3"\n',
    '[ -x "$PY" ] || PY="$DIR/python/bin/python"\n',
    command,
  ].join("")
}

async function writeExecutable(file: string, content: string) {
  await writeFile(file, content)
  await chmod(file, 0o755)
}

async function verifyRuntime(target: RuntimeTarget, targetDir: string) {
  const prefix = commandPrefix(target)

  if (!prefix) {
    console.log(`Skipping runtime verification for ${target.id}; it is not executable on this host.`)
    return
  }

  if (shouldInstallNode()) {
    await run([...prefix, nodeExecutable(target, targetDir), "--version"])
  }

  if (shouldInstallPython()) {
    await run(
      [
        ...prefix,
        pythonExecutable(target, targetDir),
        "-c",
        "import json, sysconfig; paths=sysconfig.get_paths(); text=json.dumps(paths); print(text); assert '/opt/homebrew' not in text and '/usr/local/Cellar' not in text",
      ],
      { env: pythonEnv(targetDir) },
    )
  }

  if (shouldInstallFfmpeg() && ffmpegSupported(target)) {
    await run([...prefix, ffmpegExecutable(target, targetDir, "ffmpeg"), "-version"])
    await run([...prefix, ffmpegExecutable(target, targetDir, "ffprobe"), "-version"])
  }
}

function commandPrefix(target: RuntimeTarget) {
  if (target.id === `${process.platform}-${process.arch}`) return []
  if (
    options.installCrossPackages &&
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    target.id === "darwin-x64"
  ) {
    return ["/usr/bin/arch", "-x86_64"]
  }
  return undefined
}

function nodeExecutable(target: RuntimeTarget, targetDir: string) {
  if (target.windows) return path.join(targetDir, "node", "node.exe")
  return path.join(targetDir, "node", "bin", "node")
}

function pythonExecutable(target: RuntimeTarget, targetDir: string) {
  if (target.windows) return path.join(targetDir, "python", "python.exe")
  return path.join(targetDir, "python", "bin", "python3")
}

function ffmpegExecutable(target: RuntimeTarget, targetDir: string, executable: FfmpegExecutable) {
  return path.join(targetDir, "bin", ffmpegFilename(target, executable))
}

function ffmpegFilename(target: RuntimeTarget, executable: FfmpegExecutable) {
  return target.windows ? `${executable}.exe` : executable
}

function ffmpegSupported(target: RuntimeTarget) {
  return target.id !== "linux-x64"
}

function ffmpegBuildKey(target: RuntimeTarget) {
  if (target.windows) return `btbn:${ffmpegRelease}:${ffmpegBuild}`
  if (target.id === "darwin-x64") {
    return [
      process.env.OPENCODE_DESKTOP_FFMPEG_DARWIN_X64_FFMPEG_URL ?? "https://evermeet.cx/ffmpeg/getrelease/zip",
      process.env.OPENCODE_DESKTOP_FFMPEG_DARWIN_X64_FFPROBE_URL ?? "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
    ].join("|")
  }
  if (target.id === "darwin-arm64") {
    return [
      process.env.OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFMPEG_URL ?? "",
      process.env.OPENCODE_DESKTOP_FFMPEG_DARWIN_ARM64_FFPROBE_URL ?? "",
    ].join("|")
  }
  return "unsupported"
}

function pythonEnv(targetDir: string) {
  return {
    ...process.env,
    PATH: [path.join(targetDir, "bin"), path.join(targetDir, "python", "bin"), process.env.PATH ?? ""].join(path.delimiter),
    PYTHONHOME: path.join(targetDir, "python"),
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
  }
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "opencode-desktop-runtime-installer",
    },
  })

  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`)

  return response.text()
}

function parseJson(content: string): unknown {
  return JSON.parse(content)
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-desktop-runtime-installer",
    },
  })

  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`)

  const value: unknown = await response.json()
  return value
}
