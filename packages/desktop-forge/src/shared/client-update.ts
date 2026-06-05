export type ClientUpdatePrompt = {
    changelog: string | null
    currentVersion: string
    forceUpdate: boolean
    minVersion: string | null
    officialUrl: string
    title: string | null
    version: string
}

export type ClientAppInfo = {
    arch: "x64" | "arm64" | null
    platform: "mac" | "win" | null
    version: string
}
