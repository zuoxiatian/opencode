import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

type RuntimeTarget = {
    id: string
    nodePlatform: string
    pythonPlatform: string
    windows: boolean
}

type Download = {
    archive: string
    expectedSha256: string | undefined
    url: string
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

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = path.join(packageDir, "runtimes")
const nodeVersion = process.env.OPENCODE_DESKTOP_NODE_VERSION ?? "22.22.3"
const pythonVersion = process.env.OPENCODE_DESKTOP_PYTHON_VERSION ?? "3.14.5"
const pythonStandaloneRelease = process.env.OPENCODE_DESKTOP_PYTHON_STANDALONE_RELEASE ?? "20260510"
const args = process.argv.slice(2)
const options = {
    all: args.includes("--all"),
    help: args.includes("--help") || args.includes("-h"),
    installCrossPackages: args.includes("--install-cross-packages"),
    nodeOnly: args.includes("--node-only"),
    pythonOnly: args.includes("--python-only"),
}
const runtimeTargets: RuntimeTarget[] = [
    {
        id: "darwin-arm64",
        nodePlatform: "darwin-arm64",
        pythonPlatform: "aarch64-apple-darwin",
        windows: false,
    },
    {
        id: "darwin-x64",
        nodePlatform: "darwin-x64",
        pythonPlatform: "x86_64-apple-darwin",
        windows: false,
    },
    {
        id: "win32-x64",
        nodePlatform: "win-x64",
        pythonPlatform: "x86_64-pc-windows-msvc",
        windows: true,
    },
    {
        id: "linux-x64",
        nodePlatform: "linux-x64",
        pythonPlatform: "x86_64-unknown-linux-gnu",
        windows: false,
    },
]

if (options.nodeOnly && options.pythonOnly) {
    throw new Error("Use only one of --node-only or --python-only")
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
        "  --node-only               Install Node.js only",
        "  --python-only             Install Python only",
        "  --install-cross-packages  On Apple Silicon, run darwin-x64 Python through Rosetta",
        "",
        "Version overrides:",
        "  OPENCODE_DESKTOP_NODE_VERSION",
        "  OPENCODE_DESKTOP_PYTHON_VERSION",
        "  OPENCODE_DESKTOP_PYTHON_STANDALONE_RELEASE",
    ].join("\n"))
    process.exit(0)
}

const requestedTargetIds = args.flatMap((arg) => {
    if (arg.startsWith("--target=")) return [arg.slice("--target=".length)]
    if (arg.startsWith("--")) return []
    return [arg]
})
const selectedTargets = (
    options.all
        ? runtimeTargets
        : requestedTargetIds.length
            ? requestedTargetIds.map((id) => {
                const target = runtimeTargets.find((item) => item.id === id)
                if (!target) throw new Error(`Unknown runtime target: ${id}`)
                return target
            })
            : runtimeTargets
)

if (!selectedTargets.length) {
    throw new Error("No runtime targets selected")
}

await mkdir(runtimeRoot, { recursive: true })
await Promise.all(selectedTargets.map((target) => installTarget(target)))

