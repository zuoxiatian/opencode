import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(packageDir, "../..")
const opencodeDir = path.join(repoRoot, "packages", "opencode")
const bun = process.env.BUN_PATH ?? "bun"
const args = process.argv.slice(2)
const command = args.find((arg) => !arg.startsWith("--")) ?? "all"
const options = {
    help: args.includes("--help") || args.includes("-h"),
    skipClientPackage: args.includes("--skip-client-package"),
    skipDesktopBuild: args.includes("--skip-desktop-build"),
    skipOpencode: args.includes("--skip-opencode"),
    skipOpencodeInstall: args.includes("--skip-opencode-install") || process.env.OPENCODE_DESKTOP_SKIP_OPENCODE_INSTALL === "1",
}
const clientTargetGroups = {
    all: [["--mac"], ["--win"], ["--linux"]],
    linux: [["--linux"]],
    mac: [["--mac"]],
    "mac-arm64": [["--mac", "--arm64"]],
    "mac-x64": [["--mac", "--x64"]],
    win: [["--win"]],
    "win-zip": [["--win", "zip"]],
} as const
const opencodeBinaries = [
    {
        id: "win32-x64",
        destination: path.join(packageDir, "bin", "opencode.exe"),
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
]
type OpencodeBinaryId = (typeof opencodeBinaries)[number]["id"]
const packageTargetIds: Record<keyof typeof clientTargetGroups | "opencode", OpencodeBinaryId[]> = {
    all: ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"],
    linux: ["linux-x64"],
    mac: ["darwin-x64", "darwin-arm64"],
    "mac-arm64": ["darwin-arm64"],
    "mac-x64": ["darwin-x64"],
    opencode: ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"],
    win: ["win32-x64"],
    "win-zip": ["win32-x64"],
}

if (options.help) {
    console.log([
        "Usage: bun run packages/desktop-lxz/script/package.ts [target] [options]",
        "",
        "Targets:",
        "  opencode   Build packages/opencode and copy desktop backend binaries",
        "  all        Package macOS, Windows, and Linux clients sequentially",
        "  win        Package Windows installer and portable client",
        "  win-zip    Package Windows zip client",
        "  mac        Package macOS x64 and arm64 clients",
        "  mac-x64    Package macOS x64 client",
        "  mac-arm64  Package macOS arm64 client",
        "  linux      Package Linux x64 client",
        "",
        "Options:",
        "  --skip-opencode          Reuse existing packages/opencode/dist output",
        "  --skip-opencode-install  Pass --skip-install to packages/opencode/script/build.ts",
        "  --skip-desktop-build     Skip electron-vite build",
        "  --skip-client-package    Stop before electron-builder",
    ].join("\n"))
    process.exit(0)
}

if (command !== "opencode" && !isClientTarget(command)) {
    throw new Error(`Unknown desktop-lxz package target: ${command}`)
}

if (!options.skipOpencode) {
    await run([
        bun,
        "run",
        "script/build.ts",
        ...(options.skipOpencodeInstall ? ["--skip-install"] : []),
    ], opencodeDir)
}

await copyOpencodeBinaries(packageTargetIds[command], options.skipOpencode)

if (command === "opencode") process.exit(0)

if (!options.skipDesktopBuild) {
    await run([bun, "run", "runtime:install", "--", ...packageTargetIds[command]], packageDir)
    await run([bun, "run", "electron-vite", "build"], packageDir, desktopToolEnv())
}

if (!options.skipClientPackage) {
    for (const targetArgs of clientTargetGroups[command]) {
        await run([bun, "run", "electron-builder", ...targetArgs], packageDir, {
            ...desktopToolEnv(),
            CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
        })
    }
}

function isClientTarget(value: string): value is keyof typeof clientTargetGroups {
    return value in clientTargetGroups
}

async function copyOpencodeBinaries(ids: OpencodeBinaryId[], reuseExistingBin: boolean) {
    await Promise.all(opencodeBinaries.filter((binary) => ids.includes(binary.id)).map(async (binary) => {
        if (!existsSync(binary.source)) {
            if (reuseExistingBin && existsSync(binary.destination)) {
                if (binary.executable) await chmod(binary.destination, 0o755)
                console.log(`Reusing ${path.relative(repoRoot, binary.destination)}`)
                return
            }

            throw new Error(`Missing opencode binary: ${binary.source}`)
        }

        await mkdir(path.dirname(binary.destination), { recursive: true })
        await copyFile(binary.source, binary.destination)
        if (binary.executable) await chmod(binary.destination, 0o755)
        console.log(`Copied ${path.relative(repoRoot, binary.source)} -> ${path.relative(repoRoot, binary.destination)}`)
    }))
}

function desktopToolEnv() {
    const runtimeDir = path.join(packageDir, "runtimes", `${process.platform}-${process.arch}`)

    return {
        ...process.env,
        PATH: [
            path.join(runtimeDir, "bin"),
            path.join(runtimeDir, "node", "bin"),
            path.join(runtimeDir, "node"),
            process.env.PATH ?? "",
        ].join(path.delimiter),
    }
}

async function run(cmd: string[], cwd: string, env = process.env) {
    console.log(`$ ${cmd.join(" ")}`)

    const code = await new Promise<number>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
            cwd,
            env,
            stdio: "inherit",
        })

        proc.on("error", reject)
        proc.on("exit", (code) => resolve(code ?? 0))
    })

    if (code !== 0) throw new Error(`Command failed (${code}): ${cmd.join(" ")}`)
}
