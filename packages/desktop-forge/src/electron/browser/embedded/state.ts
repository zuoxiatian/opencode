import type { BrowserBounds, BrowserState, BrowserTabState } from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "./tab"

export const EMPTY_BOUNDS: BrowserBounds = { height: 0, width: 0, x: 0, y: 0 }

export function tabState(tab: EmbeddedTab): BrowserTabState {
    return {
        canGoBack: tab.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.webContents.navigationHistory.canGoForward(),
        capabilities: ["cdp"],
        dialog: tab.dialog ? { ...tab.dialog } : null,
        downloadCount: tab.downloads.size,
        error: tab.error ? { ...tab.error } : null,
        favicon: tab.error ? null : tab.favicon ?? null,
        generation: tab.generation,
        id: tab.id,
        loading: tab.webContents.isLoading(),
        ownership: { ...tab.ownership },
        title: tab.webContents.getTitle(),
        url: tab.error?.url || tab.pendingUrl || tab.webContents.getURL(),
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

export function sanitizeBounds(bounds: BrowserBounds, limit?: { height: number; width: number }) {
    const sanitized = {
        height: nonnegativeInteger(bounds.height),
        width: nonnegativeInteger(bounds.width),
        x: nonnegativeInteger(bounds.x),
        y: nonnegativeInteger(bounds.y),
    }
    if (!limit) return sanitized
    const x = Math.min(sanitized.x, limit.width)
    const y = Math.min(sanitized.y, limit.height)
    return {
        height: Math.min(sanitized.height, limit.height - y),
        width: Math.min(sanitized.width, limit.width - x),
        x,
        y,
    }
}

function nonnegativeInteger(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}
