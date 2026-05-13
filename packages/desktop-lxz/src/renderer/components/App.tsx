import { createSignal, Show, onMount, onCleanup } from "solid-js"
import { FolderPanel } from "./FolderPanel"
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
    const [folderWidth, setFolderWidth] = createSignal(260)
    const [isDragging, setIsDragging] = createSignal<"folder" | null>(null)

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
            {/* 窗口标题栏 */}
            <div
                class="window-titlebar"
                classList={{ "window-titlebar-macos": navigator.platform.toLowerCase().includes("mac") }}
            >
                <img class="window-titlebar-icon" src={appIcon} alt="" />
                <span class="window-titlebar-title">LongwiseTechAgent</span>
            </div>

            <div class={`app-layout ${isDragging() ? "dragging" : ""}`}>
                {/* 拖拽时的透明遮罩层 - 防止 iframe 捕获鼠标事件 */}
                <Show when={isDragging()}>
                    <div class="drag-overlay" />
                </Show>

                {/* 侧边栏面板 */}
                <div
                    class="folder-panel-container"
                    style={{ width: `${folderWidth()}px` }}
                >
                    <FolderPanel />
                </div>

                {/* 分隔条：项目列表 ↔ 聊天 */}
                <div
                    class={`resizer ${isDragging() === "folder" ? "active" : ""}`}
                    onMouseDown={handleMouseDown("folder")}
                />

                {/* 聊天面板 */}
                <div class="chat-panel-wrapper expanded">
                    <ChatPanel />
                </div>
            </div>
        </SDKProvider>
        </MarkedProvider>
    )
}
