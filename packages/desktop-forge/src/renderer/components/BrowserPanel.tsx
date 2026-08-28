import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
    ArrowLeft,
    ArrowRight,
    CircleAlert,
    Globe2,
    LoaderCircle,
    PanelRightClose,
    Plus,
    RefreshCw,
    SquareArrowOutUpRight,
    X,
} from "lucide-solid"
import type { BrowserCommandInput, BrowserState, BrowserTabState } from "../../shared/browser"
import { browserErrorContent, browserErrorHost } from "../../shared/browser-error"

interface BrowserPanelProps {
    conversationId: string
    layoutRevision: number
    state: BrowserState
}

export function BrowserPanel(props: BrowserPanelProps) {
    const [address, setAddress] = createSignal(
        props.state.tabs.find((tab) => tab.id === props.state.activeTabId)?.url ?? "",
    )
    const activeTab = createMemo(() => props.state.tabs.find((tab) => tab.id === props.state.activeTabId))
    const activeUrl = createMemo(() => activeTab()?.url ?? "")
    let tabList: HTMLDivElement | undefined
    let viewport: HTMLDivElement | undefined

    const run = (command: BrowserCommandInput) =>
        window.electronAPI.browserCommand(props.conversationId, command).catch((error: unknown) => {
            console.error("Embedded browser command failed:", error)
        })
    const syncBounds = () => {
        if (!viewport || !activeTab()?.url) return
        const bounds = viewport.getBoundingClientRect()
        void window.electronAPI
            .setBrowserBounds({
                height: bounds.height,
                width: bounds.width,
                x: bounds.x,
                y: bounds.y,
            })
            .catch(() => undefined)
    }
    const navigate = async (event: SubmitEvent) => {
        event.preventDefault()
        if (!address().trim()) return
        const tabId = activeTab()?.id
        if (tabId) {
            await run({ command: { name: "tab.goto", url: address() }, tabId })
            return
        }
        const created = await run({ command: { name: "tabs.new" } })
        if (created?.data.tab?.id) {
            await run({
                command: { name: "tab.goto", url: address() },
                tabId: created.data.tab.id,
            })
        }
    }
    const closeTab = (event: Event, tabId: string) => {
        event.stopPropagation()
        void run({ command: { name: "tab.close" }, tabId })
    }

    createEffect(() => {
        setAddress(activeUrl())
    })
    createEffect(() => {
        const tabId = props.state.activeTabId
        if (!tabId) return
        requestAnimationFrame(() => {
            tabList?.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)
                ?.scrollIntoView({ block: "nearest", inline: "nearest" })
        })
    })
    createEffect(() => {
        props.layoutRevision
        activeUrl()
        requestAnimationFrame(syncBounds)
    })
    onMount(() => {
        const observer = new ResizeObserver(syncBounds)
        if (viewport) observer.observe(viewport)
        window.addEventListener("resize", syncBounds)
        requestAnimationFrame(syncBounds)
        onCleanup(() => {
            observer.disconnect()
            window.removeEventListener("resize", syncBounds)
        })
    })

    return (
        <section class="embedded-browser" aria-label="内嵌浏览器">
            <header class="embedded-browser-tabs">
                <div ref={tabList} class="embedded-browser-tab-list" role="tablist" aria-label="浏览器标签页">
                    <For each={props.state.tabs}>
                        {(tab) => (
                            <div
                                class="embedded-browser-tab"
                                classList={{ active: tab.id === props.state.activeTabId }}
                                data-tab-id={tab.id}
                                title={tab.title || tab.url || "新标签页"}
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    class="embedded-browser-tab-target"
                                    aria-selected={tab.id === props.state.activeTabId}
                                    onClick={() => void run({ command: { name: "tab.activate" }, tabId: tab.id })}
                                >
                                    <BrowserTabIcon tab={tab} />
                                    <span>{tabLabel(tab)}</span>
                                </button>
                                <button
                                    type="button"
                                    class="embedded-browser-tab-close"
                                    title="关闭标签页"
                                    aria-label={`关闭${tabLabel(tab)}`}
                                    onClick={(event) => closeTab(event, tab.id)}
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        )}
                    </For>
                    <button
                        type="button"
                        class="embedded-browser-new-tab"
                        title="新建标签页"
                        aria-label="新建标签页"
                        onClick={() => void run({ command: { name: "tabs.new" } })}
                    >
                        <Plus size={17} />
                    </button>
                </div>
                <div class="embedded-browser-window-actions">
                    <button
                        type="button"
                        class="browser-panel-toggle"
                        title="折叠浏览器"
                        aria-label="折叠浏览器"
                        onClick={() => void run({ command: { name: "browser.hide" } })}
                    >
                        <PanelRightClose size={17} strokeWidth={1.8} />
                    </button>
                </div>
            </header>

            <div class="embedded-browser-toolbar">
                <nav class="embedded-browser-navigation" aria-label="网页导航">
                    <button
                        type="button"
                        title="后退"
                        aria-label="后退"
                        disabled={!activeTab()?.canGoBack}
                        onClick={() => void run({ command: { name: "tab.back" }, tabId: activeTab()?.id })}
                    >
                        <ArrowLeft size={16} />
                    </button>
                    <button
                        type="button"
                        title="前进"
                        aria-label="前进"
                        disabled={!activeTab()?.canGoForward}
                        onClick={() => void run({ command: { name: "tab.forward" }, tabId: activeTab()?.id })}
                    >
                        <ArrowRight size={16} />
                    </button>
                    <button
                        type="button"
                        title={activeTab()?.loading ? "停止" : "刷新"}
                        aria-label={activeTab()?.loading ? "停止" : "刷新"}
                        disabled={!activeTab()?.url}
                        onClick={() => void run({
                            command: { name: activeTab()?.loading ? "tab.stop" : "tab.reload" },
                            tabId: activeTab()?.id,
                        })}
                    >
                        {activeTab()?.loading
                            ? <X size={15} />
                            : <RefreshCw size={15} />}
                    </button>
                </nav>
                <form class="embedded-browser-address" onSubmit={navigate}>
                    <Globe2 size={14} aria-hidden="true" />
                    <input
                        aria-label="网页地址"
                        value={address()}
                        placeholder="输入 URL"
                        spellcheck={false}
                        onFocus={(event) => event.currentTarget.select()}
                        onInput={(event) => setAddress(event.currentTarget.value)}
                    />
                    <button
                        type="button"
                        class="embedded-browser-address-open"
                        title="在默认浏览器中打开"
                        aria-label="在默认浏览器中打开"
                        disabled={!activeTab()?.url}
                        onClick={() => {
                            const url = activeTab()?.url
                            if (url) void window.electronAPI.openExternal(url).catch(() => undefined)
                        }}
                    >
                        <SquareArrowOutUpRight size={14} strokeWidth={1.8} />
                    </button>
                </form>
            </div>

            <div ref={viewport} class="embedded-browser-viewport">
                <Show when={activeTab()?.error}>
                    {(error) => {
                        const content = browserErrorContent(error())
                        return (
                            <div class="embedded-browser-error">
                                <div class="embedded-browser-error-content">
                                    <CircleAlert class="embedded-browser-error-icon" size={30} strokeWidth={1.6} />
                                    <strong>{content.title}</strong>
                                    <p>{content.message}</p>
                                    <ul>
                                        <For each={content.suggestions}>
                                            {(suggestion) => <li>{suggestion}</li>}
                                        </For>
                                    </ul>
                                    <button
                                        type="button"
                                        onClick={() => void run({
                                            command: { name: "tab.reload" },
                                            tabId: activeTab()?.id,
                                        })}
                                    >
                                        <RefreshCw size={13} />
                                        重新加载
                                    </button>
                                    <code>{content.code}</code>
                                </div>
                            </div>
                        )
                    }}
                </Show>
                <Show when={!activeTab()?.url && !activeTab()?.error}>
                    <div class="embedded-browser-empty">
                        <div class="embedded-browser-empty-content">
                            <strong>从这里开始浏览</strong>
                            <span>输入网址，或让 LongwiseTechAgent 帮你打开并阅读页面</span>
                        </div>
                    </div>
                </Show>
            </div>
        </section>
    )
}

function BrowserTabIcon(props: { tab: BrowserTabState }) {
    const [failed, setFailed] = createSignal<string | null>(null)
    createEffect(() => {
        props.tab.generation
        setFailed(null)
    })
    const source = createMemo(() => {
        if (props.tab.error) return
        const favicon = props.tab.favicon
        return favicon && failed() !== favicon ? favicon : undefined
    })

    return (
        <Show
            when={!props.tab.loading}
            fallback={<LoaderCircle class="embedded-browser-spinner" size={14} />}
        >
            <Show when={source()} fallback={<Globe2 size={14} />}>
                {(favicon) => (
                    <img
                        class="embedded-browser-tab-favicon"
                        src={favicon()}
                        alt=""
                        draggable={false}
                        onError={() => setFailed(favicon())}
                    />
                )}
            </Show>
        </Show>
    )
}

function tabLabel(tab: BrowserTabState) {
    if (tab.error) return browserErrorHost(tab.error) || "加载失败"
    if (tab.title) return tab.title
    if (!tab.url) return "新标签页"
    try {
        return new URL(tab.url).hostname
    } catch {
        return tab.url
    }
}
