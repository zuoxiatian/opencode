import type { Platform } from "@opencode-ai/app"
import type { Accessor } from "solid-js"

/**
 * 创建平台适配层
 */
export function createPlatform(password: Accessor<string | null>): Platform {
    const os = (() => {
        const platform = navigator.platform.toLowerCase()
        if (platform.includes("win")) return "windows"
        if (platform.includes("mac")) return "macos"
        if (platform.includes("linux")) return "linux"
        return undefined
    })()

    return {
        platform: "desktop",
        os,
        version: "1.0.0",

        async openDirectoryPickerDialog(opts) {
            const result = await window.electronAPI.pickDirectory()
            return result
        },

        async openFilePickerDialog(opts) {
            const result = await window.electronAPI.pickFile({
                multiple: opts?.multiple,
            })
            return result
        },

        async saveFilePickerDialog(opts) {
            const result = await window.electronAPI.saveFile({
                defaultPath: opts?.defaultPath,
            })
            return result
        },

        openLink(url: string) {
            void window.electronAPI.openExternal(url)
        },

        async restart() {
            await window.electronAPI.restart()
        },

        async notify(title, description, href) {
            // 使用浏览器 Notification API
            if (!("Notification" in window)) return

            const permission =
                Notification.permission === "default"
                    ? await Notification.requestPermission().catch(() => "denied")
                    : Notification.permission

            if (permission !== "granted") return

            // 检查窗口是否获得焦点
            if (document.hasFocus()) return

            const notification = new Notification(title, {
                body: description ?? "",
                icon: "https://opencode.ai/favicon-96x96.png",
            })

            notification.onclick = () => {
                window.focus()
                if (href) {
                    window.history.pushState(null, "", href)
                    window.dispatchEvent(new PopStateEvent("popstate"))
                }
                notification.close()
            }
        },

        // 带认证的 fetch
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
            const pw = password()
            console.log("[platform.fetch] password:", pw ? "****" : "null", "url:", input.toString())

            if (pw) {
                const headers = new Headers(init?.headers)
                headers.set("Authorization", `Basic ${btoa(`opencode:${pw}`)}`)
                return fetch(input, { ...init, headers })
            }

            return fetch(input, init)
        }) as typeof fetch,
    }
}
