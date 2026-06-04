import { readFile } from "node:fs/promises"
import path from "node:path"
import { bun, opencodeDir, packageDir } from "./lib/paths.ts"
import { copyOpencodeBinaries } from "./lib/opencode-binaries.ts"
import { run } from "./lib/run.ts"
import { isPrepareTarget, packageTargetIds, type PrepareTarget } from "./lib/targets.ts"

const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--")
const target = args.find((arg) => !arg.startsWith("--")) ?? "all"
const options = {
  help: args.includes("--help") || args.includes("-h"),
  skipOpencode: args.includes("--skip-opencode"),
  skipOpencodeInstall: args.includes("--skip-opencode-install") || process.env.OPENCODE_DESKTOP_SKIP_OPENCODE_INSTALL === "1",
  skipRuntimes: args.includes("--skip-runtimes"),
}
const desktopPackage = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as { version?: string }

if (options.help) {
  console.log([
    "Usage: bun run script/prepare-assets.ts [target] [options]",
    "",
    "Targets:",
    "  opencode   Build packages/opencode and copy desktop backend binaries",
    "  all        Prepare macOS, Windows, and Linux assets",
    "  win        Prepare Windows x64 assets",
    "  win-zip    Prepare Windows x64 zip assets",
    "  mac        Prepare macOS x64 and arm64 assets",
    "  mac-x64    Prepare macOS x64 assets",
    "  mac-arm64  Prepare macOS arm64 assets",
    "  linux      Prepare Linux x64 assets",
    "",
    "Options:",
    "  --skip-opencode          Reuse existing packages/opencode/dist output or desktop bin output",
    "  --skip-opencode-install  Pass --skip-install to packages/opencode/script/build.ts",
    "  --skip-runtimes          Do not install Node/Python runtimes",
  ].join("\n"))
  process.exit(0)
}

if (!isPrepareTarget(target)) {
  throw new Error(`Unknown desktop-forge asset target: ${target}`)
}

await prepareAssets(target)

async function prepareAssets(target: PrepareTarget) {
  if (!options.skipOpencode) {
    await run(
      [
        bun,
        "run",
        "script/build.ts",
        ...(options.skipOpencodeInstall ? ["--skip-install"] : []),
      ],
      {
        cwd: opencodeDir,
        env: {
          ...process.env,
          OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL ?? "latest",
          OPENCODE_VERSION: process.env.OPENCODE_VERSION ?? String(desktopPackage.version ?? "0.0.0"),
        },
      },
    )
  }

  await copyOpencodeBinaries(packageTargetIds[target], options.skipOpencode)

  if (target === "opencode" || options.skipRuntimes) return

  await run([bun, "run", "runtime:install", "--", ...packageTargetIds[target]], { cwd: packageDir })
}
