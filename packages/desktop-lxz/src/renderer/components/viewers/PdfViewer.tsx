import { createSignal, createEffect, onMount, Show, For, Accessor, on } from "solid-js"
import { useSDK } from "../../context/sdk"
import { ResultsPanel } from "../ResultsPanel"
import { PdfCanvasRenderer } from "./PdfCanvasRenderer"

interface PdfViewerProps {
    filePath: Accessor<string>
    fileName: Accessor<string>
}

export function PdfViewer(props: PdfViewerProps) {
    const sdk = useSDK()
    const [pdfData, setPdfData] = createSignal<Uint8Array | null>(null)
    const [isLoading, setIsLoading] = createSignal(false)
    const [error, setError] = createSignal<string | null>(null)
    const [highlight, setHighlight] = createSignal<{ page: number; rects?: any[]; searchText?: string; version: number } | null>(null)
    const [resultsCollapsed, setResultsCollapsed] = createSignal(true)
    let highlightVersion = 0

    // 当文件路径改变时，加载 PDF 数据
    createEffect(on(() => props.filePath(), async (path) => {
        if (path && path.toLowerCase().endsWith(".pdf")) {
            setIsLoading(true)
            setError(null)
            setHighlight(null)
            try {
                if (window.electronAPI) {
                    const result = await window.electronAPI.readFileBase64(path)
                    if (result.success && result.base64) {
                        const binaryString = atob(result.base64)
                        const bytes = new Uint8Array(binaryString.length)
                        for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i)
                        }
                        setPdfData(bytes)
                    } else {
                        throw new Error(result.error || "读取文件失败")
                    }
                } else {
                    const response = await fetch(`file://${path}`)
                    const buffer = await response.arrayBuffer()
                    setPdfData(new Uint8Array(buffer))
                }
            } catch (err: any) {
                console.error("加载 PDF 失败:", err)
                setError(`加载 PDF 失败: ${err.message}`)
            } finally {
                setIsLoading(false)
            }
        } else {
            setPdfData(null)
        }
    }))

    // 处理审计结果点击
    const handleIssueClick = (issue: any) => {
        console.log("审核结果点击:", issue)
        if (issue.position && issue.position.page) {
            highlightVersion++
            setHighlight({
                page: issue.position.page,
                rects: issue.position.rects || undefined,
                searchText: issue.matchedText || undefined, // 使用匹配文本进行搜索定位
                version: highlightVersion
            })
        }
    }

    return (
        <>
            {/* 文件头部信息 */}
            <div class="content-header">
                <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ "font-size": "16px" }}>📕</span>
                    <span style={{ "font-weight": 500, "max-width": "300px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
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

                    <Show when={!isLoading() && !error() && pdfData()}>
                        <PdfCanvasRenderer
                            data={pdfData()!}
                            highlight={highlight()}
                        />
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

export function isPdfFile(filename: string): boolean {
    return filename.toLowerCase().endsWith(".pdf")
}
