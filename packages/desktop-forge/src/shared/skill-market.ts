export type SkillSource = "market" | "local"
export type SkillMarketOperationSource = "manual" | "auto-sync"
export type SkillMarketOperationType = "install" | "update" | "delete" | "archive-delete"

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
}

export interface SkillInstallRequest {
    skillID?: number
    skillKey: string
    name: string
    version: string
    description?: string
    downloadUrl: string
    sha256: string
    fileName?: string
    fileSize?: number
    manifest?: unknown
}

export interface SkillMarketOperationOptions {
    source?: SkillMarketOperationSource
    type?: SkillMarketOperationType
}

export interface SkillMarketOperation {
    skillKey: string
    type: SkillMarketOperationType
    source: SkillMarketOperationSource
    status: "running"
    startedAt: string
}

export type SkillOperationResult =
    | { success: true; skill: InstalledSkill }
    | { success: false; error: string }

export type SkillDeleteResult =
    | { success: true; skillKey: string }
    | { success: false; error: string }
