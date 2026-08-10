import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
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
import { showDesktopToast } from "../toast"

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
    const marketByRecordKey = createMemo(() => new Map(marketSkills().map((skill) => [catalogRecordKey(skill), skill])))
    const marketByKey = createMemo(() => new Map(marketSkills().map((skill) => [catalogLookupKey(skill), skill])))
    const activeArchivedSkills = createMemo(() => archivedSkills().filter((skill) => !marketByRecordKey().has(catalogRecordKey(skill))))
    const activeArchivedByKey = createMemo(() => new Map(activeArchivedSkills().map((skill) => [catalogLookupKey(skill), skill])))
    const archivedByKey = createMemo(() => new Map(activeArchivedSkills().map((skill) => [catalogLookupKey(skill), skill])))
    const catalogByKey = createMemo(() => new Map([...activeArchivedSkills(), ...marketSkills()].map((skill) => [catalogLookupKey(skill), skill])))
    const operationByKey = createMemo(() => new Map(operations().map((operation) => [operation.skillKey, operation])))
    const installedBundleDisplaySkill = (bundleKey: string, skills: InstalledSkill[]) => {
        const catalogSkill = marketByKey().get(bundleKey) ?? activeArchivedByKey().get(bundleKey)
        const first = skills[0]
        const skillNames = skills.map((skill) => skill.skillKey).toSorted((a, b) => a.localeCompare(b))
        return {
            bundleKey,
            bundleName: catalogSkill?.name ?? first.bundleName ?? bundleKey,
            bundleSkillNames: skillNames,
            bundleSkills: first.bundleSkills ?? skills.map((skill) => ({ skillID: skill.skillID, skillKey: skill.skillKey, version: skill.version })),
            bundleVersion: first.bundleVersion ?? first.version,
            canDelete: skills.some((skill) => skill.canDelete),
            description: catalogSkill?.description ?? first.description,
            downloadUrl: first.downloadUrl,
            enabled: skills.some((skill) => skill.enabled),
            fileName: first.fileName,
            fileSize: first.fileSize,
            installedAt: first.installedAt,
            location: first.location,
            managed: skills.every((skill) => skill.managed),
            name: catalogSkill?.name ?? first.bundleName ?? bundleKey,
            recordType: "bundle",
            sha256: first.sha256,
            skillID: first.skillID,
            skillKey: bundleKey,
            source: "market",
            updatedAt: first.updatedAt,
            version: first.bundleVersion ?? first.version,
        } satisfies InstalledSkill
    }
    const installedDisplaySkills = createMemo(() => {
        const bundles = installedSkills().reduce((result, skill) => {
            if (!skill.bundleKey) return result
            return result.set(skill.bundleKey, [...(result.get(skill.bundleKey) ?? []), skill])
        }, new Map<string, InstalledSkill[]>())
        return [
            ...[...bundles.entries()].map((entry) => installedBundleDisplaySkill(entry[0], entry[1])),
            ...installedSkills().filter((skill) => !skill.bundleKey),
        ].toSorted((a, b) => a.name.localeCompare(b.name))
    })
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
            skill.recordType,
            ...bundleSkillNames(skill),
        ])),
    )
    const visibleInstalledSkills = createMemo(() =>
        installedDisplaySkills().filter((skill) => matchesQuery([
            installedDisplayName(skill),
            skill.skillKey,
            skill.source,
            installedDescription(skill),
            skill.bundleKey ?? "",
            skill.bundleName ?? "",
            ...(skill.bundleSkillNames ?? []),
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
        const operationKey = clientSkillOperationKey(skill)
        if (operationByKey().has(operationKey)) return
        const action = marketStatus(skill) === "update_available" ? "更新" : "安装"
        await runWithBusyKey(operationKey, async () => {
            const result = await window.electronAPI.installSkill({
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
            })

            if (!result.success) {
                showDesktopToast({ description: result.error, title: `${action}失败`, variant: "error" })
                return
            }

            await reloadInstalledSkills()
            await refreshSkillCache()
            showDesktopToast({ description: `${skill.name} ${skill.version}`, title: `${action}成功`, variant: "success" })
        })
    }

    const deleteSkill = async (skill: InstalledSkill) => {
        if (!canDeleteInstalledSkill(skill)) return
        const operationKey = installedSkillOperationKey(skill)
        if (operationByKey().has(operationKey)) return
        await runWithBusyKey(operationKey, async () => {
            const result = await window.electronAPI.deleteSkill(
                skill.skillKey,
                skill.bundleKey && skill.recordType === "bundle"
                    ? { bundleKey: skill.bundleKey, bundleSkillKeys: skill.bundleSkillNames ?? [] }
                    : undefined,
            )
            if (!result.success) {
                showDesktopToast({ description: result.error, title: "删除失败", variant: "error" })
                return
            }

            await reloadInstalledSkills()
            await refreshSkillCache()
            showDesktopToast({ description: installedDisplayName(skill), title: "已删除", variant: "success" })
        })
    }

    const marketStatus = (skill: ClientSkill) => {
        if (operationByKey().has(clientSkillOperationKey(skill))) return "processing"
        if (skill.recordType === "bundle") return bundleMarketStatus(skill)
        const installed = installedByKey().get(skill.skillKey)
        if (!installed) return "not_installed"
        if (!installed.managed) return "unknown_local"
        if (compareVersions(skill.version, installed.version) > 0) return "update_available"
        return "installed"
    }

    const bundleMarketStatus = (skill: ClientSkill) => {
        const installed = installedBundleSkills(skill)
        if (!installed.length) return "not_installed"
        if (installed.some((item) => !item.managed)) return "unknown_local"
        if (compareVersions(skill.version, installedBundleVersion(installed)) > 0) return "update_available"
        return "installed"
    }

    const statusLabel = (skill: ClientSkill) => {
        const operation = operationByKey().get(clientSkillOperationKey(skill))
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
        const operation = operationByKey().get(clientSkillOperationKey(skill))
        if (operation) return operationLabel(operation)
        const status = marketStatus(skill)
        if (busyKeys().has(clientSkillOperationKey(skill))) return "处理中"
        if (status === "not_installed") return "安装"
        if (status === "update_available") return "更新"
        if (status === "unknown_local") return "本地"
        return "已安装"
    }

    const actionIcon = (skill: ClientSkill) => {
        if (busyKeys().has(clientSkillOperationKey(skill)) || operationByKey().has(clientSkillOperationKey(skill))) return LoaderCircle
        return marketStatus(skill) === "update_available" ? RefreshCw : Download
    }

    const canInstallMarketSkill = (skill: ClientSkill) => {
        if (operationByKey().has(clientSkillOperationKey(skill))) return false
        const status = marketStatus(skill)
        return status === "not_installed" || status === "update_available"
    }

    const installedBundleSkills = (skill: ClientSkill) =>
        installedSkills().filter((item) => item.bundleKey === clientSkillBundleKey(skill))

    const installedBundleVersion = (skills: InstalledSkill[]) =>
        skills.find((skill) => skill.bundleVersion)?.bundleVersion ?? skills[0]?.version ?? "unknown"

    const marketInstalledSkill = (skill: ClientSkill) => {
        if (skill.recordType !== "bundle") return installedByKey().get(skill.skillKey)
        const installed = installedBundleSkills(skill)
        if (!installed.length) return undefined
        return installedBundleDisplaySkill(clientSkillBundleKey(skill), installed)
    }

    const sourceLabel = (source: InstalledSkill["source"]) => {
        if (source === "market") return "市场"
        return "本地"
    }

    const catalogForInstalledSkill = (skill: InstalledSkill) => {
        if (skill.bundleKey) return marketByKey().get(skill.bundleKey) ?? activeArchivedByKey().get(skill.bundleKey)
        return catalogByKey().get(skill.skillKey)
    }

    const archivedForInstalledSkill = (skill: InstalledSkill) => {
        if (skill.bundleKey) return activeArchivedByKey().get(skill.bundleKey)
        return archivedByKey().get(skill.skillKey)
    }

    const installedStatusLabel = (skill: InstalledSkill) => {
        const operation = operationByKey().get(installedSkillOperationKey(skill))
        if (operation) return operationLabel(operation)
        if (archivedForInstalledSkill(skill)) return "已下架"
        if (catalogForInstalledSkill(skill)?.isRequired) return "必装"
        if (skill.bundleKey) return "技能包"
        return sourceLabel(skill.source)
    }

    const installedStatusClass = (skill: InstalledSkill) => {
        if (operationByKey().has(installedSkillOperationKey(skill))) return "processing"
        if (archivedForInstalledSkill(skill)) return "archived"
        if (catalogForInstalledSkill(skill)?.isRequired) return "required"
        return "installed"
    }

    const isRequiredInstalledSkill = (skill: InstalledSkill) => catalogForInstalledSkill(skill)?.isRequired === true

    const canDeleteInstalledSkill = (skill: InstalledSkill) =>
        skill.canDelete && !isRequiredInstalledSkill(skill) && !operationByKey().has(installedSkillOperationKey(skill))

    const deleteSkillTitle = (skill: InstalledSkill) => {
        if (busyKeys().has(installedSkillOperationKey(skill)) || operationByKey().has(installedSkillOperationKey(skill))) return "处理中"
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

    const bundleSkillCountLabel = (skill: ClientSkill) => {
        const count = skill.bundleMeta?.skillCount || bundleSkillNames(skill).length
        return count ? `${count} 个技能` : "技能包"
    }

    const bundleSkillNamesLabel = (skill: ClientSkill) => bundleSkillNames(skill).join(", ")

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
                                <p>{marketSkills().length} 个条目 · {installedDisplaySkills().length} 个已安装</p>
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
                                            const installed = marketInstalledSkill(skill)
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
                                                            <Show when={skill.recordType === "bundle"}>
                                                                <span>{bundleSkillCountLabel(skill)}</span>
                                                            </Show>
                                                            <Show when={skill.recordType === "bundle" && bundleSkillNamesLabel(skill)}>
                                                                <span>{bundleSkillNamesLabel(skill)}</span>
                                                            </Show>
                                                            <Show when={installed}>
                                                                {(item) => <span>当前 v{item().version}</span>}
                                                            </Show>
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        class="skill-market-action"
                                                        disabled={!canInstallMarketSkill(skill) || busyKeys().has(clientSkillOperationKey(skill))}
                                                        onClick={() => void installSkill(skill)}
                                                    >
                                                        <Icon
                                                            class={`sidebar-lucide-icon ${busyKeys().has(clientSkillOperationKey(skill)) || operationByKey().has(clientSkillOperationKey(skill)) ? "skill-market-spinner" : ""}`}
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
                                                        <Show when={skill.recordType === "bundle" && skill.bundleSkillNames?.length}>
                                                            {(count) => <span>{count()} 个技能</span>}
                                                        </Show>
                                                        <Show when={skill.bundleName ?? skill.bundleKey}>
                                                            {(item) => <span>{item()}</span>}
                                                        </Show>
                                                    </div>
                                                </div>
                                                <Show when={!isRequiredInstalledSkill(skill)}>
                                                    <div class="skill-market-row-actions">
                                                        <button
                                                            type="button"
                                                            class="skill-market-icon-button danger"
                                                            disabled={!canDeleteInstalledSkill(skill) || busyKeys().has(installedSkillOperationKey(skill))}
                                                            onClick={() => void deleteSkill(skill)}
                                                            title={deleteSkillTitle(skill)}
                                                            aria-label={deleteSkillTitle(skill)}
                                                        >
                                                            <Show
                                                                when={busyKeys().has(installedSkillOperationKey(skill)) || operationByKey().has(installedSkillOperationKey(skill))}
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

function catalogRecordKey(skill: ClientSkill) {
    return `${skill.recordType}:${catalogLookupKey(skill)}`
}

function catalogLookupKey(skill: ClientSkill) {
    return skill.recordType === "bundle" ? clientSkillBundleKey(skill) : skill.skillKey
}

function clientSkillBundleKey(skill: ClientSkill) {
    return skill.bundleKey ?? skill.bundleMeta?.bundleKey ?? skill.skillKey
}

function clientSkillOperationKey(skill: ClientSkill) {
    return skill.recordType === "bundle" ? clientSkillBundleKey(skill) : skill.skillKey
}

function installedSkillOperationKey(skill: InstalledSkill) {
    return skill.recordType === "bundle" && skill.bundleKey ? skill.bundleKey : skill.skillKey
}

function bundleSkillNames(skill: ClientSkill) {
    const skillNames = skill.bundleMeta?.skillNames.filter(Boolean) ?? []
    if (skillNames.length) return skillNames
    return skill.bundleMeta?.skills.map((item) => item.skillKey).filter(Boolean) ?? []
}
