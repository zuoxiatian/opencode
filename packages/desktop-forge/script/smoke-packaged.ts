import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { stat, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { text } from "node:stream/consumers"
import manifest from "../resources/agent-browser/manifest.json"
import {
  AGENT_BROWSER_PLUGIN_PROTOCOL,
  DESKTOP_FORGE_AGENT_BROWSER_CDP_URL,
  DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
} from "../src/electron/browser/agent-browser/provider-contract.ts"
import { packageDir } from "./lib/paths.ts"
import { runtimeTargetById, type RuntimeTargetId } from "./lib/targets.ts"

const args = process.argv.slice(2).filter((argument) => argument !== "--")
const target = option("--target") ?? `${process.platform}-${process.arch}`
const packageRoot = option("--package-root")
const staticOnly = args.includes("--static")
const formalMac = args.includes("--formal-mac")
const skipSignature = args.includes("--skip-signature")
const runtimeTarget = runtimeTargetById(target)
const emulatedMac = process.platform === "darwin"
  && process.arch === "arm64"
  && target === "darwin-x64"

if (!runtimeTarget) throw new Error(`Unsupported packaged smoke target: ${target}`)
if (!staticOnly && target !== `${process.platform}-${process.arch}` && !emulatedMac) {
  throw new Error(`Live packaged smoke for ${target} must run on ${process.platform}-${process.arch}`)
}
if (formalMac && target.split("-")[0] !== "darwin") {
  throw new Error("--formal-mac is only supported for macOS packages")
}
if (formalMac && skipSignature) {
  throw new Error("--formal-mac and --skip-signature cannot be used together")
}

await smokePackage(runtimeTarget.id)

async function smokePackage(target: RuntimeTargetId) {
  const platform = runtimeTargetById(target)?.windows
    ? "win32"
    : target.startsWith("darwin-")
      ? "darwin"
      : "linux"
  const arch = target.endsWith("-arm64") ? "arm64" : "x64"
  const root = packageRoot
    ? path.resolve(packageRoot)
    : path.join(packageDir, "release", `LongwiseTechAgent-${platform}-${arch}`)
  const app = platform === "darwin"
    ? path.join(root, "LongwiseTechAgent.app")
    : path.join(root, platform === "win32" ? "LongwiseTechAgent.exe" : "LongwiseTechAgent")
  const resources = platform === "darwin"
    ? path.join(app, "Contents", "Resources")
    : path.join(root, "resources")
  const directory = path.join(resources, "agent-browser", target)
  const binary = path.join(directory, platform === "win32" ? "agent-browser.exe" : "agent-browser")
  const provider = path.join(
    directory,
    platform === "win32"
      ? "desktop-forge-agent-browser-provider.exe"
      : "desktop-forge-agent-browser-provider",
  )

  await Promise.all([
    requireFile(app, "packaged app executable"),
    requireFile(path.join(resources, "app.asar"), "packaged ASAR"),
    requireFile(binary, "packaged agent-browser"),
    requireFile(provider, "packaged agent-browser provider"),
  ])
  assert.deepEqual(
    JSON.parse(await readFile(path.join(resources, "agent-browser", "manifest.json"), "utf8")),
    manifest,
    "packaged agent-browser manifest differs from the pinned source manifest",
  )
  if (platform !== "win32") {
    const modes = await Promise.all([stat(binary), stat(provider)])
    assert.ok(modes.every((item) => (item.mode & 0o111) !== 0), "packaged helpers must be executable")
  }
  if (platform !== "darwin") {
    assert.equal(
      await sha256(binary),
      manifest.artifacts[target].sha256,
      "packaged agent-browser checksum differs from the pinned artifact",
    )
  }
  if (platform === "darwin" && !skipSignature) {
    await Promise.all([
      successful("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]),
      successful("codesign", ["--verify", "--strict", "--verbose=2", binary]),
      successful("codesign", ["--verify", "--strict", "--verbose=2", provider]),
    ])
  }
  if (formalMac) {
    const signature = await execute("codesign", ["--display", "--verbose=4", app])
    assert.equal(signature.exitCode, 0, "unable to inspect the packaged macOS signature")
    assert.match(signature.stderr, /Authority=Developer ID Application:/)
    await Promise.all([
      successful("spctl", ["--assess", "--type", "execute", "--verbose=4", app]),
      successful("xcrun", ["stapler", "validate", app]),
    ])
  }
  if (staticOnly) {
    process.stdout.write(`${JSON.stringify({ static: true, success: true, target })}\n`)
    return
  }

  const helperEnv = isolatedEnvironment()
  const version = await execute(binary, ["--version"], { env: helperEnv })
  assert.equal(version.exitCode, 0, "packaged agent-browser --version failed")
  assert.equal(version.stdout.trim(), `agent-browser ${manifest.version}`)

  const cdpUrl = "ws://127.0.0.1:43210/cdp/package-smoke"
  const providerResult = await execute(provider, [], {
    env: {
      ...helperEnv,
      [DESKTOP_FORGE_AGENT_BROWSER_CDP_URL]: cdpUrl,
    },
    input: JSON.stringify({
      capability: "browser.provider",
      protocol: AGENT_BROWSER_PLUGIN_PROTOCOL,
      request: {
        launchOptions: {
          colorScheme: null,
          engine: "chrome",
          headed: false,
          userAgent: null,
        },
        provider: DESKTOP_FORGE_AGENT_BROWSER_PROVIDER,
        session: "desktop-forge-package-smoke",
      },
      type: "browser.launch",
    }),
  })
  assert.equal(providerResult.exitCode, 0, "packaged provider helper failed")
  assert.deepEqual(JSON.parse(providerResult.stdout), {
    browser: {
      cdpUrl,
      directPage: true,
    },
    protocol: AGENT_BROWSER_PLUGIN_PROTOCOL,
    success: true,
  })

  const electron = String(createRequire(import.meta.url)("electron"))
  const runtimeBundleDir = await mkdtemp(path.join(tmpdir(), "df-packaged-runtime-smoke-"))
  const runtimeBundle = path.join(runtimeBundleDir, "browser-runtime.integration.poc.mjs")
  await successful(process.execPath, [
    "build",
    "--target=node",
    "--external=electron",
    `--outfile=${runtimeBundle}`,
    path.join(packageDir, "test", "browser-runtime.integration.poc.ts"),
  ])
  const runtime = await execute(
    electron,
    [runtimeBundle],
    {
      env: {
        ...isolatedEnvironment(),
        DESKTOP_FORGE_PACKAGED_RESOURCES_PATH: resources,
        DESKTOP_FORGE_PACKAGED_TARGET_ARCH: arch,
      },
      timeout: 120_000,
    },
  )
  assert.equal(runtime.exitCode, 0, runtime.stderr || "packaged browser Runtime smoke failed")
  assert.equal(JSON.parse(runtime.stdout).success, true)
  await rm(runtimeBundleDir, { force: true, recursive: true })

  const userData = await mkdtemp(path.join(tmpdir(), "df-packaged-app-smoke-"))
  const launched = await execute(
    platform === "darwin" ? path.join(app, "Contents", "MacOS", "LongwiseTechAgent") : app,
    [`--user-data-dir=${userData}`, "--desktop-forge-packaged-smoke"],
    {
      env: isolatedEnvironment(),
      timeout: 30_000,
    },
  )
  assert.equal(launched.exitCode, 0, launched.stderr || "packaged app startup smoke failed")
  assert.deepEqual(
    JSON.parse(await readFile(path.join(userData, "desktop-forge-packaged-smoke.json"), "utf8")),
    {
      browserRuntime: true,
      browserTransport: true,
      ready: true,
    },
  )
  assert.deepEqual(await daemonFiles(userData), [], "packaged app left agent-browser daemon files behind")
  await rm(userData, { force: true, recursive: true })
  process.stdout.write(`${JSON.stringify({
    appStartup: true,
    directPage: true,
    noGlobalRuntimeDependency: true,
    runtime: true,
    success: true,
    target,
    ...(emulatedMac ? { translated: true } : {}),
  })}\n`)
}

function option(name: string) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

async function requireFile(file: string, label: string) {
  const info = await stat(file).catch(() => undefined)
  assert.ok(info?.isFile() || info?.isDirectory(), `Missing ${label}: ${file}`)
}

function isolatedEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase()
      return name !== "PATH"
        && !name.startsWith("AGENT_BROWSER_")
        && !name.startsWith("BUN_")
        && !name.startsWith("CHROME_")
        && !name.startsWith("NODE_")
        && !name.startsWith("NPM_")
        && !name.startsWith("PLAYWRIGHT_")
        && name !== DESKTOP_FORGE_AGENT_BROWSER_CDP_URL
    })),
    PATH: "",
  }
}

async function execute(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string | undefined>
    input?: string
    timeout?: number
  } = {},
) {
  const child = spawn(command, args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdin.end(options.input)
  const timeout = { reached: false }
  const timer = setTimeout(() => {
    timeout.reached = true
    child.kill()
  }, options.timeout ?? 15_000)
  const result = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? -1))
    }),
    text(child.stdout),
    text(child.stderr),
  ])
  clearTimeout(timer)
  if (timeout.reached) throw new Error(`Command timed out: ${command}`)
  return {
    exitCode: result[0],
    stderr: result[2],
    stdout: result[1],
  }
}

async function successful(command: string, args: string[]) {
  const result = await execute(command, args)
  assert.equal(result.exitCode, 0, result.stderr || `${command} failed`)
}

async function daemonFiles(userData: string) {
  const directory = path.join(
    userData,
    "agent-browser",
    "sockets",
    "namespaces",
    "desktop-forge",
    "run",
  )
  return readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}
