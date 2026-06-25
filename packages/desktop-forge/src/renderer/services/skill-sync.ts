import type { InstalledSkill, SkillInstallRequest, SkillMarketOperationOptions } from "../../shared/skill-market"
import { listClientSkillCatalog, type ClientSkill } from "../api/skills"

export interface SkillSyncSummary {
    archivedDeleted: number
    requiredInstalled: number
    requiredUpdated: number
    errors: string[]
}

type RequiredSkillAction = "install" | "update" | "none"
type ArchivedDeleteRequest = {
    skillKey: string
    skillKeys: string[]
    options: SkillMarketOperationOptions
}

export async function syncRequiredClientSkills() {
    const [catalog, installed] = await Promise.all([
        listClientSkillCatalog(),
        window.electronAPI.listInstalledSkills(),
    ])
    const installedByKey = new Map(installed.map((skill) => [skill.skillKey, skill]))
    const publishedKeys = new Set(catalog.skills.map(catalogRecordKey))
    const activeArchivedSkills = catalog.archivedSkills.filter((skill) => !publishedKeys.has(catalogRecordKey(skill)))
    const archivedKeys = new Set(activeArchivedSkills.map(catalogRecordKey))
    const archivedRequests = activeArchivedSkills.flatMap((skill) =>
        archivedDeleteRequests(skill, installed, installedByKey))
    const archivedResults = await Promise.all(
        archivedRequests.map((request) => window.electronAPI.deleteSkill(request.skillKey, request.options)
            .then((result) => ({ request, result }))),
    )
    archivedResults.forEach((item) => {
        if (!item.result.success) return
        item.request.skillKeys.forEach((skillKey) => installedByKey.delete(skillKey))
    })

    const requiredPlan = catalog.skills
        .filter((skill) => skill.isRequired && !archivedKeys.has(catalogRecordKey(skill)))
        .map((skill) => ({
            action: requiredSkillAction(skill, installed, installedByKey),
            skill,
        }))
    const installResults = await Promise.all(
        requiredPlan
            .filter((item) => item.action === "install" || item.action === "update")
            .map((item) => window.electronAPI.installSkill(skillInstallRequest(item.skill), { source: "auto-sync" })
                .then((result) => ({ action: item.action, result, skill: item.skill }))),
    )

    return {
        archivedDeleted: archivedResults.filter((item) => item.result.success).length,
        errors: [
            ...archivedResults.map((item) => item.result.success ? undefined : item.result.error).filter(isDefined),
            ...installResults.map((item) => item.result.success ? undefined : item.result.error).filter(isDefined),
        ],
        requiredInstalled: installResults.filter((item) => item.action === "install" && item.result.success).length,
        requiredUpdated: installResults.filter((item) => item.action === "update" && item.result.success).length,
    } satisfies SkillSyncSummary
}

function requiredSkillAction(
    skill: ClientSkill,
    installed: InstalledSkill[],
    installedByKey: Map<string, InstalledSkill>,
): RequiredSkillAction {
    if (skill.recordType === "bundle") return requiredBundleAction(skill, installed)

    const current = installedByKey.get(skill.skillKey)
    if (!current) return "install"
    if (!current.managed) return "update"
    if (compareVersions(skill.version, current.version) > 0) return "update"
    return "none"
}

function requiredBundleAction(skill: ClientSkill, installed: InstalledSkill[]) {
    const installedSkills = installed.filter((item) => item.bundleKey === clientSkillBundleKey(skill))
    if (!installedSkills.length) return "install"
    if (installedSkills.some((item) => !item.managed)) return "update"
    if (compareVersions(skill.version, installedBundleVersion(installedSkills)) > 0) return "update"
    return "none"
}

function archivedDeleteRequests(
    skill: ClientSkill,
    installed: InstalledSkill[],
    installedByKey: Map<string, InstalledSkill>,
): ArchivedDeleteRequest[] {
    if (skill.recordType === "bundle") {
        const skills = installed
            .filter((item) => item.bundleKey === clientSkillBundleKey(skill))
            .filter(uniqueInstalledSkill)
            .filter(isManagedInstalledSkill)
        if (!skills.length) return []
        return [{
            options: {
                bundleKey: clientSkillBundleKey(skill),
                bundleSkillKeys: skills.map((item) => item.skillKey),
                source: "auto-sync",
                type: "archive-delete",
            },
            skillKey: clientSkillBundleKey(skill),
            skillKeys: skills.map((item) => item.skillKey),
        }]
    }

    const current = installedByKey.get(skill.skillKey)
    if (!isManagedInstalledSkill(current)) return []
    return [{
        options: { source: "auto-sync", type: "archive-delete" },
        skillKey: current.skillKey,
        skillKeys: [current.skillKey],
    }]
}

function catalogRecordKey(skill: ClientSkill) {
    return `${skill.recordType}:${skill.recordType === "bundle" ? clientSkillBundleKey(skill) : skill.skillKey}`
}

function clientSkillBundleKey(skill: ClientSkill) {
    return skill.bundleKey ?? skill.bundleMeta?.bundleKey ?? skill.skillKey
}

function installedBundleVersion(skills: InstalledSkill[]) {
    return skills.find((skill) => skill.bundleVersion)?.bundleVersion ?? skills[0]?.version ?? "unknown"
}

function uniqueInstalledSkill(skill: InstalledSkill, index: number, skills: InstalledSkill[]) {
    return skills.findIndex((item) => item.skillKey === skill.skillKey) === index
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined
}

function isManagedInstalledSkill(skill: InstalledSkill | undefined): skill is InstalledSkill {
    return skill?.canDelete === true
}

function skillInstallRequest(skill: ClientSkill): SkillInstallRequest {
    return {
        bundleHistory: skill.bundleHistory,
        bundleKey: clientSkillBundleKey(skill),
        bundleMeta: skill.bundleMeta,
        description: skill.description ?? undefined,
        downloadUrl: skill.downloadUrl,
        fileName: skill.fileName,
        fileSize: skill.fileSize,
        manifest: skill.manifest,
        name: skill.name,
        recordType: skill.recordType,
        sha256: skill.sha256,
        skillID: skill.id,
        skillKey: skill.skillKey,
        version: skill.version,
    }
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
