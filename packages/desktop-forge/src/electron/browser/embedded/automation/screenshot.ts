import { BrowserWindow, nativeTheme } from "electron"
import type {
    BrowserBounds,
    BrowserLoadError,
    BrowserScreenshot,
    BrowserScreenshotInput,
} from "@opencode-ai/browser-protocol"
import { browserErrorContent } from "../../../../shared/browser-error"
import type { CdpSender } from "./cdp"
import { asRecord } from "./cdp"
import { BrowserRuntimeException } from "../../errors"

export async function captureScreenshot(
    send: CdpSender,
    input: BrowserScreenshotInput,
): Promise<BrowserScreenshot> {
    const metrics = asRecord(await send("Page.getLayoutMetrics"))
    const content = readRect(metrics.cssContentSize)
    const requested = input.clip
        ? sanitizeClip(input.clip)
        : input.fullPage
            ? content
            : readViewport(metrics.cssVisualViewport) ?? readViewport(metrics.cssLayoutViewport)
    if (
        input.clip
        && requested
        && content
        && (
            requested.x + requested.width > content.x + content.width
            || requested.y + requested.height > content.y + content.height
        )
    ) {
        throw new BrowserRuntimeException("INVALID_COMMAND", "Screenshot clip is outside the page bounds")
    }
    const clip = requested ?? { height: 1, width: 1, x: 0, y: 0 }
    const imageFormat = input.imageFormat ?? "png"
    const result = asRecord(await send("Page.captureScreenshot", {
        captureBeyondViewport: input.fullPage === true || input.clip != null,
        clip: { ...clip, scale: 1 },
        format: imageFormat,
        fromSurface: true,
        ...(imageFormat === "jpeg"
            ? { quality: Math.max(0, Math.min(100, Math.round(input.quality ?? 80))) }
            : {}),
    }))
    if (typeof result.data !== "string") throw new Error("Browser screenshot did not return image data")
    return {
        data: result.data,
        height: Math.round(clip.height),
        mimeType: imageFormat === "jpeg" ? "image/jpeg" : "image/png",
        width: Math.round(clip.width),
    }
}

export async function captureErrorScreenshot(
    window: BrowserWindow,
    viewport: BrowserBounds,
    input: BrowserScreenshotInput,
    context: {
        active: boolean
        error: BrowserLoadError
        visible: boolean
    },
): Promise<BrowserScreenshot> {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new BrowserRuntimeException("BROWSER_UNAVAILABLE", "Browser window is closed")
    }
    if (!context.active || !context.visible || viewport.width <= 0 || viewport.height <= 0) {
        return captureDetachedErrorScreenshot(window, viewport, input, context.error)
    }
    const clip = input.clip ? sanitizeClip(input.clip) : {
        height: viewport.height,
        width: viewport.width,
        x: 0,
        y: 0,
    }
    if (clip.x + clip.width > viewport.width || clip.y + clip.height > viewport.height) {
        throw new BrowserRuntimeException("INVALID_COMMAND", "Screenshot clip is outside the page bounds")
    }
    const image = await window.webContents.capturePage({
        height: Math.round(clip.height),
        width: Math.round(clip.width),
        x: Math.round(viewport.x + clip.x),
        y: Math.round(viewport.y + clip.y),
    })
    const size = image.getSize()
    const imageFormat = input.imageFormat ?? "png"
    return {
        data: (
            imageFormat === "jpeg"
                ? image.toJPEG(Math.max(0, Math.min(100, Math.round(input.quality ?? 80))))
                : image.toPNG()
        ).toString("base64"),
        height: size.height,
        mimeType: imageFormat === "jpeg" ? "image/jpeg" : "image/png",
        width: size.width,
    }
}

