import { browserError, type BrowserRuntimeError } from "@opencode-ai/browser-protocol"

export class BrowserClientError extends Error {
  readonly browser: BrowserRuntimeError

  constructor(error: BrowserRuntimeError) {
    super(error.message)
    this.name = "BrowserClientError"
    this.browser = error
  }
}

export function requireBrowserResult<T>(value: T | undefined, name: string): T {
  if (value !== undefined) return value
  throw new BrowserClientError(browserError(
    "BROWSER_UNAVAILABLE",
    `Browser response is missing ${name}`,
    true,
  ))
}
