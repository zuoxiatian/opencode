import type { InstalledSkill, SkillInstallRequest } from "../../shared/skill-market"
import { listClientSkillCatalog, type ClientSkill } from "../api/skills"

export interface SkillSyncSummary {
    archivedDeleted: number
    requiredInstalled: number
    requiredUpdated: number
    errors: string[]
}

type RequiredSkillAction = "install" | "update" | "none"

export async function syncRequiredClientSkills() {
    const [catalog, installed] = await Promise.all([
        listClientSkillCatalog(),
        window.electronAPI.listInstalledSkills(),
    ])
    const installedByKey = new Map(installed.map((skill) => [skill.skillKey, skill]))
    const publishedKeys = new Set(catalog.skills.map((skill) => skill.skillKey))
    const activeArchivedSkills = catalog.archivedSkills.filter((skill) => !publishedKeys.has(skill.skillKey))
    const archivedKeys = new Set(activeArchivedSkills.map((skill) => skill.skillKey))
    const archivedResults = await Promise.all(
        activeArchivedSkills
            .map((skill) => installedByKey.get(skill.skillKey))
            .filter(isManagedInstalledSkill)
            .map((skill) => window.electronAPI.deleteSkill(skill.skillKey, { source: "auto-sync", type: "archive-delete" })),
    )
    archivedResults.forEach((result) => {
        if (!result.success) return
        installedByKey.delete(result.skillKey)
    })

    const requiredPlan = catalog.skills
        .filter((skill) => skill.isRequired && !archivedKeys.has(skill.skillKey))
        .map((skill) => ({
            action: requiredSkillAction(skill, installedByKey.get(skill.skillKey)),
            skill,
        }))
    const installResults = await Promise.all(
        requiredPlan
            .filter((item) => item.action === "install" || item.action === "update")
            .map((item) => window.electronAPI.installSkill(skillInstallRequest(item.skill), { source: "auto-sync" })
                .then((result) => ({ action: item.action, result, skill: item.skill }))),
    )

    return {
        archivedDeleted: archivedResults.filter((result) => result.success).length,
        errors: [
            ...archivedResults.map((result) => result.success ? undefined : result.error).filter(isDefined),
            ...installResults.map((item) => item.result.success ? undefined : item.result.error).filter(isDefined),
        ],
        requiredInstalled: installResults.filter((item) => item.action === "install" && item.result.success).length,
        requiredUpdated: installResults.filter((item) => item.action === "update" && item.result.success).length,
    } satisfies SkillSyncSummary
}

function requiredSkillAction(skill: ClientSkill, installed: InstalledSkill | undefined): RequiredSkillAction {
    if (!installed) return "install"
    if (!installed.managed) return "update"
    if (compareVersions(skill.version, installed.version) > 0) return "update"
    return "none"
}

function isManagedInstalledSkill(skill: InstalledSkill | undefined): skill is InstalledSkill {
    return skill?.canDelete === true
}

function skillInstallRequest(skill: ClientSkill): SkillInstallRequest {
    return {
        description: skill.description ?? undefined,
        downloadUrl: skill.downloadUrl,
        fileName: skill.fileName,
        fileSize: skill.fileSize,
        manifest: skill.manifest,
        name: skill.name,
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

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined
}
