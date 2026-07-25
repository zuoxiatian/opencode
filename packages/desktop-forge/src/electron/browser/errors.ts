import { browserError, type BrowserErrorCode, type BrowserRuntimeError } from "@opencode-ai/browser-protocol"

export class BrowserRuntimeException extends Error {
    readonly browser: BrowserRuntimeError

    constructor(code: BrowserErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
        super(message)
        this.name = "BrowserRuntimeException"
        this.browser = browserError(code, message, retryable, details)
    }
}

export function runtimeError(error: unknown) {
    if (error instanceof BrowserRuntimeException) return error.browser
    if (error instanceof Error && error.name === "AbortError") {
        return browserError("CANCELLED", "Browser command was cancelled", true)
    }
    return browserError(
        "BROWSER_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        true,
    )
}
