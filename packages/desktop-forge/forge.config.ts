import type { ForgeConfig } from "@electron-forge/shared-types"
import { MakerSquirrel } from "@electron-forge/maker-squirrel"
import { MakerZIP } from "@electron-forge/maker-zip"
import { MakerDMG } from "@electron-forge/maker-dmg"
import { MakerDeb } from "@electron-forge/maker-deb"
import { MakerRpm } from "@electron-forge/maker-rpm"
import { VitePlugin } from "@electron-forge/plugin-vite"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { FuseV1Options, FuseVersion } from "@electron/fuses"
import type { NotaryToolCredentials } from "@electron/notarize/lib/types"
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { chmod, cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const APP_ID = "ai.opencode.desktop"
const APP_NAME = "LongwiseTechAgent"
const packageDir = path.resolve(__dirname)
const execFileAsync = promisify(execFile)
const macEntitlements = path.resolve(packageDir, "build", "entitlements.mac.plist")
const macEntitlementsInherit = path.resolve(packageDir, "build", "entitlements.mac.inherit.plist")

loadLocalSigningEnv()

const config: ForgeConfig = {
  outDir: "release",
  packagerConfig: {
    appBundleId: APP_ID,
    appCategoryType: "public.app-category.productivity",
    executableName: APP_NAME,
    extendInfo: {
      CFBundleDisplayName: APP_NAME,
      CFBundleName: APP_NAME,
    },
    extraResource: optionalResources(["build"]),
    icon: path.resolve(packageDir, "build", "icon"),
    name: APP_NAME,
    osxNotarize: macNotarizeOptions(),
    osxSign: macSignOptions(),
    asar: true,
    afterCopyExtraResources: [copyPlatformResources],
    win32metadata: {
      CompanyName: "Longwise",
      FileDescription: `${APP_NAME} desktop client`,
      InternalName: APP_NAME,
      OriginalFilename: `${APP_NAME}.exe`,
      ProductName: APP_NAME,
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: APP_NAME,
      setupIcon: path.resolve(packageDir, "build", "icon.ico"),
    }),
    new MakerDMG({
      title: APP_NAME,
      background: path.resolve(packageDir, "build", "background.tiff"),
      icon: path.resolve(packageDir, "build", "icon.icns"),
      iconSize: 96,
      contents: (options) => [
        {
          x: 240,
          y: 255,
          type: "file",
          path: options.appPath,
        },
        {
          x: 528,
          y: 255,
          type: "link",
          path: "/Applications",
        },
      ],
      additionalDMGOptions: {
        window: {
          size: {
            width: 768,
            height: 512,
          },
        },
      },
    }),
    new MakerZIP({}, ["win32"]),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config

function macSignOptions() {
  const identity = process.env.CSC_NAME
  const keychain = process.env.CSC_KEYCHAIN

  return {
    ...(identity ? { identity } : {}),
    ...(keychain ? { keychain } : {}),
    continueOnError: false,
    optionsForFile: macSignOptionsForFile,
  }
}

function macSignOptionsForFile(filePath: string) {
  return {
    entitlements: isMainAppSignTarget(filePath) ? macEntitlements : macEntitlementsInherit,
  }
}

function isMainAppSignTarget(filePath: string) {
  return (
    filePath.endsWith(`${APP_NAME}.app`) ||
    filePath.endsWith(path.join(`${APP_NAME}.app`, "Contents", "MacOS", APP_NAME))
  )
}

function loadLocalSigningEnv() {
  const file = path.join(packageDir, "signing.local.env")
  if (!existsSync(file)) return

  for (const [key, value] of Object.entries(readEnvFile(file))) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function readEnvFile(file: string) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => parseEnvLine(line.replace(/^export\s+/, ""))),
  )
}

function parseEnvLine(line: string): [string, string] {
  const separator = line.indexOf("=")
  if (separator < 1) throw new Error(`Invalid signing config line: ${line}`)

  return [line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim())]
}

