import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Project, Session } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "../context/sdk"

interface FileItem {
    name: string
    path: string
    isDirectory: boolean
}

function isDefaultSessionTitle(title?: string) {
    const value = title?.trim()
    return value === "新对话" || /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(value ?? "")
}

export function FolderPanel() {
    const sdk = useSDK()
    const [projects, setProjects] = createSignal<Project[]>([])
    const [files, setFiles] = createSignal<FileItem[]>([])
    const [sessionsByFolder, setSessionsByFolder] = createSignal<Record<string, Session[]>>({})
    const [isLoadingFiles, setIsLoadingFiles] = createSignal(false)
    const [loadingFolders, setLoadingFolders] = createSignal<Set<string>>(new Set())
    const [deletingProjects, setDeletingProjects] = createSignal<Set<string>>(new Set())
    const [deletingSessions, setDeletingSessions] = createSignal<Set<string>>(new Set())
    const [renamingSessions, setRenamingSessions] = createSignal<Set<string>>(new Set())
    const [editingSessionID, setEditingSessionID] = createSignal<string | null>(null)
    const [editingSessionTitle, setEditingSessionTitle] = createSignal("")
    const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(new Set())
    const [expandedSessionFolders, setExpandedSessionFolders] = createSignal<Set<string>>(new Set())
    const [showFiles, setShowFiles] = createSignal(false)
    const [lastSelectedFilePath, setLastSelectedFilePath] = createSignal<string | null>(null)
    let unsubscribe: (() => void) | undefined

    const projectFolders = () => projects().map((project) => project.worktree)

    const projectActivityTime = (project: Project) =>
        Math.max(project.time.updated, ...(sessionsByFolder()[project.worktree] ?? []).map((session) => session.time.updated))

    const sortedProjects = () =>
        projects()
            .toSorted((a, b) => {
                const diff = projectActivityTime(b) - projectActivityTime(a)
                if (diff !== 0) return diff
                return getFolderName(a.worktree).localeCompare(getFolderName(b.worktree))
            })

    const sortedProjectFolders = () => sortedProjects().map((project) => project.worktree)

    const loadProjects = async () => {
        try {
            const result = await sdk.client.project.list(undefined, { throwOnError: true })
            const listed = (result.data ?? [])
                .filter((project) => Boolean(project.worktree))
                .sort((a, b) => b.time.updated - a.time.updated)

            setProjects(listed)
            setCollapsedFolders((prev) => new Set(listed.map((project) => project.worktree).filter((folder) => prev.has(folder))))
        } catch (error) {
            console.error("加载项目列表失败:", error)
            setProjects([])
        }
    }

    onMount(() => {
        void loadProjects()
        unsubscribe = sdk.subscribeToEvents((event) => {
            if (event.type === "session.created" || event.type === "session.updated") {
                applySessionUpdate(event.properties.sessionID, event.properties.info as Partial<Session>)
                void loadProjects()
            }
            if (event.type === "session.deleted") {
                const properties = event.properties as { sessionID?: string; info?: Partial<Session> }
                const sessionID = properties.sessionID ?? properties.info?.id
                if (!sessionID) return
                removeSession(sessionID)
                setDeletingSessions((prev) => new Set([...prev].filter((item) => item !== sessionID)))
                void loadProjects()
            }
            if (event.type === "project.deleted") {
                const project = event.properties as Project
                removeProject(project)
                setDeletingProjects((prev) => new Set([...prev].filter((item) => item !== project.id)))
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
        void Promise.all(projectFolders().map(loadSessions))
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
        setCollapsedFolders((prev) => new Set(prev).add(folder))
        activateFolder(folder)
        await sdk.client.project.list(undefined, {
            headers: {
                "x-opencode-directory": encodeURIComponent(folder),
            },
            throwOnError: true,
        })
        void loadProjects()
    }

    const activateFolder = (folder: string) => {
        sdk.setDirectory(folder)
        setShowFiles(false)
        void loadSessions(folder)
    }

    const clearProjectState = (project: Project) => {
        setProjects((prev) => prev.filter((item) => item.id !== project.id))
        setSessionsByFolder((prev) => Object.fromEntries(Object.entries(prev).filter((entry) => entry[0] !== project.worktree)))
        setCollapsedFolders((prev) => new Set([...prev].filter((folder) => folder !== project.worktree)))
        setExpandedSessionFolders((prev) => new Set([...prev].filter((folder) => folder !== project.worktree)))
        if (sdk.directory() !== project.worktree) return
        sdk.setDirectory("")
        sdk.setSelectedSession(null)
        setFiles([])
        setShowFiles(false)
    }

    const removeProject = (project: Project) => {
        clearProjectState(project)
        sdk.refreshSessionList()
    }

    const createSessionForFolder = async (folder: string, event: MouseEvent) => {
        event.stopPropagation()
        try {
            const result = await sdk.client.session.create({ directory: folder }, { throwOnError: true })
            activateFolder(folder)
            sdk.setSelectedSession(result.data)
            setSessionsByFolder((prev) => ({ ...prev, [folder]: [result.data, ...(prev[folder] ?? [])] }))
            sdk.refreshSessionList()
            void loadProjects()
        } catch (error) {
            console.error("创建会话失败:", error)
        }
    }

    const removeSession = (sessionID: string) => {
        setSessionsByFolder((prev) => Object.fromEntries(
            Object.entries(prev).map((entry) => [entry[0], entry[1].filter((session) => session.id !== sessionID)]),
        ))
    }

    const updateSession = (folder: string, next: Session) => {
        setSessionsByFolder((prev) => ({
            ...prev,
            [folder]: (prev[folder] ?? [])
                .map((session) => session.id === next.id ? next : session)
                .sort((a, b) => b.time.updated - a.time.updated),
        }))
        if (sdk.selectedSession()?.id === next.id) {
            sdk.setSelectedSession(next)
        }
    }

    const selectSession = (folder: string, session: Session) => {
        activateFolder(folder)
        sdk.setSelectedSession(session)
    }

    const deleteProject = async (project: Project, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (deletingProjects().has(project.id)) return
        setDeletingProjects((prev) => new Set(prev).add(project.id))
        try {
            await sdk.client.project.delete({ projectID: project.id, directory: project.worktree }, { throwOnError: true })
            removeProject(project)
            void loadProjects()
        } catch (error) {
            console.error("删除项目失败:", error)
        } finally {
            setDeletingProjects((prev) => new Set([...prev].filter((item) => item !== project.id)))
        }
    }

    const deleteSession = async (folder: string, session: Session, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (deletingSessions().has(session.id)) return
        setDeletingSessions((prev) => new Set(prev).add(session.id))
        try {
            await sdk.client.session.delete({ sessionID: session.id, directory: folder }, { throwOnError: true })
            removeSession(session.id)
            if (sdk.selectedSession()?.id === session.id) {
                sdk.setSelectedSession(null)
            }
            sdk.refreshSessionList()
            void loadProjects()
        } catch (error) {
            console.error("鍒犻櫎浼氳瘽澶辫触:", error)
        } finally {
            setDeletingSessions((prev) => new Set([...prev].filter((item) => item !== session.id)))
        }
    }

    const startRenameSession = (session: Session, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (renamingSessions().has(session.id)) return
        setEditingSessionID(session.id)
        setEditingSessionTitle(getSessionTitle(session))
    }

    const cancelRenameSession = () => {
        setEditingSessionID(null)
        setEditingSessionTitle("")
    }

    const commitRenameSession = async (folder: string, session: Session) => {
        const title = editingSessionTitle().trim()
        cancelRenameSession()
        if (!title || title === session.title) return
        setRenamingSessions((prev) => new Set(prev).add(session.id))
        try {
            const result = await sdk.client.session.update({
                sessionID: session.id,
                directory: folder,
                title,
            }, { throwOnError: true })
            updateSession(folder, result.data)
            sdk.refreshSessionList()
            void loadProjects()
        } catch (error) {
            console.error("修改会话名称失败:", error)
        } finally {
            setRenamingSessions((prev) => new Set([...prev].filter((item) => item !== session.id)))
        }
    }

    const handleRenameKeyDown = (folder: string, session: Session, event: KeyboardEvent) => {
        event.stopPropagation()
        if (event.key === "Escape") {
            event.preventDefault()
            cancelRenameSession()
            return
        }
        if (event.key !== "Enter") return
        event.preventDefault()
        void commitRenameSession(folder, session)
    }

    const handleSessionKeyDown = (folder: string, session: Session, event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        selectSession(folder, session)
    }

    const getFolderName = (folder: string) => folder.split(/[/\\]/).pop() || folder

    const formatRelativeTime = (time: number) => {
        const diff = Date.now() - time
        if (diff < 60_000) return "刚刚"
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`
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

    const isSelectedFile = (file: FileItem) => sdk.selectedFiles().some((selected) => selected.path === file.path)

    const selectFileRange = (file: FileItem) => {
        const start = files().findIndex((item) => item.path === lastSelectedFilePath())
        const end = files().findIndex((item) => item.path === file.path)
        if (start === -1 || end === -1) return [file]
        const [from, to] = start < end ? [start, end] : [end, start]
        return files().slice(from, to + 1)
    }

    const handleFileClick = (file: FileItem, event: MouseEvent) => {
        if (event.shiftKey) {
            sdk.setSelectedFile(file)
            const range = selectFileRange(file)
            sdk.setSelectedFiles((selected) => {
                const paths = new Set(selected.map((item) => item.path))
                return [...selected, ...range.filter((item) => !paths.has(item.path))]
            })
            setLastSelectedFilePath(file.path)
            return
        }
        if (event.ctrlKey || event.metaKey) {
            sdk.setSelectedFile(file)
            sdk.setSelectedFiles((selected) =>
                selected.some((item) => item.path === file.path)
                    ? selected.filter((item) => item.path !== file.path)
                    : [...selected, file],
            )
            setLastSelectedFilePath(file.path)
            return
        }
        if (sdk.selectedFiles().length === 1 && sdk.selectedFiles()[0].path === file.path) {
            sdk.setSelectedFile(null)
            sdk.setSelectedFiles([])
            setLastSelectedFilePath(null)
            return
        }
        sdk.setSelectedFile(file)
        sdk.setSelectedFiles([file])
        setLastSelectedFilePath(file.path)
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
                    when={sortedProjectFolders().length > 0}
                    fallback={
                        <div class="empty-state">
                            <div class="empty-state-title">还没有打开任何文件夹</div>
                            <div class="empty-state-subtitle">选择一个文件夹后，对话会按文件夹保存。</div>
                        </div>
                    }
                >
                    <div class="project-section-title">项目</div>
                    <div class="project-list">
                        <For each={sortedProjects()}>
                            {(project) => {
                                const folder = project.worktree
                                return (
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
                                                class="project-row-action project-new-session"
                                                onClick={(event) => createSessionForFolder(folder, event)}
                                                title="新建会话"
                                                aria-label="新建会话"
                                            ></button>
                                            <button
                                                type="button"
                                                class="project-row-action project-delete"
                                                disabled={deletingProjects().has(project.id)}
                                                onClick={(event) => deleteProject(project, event)}
                                                title="删除项目"
                                                aria-label="删除项目"
                                            ></button>
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
                                                    <div
                                                        role="button"
                                                        tabIndex={0}
                                                        class={`project-conversation-item ${sdk.selectedSession()?.id === session.id ? "active" : ""}`}
                                                        onClick={() => selectSession(folder, session)}
                                                        onKeyDown={(event) => handleSessionKeyDown(folder, session, event)}
                                                        title={session.title}
                                                    >
                                                        <Show
                                                            when={editingSessionID() === session.id}
                                                            fallback={<span class="project-conversation-title">{getSessionTitle(session)}</span>}
                                                        >
                                                            <input
                                                                class="project-conversation-title-input"
                                                                value={editingSessionTitle()}
                                                                onClick={(event) => event.stopPropagation()}
                                                                onInput={(event) => setEditingSessionTitle(event.currentTarget.value)}
                                                                onBlur={() => void commitRenameSession(folder, session)}
                                                                onKeyDown={(event) => handleRenameKeyDown(folder, session, event)}
                                                                ref={(element) => queueMicrotask(() => { element.focus(); element.select(); })}
                                                            />
                                                        </Show>
                                                        <span class="project-conversation-time">{formatRelativeTime(session.time.updated)}</span>
                                                        <button
                                                            type="button"
                                                            class="project-conversation-rename"
                                                            disabled={renamingSessions().has(session.id)}
                                                            onClick={(event) => startRenameSession(session, event)}
                                                            title="修改会话名称"
                                                            aria-label="修改会话名称"
                                                        ></button>
                                                        <button
                                                            type="button"
                                                            class="project-conversation-delete"
                                                            disabled={deletingSessions().has(session.id)}
                                                            onClick={(event) => deleteSession(folder, session, event)}
                                                            title="删除会话"
                                                            aria-label="删除会话"
                                                        ></button>
                                                    </div>
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
                                )
                            }}
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
                                                class={`file-item ${isSelectedFile(file) ? "active" : ""}`}
                                                onClick={(event) => handleFileClick(file, event)}
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
