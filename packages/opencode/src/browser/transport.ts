import {
  BROWSER_PROTOCOL_VERSION,
  DEFAULT_BROWSER_ID,
  browserError,
  isRecord,
  type BrowserCommandInput,
  type BrowserCommandRequest,
  type BrowserCommandResponse,
  type BrowserErrorResponse,
  type BrowserEvent,
} from "@opencode-ai/browser-protocol"
import { BrowserClientError } from "./result"

export interface BrowserTransportOptions {
  abort: AbortSignal
  callId?: string
  endpoint: string
  expectedOrigin?: string
  sessionId: string
  token: string
}

export class BrowserTransport {
  private events: BrowserEvent[] = []

  constructor(private readonly options: BrowserTransportOptions) {}

  recentEvents() {
    return [...this.events]
  }

  command<T = import("@opencode-ai/browser-protocol").BrowserCommandData>(input: BrowserCommandInput) {
    const request: BrowserCommandRequest = {
      browserId: input.browserId ?? DEFAULT_BROWSER_ID,
      callId: this.options.callId,
      command: input.command,
      expectedOrigin: input.expectedOrigin ?? (input.tabId ? this.options.expectedOrigin : undefined),
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      sessionId: this.options.sessionId,
      tabId: input.tabId,
    }
    const timeout = AbortSignal.timeout(commandTimeout(input))

    return fetch(`${this.options.endpoint}/v1/browser/commands`, {
      body: JSON.stringify(request),
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.any([this.options.abort, timeout]),
    }).then(async (response) => {
      const body = await response.text()
      const parsed = parseResponse(body, request.requestId)
      if (!response.ok || "error" in parsed) {
        throw new BrowserClientError("error" in parsed
          ? parsed.error
          : browserError("BROWSER_UNAVAILABLE", `Browser command failed with status ${response.status}`, true))
      }
      const result = parsed as BrowserCommandResponse<T>
      this.events = result.events
      await hydrateScreenshot(result, this.options)
      return result
    }).catch((error: unknown) => {
      if (error instanceof BrowserClientError) throw error
      if (this.options.abort.aborted) {
        throw new BrowserClientError(browserError("CANCELLED", "Browser command was cancelled", true))
      }
      if (timeout.aborted) {
        throw new BrowserClientError(browserError("TIMEOUT", "Browser command timed out", true))
      }
      throw new BrowserClientError(browserError(
        "BROWSER_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        true,
      ))
    })
  }
}

async function hydrateScreenshot<T>(
  response: BrowserCommandResponse<T>,
  options: BrowserTransportOptions,
) {
  const data = isRecord(response.data) ? response.data : undefined
  const screenshot = data && isRecord(data.screenshot) ? data.screenshot : undefined
  if (!screenshot || typeof screenshot.reference !== "string" || typeof screenshot.data === "string") return
  if (!screenshot.reference.startsWith("/v1/browser/assets/")) {
    throw new BrowserClientError(browserError("BROWSER_UNAVAILABLE", "Browser returned an invalid asset reference", true))
  }
  const asset = await fetch(`${options.endpoint}${screenshot.reference}`, {
    headers: { Authorization: `Bearer ${options.token}` },
    signal: AbortSignal.any([options.abort, AbortSignal.timeout(60_000)]),
  })
  if (!asset.ok) throw new BrowserClientError(browserError(
    "BROWSER_UNAVAILABLE",
    `Browser screenshot asset failed with status ${asset.status}`,
    true,
  ))
  screenshot.data = Buffer.from(await asset.arrayBuffer()).toString("base64")
}

function parseResponse(body: string, requestId: string): BrowserCommandResponse | BrowserErrorResponse {
  const parsed = parseJson(body)
  if (
    !isRecord(parsed)
    || parsed.protocolVersion !== BROWSER_PROTOCOL_VERSION
  ) {
    return invalidResponse(requestId)
  }
  if ("error" in parsed) {
    if (parsed.requestId !== undefined && parsed.requestId !== requestId) return invalidResponse(requestId)
    const error = parsed.error
    if (
      !isRecord(error)
      || typeof error.code !== "string"
      || typeof error.message !== "string"
      || typeof error.retryable !== "boolean"
    ) {
      return invalidResponse(requestId, "Browser returned an invalid error response")
    }
    return parsed as unknown as BrowserErrorResponse
  }
  if (
    parsed.requestId !== requestId
    || !("data" in parsed)
    || !Array.isArray(parsed.events)
  ) return invalidResponse(requestId)
  return parsed as unknown as BrowserCommandResponse
}

function commandTimeout(input: BrowserCommandInput) {
  const timeout = "timeout" in input.command
    && typeof input.command.timeout === "number"
    && Number.isFinite(input.command.timeout)
    ? input.command.timeout + 5_000
    : 60_000
  return Math.min(10 * 60_000 + 5_000, Math.max(60_000, timeout))
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

function invalidResponse(requestId: string, message = "Browser returned an invalid response"): BrowserErrorResponse {
  return {
    error: browserError("BROWSER_UNAVAILABLE", message, true),
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    requestId,
  }
}
