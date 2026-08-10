import { BaseWindow, BrowserWindow, nativeTheme, type WebContents } from "electron"
import { join } from "node:path"
import type {
    DesktopToastInput,
    DesktopToastRenderState,
    ModalOverlayContentSize,
    ModalOverlayInput,
    ModalOverlayRenderState,
    OverlayAction,
} from "../../shared/overlay"
import { BUNDLE_DIR } from "../resources/paths"

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined
declare const MAIN_WINDOW_VITE_NAME: string

const TOAST_CARD_WIDTH = 416
const TOAST_GAP = 8
const TOAST_MEASUREMENT_HEIGHT = 160
const TOAST_PADDING = 8
const TOAST_POOL_SIZE = 4
const TOAST_RIGHT = 18
const TOAST_TOP = 56
const IMAGE_PREVIEW_HEADER_HEIGHT = 42
const IMAGE_PREVIEW_MAX_WIDTH = 1280
const IMAGE_PREVIEW_MIN_WIDTH = 420
const MODAL_MARGIN = 24
const MODAL_SIZES = {
    settings: { height: 560, width: 860 },
    "skill-market": { height: 640, width: 980 },
} as const

interface ToastWindowSlot {
    active: boolean
    height: number
    input: DesktopToastInput | null
    ready: boolean
    revision: number
    sequence: number
    timer: ReturnType<typeof setTimeout> | null
    window: BrowserWindow
}

export class OverlayWindowManager {
    private modalBackdropWindow: BaseWindow | null = null
    private modalContentSize: ModalOverlayContentSize | null = null
    private modalInput: ModalOverlayInput | null = null
    private modalReady: Promise<BrowserWindow> | null = null
    private modalRendererReady = false
    private modalRevision = 0
    private modalWindow: BrowserWindow | null = null
    private toastReady: Promise<void> | null = null
    private toastRevision = 0
    private toastSequence = 0
    private toastSlots: ToastWindowSlot[] = []

    constructor(private readonly mainWindow: BrowserWindow) {
        nativeTheme.on("updated", this.syncModalBackdropTheme)
        mainWindow.on("enter-full-screen", this.syncBounds)
        mainWindow.on("hide", this.syncToastVisibility)
        mainWindow.on("leave-full-screen", this.syncBounds)
        mainWindow.on("minimize", this.syncToastVisibility)
        mainWindow.on("move", this.syncBounds)
        mainWindow.on("resize", this.syncBounds)
        mainWindow.on("restore", this.syncToastVisibility)
        mainWindow.on("show", this.syncToastVisibility)
    }

    prewarm() {
        return Promise.all([
            this.ensureModalWindow(),
            this.ensureToastWindows(),
        ]).then(() => undefined)
    }

    open(input: ModalOverlayInput) {
        if (this.mainWindow.isDestroyed()) throw new Error("主窗口已经关闭")

        this.modalInput = input
        this.modalContentSize = null
        this.modalRevision += 1
        this.modalBackdropWindow?.hide()
        this.modalWindow?.hide()
        void this.ensureModalWindow()
            .then(() => this.renderModal())
            .catch((error: unknown) => {
                console.error("加载桌面浮层失败:", error)
                this.modalInput = null
            })
    }

    closeModal(sender?: Electron.WebContents) {
        if (sender && this.modalWindow?.webContents !== sender) return
        this.modalInput = null
        this.modalContentSize = null
        this.modalRevision += 1
        this.modalBackdropWindow?.hide()
        this.modalWindow?.hide()
        if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.focus()
    }

    ownsWebContents(sender: Electron.WebContents) {
        return this.modalWindow?.webContents === sender || this.toastSlots.some((slot) => slot.window.webContents === sender)
    }

    readyModal(sender: Electron.WebContents) {
        if (this.modalWindow?.webContents !== sender) throw new Error("拒绝未知视图初始化弹框浮层")
        this.modalRendererReady = true
        this.renderModal()
    }

