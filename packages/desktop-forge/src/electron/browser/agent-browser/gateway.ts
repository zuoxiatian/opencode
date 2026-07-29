import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import {
    diagnosticHash,
    type AgentBrowserDiagnosticSink,
} from "./diagnostics"

const DEFAULT_LEASE_TTL = 30_000
const DEFAULT_COMMAND_TIMEOUT = 10_000
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const MAX_PENDING_REQUESTS = 256
const PAGE_DOMAINS = new Set([
    "Accessibility",
    "CSS",
    "DOM",
    "DOMDebugger",
    "Emulation",
    "Fetch",
    "Input",
    "Log",
    "Network",
    "Overlay",
    "Page",
    "Performance",
    "Runtime",
    "Storage",
])

export type CdpTabLease = {
    connectedAt?: number
    createdAt: number
    expiresAt: number
    id: string
    ownerSessionId: string
    revokedAt?: number
    tabGeneration: number
    tabId: string
}

export type CdpTabTransport = {
    hasChildSession(sessionId: string): boolean
    onDetach(listener: (reason: string) => void): () => void
    onMessage(listener: (
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
    ) => void): () => void
    sendCommand(
        method: string,
        params?: Record<string, unknown>,
        sessionId?: string,
    ): Promise<unknown>
}

type LeaseRecord = {
    active: () => boolean
    autoAttach?: Promise<void>
    data: CdpTabLease
    lastChildSession?: string
    pending: Set<number>
    pendingHighWatermark: number
    removeDetach?: () => void
    removeMessage?: () => void
    socket?: WebSocket
    transport: CdpTabTransport
}

class GatewayCommandTimeoutError extends Error {}

export class CdpTabGateway {
    private readonly leases = new Map<string, LeaseRecord>()
    private server?: Server
    private websocket?: WebSocketServer
    private sweepTimer?: NodeJS.Timeout
    private port?: number

    constructor(
        private readonly now: () => number = Date.now,
        private readonly commandTimeout = DEFAULT_COMMAND_TIMEOUT,
        private readonly diagnostic?: AgentBrowserDiagnosticSink,
    ) {}

