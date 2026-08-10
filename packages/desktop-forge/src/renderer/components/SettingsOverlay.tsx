import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { LucideIcon } from "lucide-solid"
import Brain from "lucide-solid/icons/brain"
import CircleQuestionMark from "lucide-solid/icons/circle-question-mark"
import CircleUser from "lucide-solid/icons/circle-user"
import Eye from "lucide-solid/icons/eye"
import EyeOff from "lucide-solid/icons/eye-off"
import Globe from "lucide-solid/icons/globe"
import Info from "lucide-solid/icons/info"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Lock from "lucide-solid/icons/lock"
import MessageCircle from "lucide-solid/icons/message-circle"
import Monitor from "lucide-solid/icons/monitor"
import Moon from "lucide-solid/icons/moon"
import Palette from "lucide-solid/icons/palette"
import RefreshCw from "lucide-solid/icons/refresh-cw"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import Sun from "lucide-solid/icons/sun"
import Wrench from "lucide-solid/icons/wrench"
import X from "lucide-solid/icons/x"
import type { SettingsOverlayData } from "../../shared/overlay"
import type { ClientAppInfo } from "../../shared/client-update"
import { changeClientPassword, type ClientPasswordFailureReason } from "../api/client"
import { CLIENT_UPDATE_CHANNEL } from "../config"
import { checkClientUpdate } from "../services/client-update"
import { THEME_STORAGE_KEY } from "../theme"
import { showDesktopToast } from "../toast"

type SettingsSection = "appearance" | "account" | "chat" | "about"
type PasswordFormState = {
    confirmPassword: string
    currentPassword: string
    newPassword: string
}

const SYSTEM_THEME_MODE_OPTION = { mode: "system", label: "系统", icon: Monitor } as const
const THEME_MODE_OPTIONS = [
    SYSTEM_THEME_MODE_OPTION,
    { mode: "light", label: "亮色", icon: Sun },
    { mode: "dark", label: "暗色", icon: Moon },
] as const
const SETTINGS_SECTION_OPTIONS = [
    { section: "appearance", label: "外观", description: "主题与界面", icon: Palette },
    { section: "account", label: "账户", description: "账号安全", icon: CircleUser },
    { section: "chat", label: "聊天", description: "消息显示", icon: MessageCircle },
    { section: "about", label: "关于", description: "版本更新", icon: Info },
] as const

