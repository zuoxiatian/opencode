/* @refresh reload */
import { render } from "solid-js/web"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import "./index.css"
import { App } from "./components/App"
import { OverlayRoot } from "./components/OverlayRoot"
import { LoginPage } from "./components/LoginPage"
import { clearClientAuthSession, isClientAuthSessionExpired, readStoredClientAuthSession, subscribeClientAuthSession, type ClientAuthSession } from "./auth"
import { checkClientStatus } from "./api/client"
import {
    clearStoredClientCapabilities,
    clientCapabilitiesAccountKey,
    getClientCapabilities,
    readStoredClientCapabilities,
    writeStoredClientCapabilities,
    type ClientCapabilities,
} from "./api/capabilities"
import { CLIENT_DEBUG_LOGS_ENABLED } from "./config"
import { getClientModelConfig } from "./api/model-config"
import { checkClientUpdate } from "./services/client-update"
import { syncRequiredClientSkills, type SkillSyncSummary } from "./services/skill-sync"
import { getSystemTheme, readStoredThemeMode, resolveThemeMode, THEME_STORAGE_KEY } from "./theme"
import welcomeIcon from "../../build/128x128.png"
import { showDesktopToast } from "./toast"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
    defaultDirectory: string
}

const CLIENT_STATUS_CHECK_INTERVAL_MS = 30_000
const OPENCODE_SERVICE_CHECK_INTERVAL_MS = 5_000
const OPENCODE_SERVICE_RECOVERY_GRACE_MS = 60_000
const OPENCODE_SERVICE_OFFLINE_FAILURE_THRESHOLD = 2
const OPENCODE_SERVICE_RECOVERY_STORAGE_KEY = "desktop-lxz.serviceRecoveryStartedAt"

type OpencodeServiceStatus = "checking" | "online" | "offline"

