import type { SessionState } from "./types"

export function dropSessionCaches(store: SessionState, sessionIDs: Iterable<string>) {
    const stale = new Set(Array.from(sessionIDs).filter(Boolean))
    if (stale.size === 0) return

    for (const key of Object.keys(store.part)) {
        const parts = store.part[key]
        if (!parts?.some((part) => stale.has(part?.sessionID ?? ""))) continue
        delete store.part[key]
    }

    for (const sessionID of stale) {
        delete store.message[sessionID]
        delete store.todo[sessionID]
        delete store.session_diff[sessionID]
        delete store.session_status[sessionID]
        delete store.permission[sessionID]
        delete store.question[sessionID]
    }
}