export function SettingsOverlay(props: { data: SettingsOverlayData; onClose: () => void }) {
    const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("appearance")
    const [themeMode, setThemeMode] = createSignal(props.data.themeMode)
    const [chatVisibility, setChatVisibility] = createSignal(props.data.chatVisibility)
    const [linkOpenMode, setLinkOpenMode] = createSignal(props.data.linkOpenMode)
    const [appInfo, setAppInfo] = createSignal<ClientAppInfo | null>(null)
    const [isManualUpdateChecking, setIsManualUpdateChecking] = createSignal(false)
    const [passwordForm, setPasswordForm] = createSignal<PasswordFormState>({
        confirmPassword: "",
        currentPassword: "",
        newPassword: "",
    })
    const [isPasswordFormOpen, setIsPasswordFormOpen] = createSignal(false)
    const [isPasswordSubmitting, setIsPasswordSubmitting] = createSignal(false)
    const currentSettingsSection = () => SETTINGS_SECTION_OPTIONS.find((item) => item.section === settingsSection()) ?? SETTINGS_SECTION_OPTIONS[0]
    const currentThemeModeOption = () => THEME_MODE_OPTIONS.find((item) => item.mode === themeMode()) ?? SYSTEM_THEME_MODE_OPTION
    const accountName = () => props.data.clientAuthSession.user.name ?? props.data.clientAuthSession.user.username
    const accountSummaryMeta = () => [
        props.data.clientAuthSession.user.username !== accountName()
            ? `用户名 ${props.data.clientAuthSession.user.username}`
            : null,
        props.data.clientAuthSession.user.department
            && props.data.clientAuthSession.user.department !== accountName()
            && props.data.clientAuthSession.user.department !== props.data.clientAuthSession.user.username
            ? `部门 ${props.data.clientAuthSession.user.department}`
            : null,
    ].filter((item): item is string => Boolean(item)).join(" · ") || "当前账号"
    const appPlatformText = () => {
        if (appInfo()?.platform === "mac") return "macOS"
        if (appInfo()?.platform === "win") return "Windows"
        return "当前平台"
    }
    const close = () => {
        if (isPasswordFormOpen()) {
            closePasswordForm()
            return
        }
        props.onClose()
    }

    createEffect(() => {
        if (settingsSection() !== "about" || appInfo()) return
        void window.electronAPI.getAppInfo().then(setAppInfo)
    })

    createEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            event.preventDefault()
            close()
        }
        window.addEventListener("keydown", handleKeyDown)
        onCleanup(() => window.removeEventListener("keydown", handleKeyDown))
    })

    const updateThemeMode = (mode: SettingsOverlayData["themeMode"]) => {
        setThemeMode(mode)
        localStorage.setItem(THEME_STORAGE_KEY, mode)
        void window.electronAPI.setThemeMode(mode).then((theme) => {
            if (themeMode() !== mode) return
            document.documentElement.dataset.themeMode = mode
            document.documentElement.dataset.theme = theme
            document.documentElement.style.colorScheme = theme
            void window.electronAPI.sendOverlayAction({ mode, type: "settings.theme-mode" })
        })
    }
    const updateChatVisibility = (changes: Partial<SettingsOverlayData["chatVisibility"]>) => {
        const settings = { ...chatVisibility(), ...changes }
        setChatVisibility(settings)
        void window.electronAPI.sendOverlayAction({ settings, type: "settings.chat-visibility" })
    }
    const updateLinkOpenMode = (mode: SettingsOverlayData["linkOpenMode"]) => {
        setLinkOpenMode(mode)
        void window.electronAPI.sendOverlayAction({ mode, type: "settings.link-open-mode" })
    }
    const updatePasswordForm = (changes: Partial<PasswordFormState>) => {
        setPasswordForm((current) => ({ ...current, ...changes }))
    }
    const resetPasswordForm = () => setPasswordForm({
        confirmPassword: "",
        currentPassword: "",
        newPassword: "",
    })
    const closePasswordForm = () => {
        if (isPasswordSubmitting()) return
        resetPasswordForm()
        setIsPasswordFormOpen(false)
    }
    const notifyPasswordChangeError = (description: string) => showDesktopToast({
        description,
        title: "修改密码失败",
        variant: "error",
    })
    const passwordChangeErrorDescription = (result: { reason: ClientPasswordFailureReason; message?: string }) => {
        if (result.reason === "invalid_current_password") return "当前密码不正确"
        if (result.message) return result.message
        if (result.reason === "network") return "无法连接登录服务"
        if (result.reason === "unauthorized") return "登录已失效，请重新登录"
        return "修改密码失败，请稍后重试"
    }
    const submitPasswordChange = async (event: Event) => {
        event.preventDefault()
        if (isPasswordSubmitting()) return

        const form = passwordForm()
        const nextPassword = form.newPassword.trim()
        if (!form.currentPassword || !nextPassword) {
            notifyPasswordChangeError("请输入当前密码和新密码")
            return
        }
        if (nextPassword.length > 255) {
            notifyPasswordChangeError("新密码不能超过 255 个字符")
            return
        }
        if (nextPassword !== form.confirmPassword.trim()) {
            notifyPasswordChangeError("两次输入的新密码不一致")
            return
        }

        setIsPasswordSubmitting(true)
        const result = await changeClientPassword({
            currentPassword: form.currentPassword,
            newPassword: nextPassword,
        })
        setIsPasswordSubmitting(false)
        if (!result.ok) {
            notifyPasswordChangeError(passwordChangeErrorDescription(result))
            return
        }

        closePasswordForm()
        showDesktopToast({ title: "密码已修改", variant: "success" })
    }
    const checkForClientUpdateManually = async () => {
        if (isManualUpdateChecking()) return

        setIsManualUpdateChecking(true)
        const update = await checkClientUpdate().catch((error: unknown) => {
            console.error("手动检查客户端更新失败:", error)
            showDesktopToast({
                description: error instanceof Error ? error.message : String(error),
                title: "检查更新失败",
                variant: "error",
            })
            return undefined
        })
        setIsManualUpdateChecking(false)
        if (update === undefined) return
        if (!update) {
            showDesktopToast({
                description: `当前版本 ${appInfo()?.version ?? ""}`,
                title: "当前已是最新版本",
                variant: "success",
            })
            return
        }
        await window.electronAPI.promptClientUpdate(update)
    }

    return (
        <div class="settings-dialog-root">
            <button type="button" class="settings-dialog-backdrop" aria-label="关闭设置" onClick={close} />
            <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-lxz-settings-title">
                <button type="button" class="settings-dialog-close" onClick={close} title="关闭" aria-label="关闭设置">
                    <X class="sidebar-lucide-icon" size={16} strokeWidth={1.9} />
                </button>
                <aside class="settings-dialog-sidebar">
                    <div class="settings-dialog-titlebar">
                        <div>
                            <div class="settings-dialog-kicker">LongwiseTechAgent</div>
                            <h2 id="desktop-lxz-settings-title">设置</h2>
                        </div>
                    </div>
                    <nav class="settings-dialog-nav" aria-label="设置分类">
                        <For each={SETTINGS_SECTION_OPTIONS}>
                            {(item) => (
                                <button
                                    type="button"
                                    class="settings-dialog-nav-item"
                                    classList={{ active: settingsSection() === item.section }}
                                    onClick={() => setSettingsSection(item.section)}
                                    aria-current={settingsSection() === item.section ? "page" : undefined}
                                >
                                    <Dynamic component={item.icon} class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />
                                    <span>
                                        <span class="settings-dialog-nav-label">{item.label}</span>
                                        <span class="settings-dialog-nav-description">{item.description}</span>
                                    </span>
                                </button>
                            )}
                        </For>
                    </nav>
                </aside>
                <main class="settings-dialog-content">
                    <div class="settings-page-heading">
                        <Dynamic component={currentSettingsSection().icon} class="settings-page-icon" size={19} strokeWidth={1.85} />
                        <div>
                            <h3>{currentSettingsSection().label}</h3>
                            <p>{currentSettingsSection().description}</p>
                        </div>
                    </div>
                    <Show when={settingsSection() === "appearance"}>
                        <section class="settings-section">
                            <div class="settings-section-heading"><h4>主题</h4><p>选择界面跟随系统、亮色或暗色显示。</p></div>
                            <div class="settings-theme-options" role="group" aria-label="主题">
                                <For each={THEME_MODE_OPTIONS}>
                                    {(option) => (
                                        <button
                                            type="button"
                                            class="settings-theme-option"
                                            classList={{ active: themeMode() === option.mode }}
                                            onClick={() => updateThemeMode(option.mode)}
                                            aria-pressed={themeMode() === option.mode}
                                        >
                                            <Dynamic component={option.icon} class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />
                                            <span>{option.label}</span>
                                        </button>
                                    )}
                                </For>
                            </div>
                            <div class="settings-current-value">当前：{currentThemeModeOption().label}</div>
                        </section>
                    </Show>
                    <Show when={settingsSection() === "account"}>
                        <section class="settings-section">
                            <div class="settings-section-heading"><h4>当前账号</h4></div>
                            <div class="settings-account-summary">
                                <span class="settings-account-avatar" aria-hidden="true">
                                    <CircleUser class="sidebar-lucide-icon" size={17} strokeWidth={1.85} />
                                </span>
                                <span class="settings-account-copy">
                                    <span class="settings-account-name">{accountName()}</span>
                                    <span class="settings-account-meta">{accountSummaryMeta()}</span>
                                </span>
                            </div>
                        </section>
                        <section class="settings-section">
                            <div class="settings-section-heading"><h4>修改密码</h4><p>请确认当前密码后设置新密码。</p></div>
                            <button type="button" class="settings-password-trigger" onClick={() => setIsPasswordFormOpen(true)}>
                                <Lock class="sidebar-lucide-icon" size={16} strokeWidth={1.9} />
                                <span>修改密码</span>
                            </button>
                        </section>
                    </Show>
                    <Show when={settingsSection() === "chat"}>
                        <section class="settings-section">
                            <div class="settings-section-heading"><h4>消息显示</h4><p>控制聊天记录中辅助信息的展示方式。</p></div>
                            <div class="settings-option-list">
                                <SettingsSwitchRow icon={CircleQuestionMark} title="显示问答" description="展示历史问题与用户回答。" checked={chatVisibility().questionAnswers} onChange={(questionAnswers) => updateChatVisibility({ questionAnswers })} />
                                <SettingsSwitchRow icon={Brain} title="显示思考" description="展示模型的思考过程。默认关闭。" checked={chatVisibility().reasoning} onChange={(reasoning) => updateChatVisibility({ reasoning })} />
                                <SettingsSwitchRow icon={SquareTerminal} title="显示 Shell 调用" description="展示 bash、shell 等终端命令调用。默认关闭。" checked={chatVisibility().shellCalls} onChange={(shellCalls) => updateChatVisibility({ shellCalls })} />
                                <SettingsSwitchRow icon={Wrench} title="显示工具调用" description="展示文件、搜索等非 Shell 工具调用；子任务始终展示。默认关闭。" checked={chatVisibility().toolCalls} onChange={(toolCalls) => updateChatVisibility({ toolCalls })} />
                            </div>
                        </section>
                        <section class="settings-section">
                            <div class="settings-section-heading"><h4>链接打开方式</h4><p>控制聊天消息中的链接如何打开。</p></div>
                            <div class="settings-option-list">
                                <SettingsSwitchRow
                                    icon={Globe}
                                    title="使用默认浏览器打开链接"
                                    description={linkOpenMode() === "browser" ? "链接会交给系统默认浏览器打开。" : "关闭后链接会在应用右侧的内嵌浏览器中打开。"}
                                    checked={linkOpenMode() === "browser"}
                                    onChange={(checked) => updateLinkOpenMode(checked ? "browser" : "direct")}
                                />
                            </div>
                        </section>
                    </Show>
                    <Show when={settingsSection() === "about"}>
                        <section class="settings-section">
                            <div class="settings-section-heading"><h4>应用信息</h4><p>LongwiseTechAgent</p></div>
                            <div class="settings-about-list">
                                <div class="settings-about-row"><span class="settings-about-label">当前版本</span><span class="settings-about-value">{appInfo()?.version ?? "..."}</span></div>
                                <div class="settings-about-row"><span class="settings-about-label">平台架构</span><span class="settings-about-value">{appPlatformText()} {appInfo()?.arch ?? ""}</span></div>
                                <div class="settings-about-row"><span class="settings-about-label">更新通道</span><span class="settings-about-value">{CLIENT_UPDATE_CHANNEL}</span></div>
                            </div>
                            <button type="button" class="settings-update-button" disabled={isManualUpdateChecking()} onClick={() => void checkForClientUpdateManually()}>
                                <Show when={isManualUpdateChecking()} fallback={<RefreshCw class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />}>
                                    <LoaderCircle class="sidebar-lucide-icon settings-update-spinner" size={16} strokeWidth={1.9} />
                                </Show>
                                <span>{isManualUpdateChecking() ? "检查中" : "检查更新"}</span>
                            </button>
                        </section>
                    </Show>
                </main>
            </div>
            <Show when={isPasswordFormOpen()}>
                <div class="settings-password-dialog-layer">
                    <button type="button" class="settings-password-dialog-backdrop" aria-label="关闭修改密码" onClick={closePasswordForm} />
                    <form class="settings-password-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-lxz-password-title" onSubmit={submitPasswordChange}>
                        <button type="button" class="settings-password-dialog-close" disabled={isPasswordSubmitting()} onClick={closePasswordForm} title="关闭" aria-label="关闭修改密码">
                            <X class="sidebar-lucide-icon" size={15} strokeWidth={1.9} />
                        </button>
                        <div class="settings-password-dialog-heading"><h4 id="desktop-lxz-password-title">修改密码</h4><p>请确认当前密码后设置新密码。</p></div>
                        <SettingsPasswordField autocomplete="current-password" disabled={isPasswordSubmitting()} label="当前密码" placeholder="当前密码" value={passwordForm().currentPassword} onInput={(currentPassword) => updatePasswordForm({ currentPassword })} />
                        <SettingsPasswordField autocomplete="new-password" disabled={isPasswordSubmitting()} label="新密码" placeholder="新密码" value={passwordForm().newPassword} onInput={(newPassword) => updatePasswordForm({ newPassword })} />
                        <SettingsPasswordField autocomplete="new-password" disabled={isPasswordSubmitting()} label="确认新密码" placeholder="再次输入新密码" value={passwordForm().confirmPassword} onInput={(confirmPassword) => updatePasswordForm({ confirmPassword })} />
                        <div class="settings-password-actions">
                            <button type="button" class="settings-password-cancel" disabled={isPasswordSubmitting()} onClick={closePasswordForm}>取消</button>
                            <button type="submit" class="settings-password-submit" disabled={isPasswordSubmitting()}><span>{isPasswordSubmitting() ? "保存中" : "保存新密码"}</span></button>
                        </div>
                    </form>
                </div>
            </Show>
        </div>
    )
}