function macNotarizeOptions(): NotaryToolCredentials | undefined {
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE
  if (keychainProfile) {
    return process.env.APPLE_KEYCHAIN
      ? ({
          keychain: process.env.APPLE_KEYCHAIN,
          keychainProfile,
        } satisfies NotaryToolCredentials)
      : ({
          keychainProfile,
        } satisfies NotaryToolCredentials)
  }

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID
  if (appleId && appleIdPassword && teamId) {
    return {
      appleId,
      appleIdPassword,
      teamId,
    } satisfies NotaryToolCredentials
  }

  const appleApiIssuer = process.env.APPLE_API_ISSUER
  const appleApiKey = process.env.APPLE_API_KEY
  const appleApiKeyId = process.env.APPLE_API_KEY_ID
  if (appleApiIssuer && appleApiKey && appleApiKeyId) {
    return {
      appleApiIssuer,
      appleApiKey,
      appleApiKeyId,
    } satisfies NotaryToolCredentials
  }

  return undefined
}

function unquote(value: string) {
  if (value.length < 2) return value
  if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

function optionalResources(names: string[]) {
  return names
    .map((name) => path.resolve(packageDir, name))
    .filter((item) => existsSync(item))
}

function copyPlatformResources(
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  done: (error?: Error | null) => void,
) {
  void copyPlatformResourceFiles(buildPath, platform, arch)
    .then(() => done())
    .catch((error: unknown) => done(error instanceof Error ? error : new Error(String(error))))
}

async function copyPlatformResourceFiles(buildPath: string, platform: string, arch: string) {
  await copyPlatformRuntime(buildPath, platform, arch)
  await copyOpencodeBinary(buildPath, platform, arch)
  await copyMacAppIcon(buildPath, platform)
}

async function copyPlatformRuntime(buildPath: string, platform: string, arch: string) {
  const source = path.resolve(packageDir, "runtimes", `${platform}-${arch}`)
  if (!existsSync(source)) return

  const destination = path.join(resourcesPath(buildPath, platform), "runtimes", `${platform}-${arch}`)
  await cp(source, destination, {
    force: true,
    recursive: true,
    verbatimSymlinks: true,
  })
  await prunePackagedNodePackageManager(destination, platform)
}

async function prunePackagedNodePackageManager(runtimePath: string, platform: string) {
  if (platform !== "win32") return

  await Promise.all(
    [
      path.join(runtimePath, "node", "node_modules"),
      ...["corepack", "corepack.cmd", "npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1"].map((name) =>
        path.join(runtimePath, "node", name),
      ),
    ].map((item) => rm(item, { force: true, recursive: true })),
  )
}

async function copyOpencodeBinary(buildPath: string, platform: string, arch: string) {
  const source = opencodeBinarySource(platform, arch)
  if (!source) return

  const destination = path.join(resourcesPath(buildPath, platform), "bin", platform === "win32" ? "opencode.exe" : "opencode")
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { force: true })
  if (platform !== "win32") await chmod(destination, 0o755)
}

async function copyMacAppIcon(buildPath: string, platform: string) {
  if (platform !== "darwin") return

  const source = path.resolve(packageDir, "build", "icon.icns")
  if (!existsSync(source)) return

  await cp(source, path.join(resourcesPath(buildPath, platform), "icon.icns"), { force: true })
  await execFileAsync("plutil", [
    "-replace",
    "CFBundleIconFile",
    "-string",
    "icon.icns",
    path.join(buildPath, `${APP_NAME}.app`, "Contents", "Info.plist"),
  ])
}

function opencodeBinarySource(platform: string, arch: string) {
  const binaryName = platform === "win32" ? "opencode.exe" : "opencode"
  return [
    platform === "darwin" ? path.resolve(packageDir, "bin", "mac", arch, binaryName) : undefined,
    platform === "linux" ? path.resolve(packageDir, "bin", "linux", arch, binaryName) : undefined,
    path.resolve(packageDir, "bin", binaryName),
  ].find((item): item is string => !!item && existsSync(item))
}

function resourcesPath(buildPath: string, platform: string) {
  if (platform === "darwin") return path.join(buildPath, `${APP_NAME}.app`, "Contents", "Resources")
  return path.join(buildPath, "resources")
}
