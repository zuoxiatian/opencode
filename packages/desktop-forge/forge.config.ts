import type { ForgeConfig } from "@electron-forge/shared-types"
import { MakerSquirrel } from "@electron-forge/maker-squirrel"
import { MakerZIP } from "@electron-forge/maker-zip"
import { MakerDeb } from "@electron-forge/maker-deb"
import { MakerRpm } from "@electron-forge/maker-rpm"
import { VitePlugin } from "@electron-forge/plugin-vite"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { FuseV1Options, FuseVersion } from "@electron/fuses"
import { existsSync } from "node:fs"
import { chmod, cp, mkdir } from "node:fs/promises"
import path from "node:path"

const APP_ID = "ai.opencode.desktop"
const APP_NAME = "LongwiseTechAgent"
const packageDir = path.resolve(__dirname)

const config: ForgeConfig = {
  outDir: "release",
  packagerConfig: {
    appBundleId: APP_ID,
    appCategoryType: "public.app-category.developer-tools",
    executableName: APP_NAME,
    extendInfo: {
      CFBundleDisplayName: APP_NAME,
      CFBundleName: APP_NAME,
    },
    extraResource: optionalResources(["build", "config", "skills"]),
    icon: path.resolve(packageDir, "build", "icon"),
    name: APP_NAME,
    asar: true,
    afterCopyExtraResources: [copyPlatformResources],
    win32metadata: {
      CompanyName: "opencode",
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
    new MakerZIP({}, ["darwin"]),
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
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config

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
}

async function copyPlatformRuntime(buildPath: string, platform: string, arch: string) {
  const source = path.resolve(packageDir, "runtimes", `${platform}-${arch}`)
  if (!existsSync(source)) return

  await cp(source, path.join(resourcesPath(buildPath, platform), "runtimes", `${platform}-${arch}`), {
    force: true,
    recursive: true,
  })
}

async function copyOpencodeBinary(buildPath: string, platform: string, arch: string) {
  const source = opencodeBinarySource(platform, arch)
  if (!source) return

  const destination = path.join(resourcesPath(buildPath, platform), "bin", platform === "win32" ? "opencode.exe" : "opencode")
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { force: true })
  if (platform !== "win32") await chmod(destination, 0o755)
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
