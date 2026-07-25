import { session, type BrowserWindow } from "electron"
import {
    BROWSER_PROTOCOL_VERSION,
    DEFAULT_BROWSER_ID,
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
import { AriaSnapshotService } from "./automation/aria-snapshot"
import { executeRawCdp, onDebuggerMessage, withDebugger } from "./automation/cdp"
import {
    coordinateClick,
    coordinateDrag,
    coordinateMove,
    coordinateScroll,
    keypressKeys,
    textInput,
} from "./automation/input"
import { LocatorService } from "./automation/locator"
import { NodeActionService } from "./automation/node-action"
import { PlaywrightRuntime } from "./automation/playwright-runtime"
import { ReadonlyEvaluationService } from "./automation/readonly-evaluate"
import { captureErrorScreenshot, captureScreenshot } from "./automation/screenshot"
import { expectNavigation, waitForLoadState, waitForTimeout, waitForURL } from "./automation/waits"
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
            {
                description: "Set or reset an explicit browser viewport override.",
                id: "viewport",
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
): BrowserBackend {
    const browserSession = session.fromPartition("persist:desktop-forge-browser")
    let registerTab = (_tab: EmbeddedTab) => undefined
    const tabs = new EmbeddedTabStore(window, events, (tab) => registerTab(tab))
    const navigation = new NavigationService(browserSession, tabs, events)
    const dialogs = new DialogService(tabs, events)
    const aria = new AriaSnapshotService()
    const nodes = new NodeActionService(aria)
    const playwright = new PlaywrightRuntime()
    const locators = new LocatorService(playwright)
    const readonlyEvaluation = new ReadonlyEvaluationService()
    const downloads = new DownloadService(browserSession, tabs, events)
    const fileChoosers = new FileChooserService(tabs, events)
    const lifecycle = new BrowserLifecycle(tabs)
    const userTabs = new BrowserUserTabs(tabs)
    const sessionNames = new Map<string, string>()
    const clearClosedTab = events.subscribe((event) => {
        if (event.type !== "tab.closed" || !event.tabId) return
        aria.clear(event.tabId)
        playwright.clear(event.tabId)
        downloads.clearTab(event.tabId)
        userTabs.clear(event.tabId)
    })

    registerTab = (tab) => {
        navigation.register(tab)
        dialogs.register(tab)
        fileChoosers.register(tab)
        if (!tab.webContents.debugger.isAttached()) {
            tab.webContents.debugger.attach("1.3")
        }
        const documentRequests = new Set<string>()
        let debuggerStarted = false
        const initializeDebugger = () => {
            if (debuggerStarted) return
            debuggerStarted = true
            const ready = Promise.all([
                tab.webContents.debugger.sendCommand("Network.enable"),
                tab.webContents.debugger.sendCommand("Page.enable"),
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
        onDebuggerMessage(tab.webContents, (_event, method, params, sessionId) => {
            if (sessionId) tab.cdpSessions.add(sessionId)
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
        }, () => !tab.closed)
        tab.webContents.setWindowOpenHandler(({ url }) => {
            if (isWebUrl(url)) {
                const ownership = {
                    ...tab.ownership,
                    disposition: tab.ownership.createdBy === "agent" ? "temporary" as const : "deliverable" as const,
                }
                void Promise.resolve().then(() => {
                    const child = tabs.create(ownership)
                    return navigation.goto(child, url, internalRequest(child.id, ownership.ownerSessionId))
                }).catch(() => undefined)
            }
            return { action: "deny" }
        })
    }

    const clearPermissions = configureBrowserPermissions(browserSession, window, events)
    const headersReceived = (
        details: Electron.OnHeadersReceivedListenerDetails,
        callback: (response: Electron.HeadersReceivedResponse) => void,
    ) => {
        const tab = tabs.list().find((candidate) =>
            candidate.webContents.id === (details.webContentsId ?? details.webContents?.id))
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
            browserSession.webRequest.onHeadersReceived(null)
            clearPermissions()
            downloads.destroy()
            fileChoosers.destroy()
            await tabs.destroy()
        },
        dispatch: async (request, context) => {
            if (context.signal?.aborted) {
                throw new BrowserRuntimeException("CANCELLED", "Browser command was cancelled", true)
            }
            if (request.command.name === "browser.show") {
                tabs.show(request)
                return {}
            }
                if (request.command.name === "browser.hide") {
                    tabs.hide(request)
                    return {}
                }
                if (request.command.name === "browser.state") return {}
                if (request.command.name === "browser.nameSession") {
                    sessionNames.set(request.sessionId, request.command.value)
                    return {}
                }
                if (request.command.name === "browser.viewport.set") {
                    tabs.setBounds(request.command.bounds)
                    return {}
                }
                if (request.command.name === "browser.viewport.reset") {
                    tabs.setBounds({ height: 0, width: 0, x: 0, y: 0 })
                    return {}
                }
                if (request.command.name === "browser.user.openTabs") {
                    return { userTabs: userTabs.openTabs(request.sessionId) }
                }
                if (request.command.name === "browser.user.claimTab") {
                    return { tab: tabState(userTabs.claimTab(request.sessionId, request.command.claimId, request)) }
                }
                if (request.command.name === "browser.user.history") {
                    return {
                        history: tabs.history({
                            from: request.command.from,
                            limit: request.command.limit,
                            queries: request.command.queries,
                            to: request.command.to,
                        }),
                    }
                }
                if (request.command.name === "tabs.list") {
                    return {
                        tabs: tabs.list()
                            .filter((tab) => visibleToSession(tab, request.sessionId))
                            .map(tabState),
                    }
                }
                if (request.command.name === "tabs.selected") {
                    const tab = tabs.get()
                    if (tab && !visibleToSession(tab, request.sessionId)) return { tab: undefined }
                    return { tab: tab ? tabState(tab) : undefined }
                }
                if (request.command.name === "tabs.get") {
                    const tab = tabs.require(request.command.targetTabId)
                    if (!visibleToSession(tab, request.sessionId)) {
                        throw new BrowserRuntimeException(
                            "TAB_NOT_FOUND",
                            `Browser tab not found: ${request.command.targetTabId}`,
                        )
                    }
                    return { tab: tabState(tab) }
                }
                if (request.command.name === "tabs.new") {
                    const tab = tabs.create(ownershipFor(request), request)
                    tabs.show(request)
                    return { tab: tabState(tab) }
                }
                if (request.command.name === "tabs.finalize") {
                    lifecycle.finalize(request as BrowserCommandRequest & {
                        command: Extract<BrowserCommand, { name: "tabs.finalize" }>
                    })
                    return {}
                }

                const tab = tabs.require(request.tabId)
                tabs.touch(tab)
                return await dispatchTabCommand({
                    aria,
                    context,
                    dialogs,
                    downloads,
                    fileChoosers,
                    lifecycle,
                    locators,
                    navigation,
                    nodes,
                    playwright,
                    readonlyEvaluation,
                    request,
                    tab,
                    tabs,
                    window,
                })
        },
        getState: () => tabs.getState(),
        setBounds: (bounds: BrowserBounds) => tabs.setBounds(bounds),
    }
}

interface TabCommandServices {
    aria: AriaSnapshotService
    context: BrowserDispatchContext
    dialogs: DialogService
    downloads: DownloadService
    fileChoosers: FileChooserService
    lifecycle: BrowserLifecycle
    locators: LocatorService
    navigation: NavigationService
    nodes: NodeActionService
    playwright: PlaywrightRuntime
    readonlyEvaluation: ReadonlyEvaluationService
    request: BrowserCommandRequest
    tab: EmbeddedTab
    tabs: EmbeddedTabStore
    window: BrowserWindow
}

async function dispatchTabCommand(services: TabCommandServices): Promise<BrowserCommandData> {
    const command = services.request.command
    const tab = services.tab

    if (command.name === "tab.state") return { tab: tabState(tab) }
    if (command.name === "tab.activate") {
        services.tabs.activate(tab.id, services.request)
        return { tab: tabState(tab) }
    }
    if (command.name === "tab.close") {
        services.aria.clear(tab.id)
        services.tabs.close(tab.id, services.request)
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
            const state = services.tabs.getState()
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
    if (command.name === "tab.dev.logs") {
        const levels = new Set(command.levels?.map((level) => level === "warning" ? "warn" : level))
        const logs = tab.logs.filter((entry) =>
            (!levels.size || levels.has(entry.level))
            && (!command.filter || entry.message.includes(command.filter)))
        return { logs: logs.slice(-(command.limit ?? 100)) }
    }
    if (command.name === "tab.playwright.domSnapshot") {
        return { dom: await services.playwright.domSnapshot(tab) }
    }
    if (command.name === "tab.playwright.html") {
        return { html: await services.playwright.html(tab) }
    }
    if (command.name === "tab.playwright.evaluate") {
        return {
            value: services.readonlyEvaluation.evaluate({
                arg: command.arg,
                expression: command.expression,
                html: await services.playwright.html(tab),
                url: tab.webContents.getURL(),
            }),
        }
    }
    if (command.name === "tab.playwright.elementInfo") {
        return {
            elements: await services.playwright.elementInfo(
                tab,
                command.x,
                command.y,
                command.includeNonInteractable,
            ),
        }
    }
    if (command.name === "tab.playwright.elementScreenshot") {
        const elements = await services.playwright.elementInfo(
            tab,
            command.x,
            command.y,
            command.includeNonInteractable,
        )
        return {
            elements,
            screenshot: await withDebugger(tab, async (send) => {
                const rect = elements.find((element) => element.boundingBox)?.boundingBox
                if (!rect) return captureScreenshot(send, {})
                await send("Overlay.enable")
                await send("Overlay.highlightRect", {
                    color: { a: 0.25, b: 255, g: 120, r: 30 },
                    outlineColor: { a: 1, b: 255, g: 120, r: 30 },
                    ...rect,
                })
                try {
                    return await captureScreenshot(send, {})
                } finally {
                    await send("Overlay.hideHighlight").catch(() => undefined)
                    await send("Overlay.disable").catch(() => undefined)
                }
            }),
        }
    }
    if (command.name === "tab.domCua.getVisibleDom") {
        return { visibleDom: await services.aria.snapshot(tab) }
    }
    if (command.name === "tab.playwright.expectNavigation") {
        await tab.debuggerReady
        const navigation = await triggeredWait(
            services.context.signal,
            async (signal) => {
                const url = await expectNavigation(tab.webContents, command.timeout, signal, command.url)
                if (command.waitUntil && command.waitUntil !== "commit") {
                    await waitForLoadState(
                        tab.webContents,
                        command.waitUntil,
                        command.timeout,
                        signal,
                    )
                }
                return {
                    finalUrl: url,
                    generation: tab.generation,
                    status: "committed" as const,
                }
            },
            command.trigger
                ? () => services.locators.run(tab, {
                    locator: command.trigger!,
                    name: "tab.playwright.locator.click",
                }, services.context.signal)
                : undefined,
        )
        return { navigation }
    }
    if (command.name === "tab.playwright.waitForURL") {
        return {
            value: await waitForURL(
                tab.webContents,
                command.url,
                command.timeout,
                services.context.signal,
                command.waitUntil,
            ),
        }
    }
    if (command.name === "tab.playwright.waitForLoadState") {
        await tab.debuggerReady
        const generation = tab.generation
        await waitForLoadState(
            tab.webContents,
            command.state,
            command.timeout,
            services.context.signal,
        )
        ensureGeneration(tab, generation, "Page changed while waiting for its load state")
        return { value: true }
    }
    if (command.name === "tab.playwright.waitForTimeout") {
        await waitForTimeout(command.timeout, services.context.signal)
        return { value: true }
    }
    if (command.name.startsWith("tab.playwright.locator.")) {
        if (command.name === "tab.playwright.locator.evaluate") {
            if (!command.expression) {
                throw new BrowserRuntimeException("INVALID_COMMAND", "Locator evaluate requires an expression")
            }
            return {
                value: services.readonlyEvaluation.evaluate({
                    arg: command.arg,
                    elementHtml: await services.playwright.locatorHtml(tab, command.locator),
                    expression: command.expression,
                    html: await services.playwright.html(tab, command.locator.frameSelectors),
                    url: tab.webContents.getURL(),
                }),
            }
        }
        if (command.name === "tab.playwright.locator.downloadMedia") {
            return {
                download: await triggeredWait(
                    services.context.signal,
                    (signal) => services.downloads.wait(
                        tab.id,
                        services.request,
                        command.timeout,
                        signal,
                        false,
                    ),
                    () => services.locators.run(tab, {
                        locator: command.locator,
                        name: "tab.playwright.locator.click",
                        timeout: command.timeout,
                    }, services.context.signal),
                ),
            }
        }
        return services.locators.run(tab, command as Extract<
            BrowserCommand,
            { name: `tab.playwright.locator.${string}` }
        >, services.context.signal)
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
                    tab.id,
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
        coordinateScroll(tab.webContents, {
            deltaX: command.deltaX,
            deltaY: command.deltaY,
        })
        return { value: true }
    }
    if (command.name === "tab.domCua.type") {
        textInput(tab.webContents, command.text)
        return { value: true }
    }
    if (command.name === "tab.domCua.keypress") {
        keypressKeys(tab.webContents, command.keys)
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
        coordinateClick(tab.webContents, {
            ...command,
            button: cuaMouseButton(command.button),
        })
        return { value: true }
    }
    if (command.name === "tab.cua.doubleClick") {
        coordinateClick(tab.webContents, { ...command, clickCount: 2 })
        return { value: true }
    }
    if (command.name === "tab.cua.move") {
        coordinateMove(tab.webContents, command)
        return { value: true }
    }
    if (command.name === "tab.cua.drag") {
        coordinateDrag(tab.webContents, command)
        return { value: true }
    }
    if (command.name === "tab.cua.scroll") {
        coordinateScroll(tab.webContents, command)
        return { value: true }
    }
    if (command.name === "tab.cua.type") {
        textInput(tab.webContents, command.text)
        return { value: true }
    }
    if (command.name === "tab.cua.keypress") {
        keypressKeys(tab.webContents, command.keys)
        return { value: true }
    }
    if (command.name === "tab.cua.downloadMedia") {
        return {
            download: await triggeredWait(
                services.context.signal,
                (signal) => services.downloads.wait(
                    tab.id,
                    services.request,
                    command.timeout,
                    signal,
                    false,
                ),
                () => Promise.resolve(coordinateClick(tab.webContents, {
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
                command.trigger
                    ? () => services.locators.run(tab, {
                        locator: command.trigger!,
                        name: "tab.playwright.locator.click",
                    }, services.context.signal)
                    : undefined,
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
                command.trigger
                    ? () => services.locators.run(tab, {
                        locator: command.trigger!,
                        name: "tab.playwright.locator.click",
                    }, services.context.signal)
                    : undefined,
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
                    tab.id,
                    services.request,
                    command.timeout,
                    signal,
                    !command.trigger,
                ),
                command.trigger
                    ? () => services.locators.run(tab, {
                        locator: command.trigger!,
                        name: "tab.playwright.locator.click",
                    }, services.context.signal)
                    : undefined,
            ),
        }
    }
    if (command.name === "tab.download.get") {
        return { download: services.downloads.get(tab.id, command.downloadId, services.request.sessionId) }
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
                executeRawCdp(send, command.method, command.params, command.target, tab.cdpSessions)),
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

function ensureGeneration(tab: EmbeddedTab, generation: number, message: string) {
    if (tab.webContents.isDestroyed()) {
        throw new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed during the command")
    }
    if (tab.generation === generation) return
    throw new BrowserRuntimeException("NAVIGATION_REPLACED", message, true)
}

function visibleToSession(tab: EmbeddedTab, sessionId: string) {
    return sessionId === "renderer"
        || tab.ownership.ownerSessionId === sessionId
}

function cuaMouseButton(button: number | undefined) {
    if (button === 2) return "middle" as const
    if (button === 3) return "right" as const
    return "left" as const
}

function ownershipFor(
    request: BrowserCommandRequest,
    disposition?: "deliverable" | "handoff" | "temporary",
) {
    const user = request.sessionId === "renderer"
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