    renderedModal(sender: Electron.WebContents, revision: number, contentSize?: ModalOverlayContentSize) {
        if (this.modalWindow?.webContents !== sender) throw new Error("拒绝未知视图完成弹框渲染")
        if (!this.modalInput || revision !== this.modalRevision) return
        this.modalContentSize = this.modalInput.kind === "image-preview" && contentSize ? contentSize : null
        this.syncModalBounds()
        this.modalBackdropWindow?.setFocusable(this.modalInput.kind === "image-preview")
        this.modalBackdropWindow?.showInactive()
        this.modalWindow.show()
        this.raiseViews()
        this.modalWindow.focus()
    }

    sendAction(sender: Electron.WebContents, action: OverlayAction) {
        if (this.modalWindow?.webContents !== sender) throw new Error("拒绝未知视图发送浮层操作")
        if (!this.modalInput) throw new Error("拒绝已关闭浮层发送操作")
        if (this.mainWindow.isDestroyed() || this.mainWindow.webContents.isDestroyed()) return
        this.mainWindow.webContents.send("overlay:action", action)
    }

    async showToast(input: DesktopToastInput) {
        await this.ensureToastWindows()
        const slots = this.toastSlots.filter((slot) => !slot.window.isDestroyed())
        if (!slots.length) throw new Error("提示窗口不可用")

        const slot = slots.find((item) => !item.active) ?? slots.reduce((oldest, item) =>
            item.sequence < oldest.sequence ? item : oldest)
        this.clearToastTimer(slot)
        slot.window.hide()
        slot.active = true
        slot.height = 0
        slot.input = input
        slot.revision = ++this.toastRevision
        slot.sequence = ++this.toastSequence
        this.prepareToastMeasurementBounds(slot)
        this.syncToastBounds()
        if (slot.ready) this.renderToast(slot)
    }

    readyToast(sender: Electron.WebContents) {
        const slot = this.toastSlots.find((item) => item.window.webContents === sender)
        if (!slot) throw new Error("拒绝未知窗口初始化提示浮层")
        slot.ready = true
        if (slot.active) this.renderToast(slot)
    }

    resizeToast(sender: Electron.WebContents, revision: number, height: number) {
        const slot = this.toastSlots.find((item) => item.window.webContents === sender)
        if (!slot) throw new Error("拒绝未知窗口调整提示浮层")
        if (revision !== slot.revision) return

        const wasVisible = slot.height > 0
        slot.height = Math.min(
            Math.max(Math.ceil(height), 0),
            Math.max(this.mainWindow.getContentBounds().height - TOAST_TOP, 0),
        )
        if (slot.height === 0) {
            this.clearToastTimer(slot)
            slot.active = false
            slot.input = null
            slot.window.hide()
        }
        if (slot.height > 0 && !wasVisible) this.scheduleToastDismiss(slot)
        this.syncToastBounds()
        this.raiseViews()
    }

    raiseViews() {
        if (this.mainWindow.isDestroyed()) return
        if (this.modalInput && this.modalWindow?.isVisible()) {
            this.modalBackdropWindow?.moveTop()
            this.modalWindow.moveTop()
        }
        this.toastSlots
            .filter((slot) => slot.active && slot.height > 0 && slot.window.isVisible())
            .sort((a, b) => a.sequence - b.sequence)
            .forEach((slot) => slot.window.moveTop())
    }

