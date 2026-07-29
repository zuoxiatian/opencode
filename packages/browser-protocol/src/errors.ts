export type BrowserErrorCode =
  | "AGENT_BROWSER_UNAVAILABLE"
  | "AGENT_SESSION_FAILED"
  | "AGENT_SESSION_LIMIT"
  | "AMBIGUOUS_LOCATOR"
  | "BROWSER_NOT_FOUND"
  | "BROWSER_UNAVAILABLE"
  | "CANCELLED"
  | "CAPABILITY_UNAVAILABLE"
  | "CDP_METHOD_DENIED"
  | "DIALOG_REQUIRED"
  | "DOWNLOAD_NOT_FOUND"
  | "ELEMENT_NOT_ACTIONABLE"
  | "FILE_CHOOSER_NOT_FOUND"
  | "GATEWAY_AUTH_FAILED"
  | "GATEWAY_UNAVAILABLE"
  | "INVALID_COMMAND"
  | "LOCATOR_NOT_FOUND"
  | "NAVIGATION_FAILED"
  | "NAVIGATION_REPLACED"
  | "ORIGIN_CHANGED"
  | "PERMISSION_DENIED"
  | "STALE_FRAME"
  | "STALE_NODE"
  | "STALE_REF"
  | "TAB_CLOSED"
  | "TAB_NOT_FOUND"
  | "TAB_NOT_OWNED"
  | "TARGET_GONE"
  | "TIMEOUT"

export interface BrowserRuntimeError {
  code: BrowserErrorCode
  details?: Record<string, unknown>
  message: string
  retryable: boolean
}

export interface BrowserErrorResponse {
  error: BrowserRuntimeError
  protocolVersion: 3
  requestId?: string
}

export function browserError(
  code: BrowserErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): BrowserRuntimeError {
  return {
    code,
    details,
    message,
    retryable,
  }
}
