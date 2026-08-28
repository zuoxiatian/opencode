import { session, type BrowserWindow } from "electron"
import {
    BROWSER_PROTOCOL_VERSION,
    DEFAULT_BROWSER_ID,
    type BrowserAutomationTarget,
    type BrowserBounds,
    type BrowserCommand,
    type BrowserCommandData,
    type BrowserCommandRequest,
    type BrowserInfo,
} from "@opencode-ai/browser-protocol"
import type { BrowserBackend, BrowserDispatchContext } from "../backend"
import { BrowserRuntimeException } from "../errors"
import type { BrowserEventStore } from "../event-store"
import { BrowserLifecycle } from "../lifecycle"
import { AgentBrowserCommandAdapter } from "../agent-browser/adapter"
import type { AgentBrowserTabController } from "../agent-browser/controller"
import { createAgentBrowserTabController } from "../agent-browser/runtime"
import { AriaSnapshotService } from "./automation/aria-snapshot"
import { executeRawCdp, withDebugger } from "./automation/cdp"
import {
    coordinateClick,
    coordinateDrag,
    coordinateMove,
    coordinateScroll,
    keypressKeys,
    textInput,
} from "./automation/input"
import { NodeActionService } from "./automation/node-action"
import { captureErrorScreenshot, captureScreenshot } from "./automation/screenshot"
import { waitForTimeout } from "./automation/waits"
import {
    readClipboard,
    readClipboardText,
    writeClipboard,
    writeClipboardText,
} from "./clipboard"
import { DialogService } from "./dialogs"
import { DownloadService } from "./downloads"
import { FileChooserService } from "./file-chooser"
import { NavigationService, browserOrigin } from "./navigation"
import { configureBrowserPermissions } from "./permissions"
import { tabState } from "./state"
import type { EmbeddedTab } from "./tab"
import { EmbeddedTabStore } from "./tab-store"
import { BrowserUserTabs } from "./user-tabs"

const info: BrowserInfo = {
    capabilities: {
        browser: [
            {
                description: "Show or hide the embedded browser and inspect its visibility.",
                id: "visibility",
            },
        ],
        tab: [{
            description: "Send raw Chrome DevTools Protocol commands and read debugger events through a supported tab.",
            id: "cdp",
        }],
    },
    id: DEFAULT_BROWSER_ID,
    name: "LongwiseTechAgent Browser",
    type: "iab",
}

