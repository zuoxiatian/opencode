export const BROWSER_DRAFT_CONVERSATION_PREFIX = "browser-draft:"

export function createBrowserDraftConversationId() {
    return `${BROWSER_DRAFT_CONVERSATION_PREFIX}${crypto.randomUUID()}`
}

export function isBrowserDraftConversationId(input: string) {
    return input.startsWith(BROWSER_DRAFT_CONVERSATION_PREFIX)
        && input.length > BROWSER_DRAFT_CONVERSATION_PREFIX.length
}
