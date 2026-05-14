import { createEffect, createSignal, Show, onMount, onCleanup } from "solid-js"
import { FolderPanel } from "./FolderPanel"
import { ChatPanel } from "./ChatPanel"
import { SDKProvider } from "../context/sdk"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { isThemeMode, THEME_STORAGE_KEY } from "../theme"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

interface AppProps {
    serverInfo: ServerInfo
}

const readStoredThemeMode = () => {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeMode(value)) return value
    return "system"
}

const getSystemTheme = () =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"

export function App(props: AppProps) {
    const [folderWidth, setFolderWidth] = createSignal(260)
    const [folderCollapsed, setFolderCollapsed] = createSignal(false)
    const [isDragging, setIsDragging] = createSignal<"folder" | null>(null)
    const [themeMode, setThemeMode] = createSignal(readStoredThemeMode())
    const [systemTheme, setSystemTheme] = createSignal(getSystemTheme())
    const isMac = () => navigator.platform.toLowerCase().includes("mac")
    const visibleFolderWidth = () => folderCollapsed() ? 0 : folderWidth()
    const resolvedTheme = () => {
        const mode = themeMode()
        if (mode === "system") return systemTheme()
        return mode
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
        const media = window.matchMedia("(prefers-color-scheme: light)")
        const updateSystemTheme = () => setSystemTheme(media.matches ? "light" : "dark")
        updateSystemTheme()
        media.addEventListener("change", updateSystemTheme)
        onCleanup(() => media.removeEventListener("change", updateSystemTheme))
    })

    createEffect(() => {
        document.documentElement.dataset.theme = resolvedTheme()
        document.documentElement.dataset.themeMode = themeMode()
        document.documentElement.style.colorScheme = resolvedTheme()
        localStorage.setItem(THEME_STORAGE_KEY, themeMode())
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
                    isMac() ? "app-layout-macos" : "",
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
                            themeMode={themeMode()}
                            onThemeModeChange={(mode) => setThemeMode(mode)}
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
                    <ChatPanel sidebarCollapsed={folderCollapsed()} onOpenSidebar={() => setFolderCollapsed(false)} />
                </div>
            </div>
        </SDKProvider>
        </MarkedProvider>
    )
}
