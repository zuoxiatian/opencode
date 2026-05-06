import { createSignal, createEffect, Show, Accessor } from "solid-js"
import { useSDK } from "../../context/sdk"

interface TextViewerProps {
    filePath: Accessor<string>
    fileName: Accessor<string>
}

export function TextViewer(props: TextViewerProps) {
    const sdk = useSDK()
    const [content, setContent] = createSignal<string>("")
    const [isLoading, setIsLoading] = createSignal(false)
    const [error, setError] = createSignal<string | null>(null)

    createEffect(async () => {
        const path = props.filePath()
        if (path && isTextFile(path)) {
            setIsLoading(true)
            setError(null)
            try {
                if (window.electronAPI) {
                    const result = await window.electronAPI.readFile(path)
                    if (result.success) {
                        setContent(result.content || "")
                    } else {
                        throw new Error(result.error || "读取文件失败")
                    }
                } else {
                    const response = await fetch(`file://${path}`)
                    const text = await response.text()
                    setContent(text)
                }
            } catch (err: any) {
                console.error("加载文本失败:", err)
                setError(`加载文本失败: ${err.message}`)
            } finally {
                setIsLoading(false)
            }
        }
    })

    return (
        <div class="text-viewer" style={{
            height: "100%",
            width: "100%",
            overflow: "auto",
            padding: "20px",
            background: "var(--bg-primary)",
            color: "var(--text-primary)",
            "font-family": "monospace",
            "white-space": "pre-wrap"
        }}>
            <Show when={isLoading()}>
                <div style={{ display: "flex", "justify-content": "center", "margin-top": "40px" }}>
                    正在加载...
                </div>
            </Show>
            <Show when={error()}>
                <div style={{ color: "var(--error)", "margin-top": "40px" }}>
                    {error()}
                </div>
            </Show>
            <Show when={!isLoading() && !error()}>
                {content()}
            </Show>
        </div>
    )
}

export function isTextFile(filename: string): boolean {
    const textExtensions = [".txt", ".md", ".json", ".js", ".ts", ".tsx", ".css", ".html"]
    return textExtensions.some(ext => filename.toLowerCase().endsWith(ext))
}