    destroy() {
        this.mainWindow.removeListener("enter-full-screen", this.syncBounds)
        this.mainWindow.removeListener("hide", this.syncToastVisibility)
        this.mainWindow.removeListener("leave-full-screen", this.syncBounds)
        this.mainWindow.removeListener("minimize", this.syncToastVisibility)
        this.mainWindow.removeListener("move", this.syncBounds)
        this.mainWindow.removeListener("resize", this.syncBounds)
        this.mainWindow.removeListener("restore", this.syncToastVisibility)
        this.mainWindow.removeListener("show", this.syncToastVisibility)
        nativeTheme.removeListener("updated", this.syncModalBackdropTheme)
        const backdrop = this.modalBackdropWindow
        const modal = this.modalWindow
        const toastWindows = this.toastSlots.map((slot) => slot.window)
        this.toastSlots.forEach((slot) => this.clearToastTimer(slot))
        this.modalBackdropWindow = null
        this.modalContentSize = null
        this.modalInput = null
        this.modalReady = null
        this.modalRendererReady = false
        this.modalRevision += 1
        this.modalWindow = null
        this.toastReady = null
        this.toastSlots = []
        if (backdrop && !backdrop.isDestroyed()) backdrop.destroy()
        if (modal && !modal.isDestroyed()) modal.destroy()
        toastWindows.forEach((window) => {
            if (!window.isDestroyed()) window.destroy()
        })
    }

    private ensureModalWindow() {
        if (this.modalReady) return this.modalReady

        const backdrop = new BaseWindow({
            ...this.mainWindow.getContentBounds(),
            backgroundColor: modalBackdropColor(),
            focusable: false,
            frame: false,
            fullscreenable: false,
            hasShadow: false,
            maximizable: false,
            minimizable: false,
            movable: false,
            parent: this.mainWindow,
            resizable: false,
            show: false,
            skipTaskbar: true,
            transparent: true,
        })
        const window = new BrowserWindow({
            ...this.mainWindow.getContentBounds(),
            acceptFirstMouse: true,
            backgroundColor: "#00000000",
            frame: false,
            fullscreenable: false,
            hasShadow: true,
            maximizable: false,
            minimizable: false,
            movable: false,
            parent: this.mainWindow,
            resizable: false,
            show: false,
            skipTaskbar: true,
            transparent: true,
            webPreferences: {
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
                preload: join(BUNDLE_DIR, "preload.js"),
                webSecurity: true,
            },
        })
        this.modalBackdropWindow = backdrop
        this.modalRendererReady = false
        this.modalWindow = window
        this.syncModalBounds()
        backdrop.on("focus", () => {
            if (this.modalBackdropWindow !== backdrop || this.modalInput?.kind !== "image-preview") return
            this.closeModal()
        })
        window.setMenuBarVisibility(false)
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
        window.once("closed", () => {
            if (!backdrop.isDestroyed()) backdrop.destroy()
            if (this.modalBackdropWindow === backdrop) this.modalBackdropWindow = null
            if (this.modalWindow !== window) return
            this.modalContentSize = null
            this.modalInput = null
            this.modalReady = null
            this.modalRendererReady = false
            this.modalRevision += 1
            this.modalWindow = null
        })
        this.modalReady = loadOverlayRenderer(window.webContents, "modal")
            .then(() => window)
            .catch((error: unknown) => {
                if (!backdrop.isDestroyed()) backdrop.destroy()
                if (!window.isDestroyed()) window.destroy()
                throw error
            })
        return this.modalReady
    }

    private ensureToastWindows() {
        if (this.toastReady) return this.toastReady

        const slots = Array.from({ length: TOAST_POOL_SIZE }, () => this.createToastWindow())
        this.toastSlots = slots
        this.toastReady = Promise.all(slots.map((slot) => loadOverlayRenderer(slot.window.webContents, "toast")))
            .then(() => undefined)
            .catch((error: unknown) => {
                slots.forEach((slot) => {
                    if (!slot.window.isDestroyed()) slot.window.destroy()
                })
                if (this.toastSlots === slots) this.toastSlots = []
                this.toastReady = null
                throw error
            })
        return this.toastReady
    }

