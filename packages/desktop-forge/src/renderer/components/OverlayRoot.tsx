import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { showToast, toaster, Toast } from "@opencode-ai/ui/toast"
import X from "lucide-solid/icons/x"
import type { ModalOverlayContentSize, OverlayState, SidebarDialogOverlayData } from "../../shared/overlay"
import { SDKProvider } from "../context/sdk"
import { SkillMarketDialog } from "./SkillMarketDialog"
import { SettingsOverlay } from "./SettingsOverlay"
import { getSystemTheme, readStoredThemeMode, resolveThemeMode, THEME_STORAGE_KEY } from "../theme"

export function OverlayRoot() {
    if (new URLSearchParams(window.location.search).get("overlay") === "toast") return <ToastOverlay />
    return <ModalOverlay />
}

function ModalOverlay() {
    const [state, setState] = createSignal<OverlayState | null>(null)
    const [revision, setRevision] = createSignal(0)
    let pendingRevision = 0
    let renderedRevision = 0

    const rendered = (contentSize?: ModalOverlayContentSize) => {
        if (revision() !== pendingRevision || renderedRevision === revision()) return
        renderedRevision = revision()
        void window.electronAPI.modalOverlayRendered(revision(), contentSize)
    }

    onMount(() => {
        const unsubscribe = window.electronAPI.onModalOverlayState((payload) => {
            pendingRevision = payload.revision
            const mode = payload.state.kind === "settings" ? payload.state.data.themeMode : readStoredThemeMode()
            void syncModalOverlayTheme(mode).then(() => {
                if (pendingRevision !== payload.revision) return
                setRevision(payload.revision)
                setState(payload.state)
                if (payload.state.kind !== "image-preview" && payload.state.kind !== "sidebar-dialog") queueMicrotask(rendered)
            })
        })
        void window.electronAPI.readyModalOverlay()
        onCleanup(unsubscribe)
    })

    return (
        <Show keyed when={state()}>
            {(current) => (
                <Switch>
                    <Match when={current.kind === "settings"}>
                        <SettingsOverlay
                            data={(current as Extract<OverlayState, { kind: "settings" }>).data}
                            onClose={() => void window.electronAPI.closeOverlay()}
                        />
                    </Match>
                    <Match when={current.kind === "skill-market"}>
                        <SDKProvider serverInfo={(current as Extract<OverlayState, { kind: "skill-market" }>).data.serverInfo}>
                            <SkillMarketDialog onClose={() => void window.electronAPI.closeOverlay()} />
                        </SDKProvider>
                    </Match>
                    <Match when={current.kind === "image-preview"}>
                        <ImagePreviewOverlay
                            data={(current as Extract<OverlayState, { kind: "image-preview" }>).data}
                            onReady={rendered}
                        />
                    </Match>
                    <Match when={current.kind === "sidebar-dialog"}>
                        <SidebarDialogOverlay
                            data={(current as Extract<OverlayState, { kind: "sidebar-dialog" }>).data}
                            onReady={rendered}
                        />
                    </Match>
                </Switch>
            )}
        </Show>
    )
}

function ToastOverlay() {
    onMount(() => {
        let observedList: Element | null = null
        let activeToast: ReturnType<typeof showToast> | null = null
        let revision = 0
        const resize = () => {
            const list = document.querySelector('[data-component="toast-region"] [data-slot="toast-list"]')
            if (list && list !== observedList) {
                observedList = list
                resizeObserver.observe(list)
            }
            const items = list
                ? Array.from(list.children).filter((item): item is HTMLElement =>
                    item instanceof HTMLElement && !(
                        document.documentElement.dataset.toastReplacing === "true" &&
                        item.hasAttribute("data-closed")
                    ))
                : []
            const gap = list ? Number.parseFloat(getComputedStyle(list).rowGap) || 0 : 0
            const height = items.reduce(
                (total, item) => total + Math.max(item.getBoundingClientRect().height, item.scrollHeight),
                0,
            ) + Math.max(items.length - 1, 0) * gap
            if (height === 0) activeToast = null
            void window.electronAPI.resizeToastOverlay(revision, height)
        }
        const resizeObserver = new ResizeObserver(resize)
        const mutationObserver = new MutationObserver(resize)
        mutationObserver.observe(document.body, {
            attributeFilter: ["data-closed", "data-opened"],
            attributes: true,
            childList: true,
            subtree: true,
        })
        const unsubscribe = window.electronAPI.onOverlayToast((state) => {
            revision = state.revision
            syncToastOverlayTheme()
            if (activeToast !== null) {
                document.documentElement.dataset.toastReplacing = "true"
                toaster.dismiss(activeToast)
                window.setTimeout(() => delete document.documentElement.dataset.toastReplacing, 150)
            }
            activeToast = showToast({ ...state.toast, persistent: true })
            queueMicrotask(resize)
        })
        const unsubscribeDismiss = window.electronAPI.onOverlayToastDismiss((targetRevision) => {
            if (targetRevision !== revision || activeToast === null) return
            toaster.dismiss(activeToast)
        })
        const media = window.matchMedia("(prefers-color-scheme: light)")
        const syncTheme = () => syncToastOverlayTheme()
        const syncStoredTheme = (event: StorageEvent) => {
            if (event.key === THEME_STORAGE_KEY) syncToastOverlayTheme()
        }
        syncTheme()
        media.addEventListener("change", syncTheme)
        window.addEventListener("storage", syncStoredTheme)
        void window.electronAPI.readyToastOverlay()
        queueMicrotask(resize)
        onCleanup(() => {
            unsubscribe()
            unsubscribeDismiss()
            media.removeEventListener("change", syncTheme)
            window.removeEventListener("storage", syncStoredTheme)
            resizeObserver.disconnect()
            mutationObserver.disconnect()
            void window.electronAPI.resizeToastOverlay(revision, 0)
        })
    })

    return <Toast.Region />
}