function Root() {
    const [serverInfo, setServerInfo] = createSignal<ServerInfo | null>(null)
    const [isServerStarting, setIsServerStarting] = createSignal(false)
    const [serverStartError, setServerStartError] = createSignal("")
    const [opencodeServiceStatus, setOpencodeServiceStatus] = createSignal<OpencodeServiceStatus>("checking")
    const [isOpencodeOfflineDialogShown, setIsOpencodeOfflineDialogShown] = createSignal(false)
    const [isModelConfigLoading, setIsModelConfigLoading] = createSignal(false)
    const [isSkillSyncing, setIsSkillSyncing] = createSignal(false)
    const [skillSyncUserID, setSkillSyncUserID] = createSignal<number | null>(null)
    const [skillUpdateReminderPending, setSkillUpdateReminderPending] = createSignal(false)
    const [isUpdateChecking, setIsUpdateChecking] = createSignal(false)
    const [updateCheckUserID, setUpdateCheckUserID] = createSignal<number | null>(null)
    const [clientAuthSession, setClientAuthSession] = createSignal<ClientAuthSession | null>(readStoredClientAuthSession())
    const [clientCapabilities, setClientCapabilities] = createSignal<ClientCapabilities | null>(null)
    const [themeMode, setThemeMode] = createSignal(readStoredThemeMode())
    const [systemTheme, setSystemTheme] = createSignal(getSystemTheme())
    let clientCapabilitiesRequest: { accountKey: string; promise: Promise<boolean> } | null = null
    if (!clientAuthSession()) clearStoredClientCapabilities()
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
        clientCapabilitiesRequest = null
        setClientAuthSession(null)
        setClientCapabilities(null)
        clearStoredClientCapabilities()
        setServerInfo(null)
        setIsServerStarting(false)
        setServerStartError("")
        setOpencodeServiceStatus("checking")
        setIsOpencodeOfflineDialogShown(false)
        sessionStorage.removeItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY)
        setIsModelConfigLoading(false)
        setIsSkillSyncing(false)
        setSkillSyncUserID(null)
        setSkillUpdateReminderPending(false)
        setIsUpdateChecking(false)
        setUpdateCheckUserID(null)
        void window.electronAPI.stopServer()
    }
    const clearSessionAndStopServer = () => {
        clearClientAuthSession()
        stopServerForLoggedOutSession()
    }
    const checkClientStatusForSession = async (session: ClientAuthSession) => {
        if (clientAuthSession()?.loginToken !== session.loginToken) return

        if (CLIENT_DEBUG_LOGS_ENABLED) console.log("[client-status] checking", new Date().toISOString())
        const result = await checkClientStatus()
        if (CLIENT_DEBUG_LOGS_ENABLED) console.log("[client-status] result", result)
        const currentSession = clientAuthSession()
        if (currentSession && currentSession.loginToken !== session.loginToken) return
        if (result.ok) return
        if (result.reason === "network") {
            if (CLIENT_DEBUG_LOGS_ENABLED && result.message) console.warn("客户端登录状态检查失败:", result.message)
            return
        }

        showDesktopToast({
            description: result.message ?? "账号已在其他设备登录，请重新登录",
            title: "登录已失效",
            variant: "error",
        })
        if (clientAuthSession()) clearSessionAndStopServer()
    }
    const refreshClientCapabilitiesForSession = (session: ClientAuthSession) => {
        const accountKey = clientCapabilitiesAccountKey(session.user)
        if (clientCapabilitiesRequest?.accountKey === accountKey) return clientCapabilitiesRequest.promise

        const promise = getClientCapabilities()
            .then((features) => {
                const currentSession = clientAuthSession()
                if (!currentSession || clientCapabilitiesAccountKey(currentSession.user) !== accountKey) return false
                writeStoredClientCapabilities(currentSession.user, features)
                setClientCapabilities(features)
                return true
            })
            .catch((error: unknown) => {
                if (CLIENT_DEBUG_LOGS_ENABLED) console.warn("读取客户端能力失败:", error)
                return false
            })
        clientCapabilitiesRequest = { accountKey, promise }
        void promise.finally(() => {
            if (clientCapabilitiesRequest?.promise !== promise) return
            clientCapabilitiesRequest = null
        })
        return promise
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
            setOpencodeServiceStatus("online")
            setIsOpencodeOfflineDialogShown(false)
            sessionStorage.removeItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY)
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
        const mode = themeMode()
        document.documentElement.dataset.theme = resolvedTheme()
        document.documentElement.dataset.themeMode = mode
        document.documentElement.style.colorScheme = resolvedTheme()
        localStorage.setItem(THEME_STORAGE_KEY, mode)
        void window.electronAPI.setThemeMode(mode).then((theme) => {
            if (mode === "system" && themeMode() === mode) setSystemTheme(theme)
        })
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

    createEffect(() => {
        const session = clientAuthSession()
        if (!session) {
            setClientCapabilities(null)
            return
        }
        setClientCapabilities(readStoredClientCapabilities(session.user))
        void refreshClientCapabilitiesForSession(session)
    })

    createEffect(() => {
        const session = clientAuthSession()
        if (!session) return

        let checking = false
        const runCheck = () => {
            if (checking || clientAuthSession()?.loginToken !== session.loginToken) return
            checking = true
            void checkClientStatusForSession(session)
                .catch((error: unknown) => {
                    if (CLIENT_DEBUG_LOGS_ENABLED) console.error("客户端登录状态检查异常:", error)
                })
                .finally(() => {
                    checking = false
                })
        }
        const runCheckWhenVisible = () => {
            if (document.visibilityState !== "visible") return
            runCheck()
        }

        runCheck()
        const timer = setInterval(runCheck, CLIENT_STATUS_CHECK_INTERVAL_MS)
        window.addEventListener("focus", runCheck)
        document.addEventListener("visibilitychange", runCheckWhenVisible)
        onCleanup(() => {
            clearInterval(timer)
            window.removeEventListener("focus", runCheck)
            document.removeEventListener("visibilitychange", runCheckWhenVisible)
        })
    })

    createEffect(() => {
        const info = serverInfo()
        if (!info) {
            setOpencodeServiceStatus("checking")
            return
        }

        setOpencodeServiceStatus("online")
        let failedChecks = 0
        let wasOnline = true
        const startedAt = Date.now()
        const checkService = () => {
            void window.electronAPI.checkServerHealth().catch(() => false).then((online) => {
                if (serverInfo()?.url !== info.url) return
                if (online) {
                    failedChecks = 0
                    wasOnline = true
                    sessionStorage.removeItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY)
                    setIsOpencodeOfflineDialogShown(false)
                    setOpencodeServiceStatus("online")
                    return
                }
                if (!wasOnline && Date.now() - startedAt < OPENCODE_SERVICE_RECOVERY_GRACE_MS) {
                    setOpencodeServiceStatus("checking")
                    return
                }
                if (isOpencodeServiceRecoveryGraceActive()) {
                    return
                }
                failedChecks += 1
                if (failedChecks < OPENCODE_SERVICE_OFFLINE_FAILURE_THRESHOLD) {
                    if (!wasOnline) setOpencodeServiceStatus("checking")
                    return
                }
                setOpencodeServiceStatus("offline")
                promptReloadForOfflineOpencodeService()
            })
        }

        checkService()
        const timer = setInterval(checkService, OPENCODE_SERVICE_CHECK_INTERVAL_MS)
        onCleanup(() => clearInterval(timer))
    })

    const promptReloadForOfflineOpencodeService = () => {
        if (isOpencodeOfflineDialogShown()) return
        setIsOpencodeOfflineDialogShown(true)
        setTimeout(() => {
            window.alert("服务连接异常，需要重新加载以恢复。点击确定后将自动重新加载。")
            sessionStorage.setItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY, String(Date.now()))
            void window.electronAPI.stopServer().finally(() => window.location.reload())
        }, 0)
    }

    const startOpencodeServer = async () => {
        if (serverInfo() || isServerStarting()) return
        setIsServerStarting(true)
        setServerStartError("")
        setIsModelConfigLoading(true)
        const modelConfig = await getClientModelConfig().catch((error: unknown) => {
            const message = errorMessage(error, "读取模型配置失败")
            console.error("读取模型配置失败:", error)
            showDesktopToast({
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
        setOpencodeServiceStatus("online")
        setIsOpencodeOfflineDialogShown(false)
        sessionStorage.removeItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY)
        setIsServerStarting(false)
    }

    const syncSkillsForSession = async (session: ClientAuthSession) => {
        if (isSkillSyncing() || skillSyncUserID() === session.user.id) return
        setIsSkillSyncing(true)
        const summary = await syncRequiredClientSkills().catch((error: unknown) => {
            console.error("同步技能失败:", error)
            showDesktopToast({
                description: error instanceof Error ? error.message : String(error),
                title: "技能同步失败",
                variant: "error",
            })
            return null
        })
        if (summary) {
            notifySkillSyncSummary(summary)
            if (summary.requiredUpdated > 0) setSkillUpdateReminderPending(true)
        }
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

    createEffect(() => {
        if (!serverInfo() || !skillUpdateReminderPending()) return
        setSkillUpdateReminderPending(false)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (serverInfo()) void window.electronAPI.promptSkillUpdateReminder()
            })
        })
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
                                opencodeServiceStatus={opencodeServiceStatus()}
                                clientAuthSession={session()}
                                appMarketEnabled={clientCapabilities()?.appMarket === true}
                                themeMode={themeMode()}
                                onThemeModeChange={setThemeMode}
                                onLogout={logout}
                            />
                        )}
                    </Show>
                )}
            </Show>
        </>
    )
}

function isOpencodeServiceRecoveryGraceActive() {
    const startedAt = Number(sessionStorage.getItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY))
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
        sessionStorage.removeItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY)
        return false
    }
    if (Date.now() - startedAt < OPENCODE_SERVICE_RECOVERY_GRACE_MS) return true
    sessionStorage.removeItem(OPENCODE_SERVICE_RECOVERY_STORAGE_KEY)
    return false
}

function notifySkillSyncSummary(summary: SkillSyncSummary) {
    const changed = summary.archivedDeleted + summary.requiredInstalled + summary.requiredUpdated
    if (summary.errors.length > 0) {
        showDesktopToast({
            description: summary.errors[0],
            title: "部分技能同步失败",
            variant: "error",
        })
        return
    }
    if (changed === 0) return
    showDesktopToast({
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
    const overlay = new URLSearchParams(window.location.search).get("overlay")
    if (overlay) {
        document.documentElement.dataset.overlayWindow = "true"
        document.documentElement.dataset.overlayKind = overlay
    }
    render(() => overlay ? <OverlayRoot /> : <Root />, rootElement)
}
