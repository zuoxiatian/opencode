import type { DesktopToastInput } from "../shared/overlay"

export function showDesktopToast(input: DesktopToastInput) {
    void window.electronAPI.showToast(input).catch((error: unknown) => {
        console.error("显示桌面提示失败:", error)
    })
}

