import { createSignal, Show, onMount, onCleanup } from "solid-js"
import { FolderPanel } from "./FolderPanel"
import { ChatPanel } from "./ChatPanel"
import { SDKProvider } from "../context/sdk"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import type { ThemeMode } from "../theme"
import { readChatVisibility, writeChatVisibility, type ChatVisibilitySettings } from "../settings"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

interface AppProps {
    serverInfo: ServerInfo
    themeMode: ThemeMode
    onThemeModeChange: (mode: ThemeMode) => void
}

export function App(props: AppProps) {
    const [folderWidth, setFolderWidth] = createSignal(260)
    const [folderCollapsed, setFolderCollapsed] = createSignal(false)
    const [isDragging, setIsDragging] = createSignal<"folder" | null>(null)
    const [chatVisibility, setChatVisibility] = createSignal(readChatVisibility())
    const platform = navigator.platform.toLowerCase()
    const isMac = platform.includes("mac")
    const isWindows = platform.includes("win")
    const visibleFolderWidth = () => folderCollapsed() ? 0 : folderWidth()
    const handleChatVisibilityChange = (settings: ChatVisibilitySettings) => {
        writeChatVisibility(settings)
        setChatVisibility(settings)
    }

    // 拖拽处理
    const handleMouseDown = (type: "folder") => (e: MouseEvent) => {
        e.preventDefault()
        setIsDragging(type)
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
    }

    const handleMouseUp = () => {
        if (isDragging()) {
            setIsDragging(null)
            document.body.style.cursor = ""
            document.body.style.userSelect = ""
        }
    }

    onMount(() => {
        document.addEventListener("mousemove", handleMouseMove)
        document.addEventListener("mouseup", handleMouseUp)
    })

    onCleanup(() => {
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
    })

    return (
        <MarkedProvider>
        <SDKProvider serverInfo={props.serverInfo}>
            <div
                class={[
                    "app-layout",
                    isDragging() ? "dragging" : "",
                    isMac || isWindows ? "app-layout-custom-titlebar" : "",
                    isMac ? "app-layout-macos" : "",
                    isWindows ? "app-layout-windows" : "",
                    folderCollapsed() ? "app-layout-folder-collapsed" : "",
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
                            themeMode={props.themeMode}
                            onThemeModeChange={props.onThemeModeChange}
                            chatVisibility={chatVisibility()}
                            onChatVisibilityChange={handleChatVisibilityChange}
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
                    />
                </div>
            </div>
        </SDKProvider>
        </MarkedProvider>
    )
}
