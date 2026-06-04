export const runtimeTargets = [
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
] as const

export type RuntimeTarget = (typeof runtimeTargets)[number]
export type RuntimeTargetId = RuntimeTarget["id"]

export const packageTargetIds = {
  all: ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"],
  linux: ["linux-x64"],
  mac: ["darwin-x64", "darwin-arm64"],
  "mac-arm64": ["darwin-arm64"],
  "mac-x64": ["darwin-x64"],
  opencode: ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"],
  win: ["win32-x64"],
  "win-zip": ["win32-x64"],
} as const satisfies Record<string, readonly RuntimeTargetId[]>

export type PrepareTarget = keyof typeof packageTargetIds

export function isPrepareTarget(value: string): value is PrepareTarget {
  return value in packageTargetIds
}

export function runtimeTargetById(id: string) {
  return runtimeTargets.find((target) => target.id === id)
}