async function syncModalOverlayTheme(mode: "dark" | "light" | "system") {
    applyOverlayTheme(mode, await window.electronAPI.setThemeMode(mode))
}

function syncToastOverlayTheme() {
    const mode = readStoredThemeMode()
    applyOverlayTheme(mode, resolveThemeMode(mode, getSystemTheme()))
}

function applyOverlayTheme(mode: "dark" | "light" | "system", theme: "dark" | "light") {
    document.documentElement.dataset.themeMode = mode
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
}

function ImagePreviewOverlay(props: {
    data: { filename?: string; mime: string; url: string }
    onReady: (contentSize: ModalOverlayContentSize) => void
}) {
    let dialog: HTMLDivElement | undefined
    const close = () => void window.electronAPI.closeOverlay()
    onMount(() => {
        queueMicrotask(() => dialog?.focus({ preventScroll: true }))
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") close()
        }
        window.addEventListener("keydown", handleKeyDown)
        onCleanup(() => window.removeEventListener("keydown", handleKeyDown))
    })

    return (
        <div class="chat-image-preview-backdrop" onMouseDown={close}>
            <div
                ref={dialog}
                class="chat-image-preview-shell"
                role="dialog"
                aria-modal="true"
                aria-label={props.data.filename ?? "图片预览"}
                tabIndex={-1}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div class="chat-image-preview-header">
                    <div class="chat-image-preview-title">{props.data.filename ?? props.data.mime}</div>
                    <button
                        class="chat-image-preview-close"
                        type="button"
                        title="关闭"
                        aria-label="关闭图片预览"
                        tabIndex={-1}
                        onClick={close}
                    >
                        <X class="chat-image-preview-close-icon" size={18} strokeWidth={2.1} />
                    </button>
                </div>
                <img
                    class="chat-image-preview-img"
                    src={props.data.url}
                    alt={props.data.filename ?? "图片预览"}
                    onLoad={(event) => props.onReady({
                        height: event.currentTarget.naturalHeight,
                        width: event.currentTarget.naturalWidth,
                    })}
                    onError={() => props.onReady({ height: 360, width: 640 })}
                />
            </div>
        </div>
    )
}

function SidebarDialogOverlay(props: {
    data: SidebarDialogOverlayData
    onReady: (contentSize: ModalOverlayContentSize) => void
}) {
    let dialog: HTMLDivElement | undefined
    let input: HTMLInputElement | undefined
    const [value, setValue] = createSignal(props.data.kind === "rename-session" ? props.data.value : "")
    const isRename = () => props.data.kind === "rename-session"
    const isProjectRemove = () => props.data.kind === "delete-project"
    const title = () => isRename() ? "重命名会话" : isProjectRemove() ? "移除项目" : "删除会话"
    const focusInitial = () => {
        if (!isRename()) {
            dialog?.focus({ preventScroll: true })
            return
        }
        input?.focus({ preventScroll: true })
        input?.select()
    }
    const cancel = async () => {
        await window.electronAPI.sendOverlayAction({ type: "sidebar-dialog.cancel" })
        await window.electronAPI.closeOverlay()
    }
    const submit = async () => {
        if (isRename() && !value().trim()) return
        await window.electronAPI.sendOverlayAction({
            type: "sidebar-dialog.submit",
            ...(isRename() ? { value: value().trim() } : {}),
        })
        await window.electronAPI.closeOverlay()
    }

    onMount(() => {
        queueMicrotask(() => {
            const bounds = dialog?.getBoundingClientRect()
            if (bounds) props.onReady({ height: Math.ceil(bounds.height), width: Math.ceil(bounds.width) })
            focusInitial()
        })
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault()
                void cancel()
                return
            }
            if (event.key !== "Enter") return
            event.preventDefault()
            void submit()
        }
        window.addEventListener("focus", focusInitial)
        window.addEventListener("keydown", handleKeyDown)
        onCleanup(() => {
            window.removeEventListener("focus", focusInitial)
            window.removeEventListener("keydown", handleKeyDown)
        })
    })

    return (
        <div class="sidebar-dialog-backdrop" onMouseDown={() => void cancel()}>
            <div
                ref={dialog}
                class="sidebar-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title()}
                tabIndex={-1}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div class="sidebar-dialog-title">{title()}</div>
                <Show
                    when={isRename()}
                    fallback={
                        <div class="sidebar-dialog-copy">
                            确定要{isProjectRemove() ? "移除" : "删除"} <span>{props.data.name}</span> 吗？{isProjectRemove() ? "项目会从列表中移除。" : "此操作不可撤销。"}
                        </div>
                    }
                >
                    <input
                        ref={input}
                        class="sidebar-dialog-input"
                        value={value()}
                        onInput={(event) => setValue(event.currentTarget.value)}
                    />
                </Show>
                <div class="sidebar-dialog-actions">
                    <button type="button" class="sidebar-dialog-button" onClick={() => void cancel()}>取消</button>
                    <button
                        type="button"
                        class={`sidebar-dialog-button ${isRename() ? "primary" : isProjectRemove() ? "" : "danger"}`}
                        disabled={isRename() && value().trim().length === 0}
                        onClick={() => void submit()}
                    >
                        {isRename() ? "保存" : isProjectRemove() ? "移除" : "删除"}
                    </button>
                </div>
            </div>
        </div>
    )
}
