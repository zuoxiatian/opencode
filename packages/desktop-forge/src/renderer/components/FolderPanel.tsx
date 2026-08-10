import { batch, createEffect, createSignal, For, Index, onCleanup, onMount, Show, untrack } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import type { Project, Session } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "../context/sdk"
import type { LucideIcon } from "lucide-solid"
import ChartColumn from "lucide-solid/icons/chart-column"
import Check from "lucide-solid/icons/check"
import CircleMinus from "lucide-solid/icons/circle-minus"
import CircleQuestionMark from "lucide-solid/icons/circle-question-mark"
import CircleUser from "lucide-solid/icons/circle-user"
import Eye from "lucide-solid/icons/eye"
import EyeOff from "lucide-solid/icons/eye-off"
import FileCode from "lucide-solid/icons/file-code"
import FileIcon from "lucide-solid/icons/file"
import FileAudio from "lucide-solid/icons/file-audio"
import FileSpreadsheet from "lucide-solid/icons/file-spreadsheet"
import FileText from "lucide-solid/icons/file-text"
import FileType from "lucide-solid/icons/file-type"
import FileVideo from "lucide-solid/icons/file-video"
import Folder from "lucide-solid/icons/folder"
import FolderOpen from "lucide-solid/icons/folder-open"
import Globe from "lucide-solid/icons/globe"
import Image from "lucide-solid/icons/image"
import Info from "lucide-solid/icons/info"
import Brain from "lucide-solid/icons/brain"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Lock from "lucide-solid/icons/lock"
import LogOut from "lucide-solid/icons/log-out"
import MessageCircle from "lucide-solid/icons/message-circle"
import Monitor from "lucide-solid/icons/monitor"
import Moon from "lucide-solid/icons/moon"
import Palette from "lucide-solid/icons/palette"
import PanelLeft from "lucide-solid/icons/panel-left"
import PencilLine from "lucide-solid/icons/pencil-line"
import Presentation from "lucide-solid/icons/presentation"
import Puzzle from "lucide-solid/icons/puzzle"
import RefreshCw from "lucide-solid/icons/refresh-cw"
import Settings from "lucide-solid/icons/settings"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import SquarePen from "lucide-solid/icons/square-pen"
import Sun from "lucide-solid/icons/sun"
import Trash2 from "lucide-solid/icons/trash-2"
import Wrench from "lucide-solid/icons/wrench"
import X from "lucide-solid/icons/x"
import type { ThemeMode } from "../theme"
import type { ClientAuthSession } from "../auth"
import type { ChatVisibilitySettings, LinkOpenMode } from "../settings"
import type { ClientAppInfo } from "../../shared/client-update"
import { CLIENT_UPDATE_CHANNEL } from "../config"
import { changeClientPassword, type ClientPasswordFailureReason } from "../api/client"
import { checkClientUpdate } from "../services/client-update"
import { SkillMarketDialog } from "./SkillMarketDialog"
import appIcon from "../../../build/128x128.png"
import { showDesktopToast } from "../toast"

interface FileItem {
    name: string
    path: string
    isDirectory: boolean
}

type SidebarMenu =
    | { kind: "project"; x: number; y: number; project: Project }
    | { kind: "session"; x: number; y: number; folder: string; session: Session }

type SidebarDialog =
    | { kind: "rename-session"; folder: string; session: Session }
    | { kind: "delete-project"; project: Project }
    | { kind: "delete-session"; folder: string; session: Session }

type SettingsSection = "appearance" | "account" | "chat" | "about"
type PasswordFormState = {
    confirmPassword: string
    currentPassword: string
    newPassword: string
}

interface FolderPanelProps {
    onCollapse: () => void
    opencodeServiceStatus: "checking" | "online" | "offline"
    clientAuthSession: ClientAuthSession
    appMarketEnabled: boolean
    themeMode: ThemeMode
    onThemeModeChange: (mode: ThemeMode) => void
    onLogout: () => void
    chatVisibility: ChatVisibilitySettings
    onChatVisibilityChange: (settings: ChatVisibilitySettings) => void
    linkOpenMode: LinkOpenMode
    onLinkOpenModeChange: (mode: LinkOpenMode) => void
}

const LAST_PROJECT_STORAGE_KEY = "desktop-lxz.lastProjectFolder"
const PROJECT_ADDED_EVENT = "desktop-lxz.project-added"
const SYSTEM_THEME_MODE_OPTION = { mode: "system", label: "系统", icon: Monitor } as const
const THEME_MODE_OPTIONS = [
    SYSTEM_THEME_MODE_OPTION,
    { mode: "light", label: "亮色", icon: Sun },
    { mode: "dark", label: "暗色", icon: Moon },
] as const
const SETTINGS_SECTION_OPTIONS = [
    { section: "appearance", label: "外观", description: "主题与界面", icon: Palette },
    { section: "account", label: "账户", description: "账号安全", icon: CircleUser },
    { section: "chat", label: "聊天", description: "消息显示", icon: MessageCircle },
    { section: "about", label: "关于", description: "版本更新", icon: Info },
] as const

function isDefaultSessionTitle(title?: string) {
    const value = title?.trim()
    return value === "新对话" || /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(value ?? "")
}

function SettingsSwitchRow(props: { icon: LucideIcon; title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <button
            type="button"
            class="settings-option-row"
            role="switch"
            aria-checked={props.checked}
            data-active={props.checked ? "true" : "false"}
            onClick={() => props.onChange(!props.checked)}
        >
            <span class="settings-option-icon" aria-hidden="true">
                <Dynamic component={props.icon} class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />
            </span>
            <span class="settings-option-copy">
                <span class="settings-option-title">{props.title}</span>
                <span class="settings-option-description">{props.description}</span>
            </span>
            <span class="settings-switch-track" aria-hidden="true">
                <span class="settings-switch-thumb" />
            </span>
        </button>
    )
}

function SettingsPasswordField(props: { autocomplete: string; disabled: boolean; label: string; onInput: (value: string) => void; placeholder: string; value: string }) {
    const [visible, setVisible] = createSignal(false)

    return (
        <label class="settings-password-field">
            <span class="settings-password-label">{props.label}</span>
            <span class="settings-password-input-wrap">
                <Lock class="settings-password-input-icon" size={15} strokeWidth={1.9} />
                <input
                    class="settings-password-input"
                    autocomplete={props.autocomplete}
                    disabled={props.disabled}
                    placeholder={props.placeholder}
                    type={visible() ? "text" : "password"}
                    value={props.value}
                    onInput={(event) => props.onInput(event.currentTarget.value)}
                />
                <button
                    type="button"
                    class="settings-password-toggle"
                    disabled={props.disabled}
                    title={visible() ? "隐藏密码" : "显示密码"}
                    aria-label={visible() ? "隐藏密码" : "显示密码"}
                    onClick={() => setVisible(!visible())}
                >
                    <Show
                        when={visible()}
                        fallback={<Eye class="settings-password-toggle-icon" size={16} strokeWidth={1.9} />}
                    >
                        <EyeOff class="settings-password-toggle-icon" size={16} strokeWidth={1.9} />
                    </Show>
                </button>
            </span>
        </label>
    )
}

