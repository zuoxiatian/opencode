import type { BrowserBounds, BrowserState, BrowserTabState } from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "./tab"

export const EMPTY_BOUNDS: BrowserBounds = { height: 0, width: 0, x: 0, y: 0 }

export function tabState(tab: EmbeddedTab): BrowserTabState {
    return {
        canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
        capabilities: ["cdp"],
        dialog: tab.dialog ? { ...tab.dialog } : null,
        downloadCount: tab.downloads.size,
        error: tab.error ? { ...tab.error } : null,
        favicon: tab.error ? null : tab.favicon ?? null,
        generation: tab.generation,
        id: tab.id,
        loading: tab.view.webContents.isLoading(),
        ownership: { ...tab.ownership },
        title: tab.view.webContents.getTitle(),
        url: tab.error?.url || tab.pendingUrl || tab.view.webContents.getURL(),
    }
}

export function browserState(
    tabs: EmbeddedTab[],
    activeTabId: string | null,
    visible: boolean,
    viewport: BrowserBounds,
): BrowserState {
    return {
        activeTabId,
        browserId: "embedded",
        tabs: tabs.map(tabState),
        viewport,
        visible,
    }
}

export function sanitizeBounds(bounds: BrowserBounds) {
    return {
        height: Math.max(0, Math.round(bounds.height)),
        width: Math.max(0, Math.round(bounds.width)),
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
    }
}