export function createEmbeddedBrowserBackend(
    window: BrowserWindow,
    events: BrowserEventStore,
    raiseOverlays?: () => void,
): BrowserBackend {
    const browserSession = session.fromPartition("persist:desktop-forge-browser")
    let registerTab: (tab: EmbeddedTab) => void = () => undefined
    const tabs = new EmbeddedTabStore(window, events, (tab) => registerTab(tab), raiseOverlays)
    const navigation = new NavigationService(browserSession, tabs, events)
    const dialogs = new DialogService(tabs, events)
    const aria = new AriaSnapshotService()
    const nodes = new NodeActionService(aria)
    const downloads = new DownloadService(browserSession, tabs, events)
    const fileChoosers = new FileChooserService(tabs, events)
    const lifecycle = new BrowserLifecycle(tabs)
    const agentBrowser = createAgentBrowserTabController()
    const automation = new AgentBrowserCommandAdapter(agentBrowser)
    const userTabs = new BrowserUserTabs(tabs)
    const sessionNames = new Map<string, string>()
    const clearClosedTab = events.subscribe((event) => {
        if (event.type !== "tab.closed" || !event.tabId) return
        aria.clear(event.tabId)
        downloads.clearTab(event.tabId)
        userTabs.clear(event.tabId)
        void agentBrowser.closeTab(event.tabId)
    })

    registerTab = (tab) => {
        navigation.register(tab)
        dialogs.register(tab)
        fileChoosers.register(tab)
        tab.debuggerTransport.ensureAttached()
        const documentRequests = new Set<string>()
        let debuggerStarted = false
        const initializeDebugger = () => {
            if (debuggerStarted) return
            debuggerStarted = true
            const ready = Promise.all([
                tab.debuggerTransport.sendCommand("Network.enable"),
                tab.debuggerTransport.sendCommand("Page.enable"),
            ]).then(() => undefined)
                .catch((error: unknown) => {
                    debuggerStarted = false
                    throw error
                })
            tab.debuggerReady = ready
            void ready.catch(() => undefined)
        }
        tab.webContents.on("did-start-loading", () => {
            documentRequests.clear()
            agentBrowser.invalidateSnapshot(tab.id)
            initializeDebugger()
        })
        tab.webContents.on("did-stop-loading", () => {
            documentRequests.forEach((requestId) => tab.networkRequests.delete(requestId))
            documentRequests.clear()
        })
        tab.webContents.on("console-message", (details) => {
            tab.logs.push({
                level: details.level === "warning" ? "warn" : details.level,
                message: details.message,
                timestamp: new Date().toISOString(),
                url: details.sourceId || undefined,
            })
            if (tab.logs.length > 1_000) tab.logs.splice(0, tab.logs.length - 1_000)
        })
        tab.debuggerTransport.onMessage((method, params, sessionId) => {
            tab.cdpSequence += 1
            tab.cdpEvents.push({
                method,
                params,
                sequence: tab.cdpSequence,
                source: {
                    ...(sessionId ? { sessionId } : {}),
                    tabId: tab.webContents.id,
                    ...(
                        typeof params.targetId === "string"
                            ? { targetId: params.targetId }
                            : typeof params.targetInfo === "object"
                                && params.targetInfo !== null
                                && "targetId" in params.targetInfo
                                && typeof params.targetInfo.targetId === "string"
                                ? { targetId: params.targetInfo.targetId }
                            : {}
                    ),
                },
            })
            if (tab.cdpEvents.length > 1_000) tab.cdpEvents.splice(0, tab.cdpEvents.length - 1_000)
            const requestId = typeof params.requestId === "string" ? params.requestId : undefined
            if (!requestId) return
            if (method === "Network.requestWillBeSent") {
                tab.networkRequests.add(requestId)
                if (params.type === "Document") documentRequests.add(requestId)
            }
            if (method === "Network.loadingFailed" || method === "Network.loadingFinished") {
                documentRequests.delete(requestId)
                tab.networkRequests.delete(requestId)
            }
        })
        tab.webContents.setWindowOpenHandler(({ url }) => {
            if (isWebUrl(url)) {
                const ownership = {
                    ...tab.ownership,
                    disposition: tab.ownership.createdBy === "agent" ? "temporary" as const : "deliverable" as const,
                }
                void Promise.resolve().then(() => {
                    const child = tabs.create(tab.conversationId, ownership)
                    return navigation.goto(child, url, internalRequest(child.id, ownership.ownerSessionId))
                }).catch(() => undefined)
            }
            return { action: "deny" }
        })
    }

    const clearPermissions = configureBrowserPermissions(browserSession, window, events, tabs)
    const fileRequested = (
        details: Electron.OnBeforeRequestListenerDetails,
        callback: (response: Electron.CallbackResponse) => void,
    ) => {
        const tab = tabs.findByWebContentsId(details.webContentsId ?? details.webContents?.id ?? -1)
        const requested = browserOrigin(details.url)
        callback({
            cancel: !tab
                || !requested?.startsWith("file:")
                || requested !== browserOrigin(tab.pendingUrl || tab.webContents.getURL()),
        })
    }
    browserSession.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, fileRequested)
    const headersReceived = (
        details: Electron.OnHeadersReceivedListenerDetails,
        callback: (response: Electron.HeadersReceivedResponse) => void,
    ) => {
        const tab = tabs.findByWebContentsId(details.webContentsId ?? details.webContents?.id ?? -1)
        if (tab && details.resourceType === "mainFrame") {
            tab.httpResponse = {
                contentLength: responseContentLength(details.responseHeaders),
                statusCode: details.statusCode,
                url: details.url,
            }
        }
        callback({})
    }
    browserSession.webRequest.onHeadersReceived({
        urls: ["http://*/*", "https://*/*"],
    }, headersReceived)

    return {
        info,
        destroy: async () => {
            clearClosedTab()
            browserSession.webRequest.onBeforeRequest(null)
            browserSession.webRequest.onHeadersReceived(null)
            clearPermissions()
            downloads.destroy()
            fileChoosers.destroy()
            await agentBrowser.destroy()
            await tabs.destroy()
        },
        disposeConversation: async (conversationId) => {
            await agentBrowser.closeOwner(conversationId)
            tabs.disposeConversation(conversationId)
        },
        dispatch: async (request, context) => {
            if (context.signal?.aborted) {
                throw new BrowserRuntimeException("CANCELLED", "Browser command was cancelled", true)
            }
            if (request.command.name === "browser.show") {
                tabs.show(context.conversationId, ownershipFor(request, context), request)
                return {}
            }
                if (request.command.name === "browser.hide") {
                    tabs.hide(context.conversationId, request)
                    return {}
                }
                if (request.command.name === "browser.state") return {}
                if (request.command.name === "browser.nameSession") {
                    sessionNames.set(request.sessionId, request.command.value)
                    return {}
                }
                if (request.command.name === "browser.user.openTabs") {
                    return { userTabs: userTabs.openTabs(context.conversationId, request.sessionId) }
                }
                if (request.command.name === "browser.user.claimTab") {
                    return {
                        tab: tabState(userTabs.claimTab(
                            context.conversationId,
                            request.sessionId,
                            request.command.claimId,
                            request,
                        )),
                    }
                }
                if (request.command.name === "browser.user.history") {
                    return {
                        history: tabs.history(context.conversationId, {
                            from: request.command.from,
                            limit: request.command.limit,
                            queries: request.command.queries,
                            to: request.command.to,
                        }),
                    }
                }
                if (request.command.name === "tabs.list") {
                    if (context.actor === "agent") {
                        userTabs.claimAvailableTabs(context.conversationId, request.sessionId, request)
                    }
                    return {
                        tabs: tabs.list(context.conversationId)
                            .filter((tab) => visibleToActor(tab, request, context))
                            .map(tabState),
                    }
                }
                if (request.command.name === "tabs.selected") {
                    const tab = tabs.get(context.conversationId)
                    if (tab && !visibleToActor(tab, request, context)) return { tab: undefined }
                    return { tab: tab ? tabState(tab) : undefined }
                }
                if (request.command.name === "tabs.get") {
                    const tab = tabs.require(context.conversationId, request.command.targetTabId)
                    if (!visibleToActor(tab, request, context)) {
                        throw new BrowserRuntimeException(
                            "TAB_NOT_FOUND",
                            `Browser tab not found: ${request.command.targetTabId}`,
                        )
                    }
                    return { tab: tabState(tab) }
                }
                if (request.command.name === "tabs.new") {
                    const tab = tabs.create(context.conversationId, ownershipFor(request, context), request)
                    tabs.show(context.conversationId, tab.ownership, request)
                    return { tab: tabState(tab) }
                }
                if (request.command.name === "tabs.finalize") {
                    await agentBrowser.closeOwner(request.sessionId)
                    lifecycle.finalize(request as BrowserCommandRequest & {
                        command: Extract<BrowserCommand, { name: "tabs.finalize" }>
                    })
                    return {}
                }

                const tab = tabs.require(context.conversationId, request.tabId)
                tabs.touch(tab)
                return await dispatchTabCommand({
                    agentBrowser,
                    aria,
                    automation,
                    context,
                    dialogs,
                    downloads,
                    fileChoosers,
                    lifecycle,
                    navigation,
                    nodes,
                    request,
                    tab,
                    tabs,
                    window,
                })
        },
        getActiveConversationId: () => tabs.getActiveConversationId(),
        getState: (conversationId) => tabs.getState(conversationId),
        promoteConversation: (sourceConversationId, targetConversationId) => {
            const state = tabs.promoteConversation(sourceConversationId, targetConversationId)
            userTabs.promoteConversation(sourceConversationId, targetConversationId)
            return state
        },
        setLayoutBounds: (bounds: BrowserBounds) => tabs.setLayoutBounds(bounds),
        setSuspended: (suspended: boolean) => tabs.setSuspended(suspended),
        syncOwner: (conversationId) => tabs.syncOwner(conversationId),
    }
}