    async start() {
        if (this.port) return this.port
        this.websocket = new WebSocketServer({
            maxPayload: MAX_MESSAGE_BYTES,
            noServer: true,
            perMessageDeflate: false,
        })
        this.server = createServer((_request, response) => {
            response.writeHead(404, {
                "cache-control": "no-store",
                "content-type": "text/plain; charset=utf-8",
            })
            response.end("Not Found")
        })
        this.server.on("upgrade", (request, socket, head) => {
            const match = request.url?.match(/^\/cdp\/([A-Za-z0-9_-]{43})$/)
            const lease = match ? this.leases.get(match[1]) : undefined
            if (!isGatewayLeaseAvailable(
                lease?.data,
                this.now(),
                lease?.active() ?? false,
                request.headers.origin,
            )) {
                rejectUpgrade(socket, lease ? 401 : 404)
                return
            }
            if (!lease) return
            lease.data.connectedAt = this.now()
            this.diagnostic?.({
                component: "gateway",
                event: "lease_connected",
                tabHash: diagnosticHash(lease.data.tabId),
            })
            this.websocket?.handleUpgrade(request, socket, head, (websocket) => {
                this.connect(lease, websocket)
            })
        })
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => {
                this.server?.removeListener("listening", listening)
                reject(error)
            }
            const listening = () => {
                this.server?.removeListener("error", failed)
                resolve()
            }
            this.server?.once("error", failed)
            this.server?.once("listening", listening)
            this.server?.listen(0, "127.0.0.1")
        })
        const address = this.server.address()
        if (!address || typeof address === "string") throw new Error("CDP Gateway failed to bind")
        this.port = address.port
        this.sweepTimer = setInterval(() => this.expireLeases(), 1_000)
        this.sweepTimer.unref()
        return this.port
    }

    createLease(input: {
        active: () => boolean
        ownerSessionId: string
        tabGeneration: number
        tabId: string
        transport: CdpTabTransport
        ttl?: number
    }) {
        if (!this.port) throw new Error("CDP Gateway is not listening")
        const id = randomBytes(32).toString("base64url")
        const data: CdpTabLease = {
            createdAt: this.now(),
            expiresAt: this.now() + (input.ttl ?? DEFAULT_LEASE_TTL),
            id,
            ownerSessionId: input.ownerSessionId,
            tabGeneration: input.tabGeneration,
            tabId: input.tabId,
        }
        this.leases.set(id, {
            active: input.active,
            data,
            pending: new Set(),
            pendingHighWatermark: 0,
            transport: input.transport,
        })
        this.diagnostic?.({
            component: "gateway",
            event: "lease_created",
            tabHash: diagnosticHash(input.tabId),
        })
        return {
            lease: { ...data },
            url: `ws://127.0.0.1:${this.port}/cdp/${id}`,
        }
    }

    getLease(id: string) {
        const lease = this.leases.get(id)
        return lease ? { ...lease.data } : undefined
    }

    isConnected(id: string) {
        return this.leases.get(id)?.socket?.readyState === WebSocket.OPEN
    }

    beginCommand(id: string) {
        const lease = this.leases.get(id)
        if (lease) lease.lastChildSession = undefined
    }

    getLastChildSession(id: string) {
        return this.leases.get(id)?.lastChildSession
    }

    revoke(id: string) {
        const lease = this.leases.get(id)
        if (!lease || lease.data.revokedAt) return false
        lease.data.revokedAt = this.now()
        this.diagnostic?.({
            component: "gateway",
            event: "lease_revoked",
            tabHash: diagnosticHash(lease.data.tabId),
        })
        this.disconnect(lease, 1008, "lease revoked")
        return true
    }

    revokeTab(tabId: string) {
        return [...this.leases.values()]
            .filter((lease) => lease.data.tabId === tabId)
            .map((lease) => this.revoke(lease.data.id))
            .filter(Boolean)
            .length
    }

    async close() {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        this.sweepTimer = undefined
        this.leases.forEach((lease) => {
            if (!lease.data.revokedAt) lease.data.revokedAt = this.now()
            const socket = lease.socket
            this.disconnect(lease)
            if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate()
        })
        this.leases.clear()
        this.websocket?.close()
        this.websocket = undefined
        if (this.server) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 250)
                this.server?.close(() => {
                    clearTimeout(timer)
                    resolve()
                })
                this.server?.closeAllConnections()
            })
        }
        this.server = undefined
        this.port = undefined
    }

    private connect(lease: LeaseRecord, socket: WebSocket) {
        lease.socket = socket
        lease.removeMessage = lease.transport.onMessage((method, params, sessionId) => {
            if (socket.readyState !== WebSocket.OPEN || !lease.active()) return
            send(socket, {
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
            })
        })
        lease.removeDetach = lease.transport.onDetach(() => {
            this.disconnect(lease, 1011, "target gone")
        })
        socket.on("message", (input, binary) => {
            if (binary || messageBytes(input) > MAX_MESSAGE_BYTES) {
                this.disconnect(lease, 1009, "message too large")
                return
            }
            this.handleRequest(lease, messageText(input))
        })
        socket.once("close", () => this.disconnect(lease))
        socket.once("error", () => this.disconnect(lease))
    }

    private handleRequest(lease: LeaseRecord, input: string) {
        const request = parseRequest(input)
        if (!request) {
            this.disconnect(lease, 1008, "invalid request")
            return
        }
        if (!lease.active()) {
            respond(lease, request.id, undefined, {
                code: -32000,
                message: "Target is no longer available",
            })
            this.disconnect(lease, 1011, "target gone")
            return
        }
        if (lease.pending.has(request.id) || lease.pending.size >= MAX_PENDING_REQUESTS) {
            respond(lease, request.id, undefined, {
                code: -32000,
                message: "Too many pending CDP requests",
            })
            return
        }
        if (request.sessionId && !lease.transport.hasChildSession(request.sessionId)) {
            respond(lease, request.id, undefined, {
                code: -32000,
                message: "CDP session is not available",
            })
            return
        }
        if (!isCdpMethodAllowed(request.method, request.params, request.sessionId, lease.transport)) {
            respond(lease, request.id, undefined, {
                code: -32000,
                message: "CDP method is not allowed",
            })
            return
        }
        if (request.sessionId) lease.lastChildSession = request.sessionId
        lease.pending.add(request.id)
        if (lease.pending.size > lease.pendingHighWatermark) {
            lease.pendingHighWatermark = lease.pending.size
            this.diagnostic?.({
                component: "gateway",
                event: "pending_high_watermark",
                pendingCommands: lease.pendingHighWatermark,
                tabHash: diagnosticHash(lease.data.tabId),
            })
        }
        void this.enableOopifForSnapshot(lease, request.method)
            .then(() => withTimeout(
                sendCdpCommand(lease.transport, request.method, request.params, request.sessionId),
                this.commandTimeout,
            )).then(
                (result) => respond(lease, request.id, result),
                (error: unknown) => respond(lease, request.id, undefined, {
                    code: -32000,
                    message: !lease.active()
                        ? "Target is no longer available"
                        : error instanceof GatewayCommandTimeoutError
                            ? "CDP command timed out"
                            : "CDP command failed",
                }),
            ).finally(() => lease.pending.delete(request.id))
    }

    private enableOopifForSnapshot(lease: LeaseRecord, method: string) {
        if (method !== "Browser.getVersion" && !method.startsWith("Accessibility.")) {
            return Promise.resolve()
        }
        lease.autoAttach ??= lease.transport.sendCommand("Target.setAutoAttach", {
            autoAttach: true,
            flatten: true,
            waitForDebuggerOnStart: false,
        }).then(() => undefined)
        return lease.autoAttach
    }

    private disconnect(lease: LeaseRecord, code?: number, reason?: string) {
        lease.removeMessage?.()
        lease.removeDetach?.()
        lease.removeMessage = undefined
        lease.removeDetach = undefined
        if (code && lease.socket?.readyState === WebSocket.OPEN) lease.socket.close(code, reason)
        lease.socket = undefined
        lease.pending.clear()
    }

    private expireLeases() {
        this.leases.forEach((lease) => {
            if (lease.data.revokedAt || lease.data.connectedAt || lease.data.expiresAt > this.now()) return
            lease.data.revokedAt = this.now()
            this.diagnostic?.({
                component: "gateway",
                event: "lease_expired",
                tabHash: diagnosticHash(lease.data.tabId),
            })
            this.disconnect(lease, 1008, "lease expired")
        })
    }
}