export function FolderPanel(props: FolderPanelProps) {
    const sdk = useSDK()
    const [projects, setProjects] = createSignal<Project[]>([])
    const [files, setFiles] = createSignal<FileItem[]>([])
    const [sessionsByFolder, setSessionsByFolder] = createSignal<Record<string, Session[]>>({})
    const [isLoadingFiles, setIsLoadingFiles] = createSignal(false)
    const [loadingFolders, setLoadingFolders] = createSignal<Set<string>>(new Set())
    const [deletingProjects, setDeletingProjects] = createSignal<Set<string>>(new Set())
    const [deletingSessions, setDeletingSessions] = createSignal<Set<string>>(new Set())
    const [renamingSessions, setRenamingSessions] = createSignal<Set<string>>(new Set())
    const [renameSessionTitle, setRenameSessionTitle] = createSignal("")
    const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(new Set())
    const [expandedSessionFolders, setExpandedSessionFolders] = createSignal<Set<string>>(new Set())
    const [lastSelectedFilePath, setLastSelectedFilePath] = createSignal<string | null>(null)
    const [unreadSessions, setUnreadSessions] = createSignal<Set<string>>(new Set())
    const [sidebarMenu, setSidebarMenu] = createSignal<SidebarMenu | null>(null)
    const [sidebarDialog] = createSignal<SidebarDialog | null>(null)
    const [nativeSidebarDialog, setNativeSidebarDialog] = createSignal<SidebarDialog | null>(null)
    const [accountMenuPosition, setAccountMenuPosition] = createSignal<{ x: number; bottom: number } | null>(null)
    const [settingsOpen, setSettingsOpen] = createSignal(false)
    const [skillMarketOpen, setSkillMarketOpen] = createSignal(false)
    const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("appearance")
    const [appInfo, setAppInfo] = createSignal<ClientAppInfo | null>(null)
    const [isManualUpdateChecking, setIsManualUpdateChecking] = createSignal(false)
    const [passwordForm, setPasswordForm] = createSignal<PasswordFormState>({
        confirmPassword: "",
        currentPassword: "",
        newPassword: "",
    })
    const [isPasswordFormOpen, setIsPasswordFormOpen] = createSignal(false)
    const [isPasswordSubmitting, setIsPasswordSubmitting] = createSignal(false)
    const sessionLoadFolders = new Set<string>()
    let fileLoadRequest = 0
    let fileRefreshTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined

    const menuPosition = (event: MouseEvent, height: number) => ({
        x: Math.min(event.clientX, window.innerWidth - 176),
        y: Math.min(event.clientY, window.innerHeight - height),
    })

    const closeSidebarMenu = () => setSidebarMenu(null)
    const closeAccountMenu = () => setAccountMenuPosition(null)
    const closeMenus = () => {
        closeSidebarMenu()
        closeAccountMenu()
    }
    const closeMenusFromDocument = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null
        if (target?.closest(".settings-entry-button, .account-menu")) return
        closeMenus()
    }

    const resetPasswordForm = () => {
        setPasswordForm({
            confirmPassword: "",
            currentPassword: "",
            newPassword: "",
        })
    }

    const openSettings = () => {
        closeMenus()
        void window.electronAPI.openOverlay({
            data: {
                chatVisibility: props.chatVisibility,
                clientAuthSession: props.clientAuthSession,
                linkOpenMode: props.linkOpenMode,
                themeMode: props.themeMode,
            },
            kind: "settings",
        })
    }

    const openSkillMarket = () => {
        if (!props.appMarketEnabled) return
        closeMenus()
        void window.electronAPI.openOverlay({
            data: { serverInfo: sdk.serverInfo },
            kind: "skill-market",
        })
    }

    const updateChatVisibility = (changes: Partial<ChatVisibilitySettings>) => {
        props.onChatVisibilityChange({ ...props.chatVisibility, ...changes })
    }

    const closeSidebarDialog = () => {
        setNativeSidebarDialog(null)
        setRenameSessionTitle("")
    }

    const rememberProjectFolder = (folder: string) => {
        localStorage.setItem(LAST_PROJECT_STORAGE_KEY, folder)
    }

    const forgetProjectFolder = (folder: string) => {
        if (localStorage.getItem(LAST_PROJECT_STORAGE_KEY) === folder) localStorage.removeItem(LAST_PROJECT_STORAGE_KEY)
    }

    const openProjectMenu = (project: Project, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        closeAccountMenu()
        setSidebarMenu({ kind: "project", project, ...menuPosition(event, 86) })
    }

    const openSessionMenu = (folder: string, session: Session, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        closeAccountMenu()
        setSidebarMenu({ kind: "session", folder, session, ...menuPosition(event, 86) })
    }

    const openAccountMenu = (event: MouseEvent) => {
        event.stopPropagation()
        closeSidebarMenu()
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        const statusRect = (event.currentTarget as HTMLElement).closest(".folder-panel-status")?.getBoundingClientRect()
        setAccountMenuPosition({
            bottom: Math.max(8, window.innerHeight - (statusRect?.top ?? rect.top)),
            x: Math.max(8, Math.min(rect.left, window.innerWidth - 232)),
        })
    }

    const openRenameSessionDialog = (folder: string, session: Session) => {
        if (renamingSessions().has(session.id)) return
        closeSidebarMenu()
        setRenameSessionTitle(getSessionTitle(session))
        setNativeSidebarDialog({ kind: "rename-session", folder, session })
        void window.electronAPI.openOverlay({
            data: { kind: "rename-session", name: getSessionTitle(session), value: getSessionTitle(session) },
            kind: "sidebar-dialog",
        })
    }

    const openDeleteProjectDialog = (project: Project) => {
        if (deletingProjects().has(project.id)) return
        closeSidebarMenu()
        setNativeSidebarDialog({ kind: "delete-project", project })
        void window.electronAPI.openOverlay({
            data: { kind: "delete-project", name: getFolderName(project.worktree) },
            kind: "sidebar-dialog",
        })
    }

    const openDeleteSessionDialog = (folder: string, session: Session) => {
        if (deletingSessions().has(session.id)) return
        closeSidebarMenu()
        setNativeSidebarDialog({ kind: "delete-session", folder, session })
        void window.electronAPI.openOverlay({
            data: { kind: "delete-session", name: getSessionTitle(session) },
            kind: "sidebar-dialog",
        })
    }

    const openProjectInFileManagerLabel = () => {
        const platform = navigator.platform.toLowerCase()
        if (platform.includes("mac")) return "在访达中打开"
        if (platform.includes("win")) return "在资源管理器中打开"
        return "在文件管理器中打开"
    }

    const markSessionUnread = (sessionID?: string) => {
        if (!sessionID) return
        if (sdk.selectedSession()?.id === sessionID) return
        setUnreadSessions((prev) => new Set(prev).add(sessionID))
    }

    const acknowledgeSession = (sessionID: string) => {
        setUnreadSessions((prev) => {
            if (!prev.has(sessionID)) return prev
            return new Set([...prev].filter((item) => item !== sessionID))
        })
    }

    const projectFolders = () => projects().map((project) => project.worktree)

    const isSameProject = (a: Project, b: Project) =>
        a.id === b.id
        && a.worktree === b.worktree
        && a.time.created === b.time.created
        && a.time.updated === b.time.updated

    const mergeProjectList = (current: Project[], next: Project[]) =>
        [
            ...next,
            ...current.filter((project) => !next.some((item) => item.id === project.id || item.worktree === project.worktree)),
        ].map((project) => {
            const existing = current.find((item) => item.id === project.id || item.worktree === project.worktree)
            return existing && isSameProject(existing, project) ? existing : project
        })

    const syncProjectList = (current: Project[], next: Project[]) =>
        next.map((project) => {
            const existing = current.find((item) => item.id === project.id || item.worktree === project.worktree)
            return existing && isSameProject(existing, project) ? existing : project
        })

    const isSameSession = (a: Session, b: Session) =>
        a.id === b.id
        && a.slug === b.slug
        && a.projectID === b.projectID
        && a.directory === b.directory
        && a.title === b.title
        && a.version === b.version
        && a.time.created === b.time.created
        && a.time.updated === b.time.updated

    const sortSessions = (sessions: Session[]) => sessions.toSorted((a, b) => b.time.updated - a.time.updated)

    const mergeSessionList = (current: Session[] | undefined, next: Session[]) =>
        sortSessions(next.map((session) => {
            const existing = current?.find((item) => item.id === session.id)
            return existing && isSameSession(existing, session) ? existing : session
        }))

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

    const applyProjectUpdate = (project: Project) => {
        setProjects((prev) => mergeProjectList(prev, [project]))
        void loadSessions(project.worktree)
    }

    const loadProjects = async () => {
        try {
            const result = await sdk.client.project.list({ directory: sdk.directory() }, { throwOnError: true })
            const listed = (result.data ?? [])
                .filter((project) => Boolean(project.worktree))
                .sort((a, b) => b.time.updated - a.time.updated)

            setProjects((prev) => syncProjectList(prev, listed))
            setCollapsedFolders((prev) => new Set(listed.map((project) => project.worktree).filter((folder) => prev.has(folder))))
            if (!sdk.directory() && listed.length > 0) {
                activateFolder(
                    (listed.find((project) => project.worktree === localStorage.getItem(LAST_PROJECT_STORAGE_KEY)) ?? listed[0]).worktree,
                    { reloadSessions: true },
                )
            }
        } catch (error) {
            console.error("加载项目列表失败:", error)
        }
    }

    const handleProjectAdded = (event: Event) => {
        const project = (event as CustomEvent<Project>).detail
        if (!project?.worktree) return
        applyProjectUpdate(project)
    }

    createEffect(() => {
        if (props.appMarketEnabled) return
        setSkillMarketOpen(false)
    })

    createEffect(() => {
        sdk.sessionListVersion()
        void loadProjects()
    })

    onMount(() => {
        window.addEventListener(PROJECT_ADDED_EVENT, handleProjectAdded)
        document.addEventListener("click", closeMenusFromDocument)
        document.addEventListener("scroll", closeMenus, true)
        unsubscribe = sdk.subscribeToEvents((event) => {
            if (event.type === "session.created" || event.type === "session.updated") {
                applySessionUpdate(event.properties.sessionID, event.properties.info as Partial<Session>)
                if (event.type === "session.created") void loadProjects()
            }
            if (event.type === "session.status") {
                const properties = event.properties as { sessionID?: string; status?: { type?: string } }
                if (properties.status?.type === "idle") markSessionUnread(properties.sessionID)
            }
            if (event.type === "session.idle") {
                markSessionUnread((event.properties as { sessionID?: string }).sessionID)
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
            if (event.type === "project.updated") {
                const project = event.properties as Project
                if (deletingProjects().has(project.id)) return
                applyProjectUpdate(project)
            }
        })
        const unsubscribeOverlayActions = window.electronAPI.onOverlayAction((action) => {
            if (action.type === "settings.theme-mode") {
                props.onThemeModeChange(action.mode)
                return
            }
            if (action.type === "settings.chat-visibility") {
                props.onChatVisibilityChange(action.settings)
                return
            }
            if (action.type === "settings.link-open-mode") {
                props.onLinkOpenModeChange(action.mode)
                return
            }
            if (action.type === "sidebar-dialog.cancel") {
                closeSidebarDialog()
                return
            }
            if (action.type !== "sidebar-dialog.submit") return
            if (action.value !== undefined) setRenameSessionTitle(action.value)
            void confirmSidebarDialog(action.value)
        })
        onCleanup(unsubscribeOverlayActions)
    })

    createEffect(() => {
        if (!settingsOpen() && !accountMenuPosition()) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            if (isPasswordFormOpen()) {
                event.preventDefault()
                closePasswordForm()
                return
            }
            setSettingsOpen(false)
            closeMenus()
        }
        document.addEventListener("keydown", handleKeyDown)
        onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
    })

    onCleanup(() => {
        window.removeEventListener(PROJECT_ADDED_EVENT, handleProjectAdded)
        document.removeEventListener("click", closeMenusFromDocument)
        document.removeEventListener("scroll", closeMenus, true)
        if (fileRefreshTimer) {
            clearTimeout(fileRefreshTimer)
            fileRefreshTimer = undefined
        }
        unsubscribe?.()
    })

    createEffect(() => {
        const folder = sdk.directory()
        if (!folder) {
            setFiles([])
            return
        }
        void loadFiles(folder)
        const stopWatching = window.electronAPI.watchDirectory(folder, () => {
            if (fileRefreshTimer) clearTimeout(fileRefreshTimer)
            fileRefreshTimer = setTimeout(() => {
                fileRefreshTimer = undefined
                if (sdk.directory() !== folder) return
                void loadFiles(folder, { quiet: true })
            }, 120)
        })
        onCleanup(() => {
            if (fileRefreshTimer) {
                clearTimeout(fileRefreshTimer)
                fileRefreshTimer = undefined
            }
            stopWatching?.()
        })
    })

    createEffect(() => {
        sdk.sessionListVersion()
        const folders = projectFolders()
        untrack(() => void Promise.all(folders.map(loadSessions)))
    })

    const loadFiles = async (folder: string, options: { quiet?: boolean } = {}) => {
        const request = ++fileLoadRequest
        if (!options.quiet) setIsLoadingFiles(true)
        try {
            const nextFiles = (await window.electronAPI.readDirectory(folder))
                .filter((file: FileItem) => !file.isDirectory)
                .sort((a: FileItem, b: FileItem) => a.name.localeCompare(b.name))
            if (request !== fileLoadRequest || sdk.directory() !== folder) return
            const paths = new Set(nextFiles.map((file) => file.path))
            const selectedFiles = sdk.selectedFiles().filter((file) => paths.has(file.path))
            const selectedFile = sdk.selectedFile()
            const lastSelected = lastSelectedFilePath()
            batch(() => {
                setFiles(nextFiles)
                sdk.setSelectedFiles(selectedFiles)
                if (selectedFile && !paths.has(selectedFile.path)) {
                    sdk.setSelectedFile(selectedFiles.at(-1) ?? null)
                }
                if (lastSelected && !paths.has(lastSelected)) {
                    setLastSelectedFilePath(selectedFiles.at(-1)?.path ?? null)
                }
            })
        } catch (error) {
            if (request !== fileLoadRequest || sdk.directory() !== folder) return
            console.error("加载文件列表失败:", error)
            batch(() => {
                setFiles([])
                sdk.setSelectedFile(null)
                sdk.setSelectedFiles([])
                setLastSelectedFilePath(null)
            })
        } finally {
            if (request === fileLoadRequest && sdk.directory() === folder) setIsLoadingFiles(false)
        }
    }

    const loadSessions = async (folder: string) => {
        if (sessionLoadFolders.has(folder)) return
        sessionLoadFolders.add(folder)
        const initialLoad = untrack(() => sessionsByFolder()[folder] === undefined)
        if (initialLoad) setLoadingFolders((prev) => new Set(prev).add(folder))
        try {
            const result = await sdk.client.session.list({
                directory: folder,
                roots: true,
                limit: 50,
            }, { throwOnError: true })
            setSessionsByFolder((prev) => ({ ...prev, [folder]: mergeSessionList(prev[folder], result.data) }))
        } catch (error) {
            console.error("加载对话记录失败:", error)
            if (initialLoad) setSessionsByFolder((prev) => ({ ...prev, [folder]: [] }))
        } finally {
            sessionLoadFolders.delete(folder)
            if (initialLoad) setLoadingFolders((prev) => new Set([...prev].filter((item) => item !== folder)))
        }
    }

    const handleOpenFolder = async () => {
        const folder = await window.electronAPI.pickDirectory()
        if (!folder) return
        setCollapsedFolders((prev) => new Set(prev).add(folder))
        activateFolder(folder, { reloadSessions: true })
        await sdk.client.instance.dispose({ directory: folder }, { throwOnError: true })
            .catch((error) => {
                console.error("释放项目实例失败:", error)
            })
        const project = await sdk.client.project.current({ directory: folder }, { throwOnError: true })
            .then((result) => result.data)
            .catch((error) => {
                console.error("添加项目文件夹失败:", error)
                return undefined
            })
        if (project) applyProjectUpdate(project)
        void loadProjects()
    }

    const activateFolder = (folder: string, options: { reloadSessions?: boolean } = {}) => {
        const changed = sdk.directory() !== folder
        rememberProjectFolder(folder)
        if (changed) sdk.setDirectory(folder)
        if (options.reloadSessions ?? changed) void loadSessions(folder)
    }

    const clearProjectState = (project: Project) => {
        const projectSessionIDs = new Set((sessionsByFolder()[project.worktree] ?? []).map((session) => session.id))
        setProjects((prev) => prev.filter((item) => item.id !== project.id && item.worktree !== project.worktree))
        setSessionsByFolder((prev) => Object.fromEntries(Object.entries(prev).filter((entry) => entry[0] !== project.worktree)))
        setCollapsedFolders((prev) => new Set([...prev].filter((folder) => folder !== project.worktree)))
        setExpandedSessionFolders((prev) => new Set([...prev].filter((folder) => folder !== project.worktree)))
        setUnreadSessions((prev) => new Set([...prev].filter((sessionID) => !projectSessionIDs.has(sessionID))))
        forgetProjectFolder(project.worktree)
        if (sdk.directory() !== project.worktree) return
        sdk.setDirectory("")
        sdk.setSelectedSession(null)
        setFiles([])
    }

    const removeProject = (project: Project) => {
        clearProjectState(project)
    }

    const startSessionDraftForFolder = (folder: string, event: MouseEvent) => {
        event.stopPropagation()
        startSessionDraft(folder)
    }

    const startSessionDraft = (folder: string) => {
        batch(() => {
            activateFolder(folder, { reloadSessions: false })
            sdk.setSelectedSession(null)
        })
    }

    const removeSession = (sessionID: string) => {
        acknowledgeSession(sessionID)
        setSessionsByFolder((prev) => Object.fromEntries(
            Object.entries(prev).map((entry) => [entry[0], entry[1].filter((session) => session.id !== sessionID)]),
        ))
    }

    const updateSession = (folder: string, next: Session) => {
        setSessionsByFolder((prev) => ({
            ...prev,
            [folder]: sortSessions((prev[folder] ?? []).map((session) => session.id === next.id ? next : session)),
        }))
        if (sdk.selectedSession()?.id === next.id) {
            sdk.setSelectedSession(next)
        }
    }

    const selectSession = (folder: string, session: Session) => {
        closeSidebarMenu()
        acknowledgeSession(session.id)
        if (sdk.directory() === folder && sdk.selectedSession()?.id === session.id) return
        batch(() => {
            activateFolder(folder, { reloadSessions: false })
            sdk.setSelectedSession(session)
        })
    }

    const deleteProject = async (project: Project) => {
        if (deletingProjects().has(project.id)) return
        const fallback = projects().find((item) => item.id !== project.id && item.worktree !== project.worktree)
        setDeletingProjects((prev) => new Set(prev).add(project.id))
        try {
            await sdk.client.instance.dispose({ directory: project.worktree }, { throwOnError: true })
                .catch((error) => {
                    console.error("释放项目实例失败:", error)
                })
            if (sdk.directory() === project.worktree) {
                if (fallback) {
                    activateFolder(fallback.worktree, { reloadSessions: true })
                } else {
                    forgetProjectFolder(project.worktree)
                    sdk.setDirectory("")
                    sdk.setSelectedSession(null)
                    setFiles([])
                }
            }
            await sdk.client.project.delete({ projectID: project.id, directory: fallback?.worktree }, { throwOnError: true })
            removeProject(project)
        } catch (error) {
            console.error("移除项目失败:", error)
        } finally {
            setDeletingProjects((prev) => new Set([...prev].filter((item) => item !== project.id)))
        }
    }

    const openProjectInFileManager = async (project: Project) => {
        closeSidebarMenu()
        const result = await window.electronAPI.openPath(project.worktree)
        if (result.success) return
        console.error("打开项目目录失败:", result.error)
    }

    const deleteSession = async (folder: string, session: Session) => {
        if (deletingSessions().has(session.id)) return
        setDeletingSessions((prev) => new Set(prev).add(session.id))
        try {
            await sdk.client.session.delete({ sessionID: session.id, directory: folder }, { throwOnError: true })
            removeSession(session.id)
            startSessionDraft(folder)
            sdk.refreshSessionList()
            void loadProjects()
        } catch (error) {
            console.error("鍒犻櫎浼氳瘽澶辫触:", error)
        } finally {
            setDeletingSessions((prev) => new Set([...prev].filter((item) => item !== session.id)))
        }
    }

    const renameSession = async (folder: string, session: Session, value?: string) => {
        const title = (value ?? renameSessionTitle()).trim()
        closeSidebarDialog()
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

    const confirmSidebarDialog = async (value?: string) => {
        const dialog = nativeSidebarDialog()
        if (!dialog) return
        if (dialog.kind === "rename-session") {
            await renameSession(dialog.folder, dialog.session, value)
            return
        }
        closeSidebarDialog()
        if (dialog.kind === "delete-project") {
            await deleteProject(dialog.project)
            return
        }
        await deleteSession(dialog.folder, dialog.session)
    }

    const handleDialogKeyDown = (event: KeyboardEvent) => {
        event.stopPropagation()
        if (event.key === "Escape") {
            event.preventDefault()
            closeSidebarDialog()
            return
        }
        if (event.key !== "Enter") return
        event.preventDefault()
        void confirmSidebarDialog()
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

    const isSessionBusy = (sessionID: string) => sdk.store.session_status[sessionID]?.type === "busy"
    const isSessionUnread = (sessionID: string) => sdk.selectedSession()?.id !== sessionID && unreadSessions().has(sessionID)
    const currentThemeModeOption = () => THEME_MODE_OPTIONS.find((item) => item.mode === props.themeMode) ?? SYSTEM_THEME_MODE_OPTION
    const currentSettingsSection = () => SETTINGS_SECTION_OPTIONS.find((item) => item.section === settingsSection()) ?? SETTINGS_SECTION_OPTIONS[0]
    const accountName = () => props.clientAuthSession.user.name ?? props.clientAuthSession.user.username
    const accountSummaryMeta = () =>
        [
            props.clientAuthSession.user.username !== accountName() ? `用户名 ${props.clientAuthSession.user.username}` : null,
            props.clientAuthSession.user.department
                && props.clientAuthSession.user.department !== accountName()
                && props.clientAuthSession.user.department !== props.clientAuthSession.user.username
                ? `部门 ${props.clientAuthSession.user.department}`
                : null,
        ].filter((item): item is string => Boolean(item)).join(" · ") || "当前账号"
    const accountMeta = () => {
        if (props.clientAuthSession.user.department) return props.clientAuthSession.user.department
        if (props.clientAuthSession.user.quotaLimit !== null) {
            return `配额 ${props.clientAuthSession.user.quotaUsed}/${props.clientAuthSession.user.quotaLimit}`
        }
        return props.clientAuthSession.user.role
    }
    const serviceStatusClass = () => props.opencodeServiceStatus === "online"
        ? "online"
        : props.opencodeServiceStatus === "offline"
            ? "offline"
            : "connecting"
    const serviceStatusText = () => props.opencodeServiceStatus === "online"
        ? "服务在线"
        : props.opencodeServiceStatus === "offline"
            ? "服务离线"
            : "检测中"
    const serviceStatusTitle = () => props.opencodeServiceStatus === "online"
        ? "服务在线"
        : props.opencodeServiceStatus === "offline"
            ? "服务连接异常"
            : "正在检测服务"
    const appPlatformText = () => {
        if (appInfo()?.platform === "mac") return "macOS"
        if (appInfo()?.platform === "win") return "Windows"
        return "当前平台"
    }
    const updatePasswordForm = (changes: Partial<PasswordFormState>) => {
        setPasswordForm((prev) => ({ ...prev, ...changes }))
    }
    const passwordChangeErrorDescription = (result: { reason: ClientPasswordFailureReason; message?: string }) => {
        if (result.reason === "invalid_current_password") return "当前密码不正确"
        if (result.message) return result.message
        if (result.reason === "network") return "无法连接登录服务"
        if (result.reason === "unauthorized") return "登录已失效，请重新登录"
        return "修改密码失败，请稍后重试"
    }
    const notifyPasswordChangeError = (description: string) => {
        showDesktopToast({
            description,
            title: "修改密码失败",
            variant: "error",
        })
    }
    const closePasswordForm = () => {
        if (isPasswordSubmitting()) return
        resetPasswordForm()
        setIsPasswordFormOpen(false)
    }
    const submitPasswordChange = async (event: Event) => {
        event.preventDefault()
        if (isPasswordSubmitting()) return

        const form = passwordForm()
        const nextPassword = form.newPassword.trim()
        if (!form.currentPassword || !nextPassword) {
            notifyPasswordChangeError("请输入当前密码和新密码")
            return
        }
        if (nextPassword.length > 255) {
            notifyPasswordChangeError("新密码不能超过 255 个字符")
            return
        }
        if (nextPassword !== form.confirmPassword.trim()) {
            notifyPasswordChangeError("两次输入的新密码不一致")
            return
        }

        setIsPasswordSubmitting(true)
        const result = await changeClientPassword({
            currentPassword: form.currentPassword,
            newPassword: nextPassword,
        })
        setIsPasswordSubmitting(false)
        if (!result.ok) {
            notifyPasswordChangeError(passwordChangeErrorDescription(result))
            return
        }

        resetPasswordForm()
        setIsPasswordFormOpen(false)
        showDesktopToast({
            title: "密码已修改",
            variant: "success",
        })
    }

    createEffect(() => {
        if (!settingsOpen() || settingsSection() !== "about" || appInfo()) return
        void window.electronAPI.getAppInfo().then(setAppInfo)
    })

    const checkForClientUpdateManually = async () => {
        if (isManualUpdateChecking()) return

        setIsManualUpdateChecking(true)
        const update = await checkClientUpdate().catch((error: unknown) => {
            console.error("手动检查客户端更新失败:", error)
            showDesktopToast({
                description: error instanceof Error ? error.message : String(error),
                title: "检查更新失败",
                variant: "error",
            })
            return undefined
        })
        setIsManualUpdateChecking(false)
        if (update === undefined) return

        if (!update) {
            showDesktopToast({
                description: `当前版本 ${appInfo()?.version ?? ""}`,
                title: "当前已是最新版本",
                variant: "success",
            })
            return
        }

        await window.electronAPI.promptClientUpdate(update)
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
                    [folder]: sortSessions([session, ...list]),
                }
            }
            return {
                ...prev,
                [folder]: sortSessions(list.map((session) => session.id === sessionID ? mergeSessionInfo(session, info) : session)),
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

    const getFileIcon = (file: FileItem): LucideIcon => {
        if (file.isDirectory) return Folder
        const ext = file.name.split(".").pop()?.toLowerCase() || ""
        const icons: Record<string, LucideIcon> = {
            pdf: FileText,
            doc: FileType, docx: FileType,
            xls: FileSpreadsheet, xlsx: FileSpreadsheet,
            csv: ChartColumn, tsv: ChartColumn,
            ppt: Presentation, pptx: Presentation,
            mp3: FileAudio, wav: FileAudio, m4a: FileAudio,
            mp4: FileVideo, mov: FileVideo, m4v: FileVideo,
            jpg: Image, jpeg: Image, png: Image, gif: Image, svg: Image,
            js: FileCode, ts: FileCode, tsx: FileCode, jsx: FileCode,
            json: FileCode,
            md: FileType,
            txt: FileType,
            html: FileCode, css: FileCode,
        }
        return icons[ext] || FileIcon
    }

    function FileTypeIcon(props: { file: FileItem }) {
        return <Dynamic component={getFileIcon(props.file)} class="file-item-icon" size={16} strokeWidth={1.8} />
    }

    const isSelectedFile = (file: FileItem) => sdk.selectedFiles().some((selected) => selected.path === file.path)
    const allFilesSelected = () => files().length > 0 && files().every(isSelectedFile)

    const toggleAllFiles = () => {
        if (allFilesSelected()) {
            sdk.setSelectedFile(null)
            sdk.setSelectedFiles([])
            setLastSelectedFilePath(null)
            return
        }
        const next = files()
        sdk.setSelectedFile(next[0] ?? null)
        sdk.setSelectedFiles(next)
        setLastSelectedFilePath(next.at(-1)?.path ?? null)
    }

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
        const selected = sdk.selectedFiles().some((item) => item.path === file.path)
        const next = selected
            ? sdk.selectedFiles().filter((item) => item.path !== file.path)
            : [...sdk.selectedFiles(), file]
        sdk.setSelectedFile(selected ? (next.at(-1) ?? null) : file)
        sdk.setSelectedFiles(next)
        setLastSelectedFilePath(selected ? (next.at(-1)?.path ?? null) : file.path)
    }

    return (
        <div class="folder-panel">
            <div class="folder-panel-header">
                <div class="sidebar-top-control-row">
                    <button class="sidebar-panel-button" onClick={props.onCollapse} title="折叠侧边栏" aria-label="折叠侧边栏">
                        <PanelLeft class="sidebar-lucide-icon" size={17} strokeWidth={1.8} />
                    </button>
                </div>
                <div class="folder-panel-brand" title="LongwiseTechAgent">
                    <img class="folder-panel-brand-icon" src={appIcon} alt="" draggable={false} />
                    <span class="folder-panel-brand-copy">
                        <span class="folder-panel-brand-title">LongwiseTechAgent</span>
                        <span class="folder-panel-brand-subtitle" aria-hidden="true"></span>
                    </span>
                </div>
                <button class="folder-open-button" onClick={handleOpenFolder} title="打开文件夹">
                    <FolderOpen class="sidebar-lucide-icon" size={17} strokeWidth={1.9} />
                    <span>打开文件夹</span>
                </button>
            </div>

            <div class="folder-panel-content project-history-layout">
                <div class="project-history-scroll">
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
                                                onContextMenu={(event) => openProjectMenu(project, event)}
                                                title={folder}
                                            >
                                                <Dynamic
                                                    component={isFolderExpanded(folder) ? FolderOpen : Folder}
                                                    class="project-folder-mark"
                                                    size={16}
                                                    strokeWidth={1.8}
                                                    aria-hidden="true"
                                                />
                                                <span class="project-folder-name">{getFolderName(folder)}</span>
                                                <button
                                                    class="project-row-action project-new-session"
                                                    onClick={(event) => startSessionDraftForFolder(folder, event)}
                                                    title="新建会话"
                                                    aria-label="新建会话"
                                                >
                                                    <SquarePen class="sidebar-action-icon" size={14} strokeWidth={1.8} />
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
                                                    <Index each={visibleSessions(folder)}>
                                                        {(session) => (
                                                            <div
                                                                role="button"
                                                                tabIndex={0}
                                                                class={`project-conversation-item ${sdk.selectedSession()?.id === session().id ? "active" : ""}`}
                                                                onClick={() => selectSession(folder, session())}
                                                                onContextMenu={(event) => openSessionMenu(folder, session(), event)}
                                                                onKeyDown={(event) => handleSessionKeyDown(folder, session(), event)}
                                                                title={session().title}
                                                            >
                                                                <Show
                                                                    when={isSessionBusy(session().id)}
                                                                    fallback={
                                                                        <Show when={isSessionUnread(session().id)}>
                                                                            <span class="project-conversation-unread" aria-hidden="true"></span>
                                                                        </Show>
                                                                    }
                                                                >
                                                                    <span class="project-conversation-spinner" aria-hidden="true"></span>
                                                                </Show>
                                                                <span class="project-conversation-title">{getSessionTitle(session())}</span>
                                                                <span class="project-conversation-time">{formatRelativeTime(session().time.updated)}</span>
                                                            </div>
                                                        )}
                                                    </Index>
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
                </div>

                <Show when={sdk.directory()}>
                    <div class="file-preview-section">
                        <div class="file-preview-header">
                            <div class="file-preview-title">项目目录</div>
                            <Show when={!isLoadingFiles() && files().length > 0}>
                                <button
                                    type="button"
                                    class={`file-select-all ${allFilesSelected() ? "active" : ""}`}
                                    onClick={toggleAllFiles}
                                    title={allFilesSelected() ? "取消全选" : "全选文件"}
                                    aria-label={allFilesSelected() ? "取消全选" : "全选文件"}
                                >
                                    <span>全选</span>
                                    <span class="file-checkbox" aria-hidden="true">
                                        <Show when={allFilesSelected()}>
                                            <Check class="file-checkbox-check" size={13} strokeWidth={2.2} />
                                        </Show>
                                    </span>
                                </button>
                            </Show>
                        </div>
                        <Show when={isLoadingFiles()}>
                            <div class="file-preview-empty">加载文件...</div>
                        </Show>
                        <Show when={!isLoadingFiles() && files().length === 0}>
                            <div class="file-preview-empty">暂无文件</div>
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
                                            <FileTypeIcon file={file} />
                                            <span class="file-item-name">{file.name}</span>
                                            <span class="file-checkbox file-item-checkbox" aria-hidden="true">
                                                <Show when={isSelectedFile(file)}>
                                                    <Check class="file-checkbox-check" size={13} strokeWidth={2.2} />
                                                </Show>
                                            </span>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>
                </Show>
            </div>

            <div class="folder-panel-status">
                <button
                    type="button"
                    class="settings-entry-button"
                    classList={{ active: Boolean(accountMenuPosition()) }}
                    onClick={openAccountMenu}
                    title="打开菜单"
                    aria-label="打开菜单"
                    aria-haspopup="menu"
                    aria-expanded={accountMenuPosition() ? "true" : "false"}
                >
                    <Settings class="sidebar-lucide-icon" size={14} strokeWidth={1.8} />
                    <span>设置</span>
                </button>
                <div class="service-status" title={serviceStatusTitle()}>
                    <span class={`status-dot ${serviceStatusClass()}`}></span>
                    <span>{serviceStatusText()}</span>
                </div>
            </div>

            <Show when={accountMenuPosition()}>
                {(position) => (
                    <Portal>
                        <div
                            class="account-menu"
                            role="menu"
                            style={{ bottom: `${position().bottom}px`, left: `${position().x}px` }}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <div class="account-menu-profile" aria-label="用户信息">
                                <span class="account-menu-avatar" aria-hidden="true">
                                    <CircleUser class="sidebar-lucide-icon" size={14} strokeWidth={1.8} />
                                </span>
                                <span class="account-menu-info">{accountName()} · {accountMeta()}</span>
                            </div>
                            <span class="account-menu-separator" aria-hidden="true" />
                            <Show when={props.appMarketEnabled}>
                                <button
                                    type="button"
                                    class="sidebar-context-menu-item"
                                    role="menuitem"
                                    onClick={openSkillMarket}
                                >
                                    <Puzzle class="sidebar-action-icon" size={14} strokeWidth={1.8} />
                                    <span>技能市场</span>
                                </button>
                            </Show>
                            <button
                                type="button"
                                class="sidebar-context-menu-item"
                                role="menuitem"
                                onClick={openSettings}
                            >
                                <Settings class="sidebar-action-icon" size={14} strokeWidth={1.8} />
                                <span>设置</span>
                            </button>
                            <button
                                type="button"
                                class="sidebar-context-menu-item danger"
                                role="menuitem"
                                onClick={() => {
                                    closeMenus()
                                    props.onLogout()
                                }}
                            >
                                <LogOut class="sidebar-action-icon" size={14} strokeWidth={1.8} />
                                <span>退出登录</span>
                            </button>
                        </div>
                    </Portal>
                )}
            </Show>

            <Show when={props.appMarketEnabled && skillMarketOpen()}>
                <SkillMarketDialog onClose={() => setSkillMarketOpen(false)} />
            </Show>

            <Show when={settingsOpen()}>
                <Portal>
                    <div class="settings-dialog-root">
                        <button
                            type="button"
                            class="settings-dialog-backdrop"
                            aria-label="关闭设置"
                            onClick={() => setSettingsOpen(false)}
                        />
                        <div
                            class="settings-dialog"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="desktop-lxz-settings-title"
                        >
                            <button
                                type="button"
                                class="settings-dialog-close"
                                onClick={() => setSettingsOpen(false)}
                                title="关闭"
                                aria-label="关闭设置"
                            >
                                <X class="sidebar-lucide-icon" size={16} strokeWidth={1.9} />
                            </button>
                            <aside class="settings-dialog-sidebar">
                                <div class="settings-dialog-titlebar">
                                    <div>
                                        <div class="settings-dialog-kicker">LongwiseTechAgent</div>
                                        <h2 id="desktop-lxz-settings-title">设置</h2>
                                    </div>
                                </div>
                                <nav class="settings-dialog-nav" aria-label="设置分类">
                                    <For each={SETTINGS_SECTION_OPTIONS}>
                                        {(item) => (
                                            <button
                                                type="button"
                                                class="settings-dialog-nav-item"
                                                classList={{ active: settingsSection() === item.section }}
                                                onClick={() => setSettingsSection(item.section)}
                                                aria-current={settingsSection() === item.section ? "page" : undefined}
                                            >
                                                <Dynamic component={item.icon} class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />
                                                <span>
                                                    <span class="settings-dialog-nav-label">{item.label}</span>
                                                    <span class="settings-dialog-nav-description">{item.description}</span>
                                                </span>
                                            </button>
                                        )}
                                    </For>
                                </nav>
                            </aside>
                            <main class="settings-dialog-content">
                                <div class="settings-page-heading">
                                    <Dynamic component={currentSettingsSection().icon} class="settings-page-icon" size={19} strokeWidth={1.85} />
                                    <div>
                                        <h3>{currentSettingsSection().label}</h3>
                                        <p>{currentSettingsSection().description}</p>
                                    </div>
                                </div>
                                <Show when={settingsSection() === "appearance"}>
                                    <section class="settings-section">
                                        <div class="settings-section-heading">
                                            <h4>主题</h4>
                                            <p>选择界面跟随系统、亮色或暗色显示。</p>
                                        </div>
                                        <div class="settings-theme-options" role="group" aria-label="主题">
                                            <For each={THEME_MODE_OPTIONS}>
                                                {(option) => (
                                                    <button
                                                        type="button"
                                                        class="settings-theme-option"
                                                        classList={{ active: props.themeMode === option.mode }}
                                                        onClick={() => props.onThemeModeChange(option.mode)}
                                                        aria-pressed={props.themeMode === option.mode}
                                                    >
                                                        <Dynamic component={option.icon} class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />
                                                        <span>{option.label}</span>
                                                    </button>
                                                )}
                                            </For>
                                        </div>
                                        <div class="settings-current-value">
                                            当前：{currentThemeModeOption().label}
                                        </div>
                                    </section>
                                </Show>
                                <Show when={settingsSection() === "account"}>
                                    <section class="settings-section">
                                        <div class="settings-section-heading">
                                            <h4>当前账号</h4>
                                        </div>
                                        <div class="settings-account-summary">
                                            <span class="settings-account-avatar" aria-hidden="true">
                                                <CircleUser class="sidebar-lucide-icon" size={17} strokeWidth={1.85} />
                                            </span>
                                            <span class="settings-account-copy">
                                                <span class="settings-account-name">{accountName()}</span>
                                                <span class="settings-account-meta">{accountSummaryMeta()}</span>
                                            </span>
                                        </div>
                                    </section>
                                    <section class="settings-section">
                                        <div class="settings-section-heading">
                                            <h4>修改密码</h4>
                                            <p>请确认当前密码后设置新密码。</p>
                                        </div>
                                        <button
                                            type="button"
                                            class="settings-password-trigger"
                                            onClick={() => setIsPasswordFormOpen(true)}
                                        >
                                            <Lock class="sidebar-lucide-icon" size={16} strokeWidth={1.9} />
                                            <span>修改密码</span>
                                        </button>
                                    </section>
                                </Show>
                                <Show when={settingsSection() === "chat"}>
                                    <section class="settings-section">
                                        <div class="settings-section-heading">
                                            <h4>消息显示</h4>
                                            <p>控制聊天记录中辅助信息的展示方式。</p>
                                        </div>
                                        <div class="settings-option-list">
                                            <SettingsSwitchRow
                                                icon={CircleQuestionMark}
                                                title="显示问答"
                                                description="展示历史问题与用户回答。"
                                                checked={props.chatVisibility.questionAnswers}
                                                onChange={(questionAnswers) => updateChatVisibility({ questionAnswers })}
                                            />
                                            <SettingsSwitchRow
                                                icon={Brain}
                                                title="显示思考"
                                                description="展示模型的思考过程。默认关闭。"
                                                checked={props.chatVisibility.reasoning}
                                                onChange={(reasoning) => updateChatVisibility({ reasoning })}
                                            />
                                            <SettingsSwitchRow
                                                icon={SquareTerminal}
                                                title="显示 Shell 调用"
                                                description="展示 bash、shell 等终端命令调用。默认关闭。"
                                                checked={props.chatVisibility.shellCalls}
                                                onChange={(shellCalls) => updateChatVisibility({ shellCalls })}
                                            />
                                            <SettingsSwitchRow
                                                icon={Wrench}
                                                title="显示工具调用"
                                                description="展示文件、搜索等非 Shell 工具调用；子任务始终展示。默认关闭。"
                                                checked={props.chatVisibility.toolCalls}
                                                onChange={(toolCalls) => updateChatVisibility({ toolCalls })}
                                            />
                                        </div>
                                    </section>
                                    <section class="settings-section">
                                        <div class="settings-section-heading">
                                            <h4>链接打开方式</h4>
                                            <p>控制聊天消息中的链接如何打开。</p>
                                        </div>
                                        <div class="settings-option-list">
                                            <SettingsSwitchRow
                                                icon={Globe}
                                                title="使用默认浏览器打开链接"
                                                description={props.linkOpenMode === "browser" ? "链接会交给系统默认浏览器打开。" : "关闭后链接会在应用右侧的内嵌浏览器中打开。"}
                                                checked={props.linkOpenMode === "browser"}
                                                onChange={(checked) => props.onLinkOpenModeChange(checked ? "browser" : "direct")}
                                            />
                                        </div>
                                    </section>
                                </Show>
                                <Show when={settingsSection() === "about"}>
                                    <section class="settings-section">
                                        <div class="settings-section-heading">
                                            <h4>应用信息</h4>
                                            <p>LongwiseTechAgent</p>
                                        </div>
                                        <div class="settings-about-list">
                                            <div class="settings-about-row">
                                                <span class="settings-about-label">当前版本</span>
                                                <span class="settings-about-value">{appInfo()?.version ?? "..."}</span>
                                            </div>
                                            <div class="settings-about-row">
                                                <span class="settings-about-label">平台架构</span>
                                                <span class="settings-about-value">{appPlatformText()} {appInfo()?.arch ?? ""}</span>
                                            </div>
                                            <div class="settings-about-row">
                                                <span class="settings-about-label">更新通道</span>
                                                <span class="settings-about-value">{CLIENT_UPDATE_CHANNEL}</span>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            class="settings-update-button"
                                            disabled={isManualUpdateChecking()}
                                            onClick={() => void checkForClientUpdateManually()}
                                        >
                                            <Show
                                                when={isManualUpdateChecking()}
                                                fallback={<RefreshCw class="sidebar-lucide-icon" size={16} strokeWidth={1.85} />}
                                            >
                                                <LoaderCircle class="sidebar-lucide-icon settings-update-spinner" size={16} strokeWidth={1.9} />
                                            </Show>
                                            <span>{isManualUpdateChecking() ? "检查中" : "检查更新"}</span>
                                        </button>
                                    </section>
                                </Show>
                            </main>
                        </div>
                        <Show when={isPasswordFormOpen()}>
                            <div class="settings-password-dialog-layer">
                                <button
                                    type="button"
                                    class="settings-password-dialog-backdrop"
                                    aria-label="关闭修改密码"
                                    onClick={closePasswordForm}
                                />
                                <form
                                    class="settings-password-dialog"
                                    role="dialog"
                                    aria-modal="true"
                                    aria-labelledby="desktop-lxz-password-title"
                                    onSubmit={submitPasswordChange}
                                >
                                    <button
                                        type="button"
                                        class="settings-password-dialog-close"
                                        disabled={isPasswordSubmitting()}
                                        onClick={closePasswordForm}
                                        title="关闭"
                                        aria-label="关闭修改密码"
                                    >
                                        <X class="sidebar-lucide-icon" size={15} strokeWidth={1.9} />
                                    </button>
                                    <div class="settings-password-dialog-heading">
                                        <h4 id="desktop-lxz-password-title">修改密码</h4>
                                        <p>请确认当前密码后设置新密码。</p>
                                    </div>
                                    <SettingsPasswordField
                                        autocomplete="current-password"
                                        disabled={isPasswordSubmitting()}
                                        label="当前密码"
                                        placeholder="当前密码"
                                        value={passwordForm().currentPassword}
                                        onInput={(currentPassword) => updatePasswordForm({ currentPassword })}
                                    />
                                    <SettingsPasswordField
                                        autocomplete="new-password"
                                        disabled={isPasswordSubmitting()}
                                        label="新密码"
                                        placeholder="新密码"
                                        value={passwordForm().newPassword}
                                        onInput={(newPassword) => updatePasswordForm({ newPassword })}
                                    />
                                    <SettingsPasswordField
                                        autocomplete="new-password"
                                        disabled={isPasswordSubmitting()}
                                        label="确认新密码"
                                        placeholder="再次输入新密码"
                                        value={passwordForm().confirmPassword}
                                        onInput={(confirmPassword) => updatePasswordForm({ confirmPassword })}
                                    />
                                    <div class="settings-password-actions">
                                        <button
                                            type="button"
                                            class="settings-password-cancel"
                                            disabled={isPasswordSubmitting()}
                                            onClick={closePasswordForm}
                                        >
                                            取消
                                        </button>
                                        <button
                                            type="submit"
                                            class="settings-password-submit"
                                            disabled={isPasswordSubmitting()}
                                        >
                                            <span>{isPasswordSubmitting() ? "保存中" : "保存新密码"}</span>
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </Show>
                    </div>
                </Portal>
            </Show>

            <Show when={sidebarMenu()}>
                {(menu) => (
                    <Portal>
                        <div
                            class="sidebar-context-menu"
                            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
                            onClick={(event) => event.stopPropagation()}
                            onContextMenu={(event) => event.preventDefault()}
                        >
                            <Show when={menu().kind === "session"}>
                                <button
                                    type="button"
                                    class="sidebar-context-menu-item"
                                    disabled={renamingSessions().has((menu() as Extract<SidebarMenu, { kind: "session" }>).session.id)}
                                    onClick={() => {
                                        const current = menu() as Extract<SidebarMenu, { kind: "session" }>
                                        openRenameSessionDialog(current.folder, current.session)
                                    }}
                                >
                                    <PencilLine class="sidebar-action-icon" size={14} strokeWidth={1.8} />
                                    <span>重命名</span>
                                </button>
                            </Show>
                            <Show when={menu().kind === "project"}>
                                <button
                                    type="button"
                                    class="sidebar-context-menu-item"
                                    onClick={() => {
                                        const current = menu() as Extract<SidebarMenu, { kind: "project" }>
                                        void openProjectInFileManager(current.project)
                                    }}
                                >
                                    <FolderOpen class="sidebar-action-icon" size={14} strokeWidth={1.8} />
                                    <span>{openProjectInFileManagerLabel()}</span>
                                </button>
                            </Show>
                            <button
                                type="button"
                                class={`sidebar-context-menu-item ${menu().kind === "session" ? "danger" : ""}`}
                                disabled={
                                    menu().kind === "project"
                                        ? deletingProjects().has((menu() as Extract<SidebarMenu, { kind: "project" }>).project.id)
                                        : deletingSessions().has((menu() as Extract<SidebarMenu, { kind: "session" }>).session.id)
                                }
                                onClick={() => {
                                    const current = menu()
                                    if (current.kind === "project") {
                                        openDeleteProjectDialog(current.project)
                                        return
                                    }
                                    openDeleteSessionDialog(current.folder, current.session)
                                }}
                            >
                                <Dynamic
                                    component={menu().kind === "project" ? CircleMinus : Trash2}
                                    class="sidebar-action-icon"
                                    size={14}
                                    strokeWidth={1.8}
                                />
                                <span>{menu().kind === "project" ? "移除" : "删除会话"}</span>
                            </button>
                        </div>
                    </Portal>
                )}
            </Show>

            <Show when={sidebarDialog()}>
                {(dialog) => {
                    const current = dialog()
                    const isRename = current.kind === "rename-session"
                    const isProjectRemove = current.kind === "delete-project"
                    const title = isRename ? "重命名会话" : isProjectRemove ? "移除项目" : "删除会话"
                    const name = current.kind === "delete-project" ? getFolderName(current.project.worktree) : getSessionTitle(current.session)
                    const busy = current.kind === "rename-session"
                        ? renamingSessions().has(current.session.id)
                        : current.kind === "delete-project"
                            ? deletingProjects().has(current.project.id)
                            : deletingSessions().has(current.session.id)

                    return (
                        <Portal>
                            <div class="sidebar-dialog-backdrop" onMouseDown={closeSidebarDialog}>
                                <div
                                    class="sidebar-dialog"
                                    role="dialog"
                                    aria-modal="true"
                                    aria-label={title}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onKeyDown={handleDialogKeyDown}
                                >
                                    <div class="sidebar-dialog-title">{title}</div>
                                    <Show
                                        when={isRename}
                                        fallback={
                                            <div class="sidebar-dialog-copy">
                                                确定要{isProjectRemove ? "移除" : "删除"} <span>{name}</span> 吗？{isProjectRemove ? "项目会从列表中移除。" : "此操作不可撤销。"}
                                            </div>
                                        }
                                    >
                                        <input
                                            class="sidebar-dialog-input"
                                            value={renameSessionTitle()}
                                            onInput={(event) => setRenameSessionTitle(event.currentTarget.value)}
                                            ref={(element) => queueMicrotask(() => { element.focus(); element.select(); })}
                                        />
                                    </Show>
                                    <div class="sidebar-dialog-actions">
                                        <button type="button" class="sidebar-dialog-button" onClick={closeSidebarDialog}>
                                            取消
                                        </button>
                                        <button
                                            type="button"
                                            class={`sidebar-dialog-button ${isRename ? "primary" : isProjectRemove ? "" : "danger"}`}
                                            disabled={busy || (isRename && renameSessionTitle().trim().length === 0)}
                                            onClick={() => void confirmSidebarDialog()}
                                        >
                                            {isRename ? "保存" : isProjectRemove ? "移除" : "删除"}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </Portal>
                    )
                }}
            </Show>
        </div>
    )
}