function SettingsSwitchRow(props: { icon: LucideIcon; title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <button type="button" class="settings-option-row" role="switch" aria-checked={props.checked} data-active={props.checked ? "true" : "false"} onClick={() => props.onChange(!props.checked)}>
            <span class="settings-option-icon" aria-hidden="true"><Dynamic component={props.icon} class="sidebar-lucide-icon" size={16} strokeWidth={1.85} /></span>
            <span class="settings-option-copy"><span class="settings-option-title">{props.title}</span><span class="settings-option-description">{props.description}</span></span>
            <span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb" /></span>
        </button>
    )
}

function SettingsPasswordField(props: { autocomplete: string; disabled: boolean; label: string; onInput: (value: string) => void; placeholder: string; value: string }) {
    const [visible, setVisible] = createSignal(false)
    return (
        <label class="settings-password-field">
            <span class="settings-password-label">{props.label}</span>
            <span class="settings-password-input-wrap">
                <Lock class="settings-password-input-icon" size={15} strokeWidth={1.9} />
                <input class="settings-password-input" autocomplete={props.autocomplete} disabled={props.disabled} placeholder={props.placeholder} type={visible() ? "text" : "password"} value={props.value} onInput={(event) => props.onInput(event.currentTarget.value)} />
                <button type="button" class="settings-password-toggle" disabled={props.disabled} title={visible() ? "隐藏密码" : "显示密码"} aria-label={visible() ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible())}>
                    <Show when={visible()} fallback={<Eye class="settings-password-toggle-icon" size={16} strokeWidth={1.9} />}><EyeOff class="settings-password-toggle-icon" size={16} strokeWidth={1.9} /></Show>
                </button>
            </span>
        </label>
    )
}
