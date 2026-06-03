import { Show, createSignal, createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { PdfViewer, isPdfFile, TextViewer, isTextFile } from "./viewers"

// 判断文件是否支持预览
function isSupportedFile(filename: string): boolean {
    return isTextFile(filename) || isPdfFile(filename)
}

// 文件类型枚举
type FileType = "pdf" | "text" | "unsupported"

function getFileType(filename: string): FileType {
    if (isPdfFile(filename)) return "pdf"
    if (isTextFile(filename)) return "text"
    return "unsupported"
}

export function ContentPanel() {
    const sdk = useSDK()

    // 计算当前文件类型
    const currentFileType = createMemo<FileType>(() => {
        const file = sdk.selectedFile()
        if (!file || file.isDirectory) return "unsupported"
        return getFileType(file.name)
    })

    // 计算当前文件路径（作为响应式 Accessor）
    const currentFilePath = createMemo(() => {
        const file = sdk.selectedFile()
        return file && !file.isDirectory ? file.path : ""
    })

    // 计算当前文件名（作为响应式 Accessor）
    const currentFileName = createMemo(() => {
        const file = sdk.selectedFile()
        return file && !file.isDirectory ? file.name : ""
    })

    return (
        <div class="content-panel">
            <Show
                when={sdk.directory()}
                fallback={
                    <div class="content-placeholder">
                        <div class="content-placeholder-icon">📄</div>
                        <div class="content-placeholder-text">
                            选择一个项目文件夹开始
                        </div>
                    </div>
                }
            >
                <Show
                    when={sdk.selectedFile() && !sdk.selectedFile()?.isDirectory}
                    fallback={
                        <div class="content-placeholder">
                            <div class="content-placeholder-icon">📑</div>
                            <div class="content-placeholder-text">
                                选择一个文件查看内容
                            </div>
                            <div style={{ "margin-top": "16px", color: "var(--text-tertiary)", "font-size": "12px" }}>
                                支持预览: PDF, Word, Markdown, TXT, JSON, JS, TS, CSS, HTML 等
                            </div>
                        </div>
                    }
                >
                    {/* 不支持的文件类型 */}
                    <Show when={currentFileType() === "unsupported"}>
                        <div class="content-placeholder">
                            <div class="content-placeholder-icon">❓</div>
                            <div class="content-placeholder-text">
                                不支持预览此类型的文件
                            </div>
                            <div style={{ "margin-top": "8px", color: "var(--text-tertiary)", "font-size": "12px" }}>
                                {currentFileName()}
                            </div>
                        </div>
                    </Show>

                    {/* PDF 文件查看器 */}
                    <Show when={currentFileType() === "pdf"}>
                        <PdfViewer
                            filePath={currentFilePath}
                            fileName={currentFileName}
                        />
                    </Show>

                    {/* 文本文件查看器 */}
                    <Show when={currentFileType() === "text"}>
                        <TextViewer
                            filePath={currentFilePath}
                            fileName={currentFileName}
                        />
                    </Show>

                    {/* 未来可添加 Word 查看器 */}
                    {/* <Show when={currentFileType() === "word"}>
                        <WordViewer
                            filePath={currentFilePath}
                            fileName={currentFileName}
                        />
                    </Show> */}
                </Show>
            </Show>
        </div>
    )
}
