import { dialog, type BrowserWindow, type Session } from "electron"
import type { BrowserEventStore } from "../event-store"
import type { EmbeddedTabStore } from "./tab-store"

export function configureBrowserPermissions(
    browserSession: Session,
    window: BrowserWindow,
    events: BrowserEventStore,
    tabs: EmbeddedTabStore,
) {
    const grants = new Map<string, boolean>()
    browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
        grants.get(permissionKey(requestingOrigin, permission)) === true)
    browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const tab = tabs.findByWebContentsId(webContents.id)
        const origin = browserOrigin(details.requestingUrl || webContents.getURL())
        if (!tab || !origin || !promptablePermission(permission)) {
            callback(false)
            return
        }
        const key = permissionKey(origin, permission)
        const existing = grants.get(key)
        if (existing != null) {
            callback(existing)
            return
        }
        events.publish("permission.requested", {
            browserId: "embedded",
            payload: { origin, permission },
            sessionId: tab.conversationId,
        })
        void dialog.showMessageBox(window, {
            buttons: ["允许", "拒绝"],
            cancelId: 1,
            defaultId: 1,
            detail: `${origin}\n\n仅对本次应用运行期间有效。`,
            message: `是否允许该网站使用${permissionLabel(permission)}？`,
            noLink: true,
            title: "网站权限",
            type: "question",
        }).then((result) => {
            const granted = result.response === 0
            grants.set(key, granted)
            events.publish("permission.resolved", {
                browserId: "embedded",
                payload: { granted, origin, permission },
                sessionId: tab.conversationId,
            })
            callback(granted)
        }).catch(() => {
            events.publish("permission.resolved", {
                browserId: "embedded",
                payload: { granted: false, origin, permission },
                sessionId: tab.conversationId,
            })
            callback(false)
        })
    })
    return () => {
        browserSession.setPermissionCheckHandler(null)
        browserSession.setPermissionRequestHandler(null)
        grants.clear()
    }
}

function permissionKey(origin: string, permission: string) {
    return `${origin}\0${permission}`
}

function browserOrigin(input: string) {
    try {
        const url = new URL(input)
        return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined
    } catch {
        return undefined
    }
}

function promptablePermission(permission: string) {
    return [
        "clipboard-read",
        "clipboard-sanitized-write",
        "fullscreen",
        "geolocation",
        "idle-detection",
        "keyboardLock",
        "media",
        "midi",
        "notifications",
        "pointerLock",
        "speaker-selection",
        "storage-access",
        "top-level-storage-access",
        "window-management",
    ].includes(permission)
}

function permissionLabel(permission: string) {
    const labels: Record<string, string> = {
        "clipboard-read": "剪贴板内容",
        "clipboard-sanitized-write": "剪贴板写入",
        "fullscreen": "全屏模式",
        "geolocation": "位置信息",
        "idle-detection": "设备活动状态",
        "keyboardLock": "键盘锁定",
        "media": "摄像头或麦克风",
        "midi": "MIDI 设备",
        "notifications": "通知",
        "pointerLock": "鼠标指针锁定",
        "speaker-selection": "音频输出设备",
        "storage-access": "跨站点存储",
        "top-level-storage-access": "顶层存储",
        "window-management": "窗口管理",
    }
    return labels[permission] ?? permission
}
