import { createSignal, createEffect, onMount, onCleanup, Show, on } from "solid-js"
import * as pdfjsLib from "pdfjs-dist"
import { textPositionService, TextRect } from "../../services/TextPositionService"

// 设置 PDF.js worker
// 在 Electron/Vite 环境中，我们已经通过主进程将 worker 复制到了 public/pdf.worker.min.mjs
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs"

interface PdfCanvasRendererProps {
    data: Uint8Array
    highlight?: {
        page: number
        rects?: TextRect[]
        searchText?: string  // 要搜索高亮的文本
        version?: number
    } | null
}

export function PdfCanvasRenderer(props: PdfCanvasRendererProps) {
    let containerRef: HTMLDivElement | undefined
    let canvasRef: HTMLCanvasElement | undefined

    const [pdf, setPdf] = createSignal<pdfjsLib.PDFDocumentProxy | null>(null)
    const [currentPage, setCurrentPage] = createSignal(1)
    const [numPages, setNumPages] = createSignal(0)
    const [scale, setScale] = createSignal(1.0)
    const [renderTask, setRenderTask] = createSignal<pdfjsLib.RenderTask | null>(null)
    const [currentHighlight, setCurrentHighlight] = createSignal<TextRect[] | null>(null)

    // 加载文档
    createEffect(on(() => props.data, async (data) => {
        if (data) {
            try {
                const loadingTask = pdfjsLib.getDocument({ data: data })
                const pdfDoc = await loadingTask.promise
                setPdf(pdfDoc)
                setNumPages(pdfDoc.numPages)
                setCurrentPage(1)
                setCurrentHighlight(null)
                renderPage(1)
            } catch (err) {
                console.error("加载 PDF 文档失败:", err)
            }
        }
    }))

    // 处理高亮跳转 - 使用 on() 显式追踪依赖
    createEffect(on(() => props.highlight, async (h) => {
        const pdfDoc = pdf()
        if (h && pdfDoc && h.page >= 1 && h.page <= numPages()) {
            console.log("跳转到页面:", h.page, "搜索文本:", h.searchText, "高亮:", h.rects)
            setCurrentPage(h.page)

            // 如果有预定义的 rects，直接使用
            if (h.rects && h.rects.length > 0) {
                setCurrentHighlight(h.rects)
                renderPage(h.page, h.rects)
            }
            // 如果有 searchText，使用 TextPositionService 在页面中搜索文本位置
            else if (h.searchText) {
                const foundRects = await findTextInPageWithService(pdfDoc, h.page, h.searchText)
                console.log("搜索到的位置:", foundRects)
                setCurrentHighlight(foundRects)
                renderPage(h.page, foundRects)
            } else {
                // 只跳转页面，不高亮
                setCurrentHighlight([])
                renderPage(h.page, [])
            }
        }
    }))

    // 使用 TextPositionService 在页面中搜索文本
    const findTextInPageWithService = async (
        pdfDoc: pdfjsLib.PDFDocumentProxy,
        pageNum: number,
        searchText: string
    ): Promise<TextRect[]> => {
        try {
            const page = await pdfDoc.getPage(pageNum)
            const textContent = await page.getTextContent()

            // 如果搜索文本太短，不处理
            if (searchText.trim().length < 2) return []

            // 使用服务的私有方法逻辑（因为服务需要整个文档，这里直接调用搜索逻辑）
            const rects: TextRect[] = []
            const normalizedSearch = searchText.toLowerCase().trim()

            // 遍历文本项寻找匹配
            for (const item of textContent.items) {
                if (!('str' in item)) continue
                const textItem = item as any
                const str = textItem.str
                const normalizedStr = str.toLowerCase()

                // 查找匹配位置
                let startIndex = normalizedStr.indexOf(normalizedSearch)
                while (startIndex !== -1) {
                    // 计算该文字的矩形
                    const transform = textItem.transform
                    const width = textItem.width || 0
                    const height = textItem.height || 10
                    const charWidth = width / (str.length || 1)

                    // PDF 坐标系：左下角是原点
                    const x1 = transform[4] + startIndex * charWidth
                    const y1 = transform[5]
                    const x2 = x1 + searchText.length * charWidth
                    const y2 = y1 + height

                    rects.push({ x1, y1, x2, y2 })

                    // 查找下一个匹配
                    startIndex = normalizedStr.indexOf(normalizedSearch, startIndex + 1)
                }
            }

            // 如果没有找到完整匹配，尝试模糊匹配（匹配部分文本）
            if (rects.length === 0 && normalizedSearch.length > 5) {
                const partialSearch = normalizedSearch.substring(0, Math.min(20, normalizedSearch.length))
                for (const item of textContent.items) {
                    if (!('str' in item)) continue
                    const textItem = item as any
                    const str = textItem.str
                    const normalizedStr = str.toLowerCase()

                    if (normalizedStr.includes(partialSearch)) {
                        const transform = textItem.transform
                        const width = textItem.width || 0
                        const height = textItem.height || 12

                        rects.push({
                            x1: transform[4],
                            y1: transform[5],
                            x2: transform[4] + width,
                            y2: transform[5] + height
                        })
                        break // 只取第一个匹配
                    }
                }
            }

            // 使用服务合并相邻的矩形
            return textPositionService.mergeAdjacentRects(rects)
        } catch (err) {
            console.error("搜索文本失败:", err)
            return []
        }
    }

    const renderPage = async (pageNo: number, rects: any[] = []) => {
        const pdfDoc = pdf()
        if (!pdfDoc || !canvasRef) return

        // 取消之前的渲染任务
        const currentTask = renderTask()
        if (currentTask) {
            currentTask.cancel()
        }

        try {
            const page = await pdfDoc.getPage(pageNo)
            const viewport = page.getViewport({ scale: scale() })

            canvasRef.height = viewport.height
            canvasRef.width = viewport.width

            const canvasContext = canvasRef.getContext("2d")
            if (!canvasContext) return

            const task = page.render({
                canvasContext,
                viewport,
                canvas: canvasRef
            })
            setRenderTask(task)

            await task.promise
            setRenderTask(null)

            // 如果有高亮，在 Canvas 上绘制
            if (rects && rects.length > 0) {
                canvasContext.fillStyle = "rgba(255, 255, 0, 0.4)"
                canvasContext.strokeStyle = "rgba(255, 100, 0, 0.8)"
                canvasContext.lineWidth = 2

                rects.forEach(rect => {
                    // PDF 坐标系 (0,0 在左下角) 转 Canvas 坐标系 (0,0 在左上角)
                    // pdfjs viewport.transform 可以处理转换
                    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
                        rect.x1, rect.y1, rect.x2, rect.y2
                    ])

                    const width = x2 - x1
                    const height = y2 - y1 // 注意转换后 y2 > y1

                    canvasContext.fillRect(x1, y1, width, height)
                    canvasContext.strokeRect(x1, y1, width, height)
                })

                // 滚动到第一个高亮位置
                if (containerRef) {
                    const firstRect = viewport.convertToViewportRectangle([
                        rects[0].x1, rects[0].y1, rects[0].x2, rects[0].y2
                    ])
                    containerRef.scrollTo({
                        top: firstRect[1] - 100,
                        behavior: "smooth"
                    })
                }
            }
        } catch (err: any) {
            if (err.name === "RenderingCancelledException") return
            console.error("渲染页面失败:", err)
        }
    }

    return (
        <div style={{
            display: "flex",
            "flex-direction": "column",
            height: "100%",
            width: "100%",
            overflow: "hidden"
        }}>
            <div class="pdf-toolbar" style={{
                padding: "var(--spacing-md)",
                background: "var(--bg-secondary)",
                "border-bottom": "1px solid var(--border-subtle)",
                display: "flex",
                "align-items": "center",
                gap: "12px",
                color: "var(--text-primary)",
                "flex-shrink": 0,
                "border-radius": "var(--radius-lg) var(--radius-lg) 0 0"
            }}>
                {/* 上一页按钮 */}
                <button
                    onClick={() => {
                        if (currentPage() > 1) {
                            const next = currentPage() - 1
                            setCurrentPage(next)
                            renderPage(next)
                        }
                    }}
                    disabled={currentPage() <= 1}
                    style={{
                        width: "24px",
                        height: "24px",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        background: currentPage() <= 1 ? "var(--bg-tertiary)" : "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                        color: currentPage() <= 1 ? "var(--text-tertiary)" : "var(--text-primary)",
                        cursor: currentPage() <= 1 ? "not-allowed" : "pointer",
                        "border-radius": "var(--radius-sm)",
                        "font-size": "14px",
                        transition: "all 0.15s ease"
                    }}
                    title="上一页"
                >◀</button>

                {/* 页码显示 */}
                <span style={{
                    "font-size": "14px",
                    color: "var(--text-secondary)",
                    "min-width": "70px",
                    "text-align": "center"
                }}>
                    {currentPage()} / {numPages()}
                </span>

                {/* 下一页按钮 */}
                <button
                    onClick={() => {
                        if (currentPage() < numPages()) {
                            const next = currentPage() + 1
                            setCurrentPage(next)
                            renderPage(next)
                        }
                    }}
                    disabled={currentPage() >= numPages()}
                    style={{
                        width: "24px",
                        height: "24px",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        background: currentPage() >= numPages() ? "var(--bg-tertiary)" : "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                        color: currentPage() >= numPages() ? "var(--text-tertiary)" : "var(--text-primary)",
                        cursor: currentPage() >= numPages() ? "not-allowed" : "pointer",
                        "border-radius": "var(--radius-sm)",
                        "font-size": "14px",
                        transition: "all 0.15s ease"
                    }}
                    title="下一页"
                >▶</button>

                {/* 分隔线 */}
                <div style={{
                    width: "1px",
                    height: "24px",
                    background: "var(--border-default)",
                    margin: "0 8px"
                }} />

                {/* 缩小按钮 */}
                <button
                    onClick={() => {
                        setScale(s => Math.max(0.5, s - 0.1))
                        renderPage(currentPage())
                    }}
                    style={{
                        width: "24px",
                        height: "24px",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        "border-radius": "var(--radius-sm)",
                        "font-size": "16px",
                        "font-weight": "bold",
                        transition: "all 0.15s ease"
                    }}
                    title="缩小"
                >−</button>

                {/* 缩放百分比 */}
                <span style={{
                    "font-size": "14px",
                    color: "var(--text-secondary)",
                    "min-width": "50px",
                    "text-align": "center"
                }}>
                    {Math.round(scale() * 100)}%
                </span>

                {/* 放大按钮 */}
                <button
                    onClick={() => {
                        setScale(s => Math.min(3, s + 0.1))
                        renderPage(currentPage())
                    }}
                    style={{
                        width: "24px",
                        height: "24px",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        "border-radius": "var(--radius-sm)",
                        "font-size": "16px",
                        "font-weight": "bold",
                        transition: "all 0.15s ease"
                    }}
                    title="放大"
                >+</button>
            </div>

            <div
                ref={containerRef}
                style={{
                    flex: 1,
                    overflow: "auto",
                    display: "flex",
                    "justify-content": "center",
                    padding: "20px",
                    background: "var(--bg-secondary)",
                    "border-radius": "0 0 var(--radius-lg) var(--radius-lg)"
                }}
            >
                <div style={{
                    position: "relative",
                    background: "white",
                    "box-shadow": "0 2px 10px rgba(0,0,0,0.3)"
                }}>
                    <canvas ref={canvasRef}></canvas>
                </div>
            </div>
        </div>
    )
}
