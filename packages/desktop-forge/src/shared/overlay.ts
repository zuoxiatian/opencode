export interface OverlayServerInfo {
    url: string
    password: string | null
    defaultDirectory: string
}

export interface OverlayClientAuthSession {
    loginToken: string
    loginTokenExpire: string
    refreshToken: string | null
    refreshTokenExpire: string | null
    user: {
        id: number
        username: string
        name: string | null
        department: string | null
        role: string
        quotaLimit: number | null
        quotaUsed: number
    }
}

export interface DesktopToastInput {
    description?: string
    duration?: number
    persistent?: boolean
    title: string
    variant?: "default" | "error" | "loading" | "success"
}

export interface DesktopToastRenderState {
    revision: number
    toast: DesktopToastInput
}

export interface SettingsOverlayData {
    chatVisibility: {
        questionAnswers: boolean
        reasoning: boolean
        shellCalls: boolean
        toolCalls: boolean
    }
    clientAuthSession: OverlayClientAuthSession
    linkOpenMode: "browser" | "direct"
    themeMode: "dark" | "light" | "system"
}

export type SidebarDialogOverlayData =
    | { kind: "delete-project"; name: string }
    | { kind: "delete-session"; name: string }
    | { kind: "rename-session"; name: string; value: string }

export type ModalOverlayInput =
    | { data: { filename?: string; mime: string; url: string }; kind: "image-preview" }
    | { data: SettingsOverlayData; kind: "settings" }
    | { data: { serverInfo: OverlayServerInfo }; kind: "skill-market" }
    | { data: SidebarDialogOverlayData; kind: "sidebar-dialog" }

export type OverlayState = ModalOverlayInput | { kind: "toast" }

export type ModalOverlayContentSize = { height: number; width: number }

export interface ModalOverlayRenderState {
    revision: number
    state: ModalOverlayInput
}

export type OverlayAction =
    | { mode: "dark" | "light" | "system"; type: "settings.theme-mode" }
    | { mode: "browser" | "direct"; type: "settings.link-open-mode" }
    | {
        settings: SettingsOverlayData["chatVisibility"]
        type: "settings.chat-visibility"
    }
    | { type: "sidebar-dialog.cancel" }
    | { type: "sidebar-dialog.submit"; value?: string }
