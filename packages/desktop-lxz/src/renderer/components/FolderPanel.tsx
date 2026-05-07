import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "../context/sdk"

interface FileItem {
    name: string
    path: string
    isDirectory: boolean
}

const RECENT_FOLDERS_KEY = "recent_folders"

function isDefaultSessionTitle(title?: string) {
    const value = title?.trim()
    return value === "新对话" || /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(value ?? "")
}

export function FolderPanel() {
    const sdk = useSDK()
    const [recentFolders, setRecentFolders] = createSignal<string[]>([])
    const [files, setFiles] = createSignal<FileItem[]>([])
    const [sessionsByFolder, setSessionsByFolder] = createSignal<Record<string, Session[]>>({})
    const [isLoadingFiles, setIsLoadingFiles] = createSignal(false)
    const [loadingFolders, setLoadingFolders] = createSignal<Set<string>>(new Set())
    const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(new Set())
    const [expandedSessionFolders, setExpandedSessionFolders] = createSignal<Set<string>>(new Set())
    const [showFiles, setShowFiles] = createSignal(false)
    let unsubscribe: (() => void) | undefined

    onMount(() => {
        const saved = localStorage.getItem(RECENT_FOLDERS_KEY)
        if (saved) {
            try {
                setRecentFolders(JSON.parse(saved))
            } catch (error) {
                console.error("无法解析最近文件夹:", error)
            }
        }
        unsubscribe = sdk.subscribeToEvents((event) => {
            if (event.type === "session.created" || event.type === "session.updated") {
                applySessionUpdate(event.properties.sessionID, event.properties.info as Partial<Session>)
            }
        })
    })

    onCleanup(() => {
        unsubscribe?.()
    })

    createEffect(() => {
        const folder = sdk.directory()
        if (!folder) {
            setFiles([])
            return
        }
        void loadFiles(folder)
    })

    createEffect(() => {
        sdk.sessionListVersion()
        void Promise.all(recentFolders().map(loadSessions))
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
        setLoadingFolders((prev) => new Set(prev).add(folder))
        try {
            const result = await sdk.client.session.list({
                directory: folder,
                roots: true,
                limit: 50,
            }, { throwOnError: true })
            setSessionsByFolder((prev) => ({ ...prev, [folder]: result.data }))
        } catch (error) {
            console.error("加载对话记录失败:", error)
            setSessionsByFolder((prev) => ({ ...prev, [folder]: [] }))
        } finally {
            setLoadingFolders((prev) => new Set([...prev].filter((item) => item !== folder)))
        }
    }

    const handleOpenFolder = async () => {
        const folder = await window.electronAPI.pickDirectory()
        if (!folder) return
        activateFolder(folder)
        saveRecentFolders([folder, ...recentFolders().filter((item) => item !== folder)].slice(0, 20))
    }

    const activateFolder = (folder: string) => {
        sdk.setDirectory(folder)
        setShowFiles(false)
        void loadSessions(folder)
    }

    const saveRecentFolders = (folders: string[]) => {
        setRecentFolders(folders)
        localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
    }

    const createSessionForFolder = async (folder: string, event: MouseEvent) => {
        event.stopPropagation()
        try {
            const result = await sdk.client.session.create({ directory: folder }, { throwOnError: true })
            activateFolder(folder)
            sdk.setSelectedSession(result.data)
            setSessionsByFolder((prev) => ({ ...prev, [folder]: [result.data, ...(prev[folder] ?? [])] }))
            sdk.refreshSessionList()
        } catch (error) {
            console.error("创建会话失败:", error)
        }
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
        if (!isDefaultSessionTitle(session.title)) return session.title
        return "新对话"
    }

    const mergeSessionInfo = (session: Session, info: Partial<Session>): Session => ({
        ...session,
        ...info,
        id: session.id,
        time: {
            ...session.time,
            ...info.time,
        },
    })

    const isCompleteSessionInfo = (info: Partial<Session>): info is Session => {
        return Boolean(info.id && info.slug && info.projectID && info.directory && info.title && info.version && info.time)
    }

    const applySessionUpdate = (sessionID: string, info: Partial<Session>) => {
        const selected = sdk.selectedSession()
        if (selected?.id === sessionID) {
            sdk.setSelectedSession(mergeSessionInfo(selected, info))
        }
        setSessionsByFolder((prev) => {
            const folder = info.directory ?? Object.entries(prev).find((entry) => entry[1].some((session) => session.id === sessionID))?.[0]
            if (!folder) return prev
            const list = prev[folder] ?? []
            const index = list.findIndex((session) => session.id === sessionID)
            if (index === -1) {
                const session = { ...info, id: sessionID }
                if (!isCompleteSessionInfo(session)) return prev
                return {
                    ...prev,
                    [folder]: [session, ...list].sort((a, b) => b.time.updated - a.time.updated),
                }
            }
            return {
                ...prev,
                [folder]: list
                    .map((session) => session.id === sessionID ? mergeSessionInfo(session, info) : session)
                    .sort((a, b) => b.time.updated - a.time.updated),
            }
        })
    }

    const visibleSessions = (folder: string) => {
        const list = sessionsByFolder()[folder] ?? []
        if (expandedSessionFolders().has(folder)) return list
        return list.slice(0, 5)
    }

    const isFolderExpanded = (folder: string) => !collapsedFolders().has(folder)

    const toggleFolder = (folder: string) => {
        activateFolder(folder)
        const next = new Set(collapsedFolders())
        if (next.has(folder)) {
            next.delete(folder)
        } else {
            next.add(folder)
        }
        setCollapsedFolders(next)
    }

    const toggleSessionLimit = (folder: string) => {
        const next = new Set(expandedSessionFolders())
        if (next.has(folder)) {
            next.delete(folder)
        } else {
            next.add(folder)
        }
        setExpandedSessionFolders(next)
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

            <div class="folder-panel-content project-history-layout">
                <Show
                    when={recentFolders().length > 0}
                    fallback={
                        <div class="empty-state">
                            <div class="empty-state-title">还没有打开任何文件夹</div>
                            <div class="empty-state-subtitle">选择一个文件夹后，对话会按文件夹保存。</div>
                        </div>
                    }
                >
                    <div class="project-section-title">项目</div>
                    <div class="project-list">
                        <For each={recentFolders()}>
                            {(folder) => (
                                <div class="project-group">
                                    <div
                                        class={`project-folder-row ${folder === sdk.directory() ? "active" : ""}`}
                                        onClick={() => toggleFolder(folder)}
                                        title={folder}
                                    >
                                        <span class="project-folder-icon">{isFolderExpanded(folder) ? "▾" : "▸"}</span>
                                        <span class="project-folder-mark" aria-hidden="true"></span>
                                        <span class="project-folder-name">{getFolderName(folder)}</span>
                                        <button
                                            class="project-new-session"
                                            onClick={(event) => createSessionForFolder(folder, event)}
                                            title="新建会话"
                                        >
                                            ⊕
                                        </button>
                                    </div>

                                    <Show when={isFolderExpanded(folder)}>
                                        <div class="project-conversation-list">
                                            <Show when={loadingFolders().has(folder)}>
                                                <div class="project-conversation-empty">加载中...</div>
                                            </Show>
                                            <Show when={!loadingFolders().has(folder) && (sessionsByFolder()[folder]?.length ?? 0) === 0}>
                                                <div class="project-conversation-empty">暂无对话</div>
                                            </Show>
                                            <For each={visibleSessions(folder)}>
                                                {(session) => (
                                                    <button
                                                        class={`project-conversation-item ${sdk.selectedSession()?.id === session.id ? "active" : ""}`}
                                                        onClick={() => { activateFolder(folder); sdk.setSelectedSession(session) }}
                                                        title={session.title}
                                                    >
                                                        <span class="project-conversation-title">{getSessionTitle(session)}</span>
                                                        <span class="project-conversation-time">{formatRelativeTime(session.time.updated)}</span>
                                                    </button>
                                                )}
                                            </For>
                                            <Show when={(sessionsByFolder()[folder]?.length ?? 0) > 5}>
                                                <button class="project-expand" onClick={() => toggleSessionLimit(folder)}>
                                                    {expandedSessionFolders().has(folder) ? "收起" : "展开显示"}
                                                </button>
                                            </Show>
                                        </div>
                                    </Show>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>

                <Show when={sdk.directory()}>
                    <div class="file-preview-section">
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
