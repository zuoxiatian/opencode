import { createSignal, createEffect, For, Show, type ParentProps, onMount, onCleanup } from "solid-js"
import { FolderPanel } from "./FolderPanel"
import { ContentPanel } from "./ContentPanel"
import { ChatPanel } from "./ChatPanel"
import { SDKProvider } from "../context/sdk"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import appIcon from "../../../build/icon.png"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

interface AppProps {
    serverInfo: ServerInfo
}

export function App(props: AppProps) {
    const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false)
    const [chatCollapsed, setChatCollapsed] = createSignal(false)
    const [contentCollapsed, setContentCollapsed] = createSignal(true)
    const [folderWidth, setFolderWidth] = createSignal(220)
    const [chatWidth, setChatWidth] = createSignal(400)
    const [isDragging, setIsDragging] = createSignal<"folder" | "chat" | null>(null)

    const toggleSidebar = () => {
        setSidebarCollapsed(!sidebarCollapsed())
    }

    const toggleChat = () => {
        setChatCollapsed(!chatCollapsed())
    }

    const toggleContent = () => {
        setContentCollapsed(!contentCollapsed())
    }

    // 拖拽处理
    const handleMouseDown = (type: "folder" | "chat") => (e: MouseEvent) => {
        e.preventDefault()
        setIsDragging(type)
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
    }

    const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging()) return

        if (isDragging() === "folder") {
            const newWidth = e.clientX - 52 // 减去工具栏宽度(52px)
            if (newWidth >= 120 && newWidth <= 500) {
                setFolderWidth(newWidth)
            }
        } else if (isDragging() === "chat") {
            const newWidth = window.innerWidth - e.clientX
            if (newWidth >= 280 && newWidth <= 700) {
                setChatWidth(newWidth)
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
            {/* 窗口标题栏 */}
            <div class="window-titlebar">
                <img class="window-titlebar-icon" src={appIcon} alt="" />
                <span class="window-titlebar-title">LongwiseTechAgent</span>
            </div>

            <div class={`app-layout ${isDragging() ? "dragging" : ""}`}>
                {/* 拖拽时的透明遮罩层 - 防止 iframe 捕获鼠标事件 */}
                <Show when={isDragging()}>
                    <div class="drag-overlay" />
                </Show>

                {/* 固定的工具栏 - 始终显示 */}
                <div class="sidebar-toolbar">
                    <button
                        class="sidebar-toggle-btn"
                        onClick={toggleSidebar}
                        title={sidebarCollapsed() ? "展开目录" : "收起目录"}
                    >
                        <span class="toggle-arrow">☰</span>
                    </button>
                    <button
                        class={`sidebar-toggle-btn ${contentCollapsed() ? "collapsed" : ""}`}
                        onClick={toggleContent}
                        title={contentCollapsed() ? "展开内容" : "收起内容"}
                    >
                        <span class="toggle-arrow">📄</span>
                    </button>
                    <button
                        class={`sidebar-toggle-btn ${chatCollapsed() ? "collapsed" : ""}`}
                        onClick={toggleChat}
                        title={chatCollapsed() ? "展开聊天" : "收起聊天"}
                    >
                        <span class="toggle-arrow">💬</span>
                    </button>
                    {/* 占位空间，将状态指示器推到底部 */}
                    <div style={{ flex: 1 }}></div>
                    {/* 服务器状态指示器 */}
                    <div class="toolbar-status" title="服务器在线">
                        <span class="status-dot online"></span>
                    </div>
                </div>

                {/* 侧边栏面板 - 可展开/收起 */}
                <div
                    class={`folder-panel-container ${sidebarCollapsed() ? "collapsed" : ""}`}
                    style={{ width: sidebarCollapsed() ? "0px" : `${folderWidth()}px` }}
                >
                    <Show when={!sidebarCollapsed()}>
                        <FolderPanel />
                    </Show>
                </div>

                {/* 分隔条1：目录 ↔ 内容 */}
                <Show when={!sidebarCollapsed()}>
                    <div
                        class={`resizer ${isDragging() === "folder" ? "active" : ""}`}
                        onMouseDown={handleMouseDown("folder")}
                    />
                </Show>

                {/* 内容面板 */}
                <div class={`content-panel-wrapper ${contentCollapsed() ? "collapsed" : ""}`}>
                    <Show when={!contentCollapsed()}>
                        <ContentPanel />
                    </Show>
                </div>

                {/* 分隔条2：内容 ↔ 聊天 */}
                <Show when={!chatCollapsed()}>
                    <div
                        class={`resizer ${isDragging() === "chat" ? "active" : ""}`}
                        onMouseDown={handleMouseDown("chat")}
                    />
                </Show>

                {/* 聊天面板 */}
                <div
                    class={`chat-panel-wrapper ${chatCollapsed() ? "collapsed" : ""} ${contentCollapsed() && !chatCollapsed() ? "expanded" : ""}`}
                    style={{ width: chatCollapsed() ? "0px" : contentCollapsed() ? undefined : `${chatWidth()}px` }}
                >
                    <Show when={!chatCollapsed()}>
                        <ChatPanel />
                    </Show>
                </div>
            </div>
        </SDKProvider>
        </MarkedProvider>
    )
}
