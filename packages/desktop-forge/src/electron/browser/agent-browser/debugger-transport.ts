import type { WebContents } from "electron"

export type TabDebuggerMessageListener = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
) => void

export type TabDebuggerDetachListener = (reason: string) => void

export class TabDebuggerTransport {
    private readonly messages = new Set<TabDebuggerMessageListener>()
    private readonly detaches = new Set<TabDebuggerDetachListener>()
    private readonly sessions = new Set<string>()
    private disposed = false

    constructor(private readonly webContents: WebContents) {
        this.webContents.debugger.on("message", this.handleMessage)
        this.webContents.debugger.on("detach", this.handleDetach)
        this.webContents.once("destroyed", this.handleDestroyed)
    }

    get childSessions(): ReadonlySet<string> {
        return this.sessions
    }

    ensureAttached() {
        if (this.disposed || this.webContents.isDestroyed()) {
            throw new Error("Browser tab debugger is no longer available")
        }
        if (!this.webContents.debugger.isAttached()) this.webContents.debugger.attach("1.3")
    }

    hasChildSession(sessionId: string) {
        return this.sessions.has(sessionId)
    }

    onMessage(listener: TabDebuggerMessageListener) {
        this.messages.add(listener)
        return () => this.messages.delete(listener)
    }

    onDetach(listener: TabDebuggerDetachListener) {
        this.detaches.add(listener)
        return () => this.detaches.delete(listener)
    }

    sendCommand(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string,
    ) {
        this.ensureAttached()
        return this.webContents.debugger.sendCommand(method, params, sessionId)
    }

    destroy() {
        if (this.disposed) return
        this.disposed = true
        this.cleanup()
        if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
            this.webContents.debugger.detach()
        }
        this.sessions.clear()
        this.messages.clear()
        this.detaches.clear()
    }

    private readonly handleMessage = (
        _event: Electron.Event,
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
    ) => {
        if (this.disposed || this.webContents.isDestroyed()) return
        if (sessionId) this.sessions.add(sessionId)
        if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
            this.sessions.add(params.sessionId)
        }
        if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
            this.sessions.delete(params.sessionId)
        }
        this.messages.forEach((listener) => listener(method, params, sessionId))
    }

    private readonly handleDetach = (_event: Electron.Event, reason: string) => {
        if (this.disposed) return
        this.sessions.clear()
        this.detaches.forEach((listener) => listener(reason))
    }

    private readonly handleDestroyed = () => {
        if (this.disposed) return
        this.disposed = true
        this.sessions.clear()
        this.detaches.forEach((listener) => listener("target closed"))
        this.cleanup()
        this.messages.clear()
        this.detaches.clear()
    }

    private cleanup() {
        this.webContents.debugger.removeListener("message", this.handleMessage)
        this.webContents.debugger.removeListener("detach", this.handleDetach)
        this.webContents.removeListener("destroyed", this.handleDestroyed)
    }
}
