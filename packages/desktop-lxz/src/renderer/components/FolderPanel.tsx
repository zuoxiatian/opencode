import { createSignal, For, Show, onMount, createEffect } from "solid-js"
import { useSDK } from "../context/sdk"

interface FileItem {
    name: string
    path: string
    isDirectory: boolean
}

export function FolderPanel() {
    const sdk = useSDK()
    const [recentFolders, setRecentFolders] = createSignal<string[]>([])
    const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null)
    const [files, setFiles] = createSignal<FileItem[]>([])
    const [isLoadingFiles, setIsLoadingFiles] = createSignal(false)
    const [expandedFolders, setExpandedFolders] = createSignal<Set<string>>(new Set<string>())

    onMount(() => {
        // 从 localStorage 加载最近使用的文件夹
        const saved = localStorage.getItem("recent_folders")
        if (saved) {
            try {
                setRecentFolders(JSON.parse(saved))
            } catch (e) {
                console.error("无法解析最近文件夹:", e)
            }
        }
    })

    // 当选择文件夹时加载文件列表
    createEffect(() => {
        const folder = selectedFolder()
        if (folder) {
            loadFiles(folder)
        } else {
            setFiles([])
        }
    })

    const loadFiles = async (folder: string) => {
        setIsLoadingFiles(true)
        try {
            const fileList = await window.electronAPI.readDirectory(folder)
            // 只保留文件，排除文件夹，按名称排序
            const filesOnly = fileList
                .filter((f: FileItem) => !f.isDirectory)
                .sort((a: FileItem, b: FileItem) => a.name.localeCompare(b.name))
            setFiles(filesOnly)
        } catch (error) {
            console.error("加载文件列表失败:", error)
            setFiles([])
        } finally {
            setIsLoadingFiles(false)
        }
    }

    const handleOpenFolder = async () => {
        const folder = await window.electronAPI.pickDirectory()
        if (folder) {
            selectFolder(folder)
        }
    }

    const selectFolder = (folder: string) => {
        setSelectedFolder(folder)
        sdk.setDirectory(folder)
        setExpandedFolders(new Set<string>())

        // 更新最近使用的文件夹列表
        const recent = recentFolders().filter((f) => f !== folder)
        const updated = [folder, ...recent].slice(0, 10)
        setRecentFolders(updated)
        localStorage.setItem("recent_folders", JSON.stringify(updated))
    }

    const getFolderName = (path: string) => {
        return path.split(/[/\\]/).pop() || path
    }

    const getFileIcon = (file: FileItem) => {
        if (file.isDirectory) return "📁"
        const ext = file.name.split(".").pop()?.toLowerCase() || ""
        const icons: Record<string, string> = {
            pdf: "📕",
            doc: "📘", docx: "📘",
            xls: "📗", xlsx: "📗",
            ppt: "📙", pptx: "📙",
            jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️",
            mp3: "🎵", wav: "🎵", flac: "🎵",
            mp4: "🎬", mov: "🎬", avi: "🎬",
            zip: "📦", rar: "📦", "7z": "📦",
            js: "📜", ts: "📜", tsx: "📜", jsx: "📜",
            py: "🐍",
            json: "📋",
            md: "📝",
            txt: "📄",
            html: "🌐", css: "🎨",
        }
        return icons[ext] || "📄"
    }

    const toggleFolder = (path: string) => {
        const expanded = new Set(expandedFolders())
        if (expanded.has(path)) {
            expanded.delete(path)
        } else {
            expanded.add(path)
        }
        setExpandedFolders(expanded)
    }

    const handleFileClick = (file: FileItem) => {
        if (file.isDirectory) {
            toggleFolder(file.path)
        } else {
            // 选择文件
            sdk.setSelectedFile(file)
        }
    }

    return (
        <div class="folder-panel">
            <div class="folder-panel-header">
                <div class="folder-panel-title">项目目录</div>
                <button class="btn btn-primary" onClick={handleOpenFolder}>
                    <span>📁</span>
                    <span>打开文件夹</span>
                </button>
            </div>

            <div class="folder-panel-content">
                <Show when={selectedFolder()}>
                    <div class="folder-panel-title" style={{ "margin-top": "16px" }}>
                        当前项目
                    </div>
                    <div class={`folder-item active`}>
                        <span class="folder-item-icon">📂</span>
                        <span class="folder-item-name">{getFolderName(selectedFolder()!)}</span>
                    </div>

                    {/* 文件列表 */}
                    <div class="folder-panel-title" style={{ "margin-top": "16px" }}>
                        文件列表
                    </div>
                    <Show when={isLoadingFiles()}>
                        <div style={{ color: "var(--text-tertiary)", padding: "8px 0" }}>
                            加载中...
                        </div>
                    </Show>
                    <Show when={!isLoadingFiles() && files().length > 0}>
                        <div class="file-list">
                            <For each={files()}>
                                {(file) => (
                                    <div
                                        class={`file-item ${sdk.selectedFile()?.path === file.path ? "active" : ""}`}
                                        onClick={() => handleFileClick(file)}
                                        title={file.path}
                                    >
                                        <span class="file-item-icon">{getFileIcon(file)}</span>
                                        <span class="file-item-name">{file.name}</span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                    <Show when={!isLoadingFiles() && files().length === 0}>
                        <div style={{ color: "var(--text-tertiary)", padding: "8px 0", "font-size": "12px" }}>
                            文件夹为空
                        </div>
                    </Show>
                </Show>

                <Show when={!selectedFolder()}>
                    <Show when={recentFolders().length > 0}>
                        <div class="folder-panel-title" style={{ "margin-top": "24px" }}>
                            最近项目
                        </div>
                        <For each={recentFolders()}>
                            {(folder) => (
                                <div
                                    class={`folder-item ${folder === selectedFolder() ? "active" : ""}`}
                                    onClick={() => selectFolder(folder)}
                                    title={folder}
                                >
                                    <span class="folder-item-icon">📁</span>
                                    <span class="folder-item-name">{getFolderName(folder)}</span>
                                </div>
                            )}
                        </For>
                    </Show>

                    <Show when={recentFolders().length === 0}>
                        <div style={{ color: "var(--text-tertiary)", "text-align": "center", padding: "48px 16px" }}>
                            <p>还没有打开任何项目</p>
                            <p style={{ "margin-top": "8px", "font-size": "12px" }}>点击上方按钮选择一个项目文件夹</p>
                        </div>
                    </Show>
                </Show>
            </div>
        </div>
    )
}