interface TabCommandServices {
    agentBrowser: AgentBrowserTabController
    aria: AriaSnapshotService
    automation: AgentBrowserCommandAdapter
    context: BrowserDispatchContext
    dialogs: DialogService
    downloads: DownloadService
    fileChoosers: FileChooserService
    lifecycle: BrowserLifecycle
    navigation: NavigationService
    nodes: NodeActionService
    request: BrowserCommandRequest
    tab: EmbeddedTab
    tabs: EmbeddedTabStore
    window: BrowserWindow
}

async function dispatchTabCommand(services: TabCommandServices): Promise<BrowserCommandData> {
    const command = services.request.command
    const tab = services.tab

    if (
        command.name.startsWith("tab.automation.")
        || (
            command.name === "tab.screenshot"
            && (command.annotate === true || command.target !== undefined)
        )
    ) {
        return services.automation.run(
            tab,
            services.request.sessionId,
            command as
                | Extract<BrowserCommand, { name: `tab.automation.${string}` }>
                | Extract<BrowserCommand, { name: "tab.screenshot" }>,
            services.context.signal,
            services.request.expectedOrigin,
        )
    }
    if (command.name === "tab.state") return { tab: tabState(tab) }
    if (command.name === "tab.activate") {
        services.tabs.activate(services.context.conversationId, tab.id, services.request)
        return { tab: tabState(tab) }
    }
    if (command.name === "tab.close") {
        services.tabs.close(services.context.conversationId, tab.id, services.request)
        return {}
    }
    if (command.name === "tab.mark") {
        services.tabs.mark(tab, command.disposition, services.request)
        return { tab: tabState(tab) }
    }
    if (command.name === "tab.goto") {
        const navigation = await services.navigation.goto(tab, command.url, services.request, services.context.signal)
        return { navigation, tab: tabState(tab) }
    }
    if (command.name === "tab.back") {
        return { navigation: await services.navigation.back(tab, services.request, services.context.signal) }
    }
    if (command.name === "tab.forward") {
        return { navigation: await services.navigation.forward(tab, services.request, services.context.signal) }
    }
    if (command.name === "tab.reload") {
        return { navigation: await services.navigation.reload(tab, services.request, services.context.signal) }
    }
    if (command.name === "tab.stop") {
        return {
            navigation: services.navigation.stop(tab, services.request),
            tab: tabState(tab),
        }
    }
    if (command.name === "tab.screenshot") {
        if (tab.error) {
            const state = services.tabs.getState(services.context.conversationId)
            return {
                screenshot: await captureErrorScreenshot(
                    services.window,
                    state.viewport,
                    command,
                    {
                        active: state.activeTabId === tab.id,
                        error: tab.error,
                        visible: state.visible,
                    },
                ),
            }
        }
        return { screenshot: await withDebugger(tab, (send) => captureScreenshot(send, command)) }
    }
    if (command.name === "tab.pdf") {
        return {
            pdf: {
                data: (await tab.webContents.printToPDF({
                    printBackground: true,
                })).toString("base64"),
                mimeType: "application/pdf",
            },
        }
    }
    if (command.name === "tab.dev.logs") {
        const levels = new Set(command.levels?.map((level) => level === "warning" ? "warn" : level))
        const logs = tab.logs.filter((entry) =>
            (!levels.size || levels.has(entry.level))
            && (!command.filter || entry.message.includes(command.filter)))
        return { logs: logs.slice(-(command.limit ?? 100)) }
    }
    if (command.name === "tab.domCua.getVisibleDom") {
        return { visibleDom: await services.aria.snapshot(tab) }
    }
    if (
        command.name === "tab.domCua.click"
        || command.name === "tab.domCua.doubleClick"
    ) {
        return services.nodes.run(tab, command)
    }
    if (command.name === "tab.domCua.downloadMedia") {
        return {
            download: await triggeredWait(
                services.context.signal,
                (signal) => services.downloads.wait(
                    tab,
                    services.request,
                    command.timeout,
                    signal,
                    false,
                ),
                () => services.nodes.run(tab, {
                    name: "tab.domCua.click",
                    nodeId: command.nodeId,
                    snapshotId: command.snapshotId,
                }),
            ),
        }
    }
    if (command.name === "tab.domCua.scroll") {
        if (command.nodeId) return services.nodes.scroll(tab, { ...command, nodeId: command.nodeId })
        await withDebugger(tab, (send) => coordinateScroll(send, {
            deltaX: command.deltaX,
            deltaY: command.deltaY,
        }))
        return { value: true }
    }
    if (command.name === "tab.domCua.type") {
        await withDebugger(tab, (send) => textInput(send, command.text))
        return { value: true }
    }
    if (command.name === "tab.domCua.keypress") {
        await withDebugger(tab, (send) => keypressKeys(send, command.keys))
        return { value: true }
    }
    if (command.name === "tab.cua.click") {
        if (command.button === 4) {
            await services.navigation.back(tab, services.request, services.context.signal)
            return { value: true }
        }
        if (command.button === 5) {
            await services.navigation.forward(tab, services.request, services.context.signal)
            return { value: true }
        }
        await withDebugger(tab, (send) => coordinateClick(send, {
            ...command,
            button: cuaMouseButton(command.button),
        }))
        return { value: true }
    }
    if (command.name === "tab.cua.doubleClick") {
        await withDebugger(tab, (send) => coordinateClick(send, { ...command, clickCount: 2 }))
        return { value: true }
    }
    if (command.name === "tab.cua.move") {
        await withDebugger(tab, (send) => coordinateMove(send, command))
        return { value: true }
    }
    if (command.name === "tab.cua.drag") {
        await withDebugger(tab, (send) => coordinateDrag(send, command))
        return { value: true }
    }
    if (command.name === "tab.cua.scroll") {
        await withDebugger(tab, (send) => coordinateScroll(send, command))
        return { value: true }
    }
    if (command.name === "tab.cua.type") {
        await withDebugger(tab, (send) => textInput(send, command.text))
        return { value: true }
    }
    if (command.name === "tab.cua.keypress") {
        await withDebugger(tab, (send) => keypressKeys(send, command.keys))
        return { value: true }
    }
    if (command.name === "tab.cua.downloadMedia") {
        return {
            download: await triggeredWait(
                services.context.signal,
                (signal) => services.downloads.wait(
                    tab,
                    services.request,
                    command.timeout,
                    signal,
                    false,
                ),
                () => withDebugger(tab, (send) => coordinateClick(send, {
                    x: command.x,
                    y: command.y,
                })),
            ),
        }
    }
    if (command.name === "tab.dialog.get") return { dialog: tab.dialog }
    if (command.name === "tab.dialog.wait") {
        await tab.debuggerReady
        if (tab.dialog) return { dialog: tab.dialog }
        return {
            dialog: await triggeredWait(
                services.context.signal,
                (signal) => services.dialogs.wait(tab, command.timeout, signal),
                automationClickTrigger(services, command.trigger, command.timeout),
                false,
            ),
        }
    }
    if (command.name === "tab.dialog.handle") {
        await tab.debuggerReady
        await services.dialogs.handle(tab, command, services.request)
        return { dialog: null }
    }
    if (command.name === "tab.fileChooser.wait") {
        await tab.debuggerReady
        if (tab.fileChooser) return { fileChooser: tab.fileChooser }
        return {
            fileChooser: await services.fileChoosers.wait(
                tab,
                command.timeout,
                services.context.signal,
                automationClickTrigger(services, command.trigger, command.timeout),
            ),
        }
    }
    if (command.name === "tab.fileChooser.setFiles") {
        await services.fileChoosers.setFiles(tab, command.chooserId, command.filePaths)
        return { value: true }
    }
    if (command.name === "tab.download.wait") {
        return {
            download: await triggeredWait(
                services.context.signal,
                (signal) => services.downloads.wait(
                    tab,
                    services.request,
                    command.timeout,
                    signal,
                    !command.trigger,
                ),
                automationClickTrigger(services, command.trigger, command.timeout),
            ),
        }
    }
    if (command.name === "tab.download.get") {
        return { download: services.downloads.get(tab, command.downloadId, services.request.sessionId) }
    }
    if (command.name === "tab.clipboard.read") {
        return { clipboardItems: await readClipboard(tab) }
    }
    if (command.name === "tab.clipboard.readText") {
        return { clipboardText: await readClipboardText(tab) }
    }
    if (command.name === "tab.clipboard.write") {
        await writeClipboard(tab, command.items)
        return {}
    }
    if (command.name === "tab.clipboard.writeText") {
        await writeClipboardText(tab, command.text)
        return {}
    }
    if (command.name === "tab.dev.cdp") {
        const origin = browserOrigin(tab.webContents.getURL())
        if (!origin || origin !== services.request.expectedOrigin) {
            throw new BrowserRuntimeException("ORIGIN_CHANGED", "CDP approval does not match the current page")
        }
        return {
            cdp: await withDebugger(tab, (send) =>
                executeRawCdp(
                    send,
                    command.method,
                    command.params,
                    command.target,
                    tab.debuggerTransport.childSessions,
                )),
        }
    }
    if (command.name === "tab.dev.cdp.events") {
        return {
            cdpEvents: await readCdpEvents(tab, command, services.context.signal),
        }
    }
    throw new BrowserRuntimeException("INVALID_COMMAND", `Unsupported tab command: ${command.name}`)
}