async function captureDetachedErrorScreenshot(
    owner: BrowserWindow,
    viewport: BrowserBounds,
    input: BrowserScreenshotInput,
    error: BrowserLoadError,
) {
    const bounds = {
        height: Math.max(1, Math.round(viewport.height || Math.min(720, owner.getContentBounds().height))),
        width: Math.max(1, Math.round(viewport.width || Math.min(1_024, owner.getContentBounds().width))),
    }
    const clip = input.clip ? sanitizeClip(input.clip) : { ...bounds, x: 0, y: 0 }
    if (clip.x + clip.width > bounds.width || clip.y + clip.height > bounds.height) {
        throw new BrowserRuntimeException("INVALID_COMMAND", "Screenshot clip is outside the page bounds")
    }
    const captureWindow = new BrowserWindow({
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff",
        height: bounds.height,
        show: false,
        webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            offscreen: true,
            sandbox: true,
        },
        width: bounds.width,
    })
    try {
        await captureWindow.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(error, nativeTheme.shouldUseDarkColors))}`,
        )
        const image = await captureWindow.webContents.capturePage({
            height: Math.round(clip.height),
            width: Math.round(clip.width),
            x: Math.round(clip.x),
            y: Math.round(clip.y),
        })
        const size = image.getSize()
        const imageFormat = input.imageFormat ?? "png"
        return {
            data: (
                imageFormat === "jpeg"
                    ? image.toJPEG(Math.max(0, Math.min(100, Math.round(input.quality ?? 80))))
                    : image.toPNG()
            ).toString("base64"),
            height: size.height,
            mimeType: imageFormat === "jpeg" ? "image/jpeg" as const : "image/png" as const,
            width: size.width,
        }
    } finally {
        if (!captureWindow.isDestroyed()) captureWindow.destroy()
    }
}

function errorPageHtml(error: BrowserLoadError, dark: boolean) {
    const content = browserErrorContent(error)
    const colors = dark
        ? {
            background: "#181818",
            button: "#2b2b2b",
            buttonBorder: "#3b3b3b",
            code: "#777777",
            icon: "#8a8a8a",
            primary: "#eeeeee",
            secondary: "#a6a6a6",
            tertiary: "#8a8a8a",
        }
        : {
            background: "#ffffff",
            button: "#f3f3f3",
            buttonBorder: "#d7d7d7",
            code: "#8b8b8b",
            icon: "#777777",
            primary: "#202020",
            secondary: "#5f5f5f",
            tertiary: "#777777",
        }
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0}
body{overflow:hidden;color:${colors.primary};background:${colors.background};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{position:absolute;top:42%;left:clamp(38px,18%,240px);width:min(520px,calc(82% - 38px));transform:translateY(-50%);text-align:left}
.icon{width:30px;height:30px;margin-bottom:20px;display:grid;place-items:center;color:${colors.icon};font-size:19px;font-weight:500;border:1.6px solid ${colors.icon};border-radius:50%}
h1{margin:0 0 10px;font-size:clamp(22px,2vw,28px);font-weight:500;line-height:1.3;letter-spacing:-.02em}
p{margin:0;color:${colors.secondary};font-size:13px;line-height:21px}
ul{margin:16px 0 22px;padding-left:18px;color:${colors.tertiary};font-size:12px;line-height:21px}
button{height:32px;padding:0 13px;color:${colors.primary};font-family:inherit;font-size:12px;font-weight:650;border:1px solid ${colors.buttonBorder};border-radius:8px;background:${colors.button}}
code{display:block;margin-top:18px;color:${colors.code};font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:10px;line-height:16px}
</style>
</head>
<body>
<main>
<div class="icon">!</div>
<h1>${escapeHtml(content.title)}</h1>
<p>${escapeHtml(content.message)}</p>
<ul>${content.suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join("")}</ul>
<button type="button">↻&nbsp;&nbsp;重新加载</button>
<code>${escapeHtml(content.code)}</code>
</main>
</body>
</html>`
}

function escapeHtml(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#039;")
}

function sanitizeClip(clip: { height: number; width: number; x: number; y: number }) {
    return {
        height: Math.max(1, clip.height),
        width: Math.max(1, clip.width),
        x: Math.max(0, clip.x),
        y: Math.max(0, clip.y),
    }
}

function readRect(value: unknown) {
    const rect = asRecord(value)
    if (
        typeof rect.height !== "number"
        || typeof rect.width !== "number"
        || typeof rect.x !== "number"
        || typeof rect.y !== "number"
    ) return undefined
    return sanitizeClip(rect as { height: number; width: number; x: number; y: number })
}

function readViewport(value: unknown) {
    const viewport = asRecord(value)
    if (
        typeof viewport.clientHeight !== "number"
        || typeof viewport.clientWidth !== "number"
        || typeof viewport.pageX !== "number"
        || typeof viewport.pageY !== "number"
    ) return undefined
    return sanitizeClip({
        height: viewport.clientHeight,
        width: viewport.clientWidth,
        x: viewport.pageX,
        y: viewport.pageY,
    })
}