async function installTarget(target: RuntimeTarget) {
    const targetDir = path.join(runtimeRoot, target.id)
    const scratchDir = path.join(runtimeRoot, ".download", `${target.id}-${Date.now()}`)
    const metadata = await readRuntimeMetadata(targetDir)
    const nextMetadata: RuntimeMetadata = {
        ...metadata,
        target: target.id,
    }

    await rm(scratchDir, { force: true, recursive: true })
    await mkdir(scratchDir, { recursive: true })
    await mkdir(targetDir, { recursive: true })

    console.log(`Installing runtime: ${target.id}`)

    if (!options.pythonOnly) {
        const existing = await currentNodeVersion(target, targetDir, metadata)
        if (existing) {
            console.log(`Node.js ${nodeVersion} already installed for ${target.id}; skipping download.`)
            nextMetadata.nodeArchive = metadata?.nodeArchive
            nextMetadata.nodeVersion = existing
        } else {
            const download = await installNode(target, targetDir, path.join(scratchDir, "node"))
            nextMetadata.nodeArchive = download.archive
            nextMetadata.nodeVersion = download.version
        }
    }

    if (!options.nodeOnly) {
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

    await writeLaunchers(target, targetDir)

    await verifyRuntime(target, targetDir)
    await writeRuntimeMetadata(targetDir, nextMetadata)
    await rm(scratchDir, { force: true, recursive: true })
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
    await writeFile(runtimeMetadataPath(targetDir), JSON.stringify(metadata, undefined, 2) + "\n")
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

    const info = await capture([
        ...prefix,
        pythonExecutable(target, targetDir),
        "-c",
        "import json, sys, sysconfig; print(json.dumps({'version': f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}', 'paths': sysconfig.get_paths()}))",
    ], pythonEnv(targetDir))
        .then((text) => text ? parseJson(text) : undefined)
        .catch(() => undefined)

    if (!isPythonRuntimeInfo(info)) return undefined
    if (!samePythonMinor(info.version, pythonVersion)) return undefined

    if (JSON.stringify(info.paths).includes("/opt/homebrew") || JSON.stringify(info.paths).includes("/usr/local/Cellar")) {
        return undefined
    }

    return info.version
}

function isPythonRuntimeInfo(value: unknown): value is PythonRuntimeInfo {
    return !!value && typeof value === "object" && "version" in value && typeof value.version === "string" && "paths" in value && !!value.paths && typeof value.paths === "object"
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

    await rm(path.join(targetDir, "node"), { force: true, recursive: true })
    await rename(source, path.join(targetDir, "node"))
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

    await rm(path.join(targetDir, "python"), { force: true, recursive: true })
    await rename(source, path.join(targetDir, "python"))
    return download
}

async function resolveNodeDownload(target: RuntimeTarget): Promise<Download> {
    const archive = `node-v${nodeVersion}-${target.nodePlatform}.${target.windows ? "zip" : "tar.gz"}`
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
    const asset = exactAsset ?? release.assets
        .map((item) => ({
            asset: item,
            version: pythonAssetVersion(item.name, target),
        }))
        .filter((item): item is { asset: GitHubRelease["assets"][number]; version: string } => {
            return !!item.version && samePythonMinor(item.version, pythonVersion)
        })
        .sort((a, b) => compareVersions(b.version, a.version))[0]?.asset

    if (!asset) throw new Error(`Could not find ${archives.join(" or ")} or another Python ${pythonMinor(pythonVersion)} asset in python-build-standalone ${pythonStandaloneRelease}`)

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

function pythonAssetVersion(name: string, target: RuntimeTarget) {
    return name.match(
        new RegExp(`^cpython-(\\d+\\.\\d+\\.\\d+)\\+${escapeRegex(pythonStandaloneRelease)}-${escapeRegex(target.pythonPlatform)}-(?:shared-)?install_only_stripped\\.tar\\.gz$`),
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

async function writeLaunchers(target: RuntimeTarget, targetDir: string) {
    const binDir = path.join(targetDir, "bin")
    await mkdir(binDir, { recursive: true })

    if (target.windows) {
        await writeFile(
            path.join(binDir, "node.cmd"),
            '@echo off\r\n"%~dp0..\\node\\node.exe" %*\r\n',
        )
        await writeFile(
            path.join(binDir, "python.cmd"),
            '@echo off\r\nfor %%I in ("%~dp0..") do set "RUNTIME_DIR=%%~fI"\r\nset "PYTHONHOME=%RUNTIME_DIR%\\python"\r\nset "PYTHONPATH="\r\nset "PYTHONNOUSERSITE=1"\r\n"%RUNTIME_DIR%\\python\\python.exe" %*\r\n',
        )
        await writeFile(
            path.join(binDir, "python3.cmd"),
            '@echo off\r\nfor %%I in ("%~dp0..") do set "RUNTIME_DIR=%%~fI"\r\nset "PYTHONHOME=%RUNTIME_DIR%\\python"\r\nset "PYTHONPATH="\r\nset "PYTHONNOUSERSITE=1"\r\n"%RUNTIME_DIR%\\python\\python.exe" %*\r\n',
        )
        await writeFile(
            path.join(binDir, "pip.cmd"),
            '@echo off\r\nfor %%I in ("%~dp0..") do set "RUNTIME_DIR=%%~fI"\r\nset "PYTHONHOME=%RUNTIME_DIR%\\python"\r\nset "PYTHONPATH="\r\nset "PYTHONNOUSERSITE=1"\r\n"%RUNTIME_DIR%\\python\\python.exe" -m pip %*\r\n',
        )
        return
    }

    await writeExecutable(
        path.join(binDir, "node"),
        '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$DIR/node/bin/node" "$@"\n',
    )
    await writeExecutable(
        path.join(binDir, "python"),
        '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport PYTHONHOME="$DIR/python"\nexport PYTHONPATH=\nexport PYTHONNOUSERSITE=1\nPY="$DIR/python/bin/python3"\n[ -x "$PY" ] || PY="$DIR/python/bin/python"\nexec "$PY" "$@"\n',
    )
    await writeExecutable(
        path.join(binDir, "python3"),
        '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport PYTHONHOME="$DIR/python"\nexport PYTHONPATH=\nexport PYTHONNOUSERSITE=1\nPY="$DIR/python/bin/python3"\n[ -x "$PY" ] || PY="$DIR/python/bin/python"\nexec "$PY" "$@"\n',
    )
    await writeExecutable(
        path.join(binDir, "pip"),
        '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport PYTHONHOME="$DIR/python"\nexport PYTHONPATH=\nexport PYTHONNOUSERSITE=1\nPY="$DIR/python/bin/python3"\n[ -x "$PY" ] || PY="$DIR/python/bin/python"\nexec "$PY" -m pip "$@"\n',
    )
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

    if (!options.pythonOnly) {
        await run([...prefix, nodeExecutable(target, targetDir), "--version"])
    }

    if (!options.nodeOnly) {
        await run([
            ...prefix,
            pythonExecutable(target, targetDir),
            "-c",
            "import json, sysconfig; paths=sysconfig.get_paths(); text=json.dumps(paths); print(text); assert '/opt/homebrew' not in text and '/usr/local/Cellar' not in text",
        ], pythonEnv(targetDir))
    }
}

function commandPrefix(target: RuntimeTarget) {
    if (target.id === `${process.platform}-${process.arch}`) return []
    if (options.installCrossPackages && process.platform === "darwin" && process.arch === "arm64" && target.id === "darwin-x64") {
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

function pythonEnv(targetDir: string) {
    return {
        ...process.env,
        PATH: [
            path.join(targetDir, "bin"),
            path.join(targetDir, "python", "bin"),
            process.env.PATH ?? "",
        ].join(path.delimiter),
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

async function run(cmd: string[], env = process.env) {
    console.log(cmd.join(" "))

    const code = await new Promise<number>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
            env,
            stdio: "inherit",
        })

        proc.on("error", reject)
        proc.on("exit", (code) => resolve(code ?? 0))
    })

    if (code !== 0) throw new Error(`Command failed (${code}): ${cmd.join(" ")}`)
}

async function capture(cmd: string[], env = process.env) {
    console.log(cmd.join(" "))

    return new Promise<string | undefined>((resolve) => {
        const chunks: Buffer[] = []
        const proc = spawn(cmd[0], cmd.slice(1), {
            env,
            stdio: ["ignore", "pipe", "ignore"],
        })

        proc.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        proc.on("error", () => resolve(undefined))
        proc.on("exit", (code) => {
            if (code !== 0) return resolve(undefined)
            resolve(Buffer.concat(chunks).toString("utf8").trim())
        })
    })
}
