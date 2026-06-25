export type SkillSource = "market" | "local"
export type SkillRecordType = "skill" | "bundle"
export type SkillMarketOperationSource = "manual" | "auto-sync"
export type SkillMarketOperationType = "install" | "update" | "delete" | "archive-delete"

export interface SkillBundleMember {
    skillID?: number
    skillKey: string
    name?: string
    version?: string
}

export interface SkillBundleMeta {
    bundleKey: string
    bundleName: string
    bundleVersion: string
    zipFileName: string
    zipSha256: string
    skillCount: number
    skillNames: string[]
    skills: SkillBundleMember[]
    uploadedAt: string
}

export interface SkillBundleHistoryItem {
    type: string
    bundleVersion: string
    zipSha256: string
    skillCount: number
    skillNames: string[]
    skills: SkillBundleMember[]
    uploadedAt: string
}

export interface InstalledSkill {
    skillKey: string
    name: string
    version: string
    description?: string
    source: SkillSource
    enabled: boolean
    managed: boolean
    canDelete: boolean
    location: string
    sha256?: string
    fileName?: string
    fileSize?: number
    downloadUrl?: string
    installedAt?: string
    updatedAt?: string
    deletedAt?: string
    skillID?: number
    recordType: SkillRecordType
    bundleKey?: string
    bundleName?: string
    bundleVersion?: string
    bundleSkillNames?: string[]
    bundleSkills?: SkillBundleMember[]
}

export interface SkillInstallRequest {
    skillID?: number
    recordType?: SkillRecordType
    skillKey: string
    name: string
    version: string
    description?: string
    downloadUrl: string
    sha256: string
    fileName?: string
    fileSize?: number
    manifest?: unknown
    bundleKey?: string | null
    bundleMeta?: SkillBundleMeta | null
    bundleHistory?: SkillBundleHistoryItem[] | null
}

export interface SkillMarketOperationOptions {
    source?: SkillMarketOperationSource
    type?: SkillMarketOperationType
    bundleKey?: string
    bundleSkillKeys?: string[]
}

export interface SkillMarketOperation {
    skillKey: string
    type: SkillMarketOperationType
    source: SkillMarketOperationSource
    status: "running"
    startedAt: string
}

export type SkillOperationResult =
    | { success: true; skills: InstalledSkill[] }
    | { success: false; error: string }

export type SkillDeleteResult =
    | { success: true; skillKey: string }
    | { success: false; error: string }
