import { Show, createSignal, createEffect, onCleanup, on, Accessor } from "solid-js"
import { useSDK } from "../../context/sdk"
import { ResultsPanel } from "../ResultsPanel"

// PDF 文件扩展名
const PDF_EXTENSIONS = [".pdf"]

export function isPdfFile(filename: string): boolean {
    const lastDot = filename.lastIndexOf(".")
    const ext = lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : ""
    return PDF_EXTENSIONS.includes(ext)
}

interface PdfViewerProps {
    filePath: Accessor<string>
    fileName: Accessor<string>
    onLoadStart?: () => void
    onLoadEnd?: () => void
    onError?: (error: string) => void
}

export function PdfViewer(props: PdfViewerProps) {
    const sdk = useSDK()
    const [pdfUrl, setPdfUrl] = createSignal<string>("")
    const [isLoading, setIsLoading] = createSignal(false)
    const [error, setError] = createSignal<string>("")
    const [resultsCollapsed, setResultsCollapsed] = createSignal(false)
    const [targetPage, setTargetPage] = createSignal<number | null>(null)
    const [iframeKey, setIframeKey] = createSignal(0)
    const [currentLoadedPath, setCurrentLoadedPath] = createSignal<string>("")

    // iframe 引用
    let iframeRef: HTMLIFrameElement | undefined

    // 当文件路径变化时加载 PDF
    createEffect(on(() => props.filePath(), (filePath) => {
        if (filePath && filePath !== currentLoadedPath()) {
            setCurrentLoadedPath(filePath)
            loadPdf(filePath)
        } else if (!filePath) {
            cleanup()
        }
    }))

    // 清理 PDF blob URL
    onCleanup(() => {
        cleanup()
    })

    const cleanup = () => {
        const url = pdfUrl()
        if (url) {
            URL.revokeObjectURL(url)
            setPdfUrl("")
        }
        setError("")
        setCurrentLoadedPath("")
    }

    const loadPdf = async (filePath: string) => {
        console.log("PdfViewer: 加载 PDF 文件:", filePath)
        setIsLoading(true)
        setError("")
        props.onLoadStart?.()

        // 清理旧的 PDF URL
        const oldUrl = pdfUrl()
        if (oldUrl) {
            URL.revokeObjectURL(oldUrl)
            setPdfUrl("")
        }

        try {
            // 读取 PDF 为 base64
            const result = await window.electronAPI.readFileBase64(filePath)
            console.log("PDF 读取结果:", result.success, result.error)

            if (result.success && result.base64) {
                console.log("Base64 长度:", result.base64.length)
                // 创建 blob URL
                const binary = atob(result.base64)
                const bytes = new Uint8Array(binary.length)
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i)
                }
                const blob = new Blob([bytes], { type: "application/pdf" })
                const url = URL.createObjectURL(blob)
                console.log("PDF Blob URL:", url)
                setPdfUrl(url)
            } else {
                const errorMsg = result.error || "无法读取 PDF 文件"
                setError(errorMsg)
                props.onError?.(errorMsg)
            }
        } catch (err) {
            console.error("加载 PDF 失败:", err)
            const errorMsg = String(err)
            setError(errorMsg)
            props.onError?.(errorMsg)
        } finally {
            setIsLoading(false)
            props.onLoadEnd?.()
        }
    }

    // 生成带页码的 PDF URL
    const getPdfSrc = () => {
        const base = pdfUrl()
        const page = targetPage()
        if (!base) return ""
        if (page) {
            return `${base}#page=${page}`
        }
        return base
    }

    // 处理审核结果点击 - 跳转到对应 PDF 页面
    const handleIssueClick = (issue: any) => {
        console.log("点击审核结果:", issue)

        if (issue.position?.page) {
            const page = issue.position.page
            console.log("跳转到第", page, "页")
            // 设置目标页码并强制重新渲染 iframe
            setTargetPage(page)
            setIframeKey(prev => prev + 1)
        }
    }

    return (
        <>
            {/* 文件头部信息 */}
            <div class="content-header">
                <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ "font-size": "16px" }}>📕</span>
                    <span style={{ "font-weight": 500 }}>
                        {props.fileName()}
                    </span>
                </div>
                {/* 审核结果展开/收起按钮 */}
                <button
                    class={`results-toggle-btn ${resultsCollapsed() ? "collapsed" : ""}`}
                    onClick={() => setResultsCollapsed(!resultsCollapsed())}
                    title={resultsCollapsed() ? "展开审核结果" : "收起审核结果"}
                >
                    <span>📋</span>
                    <span>{resultsCollapsed() ? "展开" : "收起"}审核结果</span>
                </button>
            </div>

            {/* 内容区域 - PDF 左右分割布局 */}
            <div class={`content-body ${!resultsCollapsed() ? "split-view" : ""}`}>
                {/* 左侧：PDF 预览 */}
                <div class="content-preview">
                    <Show when={isLoading()}>
                        <div class="content-placeholder">
                            <div style={{ color: "var(--text-secondary)" }}>加载中...</div>
                        </div>
                    </Show>

                    <Show when={error()}>
                        <div class="content-placeholder">
                            <div style={{ color: "var(--error)" }}>❌ {error()}</div>
                        </div>
                    </Show>

                    <Show when={!isLoading() && !error() && pdfUrl()}>
                        {/* iframeKey 变化时强制重新创建 iframe */}
                        {(() => {
                            const key = iframeKey()
                            return (
                                <iframe
                                    ref={iframeRef}
                                    src={getPdfSrc()}
                                    style={{
                                        width: "100%",
                                        flex: "1",
                                        height: "100%",
                                        border: "none",
                                        "border-radius": "8px",
                                        background: "#fff",
                                    }}
                                    title={`PDF 预览 ${key}`}
                                />
                            )
                        })()}
                    </Show>
                </div>

                {/* 右侧：审核结果面板 */}
                <Show when={!resultsCollapsed()}>
                    <div class="content-results">
                        <ResultsPanel onIssueClick={handleIssueClick} />
                    </div>
                </Show>
            </div>
        </>
    )
}
