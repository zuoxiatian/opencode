import { createEffect, createMemo, createSignal, Show, onMount, onCleanup } from "solid-js"
import { FolderPanel } from "./FolderPanel"
import { ChatPanel } from "./ChatPanel"
import { BrowserPanel } from "./BrowserPanel"
import { SDKProvider, useSDK } from "../context/sdk"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import type { ThemeMode } from "../theme"
import type { ClientAuthSession } from "../auth"
import type { BrowserState } from "../../shared/browser"
import {
    readChatVisibility,
    readLinkOpenMode,
    writeChatVisibility,
    writeLinkOpenMode,
    type ChatVisibilitySettings,
    type LinkOpenMode,
} from "../settings"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
    defaultDirectory: string
}

interface AppProps {
    serverInfo: ServerInfo
    opencodeServiceStatus: "checking" | "online" | "offline"
    clientAuthSession: ClientAuthSession
    appMarketEnabled: boolean
    themeMode: ThemeMode
    onThemeModeChange: (mode: ThemeMode) => void
    onLogout: () => void
}

export function App(props: AppProps) {
    const [folderWidth, setFolderWidth] = createSignal(260)
    const [browserWidth, setBrowserWidth] = createSignal<number | null>(null)
    const [folderCollapsed, setFolderCollapsed] = createSignal(false)
    const [isDragging, setIsDragging] = createSignal<"folder" | "browser" | null>(null)
    const [browserLayoutRevision, setBrowserLayoutRevision] = createSignal(0)
    const [browserState, setBrowserState] = createSignal<BrowserState | null>(null)
    const [browserConversationId, setBrowserConversationId] = createSignal<string | null>(null)
    const [chatVisibility, setChatVisibility] = createSignal(readChatVisibility())
    const [linkOpenMode, setLinkOpenMode] = createSignal(readLinkOpenMode())
    const platform = navigator.platform.toLowerCase()
    const isMac = platform.includes("mac")
    const isWindows = platform.includes("win")
    const visibleFolderWidth = () => folderCollapsed() ? 0 : folderWidth()
    const handleChatVisibilityChange = (settings: ChatVisibilitySettings) => {
        writeChatVisibility(settings)
        setChatVisibility(settings)
    }
    const handleLinkOpenModeChange = (mode: LinkOpenMode) => {
        writeLinkOpenMode(mode)
        setLinkOpenMode(mode)
    }
    const toggleBrowser = async (requestedConversationId?: string) => {
        const conversationId = requestedConversationId ?? browserConversationId()
        if (!conversationId) return
        const state = requestedConversationId
            ? await window.electronAPI.syncBrowserOwner(conversationId)
            : browserState()
        if (requestedConversationId) {
            setBrowserConversationId(conversationId)
            setBrowserState(state)
        }
        const name = state?.visible ? "browser.hide" : "browser.show"
        return window.electronAPI.browserCommand(conversationId, { command: { name } }).then((result) => {
            if (result.state) setBrowserState(result.state)
            setBrowserLayoutRevision((value) => value + 1)
        }).catch((error: unknown) => console.error("切换内嵌浏览器失败:", error))
    }
    const promoteBrowserConversation = async (sourceConversationId: string, targetConversationId: string) => {
        const state = await window.electronAPI.promoteBrowserConversation(sourceConversationId, targetConversationId)
        setBrowserConversationId(targetConversationId)
        setBrowserState(state)
        setBrowserLayoutRevision((value) => value + 1)
    }

    // 拖拽处理
    const handleMouseDown = (type: "folder" | "browser") => (e: MouseEvent) => {
        e.preventDefault()
        setIsDragging(type)
        void window.electronAPI
            .setBrowserSuspended(true)
            .catch(() => undefined)
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
    }

    const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging()) return

        if (isDragging() === "folder") {
            const newWidth = e.clientX
            if (newWidth >= 220 && newWidth <= 500) {
                setFolderWidth(newWidth)
            }
        }
        if (isDragging() === "browser") {
            const maxWidth = Math.max(420, window.innerWidth - visibleFolderWidth() - 420)
            setBrowserWidth(Math.min(Math.max(window.innerWidth - e.clientX, 420), maxWidth))
        }
    }

    const handleMouseUp = () => {
        if (isDragging()) {
            setIsDragging(null)
            document.body.style.cursor = ""
            document.body.style.userSelect = ""
            void window.electronAPI.setBrowserSuspended(false).catch(() => undefined)
            setBrowserLayoutRevision((value) => value + 1)
        }
    }

    onMount(() => {
        document.addEventListener("mousemove", handleMouseMove)
        document.addEventListener("mouseup", handleMouseUp)
        const unsubscribe = window.electronAPI.onBrowserStateChanged((payload) => {
            if (payload.conversationId !== browserConversationId()) return
            setBrowserState(payload.state)
        })
        onCleanup(unsubscribe)
    })

    onCleanup(() => {
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        void window.electronAPI.setBrowserSuspended(false).catch(() => undefined)
    })

    return (
        <MarkedProvider>
        <SDKProvider serverInfo={props.serverInfo}>
            <BrowserOwnerSync
                onPending={(conversationId) => {
                    setBrowserConversationId(conversationId)
                    setBrowserState(null)
                }}
                onSynced={(conversationId, state) => {
                    if (browserConversationId() !== conversationId) return
                    setBrowserConversationId(conversationId)
                    setBrowserState(state)
                    setBrowserLayoutRevision((value) => value + 1)
                }}
            />
            <div
                class={[
                    "app-layout",
                    isDragging() ? "dragging" : "",
                    isMac || isWindows ? "app-layout-custom-titlebar" : "",
                    isMac ? "app-layout-macos" : "",
                    isWindows ? "app-layout-windows" : "",
                    folderCollapsed() ? "app-layout-folder-collapsed" : "",
                    browserState()?.visible && browserWidth() === null ? "app-layout-browser-default" : "",
                ].filter(Boolean).join(" ")}
            >
                {/* 拖拽时的透明遮罩层 - 防止 iframe 捕获鼠标事件 */}
                <Show when={isDragging()}>
                    <div class="drag-overlay" />
                </Show>
                {/* 侧边栏面板 */}
                <div
                    class="folder-panel-container"
                    classList={{ collapsed: folderCollapsed() }}
                    style={{ width: `${visibleFolderWidth()}px` }}
                >
                    <Show
                        when={!folderCollapsed()}
                    >
                        <FolderPanel
                            onCollapse={() => setFolderCollapsed(true)}
                            opencodeServiceStatus={props.opencodeServiceStatus}
                            clientAuthSession={props.clientAuthSession}
                            appMarketEnabled={props.appMarketEnabled}
                            themeMode={props.themeMode}
                            onThemeModeChange={props.onThemeModeChange}
                            onLogout={props.onLogout}
                            chatVisibility={chatVisibility()}
                            onChatVisibilityChange={handleChatVisibilityChange}
                            linkOpenMode={linkOpenMode()}
                            onLinkOpenModeChange={handleLinkOpenModeChange}
                        />
                    </Show>
                </div>

                {/* 分隔条：项目列表 ↔ 聊天 */}
                <Show when={!folderCollapsed()}>
                    <div
                        class={`resizer ${isDragging() === "folder" ? "active" : ""}`}
                        onMouseDown={handleMouseDown("folder")}
                    />
                </Show>

                {/* 聊天面板 */}
                <div class="chat-panel-wrapper expanded">
                    <ChatPanel
                        sidebarCollapsed={folderCollapsed()}
                        onOpenSidebar={() => setFolderCollapsed(false)}
                        chatVisibility={chatVisibility()}
                        linkOpenMode={linkOpenMode()}
                        browserVisible={browserState()?.visible ?? false}
                        onToggleBrowser={toggleBrowser}
                        onPromoteBrowserConversation={promoteBrowserConversation}
                    />
                </div>

                <Show when={browserConversationId()}>
                    {(conversationId) => (
                        <Show when={browserState()}>
                            {(state) => <>
                            <div
                                class="resizer browser-resizer"
                                classList={{
                                    active: isDragging() === "browser",
                                    visible: state().visible,
                                }}
                                onMouseDown={handleMouseDown("browser")}
                            />
                            <div
                                class="browser-panel-wrapper"
                                classList={{ visible: state().visible }}
                                style={{ width: browserWidth() === null ? "auto" : `${browserWidth()}px` }}
                                aria-hidden={!state().visible}
                                inert={!state().visible}
                            >
                                <BrowserPanel
                                    conversationId={conversationId()}
                                    layoutRevision={browserLayoutRevision()}
                                    state={state()}
                                />
                            </div>
                            </>}
                        </Show>
                    )}
                </Show>
            </div>
        </SDKProvider>
        </MarkedProvider>
    )
}

