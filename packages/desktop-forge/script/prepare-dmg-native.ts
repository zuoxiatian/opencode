import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { run } from "./lib/run.ts"

const require = createRequire(import.meta.url)

if (process.platform !== "darwin") {
  console.log("Skipping DMG native dependency build; DMG maker only runs on macOS.")
  process.exit(0)
}

const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js")
const makerDmg = require.resolve("@electron-forge/maker-dmg")
const electronInstallerDmg = require.resolve("electron-installer-dmg/package.json", { paths: [makerDmg] })
const appdmg = require.resolve("appdmg/package.json", { paths: [electronInstallerDmg] })
const dsStore = require.resolve("ds-store/package.json", { paths: [appdmg] })
const nativePackages = [
  {
    name: "fs-xattr",
    packageJson: require.resolve("fs-xattr/package.json", { paths: [appdmg] }),
    artifact: path.join("build", "Release", "xattr.node"),
  },
  {
    name: "macos-alias",
    packageJson: require.resolve("macos-alias/package.json", { paths: [dsStore] }),
    artifact: path.join("build", "Release", "volume.node"),
  },
]

for (const item of nativePackages) {
  const packageDir = path.dirname(item.packageJson)
  if (existsSync(path.join(packageDir, item.artifact))) {
    console.log(`${item.name} native module already built.`)
    continue
  }

  await run([process.execPath, nodeGyp, "rebuild"], { cwd: packageDir })
}