export function isCdpMethodAllowed(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    transport: Pick<CdpTabTransport, "hasChildSession">,
) {
    if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) return false
    if (method === "Browser.getVersion") return !sessionId
    if (method === "Target.setAutoAttach") {
        return !sessionId
            && params.autoAttach === true
            && params.flatten === true
            && typeof params.waitForDebuggerOnStart === "boolean"
    }
    if (method === "Target.detachFromTarget") {
        return !sessionId
            && typeof params.sessionId === "string"
            && transport.hasChildSession(params.sessionId)
    }
    return PAGE_DOMAINS.has(method.slice(0, method.indexOf(".")))
}

export function isGatewayLeaseAvailable(
    lease: CdpTabLease | undefined,
    now: number,
    active: boolean,
    origin?: string,
) {
    return Boolean(
        lease
        && origin === undefined
        && !lease.revokedAt
        && !lease.connectedAt
        && lease.expiresAt > now
        && active,
    )
}

function parseRequest(input: string) {
    let parsed: unknown
    try {
        parsed = JSON.parse(input)
    } catch {
        return undefined
    }
    const request = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    const params = request.params === undefined ? {} : request.params
    if (
        typeof request.id !== "number"
        || !Number.isFinite(request.id)
        || !Number.isInteger(request.id)
        || typeof request.method !== "string"
        || !request.method
        || typeof params !== "object"
        || params === null
        || Array.isArray(params)
        || (
            request.sessionId !== undefined
            && typeof request.sessionId !== "string"
        )
    ) return undefined
    return {
        id: request.id as number,
        method: request.method,
        params: params as Record<string, unknown>,
        sessionId: request.sessionId || undefined,
    }
}

function sendCdpCommand(
    transport: CdpTabTransport,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
) {
    if (method !== "Browser.getVersion") return transport.sendCommand(method, params, sessionId)
    return transport.sendCommand(method, params).catch(() => ({
        jsVersion: process.versions.v8,
        product: `Chrome/${process.versions.chrome ?? "0"}`,
        protocolVersion: "1.3",
        revision: "@0",
        userAgent: "",
    }))
}

function respond(
    lease: LeaseRecord,
    id: number,
    result?: unknown,
    error?: { code: number; message: string },
) {
    if (lease.socket?.readyState !== WebSocket.OPEN) return
    send(lease.socket, error ? { error, id } : { id, result: result ?? {} })
}

function send(socket: WebSocket, value: unknown) {
    const output = JSON.stringify(value)
    if (Buffer.byteLength(output) > MAX_MESSAGE_BYTES) {
        socket.close(1009, "message too large")
        return
    }
    socket.send(output)
}

function messageBytes(input: RawData) {
    return Array.isArray(input)
        ? input.reduce((total, item) => total + item.byteLength, 0)
        : input.byteLength
}

function messageText(input: RawData) {
    if (Array.isArray(input)) return Buffer.concat(input).toString()
    if (input instanceof ArrayBuffer) return Buffer.from(input).toString()
    return input.toString()
}

function rejectUpgrade(socket: Duplex, status: 401 | 404) {
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\n\r\n`)
}

function withTimeout<T>(task: Promise<T>, timeout: number) {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new GatewayCommandTimeoutError()), timeout)
        timer.unref()
        task.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (error: unknown) => {
                clearTimeout(timer)
                reject(error)
            },
        )
    })
}
