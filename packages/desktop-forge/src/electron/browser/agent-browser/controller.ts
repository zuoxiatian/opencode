import { createHash, randomUUID } from "node:crypto"
import type { EmbeddedTab } from "../embedded/tab"
import { BrowserRuntimeException } from "../errors"
import type {
    AgentBrowserCommandInput,
    AgentBrowserJsonResult,
    AgentBrowserProcessManager,
} from "./process-manager"
import type { CdpTabGateway } from "./gateway"
import {
    diagnosticHash,
    type AgentBrowserDiagnosticSink,
} from "./diagnostics"

type AgentBrowserRunner = Pick<AgentBrowserProcessManager, "prepare" | "run" | "stop">

type QueuedCommandInput = Pick<
    AgentBrowserCommandInput,
    "args" | "operation" | "signal" | "timeout"
>

type SessionRecord = {
    abort: AbortController
    agentSession: string
    closing: boolean
    cdpUrl: string
    idleTimer?: NodeJS.Timeout
    leaseId: string
    latestSnapshot?: {
        id: string
        refs: Set<string>
        sessionGeneration: number
        tabGeneration: number
    }
    ownerSessionId: string
    sessionGeneration: number
    tab: EmbeddedTab
}

export type AgentBrowserControllerResult = {
    childSessionId?: string
    output: AgentBrowserJsonResult
    sessionGeneration: number
}

export type AgentBrowserTransaction = {
    run(input: {
        args: string[]
        operation: string
        timeout?: number
    }): Promise<AgentBrowserControllerResult>
}

export class AgentBrowserTabController {
    private readonly records = new Map<string, SessionRecord>()
    private readonly creating = new Map<string, Promise<SessionRecord>>()
    private readonly queues = new Map<string, Promise<void>>()
    private destroyed = false

    constructor(
        private readonly gateway: CdpTabGateway,
        private readonly processes: AgentBrowserRunner,
        private readonly maxSessions = 4,
        private readonly diagnostic?: AgentBrowserDiagnosticSink,
        private readonly idleTimeout = 5 * 60_000,
    ) {}

    run(input: {
        args: string[]
        operation: string
        ownerSessionId: string
        signal?: AbortSignal
        tab: EmbeddedTab
        timeout?: number
    }) {
        return this.transaction(input, (transaction) => transaction.run({
            args: input.args,
            operation: input.operation,
            timeout: input.timeout,
        }))
    }

    transaction<T>(
        input: {
            ownerSessionId: string
            signal?: AbortSignal
            tab: EmbeddedTab
        },
        task: (transaction: AgentBrowserTransaction) => Promise<T>,
    ) {
        const queued = (this.queues.get(input.tab.id) ?? Promise.resolve()).then(async () => {
            const record = await this.session(input.tab, input.ownerSessionId)
            this.ensureActive(record)
            if (
                record.latestSnapshot
                && record.latestSnapshot.tabGeneration !== record.tab.generation
            ) {
                record.latestSnapshot = undefined
            }
            return task({
                run: (command) => this.execute(record, {
                    ...command,
                    signal: input.signal,
                }, true),
            })
        })
        const queue = queued.then(() => undefined, () => undefined)
        this.queues.set(input.tab.id, queue)
        void queue.finally(() => {
            if (this.queues.get(input.tab.id) === queue) this.queues.delete(input.tab.id)
        })
        return queued
    }

    recordSnapshot(tabId: string, ownerSessionId: string, refs: string[] = []) {
        const record = this.requireRecord(tabId, ownerSessionId)
        record.latestSnapshot = {
            id: randomUUID(),
            refs: new Set(refs),
            sessionGeneration: record.sessionGeneration,
            tabGeneration: record.tab.generation,
        }
        return {
            snapshotId: record.latestSnapshot.id,
            tabGeneration: record.latestSnapshot.tabGeneration,
        }
    }

    validateSnapshot(tabId: string, ownerSessionId: string, snapshotId: string, ref?: string) {
        const record = this.requireRecord(tabId, ownerSessionId)
        if (
            record.latestSnapshot?.id !== snapshotId
            || record.latestSnapshot.tabGeneration !== record.tab.generation
            || record.latestSnapshot.sessionGeneration !== record.sessionGeneration
            || (ref !== undefined && !record.latestSnapshot.refs.has(ref))
        ) {
            throw new BrowserRuntimeException("STALE_REF", "Browser snapshot reference is stale", true, {
                snapshotId,
                tabGeneration: record.tab.generation,
            })
        }
    }

    invalidateSnapshot(tabId: string) {
        const record = this.records.get(tabId)
        if (record) record.latestSnapshot = undefined
    }