async function readCdpEvents(
    tab: EmbeddedTab,
    command: Extract<BrowserCommand, { name: "tab.dev.cdp.events" }>,
    signal?: AbortSignal,
) {
    const deadline = Date.now() + (command.timeout ?? 0)
    const read = () => {
        const after = command.afterSequence ?? 0
        const firstSequence = tab.cdpEvents[0]?.sequence ?? tab.cdpSequence + 1
        const matching = tab.cdpEvents.filter((event) =>
            event.sequence > after
            && (!command.methods?.length || command.methods.includes(event.method))
            && (!command.target?.sessionId || event.source.sessionId === command.target.sessionId)
            && (!command.target?.targetId || event.source.targetId === command.target.targetId))
        const limit = command.limit ?? 100
        return {
            cursor: tab.cdpSequence,
            events: matching.slice(0, limit),
            hasMore: matching.length > limit,
            truncated: after < firstSequence - 1,
        }
    }
    let result = read()
    while (!result.events.length && Date.now() < deadline) {
        await waitForTimeout(Math.min(25, deadline - Date.now()), signal)
        result = read()
    }
    return result
}

function triggerAutomationClick(
    services: TabCommandServices,
    target: BrowserAutomationTarget,
    timeout?: number,
) {
    return services.automation.run(
        services.tab,
        services.request.sessionId,
        {
            name: "tab.automation.click",
            target,
            timeout,
        },
        services.context.signal,
        services.request.expectedOrigin,
    )
}