    private createToastWindow(): ToastWindowSlot {
        const window = new BrowserWindow({
            ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
            acceptFirstMouse: true,
            backgroundColor: "#00000000",
            focusable: false,
            frame: false,
            fullscreenable: false,
            hasShadow: false,
            height: TOAST_MEASUREMENT_HEIGHT + TOAST_PADDING * 2,
            maximizable: false,
            minimizable: false,
            movable: false,
            parent: this.mainWindow,
            resizable: false,
            roundedCorners: false,
            show: false,
            skipTaskbar: true,
            transparent: true,
            width: TOAST_CARD_WIDTH + TOAST_PADDING * 2,
            webPreferences: {
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
                preload: join(BUNDLE_DIR, "preload.js"),
                webSecurity: true,
            },
        })
        const slot: ToastWindowSlot = {
            active: false,
            height: 0,
            input: null,
            ready: false,
            revision: 0,
            sequence: 0,
            timer: null,
            window,
        }
        window.setBackgroundColor("#00000000")
        window.setMenuBarVisibility(false)
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
        window.once("closed", () => {
            this.clearToastTimer(slot)
            slot.active = false
            slot.height = 0
            slot.input = null
            slot.ready = false
        })
        this.prepareToastMeasurementBounds(slot)
        return slot
    }

    private readonly syncBounds = () => {
        this.syncModalBounds()
        this.syncToastBounds()
    }

    private readonly syncModalBackdropTheme = () => {
        if (!this.modalBackdropWindow || this.modalBackdropWindow.isDestroyed()) return
        this.modalBackdropWindow.setBackgroundColor(modalBackdropColor())
    }

    private readonly syncToastVisibility = () => {
        this.syncToastBounds()
        this.raiseViews()
    }

    private syncModalBounds() {
        if (!this.modalWindow || this.modalWindow.isDestroyed()) return
        const bounds = this.mainWindow.getContentBounds()
        if (this.modalBackdropWindow && !this.modalBackdropWindow.isDestroyed()) {
            this.modalBackdropWindow.setBounds(bounds, false)
        }
        if (this.modalInput?.kind === "image-preview" && this.modalContentSize) {
            const maxWidth = Math.max(Math.min(IMAGE_PREVIEW_MAX_WIDTH, Math.floor(bounds.width * 0.94), bounds.width - MODAL_MARGIN * 2), 1)
            const maxHeight = Math.max(Math.min(Math.floor(bounds.height * 0.92), bounds.height - MODAL_MARGIN * 2), 1)
            const imageMaxHeight = Math.max(maxHeight - IMAGE_PREVIEW_HEADER_HEIGHT, 1)
            const scale = Math.min(
                1,
                maxWidth / this.modalContentSize.width,
                imageMaxHeight / this.modalContentSize.height,
            )
            const width = Math.min(
                maxWidth,
                Math.max(Math.min(IMAGE_PREVIEW_MIN_WIDTH, maxWidth), Math.ceil(this.modalContentSize.width * scale)),
            )
            const height = Math.min(maxHeight, Math.ceil(this.modalContentSize.height * scale) + IMAGE_PREVIEW_HEADER_HEIGHT)
            this.modalWindow.setBounds({
                height,
                width,
                x: bounds.x + Math.floor((bounds.width - width) / 2),
                y: bounds.y + Math.floor((bounds.height - height) / 2),
            }, false)
            return
        }
        const size = this.modalInput?.kind === "settings" ||
            this.modalInput?.kind === "skill-market"
            ? MODAL_SIZES[this.modalInput.kind]
            : null
        if (!size) {
            this.modalWindow.setBounds(bounds, false)
            return
        }
        const width = Math.min(size.width, Math.max(bounds.width - MODAL_MARGIN * 2, 1))
        const height = Math.min(size.height, Math.max(bounds.height - MODAL_MARGIN * 2, 1))
        this.modalWindow.setBounds({
            height,
            width,
            x: bounds.x + Math.floor((bounds.width - width) / 2),
            y: bounds.y + Math.floor((bounds.height - height) / 2),
        }, false)
    }

    private renderModal() {
        if (!this.modalInput || !this.modalRendererReady || !this.modalWindow || this.modalWindow.webContents.isDestroyed()) return
        this.modalWindow.webContents.send("overlay:modal-state", {
            revision: this.modalRevision,
            state: this.modalInput,
        } satisfies ModalOverlayRenderState)
    }

