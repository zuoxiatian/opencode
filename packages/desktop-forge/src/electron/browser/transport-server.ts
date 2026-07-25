import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
    BROWSER_PROTOCOL_VERSION,
    browserError,
    parseBrowserCommandRequest,
    isRecord,
} from "@opencode-ai/browser-protocol"
import type { BrowserRuntime } from "./runtime"
import { BrowserRuntimeException, runtimeError } from "./errors"

export interface BrowserTransportServer {
    close: () => void
    token: string
    url: string
}

export function startBrowserTransportServer(runtime: () => BrowserRuntime | null) {
    const token = randomBytes(32).toString("hex")
    const assets = new Map<string, { data: Buffer; mimeType: string }>()
    const server = createServer((request, response) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
            send(response, 401, {
                error: browserError("PERMISSION_DENIED", "Unauthorized"),
                protocolVersion: BROWSER_PROTOCOL_VERSION,
            })
            return
        }
        if (request.method === "GET" && request.url?.startsWith("/v1/browser/assets/")) {
            const id = request.url.slice("/v1/browser/assets/".length)
            const asset = assets.get(id)
            if (!asset) {
                send(response, 404, {
                    error: browserError("INVALID_COMMAND", "Browser asset not found"),
                    protocolVersion: BROWSER_PROTOCOL_VERSION,
                })
                return
            }
            assets.delete(id)
            response.writeHead(200, {
                "Cache-Control": "no-store",
                "Content-Type": asset.mimeType,
            })
            response.end(asset.data)
            return
        }
        if (request.method !== "POST" || request.url !== "/v1/browser/commands") {
            send(response, 404, {
                error: browserError("INVALID_COMMAND", "Not found"),
                protocolVersion: BROWSER_PROTOCOL_VERSION,
            })
            return
        }
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            send(response, 415, {
                error: browserError("INVALID_COMMAND", "Content-Type must be application/json"),
                protocolVersion: BROWSER_PROTOCOL_VERSION,
            })
            return
        }

        const controller = new AbortController()
        request.once("aborted", () => controller.abort())
        request.once("close", () => {
            if (!request.complete) controller.abort()
        })
        response.once("close", () => {
            if (!response.writableEnded) controller.abort()
        })

        let requestId: string | undefined
        void readBody(request)
            .then(parseRequest)
            .then((command) => {
                requestId = command.requestId
                const current = runtime()
                if (!current) throw new Error("Desktop browser window is not available")
                return current.dispatch(command, controller.signal)
            })
            .then((result) => send(response, 200, storeScreenshot(result, assets)))
            .catch((error: unknown) => send(response, statusFor(error), {
                error: runtimeError(error),
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                requestId,
            }))
    })

    return new Promise<BrowserTransportServer>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            const address = server.address() as AddressInfo
            resolve({
                close: () => server.close(),
                token,
                url: `http://127.0.0.1:${address.port}`,
            })
        })
    })
}

function storeScreenshot(
    response: import("@opencode-ai/browser-protocol").BrowserCommandResponse,
    assets: Map<string, { data: Buffer; mimeType: string }>,
) {
    const data = isRecord(response.data) ? response.data : undefined
    const screenshot = data && isRecord(data.screenshot) ? data.screenshot : undefined
    if (!screenshot || typeof screenshot.data !== "string" || typeof screenshot.mimeType !== "string") return response
    const id = crypto.randomUUID()
    assets.set(id, {
        data: Buffer.from(screenshot.data, "base64"),
        mimeType: screenshot.mimeType,
    })
    const expiry = setTimeout(() => assets.delete(id), 2 * 60_000)
    expiry.unref()
    return {
        ...response,
        data: {
            ...response.data,
            screenshot: {
                ...screenshot,
                data: undefined,
                reference: `/v1/browser/assets/${id}`,
            },
        },
    }
}

function parseRequest(body: string) {
    try {
        return parseBrowserCommandRequest(JSON.parse(body) as unknown)
    } catch (error) {
        throw new BrowserRuntimeException(
            "INVALID_COMMAND",
            error instanceof Error ? error.message : "Invalid browser command",
        )
    }
}

function readBody(request: IncomingMessage) {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        let length = 0
        request.on("data", (chunk: Buffer) => {
            length += chunk.length
            if (length > 256 * 1024) {
                reject(new BrowserRuntimeException("INVALID_COMMAND", "Browser command is too large"))
                request.destroy()
                return
            }
            chunks.push(chunk)
        })
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        request.on("error", reject)
    })
}

function statusFor(error: unknown) {
    const code = runtimeError(error).code
    if (code === "PERMISSION_DENIED" || code === "TAB_NOT_OWNED" || code === "ORIGIN_CHANGED") return 403
    if (code === "BROWSER_NOT_FOUND" || code === "TAB_NOT_FOUND") return 404
    if (code === "BROWSER_UNAVAILABLE" || code === "TARGET_GONE") return 503
    if (code === "TIMEOUT") return 408
    return 400
}

function send(response: ServerResponse, status: number, body: unknown) {
    if (response.destroyed || response.headersSent) return
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
    })
    response.end(JSON.stringify(body))
}