function automationClickTrigger(
    services: TabCommandServices,
    target: BrowserAutomationTarget | undefined,
    timeout?: number,
) {
    return target ? () => triggerAutomationClick(services, target, timeout) : undefined
}

async function triggeredWait<T>(
    signal: AbortSignal | undefined,
    wait: (signal: AbortSignal) => Promise<T>,
    trigger?: () => Promise<unknown>,
    waitForTrigger = true,
) {
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const waiting = wait(combined)
    if (!trigger) return waiting
    const triggered = trigger()
    return (waitForTrigger
        ? Promise.all([waiting, triggered]).then(([result]) => result)
        : Promise.race([waiting, triggered.then(() => waiting)]))
        .finally(() => controller.abort())
}

function visibleToActor(
    tab: EmbeddedTab,
    request: BrowserCommandRequest,
    context: BrowserDispatchContext,
) {
    return context.actor === "renderer"
        || tab.ownership.ownerSessionId === request.sessionId
}

function cuaMouseButton(button: number | undefined) {
    if (button === 2) return "middle" as const
    if (button === 3) return "right" as const
    return "left" as const
}

function ownershipFor(
    request: BrowserCommandRequest,
    context: BrowserDispatchContext,
    disposition?: "deliverable" | "handoff" | "temporary",
) {
    const user = context.actor === "renderer"
    return {
        createdBy: user ? "user" as const : "agent" as const,
        disposition: disposition ?? (user ? "deliverable" as const : "temporary" as const),
        ownerSessionId: user ? undefined : request.sessionId,
    }
}

function internalRequest(tabId: string, sessionId = "renderer"): BrowserCommandRequest {
    return {
        browserId: DEFAULT_BROWSER_ID,
        command: { name: "tab.state" },
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        sessionId,
        tabId,
    }
}

function isWebUrl(input: string) {
    try {
        return ["http:", "https:"].includes(new URL(input).protocol)
    } catch {
        return false
    }
}

function responseContentLength(headers?: Record<string, string[]>) {
    const value = Object.entries(headers ?? {})
        .find(([name]) => name.toLowerCase() === "content-length")?.[1][0]
    if (value === undefined) return undefined
    const length = Number(value)
    return Number.isFinite(length) && length >= 0 ? length : undefined
}
