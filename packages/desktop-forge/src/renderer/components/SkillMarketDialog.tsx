import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { showToast } from "@opencode-ai/ui/toast"
import Download from "lucide-solid/icons/download"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Package from "lucide-solid/icons/package"
import RefreshCw from "lucide-solid/icons/refresh-cw"
import Search from "lucide-solid/icons/search"
import Trash2 from "lucide-solid/icons/trash-2"
import X from "lucide-solid/icons/x"
import type { InstalledSkill, SkillMarketOperation } from "../../shared/skill-market"
import { listClientSkillCatalog, type ClientSkill } from "../api/skills"
import { useSDK } from "../context/sdk"

type SkillMarketTab = "market" | "installed"

interface SkillMarketDialogProps {
    onClose: () => void
}

const tabOptions = [
    { tab: "market", label: "市场" },
    { tab: "installed", label: "已安装" },
] as const

export function SkillMarketDialog(props: SkillMarketDialogProps) {
    const sdk = useSDK()
    const [tab, setTab] = createSignal<SkillMarketTab>("market")
    const [query, setQuery] = createSignal("")
    const [marketSkills, setMarketSkills] = createSignal<ClientSkill[]>([])
    const [archivedSkills, setArchivedSkills] = createSignal<ClientSkill[]>([])
    const [installedSkills, setInstalledSkills] = createSignal<InstalledSkill[]>([])
    const [operations, setOperations] = createSignal<SkillMarketOperation[]>([])
    const [loading, setLoading] = createSignal(true)
    const [error, setError] = createSignal("")
    const [busyKeys, setBusyKeys] = createSignal<Set<string>>(new Set())
    let searchInput: HTMLInputElement | undefined

    const installedByKey = createMemo(() => new Map(installedSkills().map((skill) => [skill.skillKey, skill])))
    const marketByKey = createMemo(() => new Map(marketSkills().map((skill) => [skill.skillKey, skill])))
    const activeArchivedSkills = createMemo(() => archivedSkills().filter((skill) => !marketByKey().has(skill.skillKey)))
    const archivedByKey = createMemo(() => new Map(activeArchivedSkills().map((skill) => [skill.skillKey, skill])))
    const catalogByKey = createMemo(() => new Map([...activeArchivedSkills(), ...marketSkills()].map((skill) => [skill.skillKey, skill])))
    const operationByKey = createMemo(() => new Map(operations().map((operation) => [operation.skillKey, operation])))
    const installedDisplayName = (skill: InstalledSkill) => catalogByKey().get(skill.skillKey)?.name ?? skill.name
    const installedDescription = (skill: InstalledSkill) => {
        const catalogSkill = catalogByKey().get(skill.skillKey)
        if (catalogSkill) return catalogSkill.description ?? ""
        return skill.description ?? ""
    }
    const normalizedQuery = () => query().trim().toLowerCase()
    const visibleMarketSkills = createMemo(() =>
        marketSkills().filter((skill) => matchesQuery([
            skill.name,
            skill.skillKey,
            skill.category ?? "",
            skill.description ?? "",
        ])),
    )
    const visibleInstalledSkills = createMemo(() =>
        installedSkills().filter((skill) => matchesQuery([
            installedDisplayName(skill),
            skill.skillKey,
            skill.source,
            installedDescription(skill),
        ])),
    )

    onMount(() => {
        void loadSkills()
        void window.electronAPI.listSkillOperations().then(updateSkillOperations)
        const unsubscribeSkillOperations = window.electronAPI.onSkillOperationsChanged(updateSkillOperations)
        onCleanup(unsubscribeSkillOperations)
        queueMicrotask(() => searchInput?.focus())
    })

    createEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            event.preventDefault()
            props.onClose()
        }
        document.addEventListener("keydown", handleKeyDown)
        onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
    })

    const matchesQuery = (values: string[]) => {
        const value = normalizedQuery()
        if (!value) return true
        return values.some((item) => item.toLowerCase().includes(value))
    }

    const loadSkills = async () => {
        setLoading(true)
        setError("")
        await Promise.all([
            listClientSkillCatalog(),
            window.electronAPI.listInstalledSkills(),
        ])
            .then(([catalog, installed]) => {
                setArchivedSkills(catalog.archivedSkills)
                setMarketSkills(catalog.skills)
                setInstalledSkills(installed)
            })
            .catch((loadError: unknown) => {
                setError(loadError instanceof Error ? loadError.message : String(loadError))
            })
            .finally(() => setLoading(false))
    }

    const reloadInstalledSkills = async () => {
        setInstalledSkills(await window.electronAPI.listInstalledSkills())
    }

    const updateSkillOperations = (next: SkillMarketOperation[]) => {
        const nextKeys = new Set(next.map((operation) => operation.skillKey))
        const completed = operations().some((operation) => !nextKeys.has(operation.skillKey))
        setOperations(next)
        if (completed) void reloadInstalledSkills()
    }

    const refreshSkillCache = async () => {
        await sdk.client.global.dispose({ throwOnError: true }).catch((disposeError: unknown) => {
            console.error("刷新技能缓存失败:", disposeError)
        })
    }

    const runWithBusyKey = async (key: string, task: () => Promise<void>) => {
        if (busyKeys().has(key)) return
        setBusyKeys((prev) => new Set(prev).add(key))
        await task().finally(() => setBusyKeys((prev) => new Set([...prev].filter((item) => item !== key))))
    }

    const installSkill = async (skill: ClientSkill) => {
        if (operationByKey().has(skill.skillKey)) return
        const installed = installedByKey().get(skill.skillKey)
        const action = installed ? "更新" : "安装"
        await runWithBusyKey(skill.skillKey, async () => {
            const result = await window.electronAPI.installSkill({
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
            })

            if (!result.success) {
                showToast({ description: result.error, title: `${action}失败`, variant: "error" })
                return
            }

            await reloadInstalledSkills()
            await refreshSkillCache()
            showToast({ description: `${skill.name} ${skill.version}`, title: `${action}成功`, variant: "success" })
        })
    }

    const deleteSkill = async (skill: InstalledSkill) => {
        if (!canDeleteInstalledSkill(skill)) return
        if (operationByKey().has(skill.skillKey)) return
        await runWithBusyKey(skill.skillKey, async () => {
            const result = await window.electronAPI.deleteSkill(skill.skillKey)
            if (!result.success) {
                showToast({ description: result.error, title: "删除失败", variant: "error" })
                return
            }

            await reloadInstalledSkills()
            await refreshSkillCache()
            showToast({ description: installedDisplayName(skill), title: "已删除", variant: "success" })
        })
    }

    const marketStatus = (skill: ClientSkill) => {
        if (operationByKey().has(skill.skillKey)) return "processing"
        const installed = installedByKey().get(skill.skillKey)
        if (!installed) return "not_installed"
        if (!installed.managed) return "unknown_local"
        if (compareVersions(skill.version, installed.version) > 0) return "update_available"
        return "installed"
    }

    const statusLabel = (skill: ClientSkill) => {
        const operation = operationByKey().get(skill.skillKey)
        if (operation) return operationLabel(operation)
        const status = marketStatus(skill)
        if (skill.isRequired && status === "update_available") return "必装更新"
        if (skill.isRequired) return "必装"
        if (status === "not_installed") return "未安装"
        if (status === "update_available") return "可更新"
        if (status === "unknown_local") return "本地安装"
        return "已安装"
    }

    const actionLabel = (skill: ClientSkill) => {
        const operation = operationByKey().get(skill.skillKey)
        if (operation) return operationLabel(operation)
        const status = marketStatus(skill)
        if (busyKeys().has(skill.skillKey)) return "处理中"
        if (status === "not_installed") return "安装"
        if (status === "update_available") return "更新"
        if (status === "unknown_local") return "本地"
        return "已安装"
    }

    const actionIcon = (skill: ClientSkill) => {
        if (busyKeys().has(skill.skillKey) || operationByKey().has(skill.skillKey)) return LoaderCircle
        return marketStatus(skill) === "update_available" ? RefreshCw : Download
    }

    const canInstallMarketSkill = (skill: ClientSkill) => {
        if (operationByKey().has(skill.skillKey)) return false
        const status = marketStatus(skill)
        return status === "not_installed" || status === "update_available"
    }

    const sourceLabel = (source: InstalledSkill["source"]) => {
        if (source === "market") return "市场"
        return "本地"
    }

    const installedStatusLabel = (skill: InstalledSkill) => {
        const operation = operationByKey().get(skill.skillKey)
        if (operation) return operationLabel(operation)
        if (archivedByKey().has(skill.skillKey)) return "已下架"
        if (marketByKey().get(skill.skillKey)?.isRequired) return "必装"
        return sourceLabel(skill.source)
    }

    const installedStatusClass = (skill: InstalledSkill) => {
        if (operationByKey().has(skill.skillKey)) return "processing"
        if (archivedByKey().has(skill.skillKey)) return "archived"
        if (marketByKey().get(skill.skillKey)?.isRequired) return "required"
        return "installed"
    }

    const isRequiredInstalledSkill = (skill: InstalledSkill) => marketByKey().get(skill.skillKey)?.isRequired === true

    const canDeleteInstalledSkill = (skill: InstalledSkill) =>
        skill.canDelete && !isRequiredInstalledSkill(skill) && !operationByKey().has(skill.skillKey)

    const deleteSkillTitle = (skill: InstalledSkill) => {
        if (busyKeys().has(skill.skillKey) || operationByKey().has(skill.skillKey)) return "处理中"
        return "删除"
    }

    const operationLabel = (operation: SkillMarketOperation) => {
        if (operation.type === "install") return "安装中"
        if (operation.type === "update") return "更新中"
        if (operation.type === "archive-delete") return "下架删除中"
        return "删除中"
    }

    const fileSizeLabel = (size: number) => {
        if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
        return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    return (
        <Portal>
            <div class="skill-market-root">
                <button type="button" class="settings-dialog-backdrop" aria-label="关闭技能市场" onClick={props.onClose} />
                <div class="skill-market-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-market-title">
                    <header class="skill-market-header">
                        <div class="skill-market-heading">
                            <Package class="skill-market-heading-icon" size={19} strokeWidth={1.85} />
                            <div>
                                <h2 id="skill-market-title">技能市场</h2>
                                <p>{marketSkills().length} 个技能 · {installedSkills().length} 个已安装</p>
                            </div>
                        </div>
                        <button type="button" class="settings-dialog-close" onClick={props.onClose} title="关闭" aria-label="关闭">
                            <X class="sidebar-lucide-icon" size={16} strokeWidth={1.9} />
                        </button>
                    </header>

                    <div class="skill-market-toolbar">
                        <div class="skill-market-tabs" role="tablist" aria-label="技能列表">
                            <For each={tabOptions}>
                                {(item) => (
                                    <button
                                        type="button"
                                        class="skill-market-tab"
                                        classList={{ active: tab() === item.tab }}
                                        onClick={() => setTab(item.tab)}
                                        role="tab"
                                        aria-selected={tab() === item.tab}
                                    >
                                        {item.label}
                                    </button>
                                )}
                            </For>
                        </div>
                        <label class="skill-market-search">
                            <Search class="skill-market-search-icon" size={15} strokeWidth={1.85} />
                            <input
                                ref={searchInput}
                                value={query()}
                                onInput={(event) => setQuery(event.currentTarget.value)}
                                placeholder="搜索技能"
                            />
                        </label>
                        <button
                            type="button"
                            class="skill-market-icon-button"
                            disabled={loading()}
                            onClick={() => void loadSkills()}
                            title="刷新"
                            aria-label="刷新"
                        >
                            <RefreshCw class="sidebar-lucide-icon" size={15} strokeWidth={1.85} />
                        </button>
                    </div>

                    <main class="skill-market-content">
                        <Show when={loading()}>
                            <div class="skill-market-empty">
                                <LoaderCircle class="skill-market-spinner" size={18} strokeWidth={2} />
                                <span>加载中</span>
                            </div>
                        </Show>
                        <Show when={!loading() && error()}>
                            <div class="skill-market-empty error">{error()}</div>
                        </Show>
                        <Show when={!loading() && !error() && tab() === "market"}>
                            <Show when={visibleMarketSkills().length > 0} fallback={<div class="skill-market-empty">暂无技能</div>}>
                                <div class="skill-market-list">
                                    <For each={visibleMarketSkills()}>
                                        {(skill) => {
                                            const Icon = actionIcon(skill)
                                            const installed = installedByKey().get(skill.skillKey)
                                            return (
                                                <article class="skill-market-row">
                                                    <div class="skill-market-row-main">
                                                        <div class="skill-market-row-title">
                                                            <span>{skill.name}</span>
                                                            <span class={`skill-market-status ${marketStatus(skill)} ${skill.isRequired ? "required" : ""}`}>{statusLabel(skill)}</span>
                                                        </div>
                                                        <div class="skill-market-row-description">{skill.description || "暂无描述"}</div>
                                                        <div class="skill-market-meta">
                                                            <span>{skill.skillKey}</span>
                                                            <span>v{skill.version}</span>
                                                            <span>{skill.category || "未分类"}</span>
                                                            <span>{skill.platform}</span>
                                                            <span>{fileSizeLabel(skill.fileSize)}</span>
                                                            <Show when={installed}>
                                                                {(item) => <span>当前 v{item().version}</span>}
                                                            </Show>
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        class="skill-market-action"
                                                        disabled={!canInstallMarketSkill(skill) || busyKeys().has(skill.skillKey)}
                                                        onClick={() => void installSkill(skill)}
                                                    >
                                                        <Icon
                                                            class={`sidebar-lucide-icon ${busyKeys().has(skill.skillKey) || operationByKey().has(skill.skillKey) ? "skill-market-spinner" : ""}`}
                                                            size={15}
                                                            strokeWidth={1.9}
                                                        />
                                                        <span>{actionLabel(skill)}</span>
                                                    </button>
                                                </article>
                                            )
                                        }}
                                    </For>
                                </div>
                            </Show>
                        </Show>
                        <Show when={!loading() && !error() && tab() === "installed"}>
                            <Show when={visibleInstalledSkills().length > 0} fallback={<div class="skill-market-empty">暂无已安装技能</div>}>
                                <div class="skill-market-list">
                                    <For each={visibleInstalledSkills()}>
                                        {(skill) => (
                                            <article class="skill-market-row">
                                                <div class="skill-market-row-main">
                                                    <div class="skill-market-row-title">
                                                        <span>{installedDisplayName(skill)}</span>
                                                        <span class={`skill-market-status ${installedStatusClass(skill)}`}>{installedStatusLabel(skill)}</span>
                                                    </div>
                                                    <div class="skill-market-row-description">{installedDescription(skill) || "暂无描述"}</div>
                                                    <div class="skill-market-meta">
                                                        <span>{skill.skillKey}</span>
                                                        <span>v{skill.version}</span>
                                                        <span>{skill.managed ? "受管理" : "本地"}</span>
                                                    </div>
                                                </div>
                                                <Show when={!isRequiredInstalledSkill(skill)}>
                                                    <div class="skill-market-row-actions">
                                                        <button
                                                            type="button"
                                                            class="skill-market-icon-button danger"
                                                            disabled={!canDeleteInstalledSkill(skill) || busyKeys().has(skill.skillKey)}
                                                            onClick={() => void deleteSkill(skill)}
                                                            title={deleteSkillTitle(skill)}
                                                            aria-label={deleteSkillTitle(skill)}
                                                        >
                                                            <Show
                                                                when={busyKeys().has(skill.skillKey) || operationByKey().has(skill.skillKey)}
                                                                fallback={<Trash2 class="sidebar-lucide-icon" size={15} strokeWidth={1.85} />}
                                                            >
                                                                <LoaderCircle class="sidebar-lucide-icon skill-market-spinner" size={15} strokeWidth={2} />
                                                            </Show>
                                                        </button>
                                                    </div>
                                                </Show>
                                            </article>
                                        )}
                                    </For>
                                </div>
                            </Show>
                        </Show>
                    </main>
                </div>
            </div>
        </Portal>
    )
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
