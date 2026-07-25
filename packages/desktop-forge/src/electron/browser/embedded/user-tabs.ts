import type { BrowserCommandRequest, BrowserUserTabInfo } from "@opencode-ai/browser-protocol"
import { BrowserRuntimeException } from "../errors"
import { tabState } from "./state"
import type { EmbeddedTabStore } from "./tab-store"

const CLAIM_TTL_MS = 60_000

export class BrowserUserTabs {
    private readonly claims = new Map<string, {
        createdAt: number
        sessionId: string
        tabId: string
        title: string
        url: string
    }>()

    constructor(private readonly tabs: EmbeddedTabStore) {}

    openTabs(sessionId: string): BrowserUserTabInfo[] {
        this.clearExpired()
        for (const [id, claim] of this.claims) {
            if (claim.sessionId === sessionId) this.claims.delete(id)
        }
        return this.tabs.list()
            .filter((tab) => !tab.ownership.ownerSessionId)
            .sort((left, right) => right.lastTouchedAt - left.lastTouchedAt)
            .map((tab) => {
                const state = tabState(tab)
                const id = `browser-claim-${crypto.randomUUID()}`
                this.claims.set(id, {
                    createdAt: Date.now(),
                    sessionId,
                    tabId: tab.id,
                    title: state.title,
                    url: state.url,
                })
                return {
                    id,
                    lastOpened: new Date(tab.lastTouchedAt).toISOString(),
                    providerTabId: tab.id,
                    title: state.title,
                    url: state.url,
                }
            })
    }

    claimTab(sessionId: string, claimId: string, request: BrowserCommandRequest) {
        this.clearExpired()
        const claim = this.claims.get(claimId)
        if (!claim || claim.sessionId !== sessionId) {
            throw new BrowserRuntimeException("TAB_NOT_FOUND", "Browser user tab is no longer available")
        }
        this.claims.delete(claimId)
        const tab = this.tabs.get(claim.tabId)
        const state = tab ? tabState(tab) : undefined
        if (
            !tab
            || tab.ownership.ownerSessionId
            || state?.title !== claim.title
            || state.url !== claim.url
        ) {
            throw new BrowserRuntimeException("TAB_NOT_FOUND", "Browser user tab changed before it was claimed")
        }
        this.tabs.claim(tab, sessionId, request)
        return tab
    }

    clear(tabId: string) {
        for (const [id, claim] of this.claims) {
            if (claim.tabId === tabId) this.claims.delete(id)
        }
    }

    private clearExpired() {
        const expiredBefore = Date.now() - CLAIM_TTL_MS
        for (const [id, claim] of this.claims) {
            if (claim.createdAt < expiredBefore) this.claims.delete(id)
        }
    }
}