function BrowserOwnerSync(props: {
    onPending: (conversationId: string | null) => void
    onSynced: (conversationId: string | null, state: BrowserState | null) => void
}) {
    const sdk = useSDK()
    const conversationId = createMemo(() => sdk.selectedSession()?.id ?? sdk.browserDraftConversationId())
    let revision = 0
    const unsubscribe = sdk.subscribeToEvents((event) => {
        if (event.type !== "session.deleted") return
        const properties = event.properties as { info?: { id?: string }; sessionID?: string }
        const conversationId = properties.sessionID ?? properties.info?.id
        if (!conversationId) return
        void window.electronAPI.disposeBrowserConversation(conversationId).catch((error: unknown) => {
            console.error("清理浏览器会话失败:", error)
        })
    })

    createEffect(() => {
        const id = conversationId()
        const current = ++revision
        props.onPending(id)
        void window.electronAPI.syncBrowserOwner(id)
            .then((state) => {
                if (current !== revision) return
                props.onSynced(id, state)
            })
            .catch((error: unknown) => {
                if (current !== revision) return
                props.onSynced(id, null)
                console.error("同步浏览器会话失败:", error)
            })
    })

    onCleanup(() => {
        revision += 1
        unsubscribe()
        void window.electronAPI.syncBrowserOwner(null).catch(() => undefined)
    })
    return null
}
