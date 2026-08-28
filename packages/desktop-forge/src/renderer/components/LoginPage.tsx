import { createSignal, onMount, Show } from "solid-js"
import Eye from "lucide-solid/icons/eye"
import EyeOff from "lucide-solid/icons/eye-off"
import CircleAlert from "lucide-solid/icons/circle-alert"
import ExternalLink from "lucide-solid/icons/external-link"
import Lock from "lucide-solid/icons/lock"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import User from "lucide-solid/icons/user"
import type { ClientAuthSession } from "../auth"
import {
    loginClient,
    type ClientAccessAction,
    type ClientLoginFailureReason,
} from "../api/client"
import welcomeIcon from "../../../build/128x128.png"
import { showDesktopToast } from "../toast"

type LoginPageProps = {
    onLogin: (session: ClientAuthSession) => void
}

export function LoginPage(props: LoginPageProps) {
    const [username, setUsername] = createSignal("")
    const [password, setPassword] = createSignal("")
    const [passwordVisible, setPasswordVisible] = createSignal(false)
    const [isSubmitting, setIsSubmitting] = createSignal(false)
    const [accessAction, setAccessAction] = createSignal<ClientAccessAction | null>(null)
    let usernameInput: HTMLInputElement | undefined

    onMount(() => usernameInput?.focus())

    const notifyLoginError = (description: string) => {
        showDesktopToast({
            description,
            title: "登录失败",
            variant: "error",
        })
    }
    const loginErrorDescription = (result: { reason: ClientLoginFailureReason; message?: string }) =>
        result.message ?? (result.reason === "network"
            ? "无法连接登录服务"
            : result.reason === "unauthorized"
                ? "账号或密码不正确"
                : "登录失败，请稍后重试")

    const openAccessAction = (action: ClientAccessAction) => {
        if (!action.url) return

        return window.electronAPI.openExternal(action.url).catch(() => {
            notifyLoginError("无法打开处理页面，请稍后重试")
        })
    }

    const submit = async (event: Event) => {
        event.preventDefault()
        if (isSubmitting()) return
        if (!username().trim() || !password()) {
            notifyLoginError("请输入账号和密码")
            return
        }

        setIsSubmitting(true)
        setAccessAction(null)

        const result = await loginClient({
            password: password(),
            username: username().trim(),
        })
        if (!result.ok) {
            if (result.reason === "action_required") {
                setAccessAction(result.action)
                setIsSubmitting(false)
                return
            }

            notifyLoginError(loginErrorDescription(result))
            setIsSubmitting(false)
            return
        }

        props.onLogin(result.session)
    }

    return (
        <main class="login-page">
            <section class="login-shell" aria-labelledby="desktop-lxz-login-title">
                <div class="login-brand">
                    <img class="login-brand-icon" src={welcomeIcon} alt="" draggable={false} />
                    <div class="login-brand-copy">
                        <h1 id="desktop-lxz-login-title">LongwiseTechAgent</h1>
                        <p>智能 · 高效 · 可靠</p>
                    </div>
                </div>

                <div class="login-panel">
                    <form class="login-form" onSubmit={submit}>
                        <div class="login-form-heading">
                            <h2>欢迎回来</h2>
                            <p>登录您的账号以继续使用 LongwiseTechAgent</p>
                        </div>

                        <Show when={accessAction()}>
                            {(action) => (
                                <section class="login-access-action" role="alert" aria-live="polite">
                                    <CircleAlert class="login-access-action-icon" size={19} strokeWidth={1.9} />
                                    <div class="login-access-action-content">
                                        <strong>{action().title}</strong>
                                        <p>{action().description}</p>
                                        <Show when={action().url}>
                                            <button
                                                type="button"
                                                class="login-access-action-button"
                                                onClick={() => void openAccessAction(action())}
                                            >
                                                <ExternalLink size={15} strokeWidth={1.9} />
                                                <span>{action().buttonText ?? "前往处理"}</span>
                                            </button>
                                        </Show>
                                    </div>
                                </section>
                            )}
                        </Show>

                        <label class="login-field">
                            <span class="login-field-label">用户名</span>
                            <span class="login-input-wrap">
                                <User class="login-input-icon" size={17} strokeWidth={1.8} />
                                <input
                                    ref={usernameInput}
                                    class="login-input"
                                    autocomplete="username"
                                    disabled={isSubmitting()}
                                    inputmode="text"
                                    placeholder="用户名"
                                    value={username()}
                                    onInput={(event) => setUsername(event.currentTarget.value)}
                                />
                            </span>
                        </label>

                        <label class="login-field">
                            <span class="login-field-label">密码</span>
                            <span class="login-input-wrap">
                                <Lock class="login-input-icon" size={17} strokeWidth={1.8} />
                                <input
                                    class="login-input"
                                    autocomplete="current-password"
                                    disabled={isSubmitting()}
                                    placeholder="密码"
                                    type={passwordVisible() ? "text" : "password"}
                                    value={password()}
                                    onInput={(event) => setPassword(event.currentTarget.value)}
                                />
                                <button
                                    type="button"
                                    class="login-secret-toggle"
                                    disabled={isSubmitting()}
                                    title={passwordVisible() ? "隐藏密码" : "显示密码"}
                                    aria-label={passwordVisible() ? "隐藏密码" : "显示密码"}
                                    onClick={() => setPasswordVisible(!passwordVisible())}
                                >
                                    <Show
                                        when={passwordVisible()}
                                        fallback={<Eye class="login-toggle-icon" size={17} strokeWidth={1.9} />}
                                    >
                                        <EyeOff class="login-toggle-icon" size={17} strokeWidth={1.9} />
                                    </Show>
                                </button>
                            </span>
                        </label>

                        <button class="login-submit" type="submit" disabled={isSubmitting()}>
                            <Show when={isSubmitting()}>
                                <LoaderCircle class="login-submit-icon login-submit-spinner" size={17} strokeWidth={2} />
                            </Show>
                            <span>{isSubmitting() ? "登录中" : "登录"}</span>
                        </button>
                    </form>
                </div>
            </section>
        </main>
    )
}