    async closeTab(tabId: string) {
        const active = this.records.get(tabId)
        if (active) {
            active.closing = true
            active.abort.abort()
            this.clearIdle(active)
            this.diagnostic?.({
                activeSessions: this.records.size,
                component: "controller",
                event: "session_closing",
                tabHash: diagnosticHash(tabId),
            })
        }
        await this.creating.get(tabId)?.catch(() => undefined)
        const record = this.records.get(tabId)
        if (!record) return
        record.closing = true
        record.abort.abort()
        await this.queues.get(tabId)?.catch(() => undefined)
        await this.processes.stop({
            cdpUrl: record.cdpUrl,
            session: record.agentSession,
            timeout: 3_000,
        }).catch(() => undefined)
        this.gateway.revoke(record.leaseId)
        this.records.delete(tabId)
        this.diagnostic?.({
            activeSessions: this.records.size,
            component: "controller",
            event: "session_closed",
            tabHash: diagnosticHash(tabId),
        })
    }

    async closeOwner(ownerSessionId: string) {
        await Promise.all(
            [...this.creating.values()].map((creation) => creation.catch(() => undefined)),
        )
        await Promise.all(
            [...this.records.values()]
                .filter((record) => record.ownerSessionId === ownerSessionId)
                .map((record) => this.closeTab(record.tab.id)),
        )
    }