    private renderToast(slot: ToastWindowSlot) {
        if (!slot.input || slot.window.webContents.isDestroyed()) return
        slot.window.webContents.send("overlay:toast", {
            revision: slot.revision,
            toast: slot.input,
        } satisfies DesktopToastRenderState)
    }

    private scheduleToastDismiss(slot: ToastWindowSlot) {
        this.clearToastTimer(slot)
        if (!slot.input || slot.input.persistent || slot.input.variant === "loading") return

        const revision = slot.revision
        slot.timer = setTimeout(() => {
            slot.timer = null
            if (!slot.active || slot.revision !== revision || slot.window.webContents.isDestroyed()) return
            slot.window.webContents.send("overlay:toast-dismiss", revision)
            slot.timer = setTimeout(() => {
                slot.timer = null
                if (!slot.active || slot.revision !== revision) return
                slot.active = false
                slot.height = 0
                slot.input = null
                slot.window.hide()
                this.syncToastBounds()
            }, 500)
            slot.timer.unref()
        }, Math.max(slot.input.duration ?? 5_000, 0))
        slot.timer.unref()
    }

    private clearToastTimer(slot: ToastWindowSlot) {
        if (!slot.timer) return
        clearTimeout(slot.timer)
        slot.timer = null
    }

    private syncToastBounds() {
        if (this.mainWindow.isDestroyed()) return
        const bounds = this.mainWindow.getContentBounds()
        const cardWidth = Math.min(TOAST_CARD_WIDTH, Math.max(bounds.width - TOAST_RIGHT - TOAST_PADDING, 1))
        const visible = this.mainWindow.isVisible() && !this.mainWindow.isMinimized()
        let top = bounds.y + TOAST_TOP
        this.toastSlots
            .filter((slot) => slot.active && slot.height > 0 && !slot.window.isDestroyed())
            .sort((a, b) => a.sequence - b.sequence)
            .forEach((slot) => {
                slot.window.setBounds({
                    height: slot.height + TOAST_PADDING * 2,
                    width: cardWidth + TOAST_PADDING * 2,
                    x: Math.max(bounds.x + bounds.width - TOAST_RIGHT - cardWidth - TOAST_PADDING, bounds.x),
                    y: top - TOAST_PADDING,
                }, false)
                top += slot.height + TOAST_GAP
                if (visible) {
                    if (!slot.window.isVisible()) slot.window.showInactive()
                    return
                }
                slot.window.hide()
            })
    }

    private prepareToastMeasurementBounds(slot: ToastWindowSlot) {
        if (slot.window.isDestroyed() || this.mainWindow.isDestroyed()) return
        const bounds = this.mainWindow.getContentBounds()
        const cardWidth = Math.min(TOAST_CARD_WIDTH, Math.max(bounds.width - TOAST_RIGHT - TOAST_PADDING, 1))
        slot.window.setBounds({
            height: Math.min(
                TOAST_MEASUREMENT_HEIGHT + TOAST_PADDING * 2,
                Math.max(bounds.height - TOAST_TOP + TOAST_PADDING, 1),
            ),
            width: cardWidth + TOAST_PADDING * 2,
            x: Math.max(bounds.x + bounds.width - TOAST_RIGHT - cardWidth - TOAST_PADDING, bounds.x),
            y: bounds.y + TOAST_TOP - TOAST_PADDING,
        }, false)
    }
}

function modalBackdropColor() {
    return nativeTheme.shouldUseDarkColors ? "#6B000000" : "#3D16181D"
}

async function loadOverlayRenderer(webContents: WebContents, kind: "modal" | "toast") {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
        if (url.hostname === "localhost") url.hostname = "127.0.0.1"
        url.searchParams.set("overlay", kind)
        await webContents.loadURL(url.toString())
        return
    }
    await webContents.loadFile(join(BUNDLE_DIR, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
        query: { overlay: kind },
    })
}
