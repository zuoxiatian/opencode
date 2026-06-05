/* @refresh reload */
import { render } from "solid-js/web"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { showToast, Toast } from "@opencode-ai/ui/toast"
import "./index.css"
import { App } from "./components/App"
import { LoginPage } from "./components/LoginPage"
import { clearClientAuthSession, isClientAuthSessionExpired, readStoredClientAuthSession, subscribeClientAuthSession, type ClientAuthSession } from "./auth"
import { getClientModelConfig } from "./api/model-config"
import { checkClientUpdate } from "./services/client-update"
import { syncRequiredClientSkills, type SkillSyncSummary } from "./services/skill-sync"
import { getSystemTheme, readStoredThemeMode, resolveThemeMode, THEME_STORAGE_KEY } from "./theme"
import welcomeIcon from "../../build/128x128.png"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

function Root() {
    const [serverInfo, setServerInfo] = createSignal<ServerInfo | null>(null)
    const [isServerStarting, setIsServerStarting] = createSignal(false)
    const [serverStartError, setServerStartError] = createSignal("")
    const [isModelConfigLoading, setIsModelConfigLoading] = createSignal(false)
    const [isSkillSyncing, setIsSkillSyncing] = createSignal(false)
    const [skillSyncUserID, setSkillSyncUserID] = createSignal<number | null>(null)
    const [isUpdateChecking, setIsUpdateChecking] = createSignal(false)
    const [updateCheckUserID, setUpdateCheckUserID] = createSignal<number | null>(null)
    const [clientAuthSession, setClientAuthSession] = createSignal<ClientAuthSession | null>(readStoredClientAuthSession())
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
    const stopServerForLoggedOutSession = () => {
        setClientAuthSession(null)
        setServerInfo(null)
        setIsServerStarting(false)
        setServerStartError("")
        setIsModelConfigLoading(false)
        setIsSkillSyncing(false)
        setSkillSyncUserID(null)
        setIsUpdateChecking(false)
        setUpdateCheckUserID(null)
        void window.electronAPI.stopServer()
    }
    const clearSessionAndStopServer = () => {
        clearClientAuthSession()
        stopServerForLoggedOutSession()
    }

    onMount(() => {
        const media = window.matchMedia("(prefers-color-scheme: light)")
        const updateSystemTheme = () => setSystemTheme(media.matches ? "light" : "dark")
        updateSystemTheme()
        media.addEventListener("change", updateSystemTheme)
        onCleanup(() => media.removeEventListener("change", updateSystemTheme))

        // 监听服务器就绪事件
        window.electronAPI.onServerReady((info) => {
            console.log("服务器就绪:", info)
            setServerInfo(info)
            setIsServerStarting(false)
            setServerStartError("")
        })

        const unsubscribeClientAuthSession = subscribeClientAuthSession((session) => {
            if (!session) {
                stopServerForLoggedOutSession()
                return
            }
            setClientAuthSession(session)
        })
        onCleanup(unsubscribeClientAuthSession)
    })

    createEffect(() => {
        document.documentElement.dataset.theme = resolvedTheme()
        document.documentElement.dataset.themeMode = themeMode()
        document.documentElement.style.colorScheme = resolvedTheme()
        localStorage.setItem(THEME_STORAGE_KEY, themeMode())
        void window.electronAPI.setThemeMode(themeMode())
        syncTitleBarOverlay()
    })

    createEffect(() => {
        const session = clientAuthSession()
        if (!session) return
        const checkExpiration = () => {
            if (!isClientAuthSessionExpired(session)) return
            clearSessionAndStopServer()
        }
        if (isClientAuthSessionExpired(session)) {
            clearSessionAndStopServer()
            return
        }
        const timer = setInterval(checkExpiration, 60_000)
        onCleanup(() => clearInterval(timer))
    })

    const startOpencodeServer = async () => {
        if (serverInfo() || isServerStarting()) return
        setIsServerStarting(true)
        setServerStartError("")
        setIsModelConfigLoading(true)
        const modelConfig = await getClientModelConfig().catch((error: unknown) => {
            const message = errorMessage(error, "读取模型配置失败")
            console.error("读取模型配置失败:", error)
            showToast({
                description: message,
                title: "模型配置同步失败",
                variant: "error",
            })
            clearSessionAndStopServer()
            return null
        })
        setIsModelConfigLoading(false)
        if (!modelConfig) {
            setIsServerStarting(false)
            return
        }
        if (!clientAuthSession()) {
            setIsServerStarting(false)
            return
        }

        const info = await window.electronAPI.startServer({ opencodeConfig: modelConfig.config }).catch((error: unknown) => {
            console.error("启动后端服务失败:", error)
            setServerStartError(errorMessage(error, "无法启动后端服务"))
            return null
        })
        if (!info) {
            setIsServerStarting(false)
            return
        }
        if (!clientAuthSession()) {
            await window.electronAPI.stopServer()
            return
        }
        setServerInfo(info)
        setIsServerStarting(false)
    }

    const syncSkillsForSession = async (session: ClientAuthSession) => {
        if (isSkillSyncing() || skillSyncUserID() === session.user.id) return
        setIsSkillSyncing(true)
        const summary = await syncRequiredClientSkills().catch((error: unknown) => {
            console.error("同步技能失败:", error)
            showToast({
                description: error instanceof Error ? error.message : String(error),
                title: "技能同步失败",
                variant: "error",
            })
            return null
        })
        if (summary) notifySkillSyncSummary(summary)
        setSkillSyncUserID(session.user.id)
        setIsSkillSyncing(false)
    }

    const checkUpdateForSession = async (session: ClientAuthSession) => {
        if (isUpdateChecking() || updateCheckUserID() === session.user.id) return
        setIsUpdateChecking(true)
        const update = await checkClientUpdate().catch((error: unknown) => {
            console.error("检查客户端更新失败:", error)
            return null
        })
        setUpdateCheckUserID(session.user.id)
        setIsUpdateChecking(false)
        if (!update || clientAuthSession()?.user.id !== session.user.id) return
        await window.electronAPI.promptClientUpdate(update)
    }

    createEffect(() => {
        const session = clientAuthSession()
        const info = serverInfo()
        if (!session) return
        if (!info) return
        if (updateCheckUserID() === session.user.id || isUpdateChecking()) return
        requestAnimationFrame(() => {
            if (!clientAuthSession() || !serverInfo()) return
            void checkUpdateForSession(session)
        })
    })

    createEffect(() => {
        const session = clientAuthSession()
        if (!session) return
        if (skillSyncUserID() === session.user.id || isSkillSyncing()) return
        void syncSkillsForSession(session)
    })

    createEffect(() => {
        const session = clientAuthSession()
        if (!session) return
        if (isSkillSyncing() || skillSyncUserID() !== session.user.id) return
        if (serverInfo() || isServerStarting()) return
        if (serverStartError()) return
        void startOpencodeServer()
    })

    const logout = () => {
        clearSessionAndStopServer()
    }

    return (
        <>
            <Show
                when={clientAuthSession()}
                fallback={<LoginPage onLogin={setClientAuthSession} />}
            >
                {(session) => (
                    <Show
                        when={serverInfo()}
                        fallback={
                            <div class="welcome-screen">
                                <img class="welcome-icon" src={welcomeIcon} alt="" />
                                <div class="welcome-title welcome-brand-title">LongwiseTechAgent</div>
                                <div class="welcome-subtitle">{serverStartError() || (isSkillSyncing() ? "正在同步技能..." : isModelConfigLoading() ? "正在加载模型配置..." : "正在启动后端服务...")}</div>
                                <Show when={!serverStartError()} fallback={
                                    <button class="btn btn-primary" onClick={() => void startOpencodeServer()}>
                                        重新启动服务
                                    </button>
                                }>
                                    <div class="welcome-progress"></div>
                                    <div class="status-indicator">
                                        <span class="status-dot connecting"></span>
                                        <span>{isSkillSyncing() ? "同步中" : isModelConfigLoading() ? "配置中" : isServerStarting() ? "启动中" : "准备启动"}</span>
                                    </div>
                                </Show>
                            </div>
                        }
                    >
                        {(info) => (
                            <App
                                serverInfo={info()}
                                clientAuthSession={session()}
                                themeMode={themeMode()}
                                onThemeModeChange={setThemeMode}
                                onLogout={logout}
                            />
                        )}
                    </Show>
                )}
            </Show>
            <Toast.Region />
        </>
    )
}

function notifySkillSyncSummary(summary: SkillSyncSummary) {
    const changed = summary.archivedDeleted + summary.requiredInstalled + summary.requiredUpdated
    if (summary.errors.length > 0) {
        showToast({
            description: summary.errors[0],
            title: "部分技能同步失败",
            variant: "error",
        })
        return
    }
    if (changed === 0) return
    showToast({
        description: [
            summary.requiredInstalled ? `安装 ${summary.requiredInstalled}` : "",
            summary.requiredUpdated ? `更新 ${summary.requiredUpdated}` : "",
            summary.archivedDeleted ? `删除下架 ${summary.archivedDeleted}` : "",
        ].filter(Boolean).join(" · "),
        title: "技能同步完成",
        variant: "success",
    })
}

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback
}

const rootElement = document.getElementById("root")
if (rootElement) {
    render(() => <Root />, rootElement)
}
