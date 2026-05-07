import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "../context/sdk"

interface FileItem {
    name: string
    path: string
    isDirectory: boolean
}

const RECENT_FOLDERS_KEY = "recent_folders"

export function FolderPanel() {
    const sdk = useSDK()
    const [recentFolders, setRecentFolders] = createSignal<string[]>([])
    const [files, setFiles] = createSignal<FileItem[]>([])
    const [sessions, setSessions] = createSignal<Session[]>([])
    const [isLoadingFiles, setIsLoadingFiles] = createSignal(false)
    const [isLoadingSessions, setIsLoadingSessions] = createSignal(false)
    const [showFiles, setShowFiles] = createSignal(false)

    onMount(() => {
        const saved = localStorage.getItem(RECENT_FOLDERS_KEY)
        if (!saved) return
        try {
            setRecentFolders(JSON.parse(saved))
        } catch (error) {
            console.error("无法解析最近文件夹:", error)
        }
    })

    createEffect(() => {
        const folder = sdk.directory()
        if (!folder) {
            setFiles([])
            setSessions([])
            return
        }
        void loadFiles(folder)
    })

    createEffect(() => {
        const folder = sdk.directory()
        sdk.sessionListVersion()
        if (!folder) {
            setSessions([])
            return
        }
        void loadSessions(folder)
    })

    const loadFiles = async (folder: string) => {
        setIsLoadingFiles(true)
        try {
            setFiles((await window.electronAPI.readDirectory(folder))
                .filter((file: FileItem) => !file.isDirectory)
                .sort((a: FileItem, b: FileItem) => a.name.localeCompare(b.name)))
        } catch (error) {
            console.error("加载文件列表失败:", error)
            setFiles([])
        } finally {
            setIsLoadingFiles(false)
        }
    }

    const loadSessions = async (folder: string) => {
        setIsLoadingSessions(true)
        try {
            setSessions((await sdk.client.session.list({
                directory: folder,
                roots: true,
                limit: 50,
            }, { throwOnError: true })).data)
        } catch (error) {
            console.error("加载对话记录失败:", error)
            setSessions([])
        } finally {
            setIsLoadingSessions(false)
        }
    }

    const handleOpenFolder = async () => {
        const folder = await window.electronAPI.pickDirectory()
        if (folder) selectFolder(folder)
    }

    const selectFolder = (folder: string) => {
        sdk.setDirectory(folder)
        setShowFiles(false)
        setRecentFolders([folder, ...recentFolders().filter((item) => item !== folder)].slice(0, 10))
        localStorage.setItem(
            RECENT_FOLDERS_KEY,
            JSON.stringify([folder, ...recentFolders().filter((item) => item !== folder)].slice(0, 10)),
        )
    }

    const getFolderName = (folder: string) => folder.split(/[/\\]/).pop() || folder

    const formatRelativeTime = (time: number) => {
        const diff = Date.now() - time
        if (diff < 60_000) return "刚刚"
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分`
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`
        if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天`
        return `${Math.floor(diff / 604_800_000)} 周`
    }

    const getSessionTitle = (session: Session) => {
        if (!session.title.startsWith("New session - ")) return session.title
        return "新对话"
    }

    const getFileIcon = (file: FileItem) => {
        if (file.isDirectory) return "📁"
        const ext = file.name.split(".").pop()?.toLowerCase() || ""
        const icons: Record<string, string> = {
            pdf: "📕",
            doc: "📄", docx: "📄",
            xls: "📊", xlsx: "📊",
            ppt: "📽️", pptx: "📽️",
            jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️",
            js: "JS", ts: "TS", tsx: "TS", jsx: "JS",
            json: "{}",
            md: "MD",
            txt: "TXT",
            html: "HTML", css: "CSS",
        }
        return icons[ext] || "📄"
    }

    const handleFileClick = (file: FileItem) => {
        sdk.setSelectedFile(file)
    }

    return (
        <div class="folder-panel">
            <div class="folder-panel-header">
                <button class="folder-open-button" onClick={handleOpenFolder} title="打开文件夹">
                    <span>📁</span>
                    <span>打开文件夹</span>
                </button>
            </div>

            <div class="folder-panel-content folder-history-layout">
                <Show
                    when={recentFolders().length > 0}
                    fallback={
                        <div class="empty-state">
                            <div class="empty-state-title">还没有打开任何文件夹</div>
                            <div class="empty-state-subtitle">选择一个文件夹后，对话会按文件夹保存。</div>
                        </div>
                    }
                >
                    <div class="folder-history-section">
                        <For each={recentFolders()}>
                            {(folder) => (
                                <button
                                    class={`history-folder-item ${folder === sdk.directory() ? "active" : ""}`}
                                    onClick={() => selectFolder(folder)}
                                    title={folder}
                                >
                                    <span class="history-folder-icon">📁</span>
                                    <span class="history-folder-name">{getFolderName(folder)}</span>
                                </button>
                            )}
                        </For>
                    </div>
                </Show>

                <Show when={sdk.directory()}>
                    <div class="conversation-section">
                        <div class="conversation-list">
                            <Show when={isLoadingSessions()}>
                                <div class="conversation-empty">加载对话记录...</div>
                            </Show>
                            <Show when={!isLoadingSessions() && sessions().length === 0}>
                                <div class="conversation-empty">当前文件夹还没有对话</div>
                            </Show>
                            <For each={sessions()}>
                                {(session) => (
                                    <button
                                        class={`conversation-item ${sdk.selectedSession()?.id === session.id ? "active" : ""}`}
                                        onClick={() => sdk.setSelectedSession(session)}
                                        title={session.title}
                                    >
                                        <span class="conversation-title">{getSessionTitle(session)}</span>
                                        <span class="conversation-time">{formatRelativeTime(session.time.updated)}</span>
                                    </button>
                                )}
                            </For>
                        </div>

                        <button class="file-toggle" onClick={() => setShowFiles(!showFiles())}>
                            <span>{showFiles() ? "▾" : "▸"}</span>
                            <span>文件预览</span>
                        </button>
                        <Show when={showFiles()}>
                            <Show when={isLoadingFiles()}>
                                <div class="conversation-empty">加载文件...</div>
                            </Show>
                            <Show when={!isLoadingFiles() && files().length > 0}>
                                <div class="file-list compact">
                                    <For each={files()}>
                                        {(file) => (
                                            <button
                                                class={`file-item ${sdk.selectedFile()?.path === file.path ? "active" : ""}`}
                                                onClick={() => handleFileClick(file)}
                                                title={file.path}
                                            >
                                                <span class="file-item-icon">{getFileIcon(file)}</span>
                                                <span class="file-item-name">{file.name}</span>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </Show>
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    )
}
