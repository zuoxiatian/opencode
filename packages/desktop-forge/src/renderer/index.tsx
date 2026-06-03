/* @refresh reload */
import { render } from "solid-js/web"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import "./index.css"
import { App } from "./components/App"
import { getSystemTheme, readStoredThemeMode, resolveThemeMode, THEME_STORAGE_KEY } from "./theme"
import welcomeIcon from "../../build/128x128.png"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

function Root() {
    const [serverInfo, setServerInfo] = createSignal<ServerInfo | null>(null)
    const [isLoading, setIsLoading] = createSignal(true)
    const [themeMode, setThemeMode] = createSignal(readStoredThemeMode())
    const [systemTheme, setSystemTheme] = createSignal(getSystemTheme())
    const resolvedTheme = () => resolveThemeMode(themeMode(), systemTheme())
    const syncTitleBarOverlay = () => {
        if (!navigator.platform.toLowerCase().includes("win")) return

        requestAnimationFrame(() => {
            const rootStyle = getComputedStyle(document.documentElement)

            void window.electronAPI.setTitleBarOverlay({
                color: "rgba(0, 0, 0, 0)",
                symbolColor: rootStyle.getPropertyValue("--text-primary").trim(),
            })
        })
    }

    onMount(async () => {
        const media = window.matchMedia("(prefers-color-scheme: light)")
        const updateSystemTheme = () => setSystemTheme(media.matches ? "light" : "dark")
        updateSystemTheme()
        media.addEventListener("change", updateSystemTheme)
        onCleanup(() => media.removeEventListener("change", updateSystemTheme))

        // 监听服务器就绪事件
        window.electronAPI.onServerReady((info) => {
            console.log("服务器就绪:", info)
            setServerInfo(info)
            setIsLoading(false)
        })

        // 尝试获取已有的服务器信息
        const existingInfo = await window.electronAPI.getServerInfo()
        if (existingInfo) {
            setServerInfo(existingInfo)
            setIsLoading(false)
        }
    })

    createEffect(() => {
        document.documentElement.dataset.theme = resolvedTheme()
        document.documentElement.dataset.themeMode = themeMode()
        document.documentElement.style.colorScheme = resolvedTheme()
        localStorage.setItem(THEME_STORAGE_KEY, themeMode())
        void window.electronAPI.setThemeMode(themeMode())
        syncTitleBarOverlay()
    })

    return (
        <Show
            when={!isLoading()}
            fallback={
                <div class="welcome-screen">
                    <img class="welcome-icon" src={welcomeIcon} alt="" />
                    <div class="welcome-title welcome-brand-title">LongwiseTechAgent</div>
                    <div class="welcome-subtitle">正在启动后端服务...</div>
                    <div class="welcome-progress"></div>
                    <div class="status-indicator">
                        <span class="status-dot connecting"></span>
                        <span>连接中</span>
                    </div>
                </div>
            }
        >
            <Show
                when={serverInfo()}
                fallback={
                    <div class="welcome-screen">
                        <img class="welcome-icon" src={welcomeIcon} alt="" />
                        <div class="welcome-title">连接失败</div>
                        <div class="welcome-subtitle">无法连接到后端服务</div>
                        <button class="btn btn-primary" onClick={() => window.electronAPI.restart()}>
                            重新启动
                        </button>
                    </div>
                }
            >
                {(info) => (
                    <App
                        serverInfo={info()}
                        themeMode={themeMode()}
                        onThemeModeChange={setThemeMode}
                    />
                )}
            </Show>
        </Show>
    )
}

const rootElement = document.getElementById("root")
if (rootElement) {
    render(() => <Root />, rootElement)
}