    async destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.records.forEach((record) => {
            record.closing = true
            record.abort.abort()
        })
        await Promise.all(
            [...this.creating.values()].map((creation) => creation.catch(() => undefined)),
        )
        await Promise.all([...this.records.keys()].map((tabId) => this.closeTab(tabId)))
        await this.gateway.close()
    }

    private async session(tab: EmbeddedTab, ownerSessionId: string) {
        if (this.destroyed) {
            throw new BrowserRuntimeException(
                "AGENT_BROWSER_UNAVAILABLE",
                "Browser automation controller is closed",
            )
        }
        const pending = this.creating.get(tab.id)
        if (pending) {
            const record = await pending
            this.ensureOwner(record, ownerSessionId)
            return record
        }
        const current = this.records.get(tab.id)
        if (current) {
            this.ensureOwner(current, ownerSessionId)
            return current
        }
        if (
            new Set([...this.records.keys(), ...this.creating.keys()]).size
            >= this.maxSessions
        ) {
            throw new BrowserRuntimeException(
                "AGENT_SESSION_LIMIT",
                "Too many active browser automation sessions",
                true,
            )
        }
        const creation = this.createSession(tab, ownerSessionId)
        this.diagnostic?.({
            activeSessions: this.records.size + this.creating.size + 1,
            component: "controller",
            event: "session_creating",
            tabHash: diagnosticHash(tab.id),
        })
        this.creating.set(tab.id, creation)
        return creation.finally(() => this.creating.delete(tab.id))
    }

    private async createSession(tab: EmbeddedTab, ownerSessionId: string) {
        if (
            tab.closed
            || tab.webContents.isDestroyed()
            || tab.ownership.ownerSessionId !== ownerSessionId
        ) {
            throw new BrowserRuntimeException(
                "TAB_NOT_OWNED",
                "Browser tab is not available to this session",
            )
        }
        await Promise.all([this.gateway.start(), this.processes.prepare()]).catch((error: unknown) => {
            if (error instanceof BrowserRuntimeException) throw error
            throw new BrowserRuntimeException(
                "GATEWAY_UNAVAILABLE",
                "Browser automation Gateway could not start",
                true,
                { causeCategory: "gateway_start" },
            )
        })
        const issued = this.gateway.createLease({
            active: () =>
                !this.destroyed
                && !tab.closed
                && !tab.webContents.isDestroyed()
                && tab.ownership.ownerSessionId === ownerSessionId,
            ownerSessionId,
            tabGeneration: tab.generation,
            tabId: tab.id,
            transport: tab.debuggerTransport,
        })
        const record: SessionRecord = {
            abort: new AbortController(),
            agentSession: sessionName(tab.id, ownerSessionId),
            cdpUrl: issued.url,
            closing: false,
            leaseId: issued.lease.id,
            ownerSessionId,
            sessionGeneration: 1,
            tab,
        }
        this.records.set(tab.id, record)
        this.armIdle(record)
        this.diagnostic?.({
            activeSessions: this.records.size,
            component: "controller",
            event: "session_ready",
            tabHash: diagnosticHash(tab.id),
        })
        return record
    }

    private execute(
        record: SessionRecord,
        input: QueuedCommandInput,
        reconnect: boolean,
    ): Promise<AgentBrowserControllerResult> {
        const startedAt = Date.now()
        this.clearIdle(record)
        this.gateway.beginCommand(record.leaseId)
        this.diagnostic?.({
            activeSessions: this.records.size,
            command: input.operation,
            component: "controller",
            event: "command_started",
            pendingCommands: this.queues.size,
            tabHash: diagnosticHash(record.tab.id),
        })
        return this.processes.run({
            ...input,
            cdpUrl: record.cdpUrl,
            session: record.agentSession,
            signal: combineSignals(input.signal, record.abort.signal),
        }).then(
            (output) => {
                this.diagnostic?.({
                    activeSessions: this.records.size,
                    command: input.operation,
                    component: "controller",
                    durationMs: Date.now() - startedAt,
                    event: "command_finished",
                    outcome: "success",
                    pendingCommands: this.queues.size,
                    tabHash: diagnosticHash(record.tab.id),
                })
                return {
                    ...(this.gateway.getLastChildSession(record.leaseId)
                        ? { childSessionId: this.gateway.getLastChildSession(record.leaseId) }
                        : {}),
                    output,
                    sessionGeneration: record.sessionGeneration,
                }
            },
            async (error: unknown) => {
                this.diagnostic?.({
                    activeSessions: this.records.size,
                    command: input.operation,
                    component: "controller",
                    durationMs: Date.now() - startedAt,
                    errorCode: error instanceof BrowserRuntimeException
                        ? error.browser.code
                        : "UNKNOWN",
                    event: "command_finished",
                    outcome: error instanceof BrowserRuntimeException
                        && error.browser.code === "CANCELLED"
                        ? "cancelled"
                        : "error",
                    pendingCommands: this.queues.size,
                    tabHash: diagnosticHash(record.tab.id),
                })
                if (!reconnect || !this.recoverable(record, error) || record.closing) throw error
                await this.reconnect(record)
                return this.execute(record, input, false)
            },
        ).finally(() => this.armIdle(record))
    }

    private async reconnect(record: SessionRecord) {
        this.ensureActive(record)
        await this.processes.stop({
            cdpUrl: record.cdpUrl,
            session: record.agentSession,
            timeout: 3_000,
        }).catch(() => undefined)
        this.gateway.revoke(record.leaseId)
        const issued = this.gateway.createLease({
            active: () =>
                !this.destroyed
                && !record.closing
                && !record.tab.closed
                && !record.tab.webContents.isDestroyed()
                && record.tab.ownership.ownerSessionId === record.ownerSessionId,
            ownerSessionId: record.ownerSessionId,
            tabGeneration: record.tab.generation,
            tabId: record.tab.id,
            transport: record.tab.debuggerTransport,
        })
        record.cdpUrl = issued.url
        record.leaseId = issued.lease.id
        record.latestSnapshot = undefined
        record.sessionGeneration += 1
        this.diagnostic?.({
            activeSessions: this.records.size,
            component: "controller",
            event: "session_reconnected",
            reconnectCount: record.sessionGeneration - 1,
            tabHash: diagnosticHash(record.tab.id),
        })
    }

    private recoverable(record: SessionRecord, error: unknown) {
        if (
            error instanceof BrowserRuntimeException
            && error.browser.code === "GATEWAY_AUTH_FAILED"
        ) {
            return this.gateway.getLease(record.leaseId)?.connectedAt !== undefined
        }
        return recoverable(error)
    }

    private requireRecord(tabId: string, ownerSessionId: string) {
        const record = this.records.get(tabId)
        if (!record) {
            throw new BrowserRuntimeException(
                "AGENT_SESSION_FAILED",
                "Browser automation session is not ready",
                true,
            )
        }
        this.ensureOwner(record, ownerSessionId)
        return record
    }

    private ensureOwner(record: SessionRecord, ownerSessionId: string) {
        if (
            record.ownerSessionId !== ownerSessionId
            || record.tab.ownership.ownerSessionId !== ownerSessionId
        ) {
            throw new BrowserRuntimeException(
                "TAB_NOT_OWNED",
                "Browser tab is controlled by another session",
            )
        }
    }

    private ensureActive(record: SessionRecord) {
        this.ensureOwner(record, record.ownerSessionId)
        if (
            record.closing
            || record.tab.closed
            || record.tab.webContents.isDestroyed()
        ) {
            throw new BrowserRuntimeException("TARGET_GONE", "Browser tab is no longer available", true)
        }
    }

    private armIdle(record: SessionRecord) {
        this.clearIdle(record)
        if (record.closing || this.destroyed || this.records.get(record.tab.id) !== record) return
        record.idleTimer = setTimeout(() => {
            record.idleTimer = undefined
            if (record.closing || this.destroyed || this.records.get(record.tab.id) !== record) return
            this.diagnostic?.({
                activeSessions: this.records.size,
                component: "controller",
                event: "session_idle",
                tabHash: diagnosticHash(record.tab.id),
            })
        }, this.idleTimeout)
        record.idleTimer.unref()
    }

    private clearIdle(record: SessionRecord) {
        if (record.idleTimer) clearTimeout(record.idleTimer)
        record.idleTimer = undefined
    }
}

function sessionName(tabId: string, ownerSessionId: string) {
    return `df-${createHash("sha256").update(`${tabId}\0${ownerSessionId}`).digest("hex").slice(0, 16)}`
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal) {
    return first ? AbortSignal.any([first, second]) : second
}

function recoverable(error: unknown) {
    return error instanceof BrowserRuntimeException
        && (
            error.browser.code === "AGENT_SESSION_FAILED"
            || error.browser.code === "GATEWAY_UNAVAILABLE"
            || error.browser.code === "TARGET_GONE"
        )
        && error.browser.retryable
}
