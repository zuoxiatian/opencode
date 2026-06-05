import type { ClientUpdatePrompt } from "../../shared/client-update"
import { CLIENT_OFFICIAL_URL, CLIENT_UPDATE_CHANNEL } from "../config"
import { listClientReleases, type ClientRelease } from "../api/releases"

export async function checkClientUpdate(): Promise<ClientUpdatePrompt | null> {
    const appInfo = await window.electronAPI.getAppInfo()
    if (!appInfo.platform || !appInfo.arch) return null

    const release = latestClientRelease(
        await listClientReleases({
            arch: appInfo.arch,
            channel: CLIENT_UPDATE_CHANNEL,
            platform: appInfo.platform,
        }),
        appInfo.version,
        appInfo.arch,
    )
    if (!release) return null

    return {
        changelog: release.changelog,
        currentVersion: appInfo.version,
        forceUpdate: release.forceUpdate,
        minVersion: release.minVersion,
        officialUrl: CLIENT_OFFICIAL_URL,
        title: release.title,
        version: release.version,
    }
}

function latestClientRelease(releases: ClientRelease[], currentVersion: string, currentArch: "x64" | "arm64") {
    return (releases
        .filter((release) => compareVersions(release.version, currentVersion) > 0)
        .toSorted((a, b) => compareVersions(b.version, a.version) || archPreference(b, currentArch) - archPreference(a, currentArch))[0]) ?? null
}

function archPreference(release: ClientRelease, currentArch: "x64" | "arm64") {
    if (release.arch === currentArch) return 2
    if (release.arch === "universal") return 1
    return 0
}

function compareVersions(next: string, current: string) {
    const nextParts = versionParts(next)
    const currentParts = versionParts(current)
    const length = Math.max(nextParts.length, currentParts.length)

    return Array.from({ length })
        .map((_, index) => (nextParts[index] ?? 0) - (currentParts[index] ?? 0))
        .find((diff) => diff !== 0) ?? 0
}

function versionParts(version: string) {
    return version
        .trim()
        .replace(/^v/i, "")
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map((part) => Number(part))
}
