import { createSignal, For, Show, createMemo, createEffect, onCleanup, onMount, batch } from "solid-js"
import { reconcile } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useSDK, type DiscussIssue } from "../context/sdk"
import type {
    Agent,
    Message,
    Part,
    PermissionRequest,
    Project,
    Provider,
    QuestionAnswer,
    QuestionRequest,
    SessionStatus,
    TextPartInput,
} from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Markdown } from "@opencode-ai/ui/markdown"
import type { LucideIcon } from "lucide-solid"
import ArrowUp from "lucide-solid/icons/arrow-up"
import Check from "lucide-solid/icons/check"
import ChevronDown from "lucide-solid/icons/chevron-down"
import CircleCheck from "lucide-solid/icons/circle-check"
import Cpu from "lucide-solid/icons/cpu"
import Folder from "lucide-solid/icons/folder"
import FolderPlus from "lucide-solid/icons/folder-plus"
import ListChecks from "lucide-solid/icons/list-checks"
import Plus from "lucide-solid/icons/plus"
import Search from "lucide-solid/icons/search"
import ShieldCheck from "lucide-solid/icons/shield-check"
import Square from "lucide-solid/icons/square"
import Terminal from "lucide-solid/icons/terminal"
import { SessionPermissionDock, SessionQuestionDock } from "./SessionRequestDock"
import { isIMECompositionEvent } from "../lib/ime"

interface QueuedPrompt {
    id: string
    sessionID: string
    text: string
    parts: TextPartInput[]
    agent: string
    model: ModelSelection
}

interface AgentOption {
    name: string
    description?: string
    mode: "primary" | "all"
    model?: ModelSelection
}

interface ModelSelection {
    providerID: string
    modelID: string
}

interface ModelOption extends ModelSelection {
    providerName: string
    modelName: string
    context: number
    isDefault: boolean
}

type PermissionMode = "default" | "auto"
type PermissionModeMap = Record<string, PermissionMode>

const LAST_PROJECT_STORAGE_KEY = "desktop-lxz.lastProjectFolder"
const PERMISSION_MODE_STORAGE_KEY = "desktop-lxz.permissionAutoAccept"
const PROJECT_ADDED_EVENT = "desktop-lxz.project-added"
const PERMISSION_MODE_OPTIONS = [
    { mode: "default", label: "默认权限", description: "遇到权限请求时手动确认" },
    { mode: "auto", label: "自动获取权限", description: "自动允许一次权限请求" },
] as const

const agentLabel = (name: string) => {
    if (name === "plan") return "计划"
    if (name === "build") return "执行"
    return name
}

const agentIcon = (name: string): LucideIcon => {
    if (name === "plan") return ListChecks
    return Terminal
}

const permissionModeIcon = (mode: PermissionMode): LucideIcon => {
    if (mode === "auto") return CircleCheck
    return ShieldCheck
}

function AgentModeIcon(props: { name: string; class?: string }) {
    return <Dynamic component={agentIcon(props.name)} class={props.class ?? "lucide-control-icon"} size={16} strokeWidth={1.8} />
}

function PermissionModeIcon(props: { mode: PermissionMode; class?: string }) {
    return <Dynamic component={permissionModeIcon(props.mode)} class={props.class ?? "lucide-control-icon"} size={16} strokeWidth={1.8} />
}

const normalizePermissionMode = (value: unknown): PermissionMode => {
    if (value === true) return "auto"
    if (value === "auto") return value
    return "default"
}

const readPermissionMode = (): PermissionModeMap => {
    const raw = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)
    if (!raw) return {}
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
        return Object.fromEntries(Object.entries(parsed).map(([sessionId, mode]) => [sessionId, normalizePermissionMode(mode)]))
    } catch {
        return {}
    }
}

const writePermissionMode = (modes: PermissionModeMap) => {
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, JSON.stringify(modes))
}

const permissionModeInfo = (mode: PermissionMode) => {
    return PERMISSION_MODE_OPTIONS.find((option) => option.mode === mode) ?? PERMISSION_MODE_OPTIONS[0]
}

const permissionModeReply = (mode: PermissionMode): "once" | "always" | undefined => {
    if (mode === "auto") return "once"
    return undefined
}

function formatSessionTitle(title?: string) {
    const value = title?.trim()
    if (!value) return "新对话"
    if (/^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(value)) return "新对话"
    return value
}

function isDefaultSessionTitle(title?: string) {
    const value = title?.trim()
    return value === "新对话" || /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(value ?? "")
}

function createInitialSessionTitle(text: string) {
    return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 20).join("")
}

function isSelectableAgent(agent: Agent): agent is Agent & { mode: "primary" | "all" } {
    return agent.mode !== "subagent" && agent.hidden !== true
}

function sameModel(a: ModelSelection, b: ModelSelection) {
    return a.providerID === b.providerID && a.modelID === b.modelID
}

function modelKey(model: ModelSelection) {
    return `${model.providerID}/${model.modelID}`
}

function toModelSelection(model: ModelSelection): ModelSelection {
    return {
        providerID: model.providerID,
        modelID: model.modelID,
    }
}

function sortModelOptions(options: ModelOption[]) {
    return options.sort(
        (a, b) => Number(a.providerName.toLowerCase() === "opencode zen") - Number(b.providerName.toLowerCase() === "opencode zen"),
    )
}

function buildModelOptions(providers: Provider[], defaults: Record<string, string>) {
    const options = providers.flatMap((provider) =>
        Object.values(provider.models)
            .filter((model) => model.capabilities.output.text && model.status !== "deprecated")
            .map((model): ModelOption => ({
                providerID: provider.id,
                modelID: model.id,
                providerName: provider.name || provider.id,
                modelName: model.name || model.id,
                context: model.limit.context,
                isDefault: defaults[provider.id] === model.id,
            })),
    )
    if (options.length) return sortModelOptions(options)
    return sortModelOptions(
        providers.flatMap((provider) =>
            Object.values(provider.models)
                .filter((model) => model.capabilities.output.text)
                .map((model): ModelOption => ({
                    providerID: provider.id,
                    modelID: model.id,
                    providerName: provider.name || provider.id,
                    modelName: model.name || model.id,
                    context: model.limit.context,
                    isDefault: defaults[provider.id] === model.id,
                })),
        ),
    )
}

function pickDefaultAgent(agents: AgentOption[]) {
    return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? "build"
}

function pickDefaultModel(models: ModelOption[], defaults: Record<string, string>) {
    return models.find((model) => defaults[model.providerID] === model.modelID) ?? models[0]
}

function cleanReasoningHeading(value: string) {
    return value
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_~]+/g, "")
        .trim()
}

function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
        const value = cleanReasoningHeading(html[1].replace(/<[^>]+>/g, " "))
        if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
        const value = cleanReasoningHeading(atx[1])
        if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
        const value = cleanReasoningHeading(setext[1])
        if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
        const value = cleanReasoningHeading(strong[1])
        if (value) return value
    }
}

function ReasoningBlock(props: { text: string; heading?: string; streaming?: boolean; cacheKey: string }) {
    const [open, setOpen] = createSignal(false)
    const heading = createMemo(() => props.heading || reasoningHeading(props.text) || "")

    return (
        <div class="chat-reasoning" data-open={open() ? "true" : "false"}>
            <button class="chat-reasoning-trigger" type="button" onClick={() => setOpen((value) => !value)}>
                <Show when={props.streaming}>
                    <span class="chat-thinking-spinner" aria-hidden="true"></span>
                </Show>
                <span class="chat-reasoning-chevron" aria-hidden="true"></span>
                <span class="chat-reasoning-label">{props.streaming ? "思考中" : "···"}</span>
                <span class="chat-reasoning-heading">{heading()}</span>
            </button>
            <Show when={open()}>
                <Markdown
                    class="chat-reasoning-content"
                    text={props.text}
                    cacheKey={`${props.cacheKey}:reasoning`}
                    streaming={props.streaming}
                />
            </Show>
        </div>
    )
}

function getToolStatusIcon(status: string) {
    switch (status) {
        case "pending": return "..."
        case "running": return ">"
        case "completed": return "✓"
        case "error": return "!"
        default: return "-"
    }
}

function cleanToolError(error: string) {
    return error.replace(/^Error:\s*/, "").trim()
}

function partKey(part: Part) {
    return part.id
}

function isStreamingPart(part: Part) {
    if (part.type === "tool") return part.state.status === "pending" || part.state.status === "running"
    return false
}

// 构建讨论问题的上下文模板
function buildIssueContext(issue: DiscussIssue): string {
    const lines = [
        `请帮我分析以下审核问题：`,
        ``,
        `【问题类型】${issue.type}`,
        `【严重程度】${issue.severity}`,
    ]

    if (issue.position?.page) {
        lines.push(`【所在位置】第 ${issue.position.page} 页`)
    }

    lines.push(`【问题描述】${issue.description}`)

    if (issue.matchedText) {
        lines.push(`【匹配文本】"${issue.matchedText}"`)
    }

    if (issue.suggestion) {
        lines.push(`【修改建议】${issue.suggestion}`)
    }

    lines.push(``, `我的问题是：`)

    return lines.join('\n')
}

const identifierState = {
    lastTimestamp: 0,
    counter: 0,
}

function createAscendingID(prefix: "msg" | "prt") {
    const now = Date.now()
    if (now !== identifierState.lastTimestamp) {
        identifierState.lastTimestamp = now
        identifierState.counter = 0
    }
    identifierState.counter += 1

    const value = BigInt(now) * BigInt(0x1000) + BigInt(identifierState.counter)
    const bytes = new Uint8Array(6)
    for (let i = 0; i < 6; i += 1) {
        bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    const random = new Uint8Array(14)
    crypto.getRandomValues(random)
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    return `${prefix}_${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}${Array.from(random).map((byte) => chars[byte % chars.length]).join("")}`
}

export function ChatPanel() {
    const sdk = useSDK()
    const [inputText, setInputText] = createSignal("")
    const [agents, setAgents] = createSignal<AgentOption[]>([])
    const [modelOptions, setModelOptions] = createSignal<ModelOption[]>([])
    const [projectOptions, setProjectOptions] = createSignal<Project[]>([])
    const [projectSearch, setProjectSearch] = createSignal("")
    const [currentAgent, setCurrentAgent] = createSignal("build")
    const [currentModel, setCurrentModel] = createSignal<ModelSelection | null>(null)
    const [showProjectMenu, setShowProjectMenu] = createSignal(false)
    const [showAgentMenu, setShowAgentMenu] = createSignal(false)
    const [showModelMenu, setShowModelMenu] = createSignal(false)
    const [showPermissionMenu, setShowPermissionMenu] = createSignal(false)
    const [requestResponding, setRequestResponding] = createSignal<string | null>(null)
    const [sendError, setSendError] = createSignal<string | null>(null)
    const [queuedPrompts, setQueuedPrompts] = createSignal<QueuedPrompt[]>([])
    const [sendingQueuedPrompt, setSendingQueuedPrompt] = createSignal<string | null>(null)
    const [failedQueuedPrompt, setFailedQueuedPrompt] = createSignal<string | null>(null)
    const [permissionModes, setPermissionModes] = createSignal<PermissionModeMap>(readPermissionMode())
    const [newSessionPermissionMode, setNewSessionPermissionMode] = createSignal<PermissionMode>("default")
    const loadedSessions = new Set<string>()
    const loadingSessions = new Set<string>()
    const autoRespondingPermissions = new Set<string>()
    let messagesContainer: HTMLDivElement | undefined
    let chatInputComposing = false
    let chatInputCompositionEndTimer: ReturnType<typeof setTimeout> | undefined

    // 当前选中的会话 ID 派生自 SDK 的 selectedSession
    const currentSessionId = createMemo<string | null>(() => sdk.selectedSession()?.id ?? null)

    const currentPermissionMode = createMemo<PermissionMode>(() => {
        const sid = currentSessionId()
        return sid ? permissionModes()[sid] ?? "default" : newSessionPermissionMode()
    })

    const currentPermissionModeInfo = createMemo(() => permissionModeInfo(currentPermissionMode()))

    const setSessionPermissionMode = (sessionId: string, mode: PermissionMode) => {
        setPermissionModes((current) => {
            const next = { ...current, [sessionId]: mode }
            writePermissionMode(next)
            return next
        })
    }

    const handlePermissionModeSelect = (mode: PermissionMode) => {
        const sid = currentSessionId()
        setSendError(null)
        setShowPermissionMenu(false)
        if (!sid) {
            setNewSessionPermissionMode(mode)
            return
        }
        setSessionPermissionMode(sid, mode)
    }

    const setPermissionMenuOpen = (open: boolean) => {
        if (open) {
            setShowProjectMenu(false)
            setShowAgentMenu(false)
            setShowModelMenu(false)
        }
        setShowPermissionMenu(open)
    }

    const setProjectMenuOpen = (open: boolean) => {
        if (open) {
            setShowPermissionMenu(false)
            setShowAgentMenu(false)
            setShowModelMenu(false)
            void loadProjectOptions()
        } else {
            setProjectSearch("")
        }
        setShowProjectMenu(open)
    }

    const setAgentMenuOpen = (open: boolean) => {
        if (open) {
            setShowProjectMenu(false)
            setShowPermissionMenu(false)
            setShowModelMenu(false)
        }
        setShowAgentMenu(open)
    }

    const setModelMenuOpen = (open: boolean) => {
        if (open) {
            setShowProjectMenu(false)
            setShowPermissionMenu(false)
            setShowAgentMenu(false)
        }
        setShowModelMenu(open)
    }

    // 当前会话的消息列表
    const messages = createMemo<Message[]>(() => {
        const sid = currentSessionId()
        if (!sid) return []
        return sdk.store.message[sid] ?? []
    })

    // 取某条消息的可见 parts（与 reducer 的 SKIP_PARTS 一致，保留 text/reasoning/tool 等）
    const partsOf = (messageID: string) => sdk.store.part[messageID] ?? []

    // 当前会话的状态（idle / busy / retry）
    const sessionStatus = createMemo<SessionStatus | undefined>(() => {
        const sid = currentSessionId()
        if (!sid) return undefined
        return sdk.store.session_status[sid]
    })

    const isBusy = createMemo(() => sessionStatus()?.type === "busy")
    const isLoading = isBusy

    const activePermissionRequest = createMemo<PermissionRequest | undefined>(() => {
        const sid = currentSessionId()
        if (!sid) return undefined
        const list = sdk.store.permission[sid]
        return list && list.length > 0 ? list[0] : undefined
    })

    const activeQuestionRequest = createMemo<QuestionRequest | undefined>(() => {
        const sid = currentSessionId()
        if (!sid) return undefined
        const list = sdk.store.question[sid]
        return list && list.length > 0 ? list[0] : undefined
    })

    const hasPendingRequest = createMemo(() => Boolean(activePermissionRequest() || activeQuestionRequest()))
    const canSend = createMemo(() => Boolean(inputText().trim() && !hasPendingRequest() && sdk.directory()))

    onCleanup(() => {
        if (chatInputCompositionEndTimer) clearTimeout(chatInputCompositionEndTimer)
    })

    // 滚动到底部
    const scrollToBottom = () => {
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight
        }
    }

    // 消息列表或当前会话流式状态变化时滚动到底部
    createEffect(() => {
        const list = messages()
        // 也跟踪最后一条 assistant 消息的 parts（流式追加 part 时也要滚动）
        if (list.length > 0) {
            const last = list[list.length - 1]
            if (last.role === "assistant") sdk.store.part[last.id]
        }
        isBusy()
        queueMicrotask(scrollToBottom)
    })

    const currentAgentInfo = createMemo(() => agents().find((agent) => agent.name === currentAgent()))

    const currentModelInfo = createMemo(() => {
        const model = currentModel()
        if (!model) return
        return modelOptions().find((option) => sameModel(option, model))
    })

    const modelLabel = createMemo(() => {
        const model = currentModelInfo()
        if (!model) return "默认模型"
        return model.modelName || model.modelID
    })

    const currentModelKey = createMemo(() => {
        const model = currentModel()
        return model ? modelKey(model) : ""
    })

    const sessionTitle = createMemo(() => formatSessionTitle(sdk.selectedSession()?.title))

    const contextLabel = createMemo(() => {
        const directory = sdk.directory()
        if (!directory) return "未选择文件夹"
        const selectedFiles = sdk.selectedFiles()
        if (selectedFiles.length === 1) return selectedFiles[0].name
        if (selectedFiles.length > 1) return `${selectedFiles.length} 个文件`
        return directory.split(/[/\\]/).pop() ?? directory
    })

    const getFolderName = (folder: string) => folder.split(/[/\\]/).pop() || folder

    const currentProjectName = createMemo(() => {
        const directory = sdk.directory()
        if (!directory) return "选择项目"
        return getFolderName(directory)
    })

    const filteredProjectOptions = createMemo(() => {
        const query = projectSearch().trim().toLowerCase()
        if (!query) return projectOptions()
        return projectOptions().filter((project) =>
            getFolderName(project.worktree).toLowerCase().includes(query)
            || project.worktree.toLowerCase().includes(query),
        )
    })

    const promptParts = (text: string): TextPartInput[] => {
        const selectedFiles = sdk.selectedFiles().filter((file) => !file.isDirectory)
        if (selectedFiles.length === 0) return [{ id: createAscendingID("prt"), type: "text", text }]
        return [
            { id: createAscendingID("prt"), type: "text", text },
            {
                id: createAscendingID("prt"),
                type: "text",
                text: [
                    "Selected files for this message. File contents are not attached; use these paths only as selection context:",
                    ...selectedFiles.map((file) => `- ${file.path}`),
                ].join("\n"),
                synthetic: true,
                metadata: {
                    selectedFiles: selectedFiles.map((file) => ({
                        name: file.name,
                        path: file.path,
                    })),
                },
            },
        ]
    }

    const loadProjectOptions = async () => {
        try {
            const result = await sdk.client.project.list(undefined, { throwOnError: true })
            setProjectOptions((result.data ?? [])
                .filter((project) => Boolean(project.worktree))
                .sort((a, b) => b.time.updated - a.time.updated))
        } catch (error) {
            console.error("加载项目切换列表失败:", error)
            setProjectOptions([])
        }
    }

    const activateProjectFolder = (folder: string) => {
        localStorage.setItem(LAST_PROJECT_STORAGE_KEY, folder)
        batch(() => {
            if (sdk.directory() !== folder) sdk.setDirectory(folder)
            sdk.setSelectedSession(null)
            setInputText("")
            setSendError(null)
        })
        sdk.refreshSessionList()
    }

    const selectProject = (project: Project) => {
        setShowProjectMenu(false)
        setProjectSearch("")
        activateProjectFolder(project.worktree)
    }

    const addProjectFolder = async () => {
        const folder = await window.electronAPI.pickDirectory()
        if (!folder) return

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
        if (project) window.dispatchEvent(new CustomEvent(PROJECT_ADDED_EVENT, { detail: project }))

        setShowProjectMenu(false)
        setProjectSearch("")
        activateProjectFolder(folder)
        void loadProjectOptions()
    }

    const loadChatOptions = async () => {
        try {
            const [providersResult, agentsResult] = await Promise.all([
                sdk.client.config.providers(undefined, { throwOnError: true }),
                sdk.client.app.agents(undefined, { throwOnError: true }),
            ])
            const defaults = providersResult.data.default
            const nextAgents = agentsResult.data
                .filter(isSelectableAgent)
                .map((agent): AgentOption => ({
                    name: agent.name,
                    description: agent.description,
                    mode: agent.mode,
                    model: agent.model,
                }))
            const nextModels = buildModelOptions(providersResult.data.providers, defaults)

            setAgents(nextAgents)
            setModelOptions(nextModels)
            setCurrentAgent((prev) => nextAgents.some((agent) => agent.name === prev) ? prev : pickDefaultAgent(nextAgents))
            setCurrentModel((prev) => {
                if (prev && nextModels.some((model) => sameModel(model, prev))) return toModelSelection(prev)
                const nextModel = pickDefaultModel(nextModels, defaults)
                return nextModel ? toModelSelection(nextModel) : null
            })
        } catch (error) {
            console.error("加载模型和模式失败:", error)
        }
    }

    const applyAgent = (agent: AgentOption) => {
        setCurrentAgent(agent.name)
        if (agent.model && modelOptions().some((model) => sameModel(model, agent.model!))) {
            setCurrentModel(toModelSelection(agent.model))
        }
        setShowAgentMenu(false)
    }

    onMount(() => {
        void loadChatOptions()
    })

    createEffect(() => {
        sdk.sessionListVersion()
        void loadProjectOptions()
    })

    // 构建认证头
    const getHeaders = (): HeadersInit => {
        const { serverInfo, directory } = sdk
        const headers: HeadersInit = {
            "Content-Type": "application/json",
        }
        if (serverInfo.password) {
            const credentials = btoa(`opencode:${serverInfo.password}`)
            headers["Authorization"] = `Basic ${credentials}`
        }
        if (directory()) {
            headers["x-opencode-directory"] = encodeURIComponent(directory())
        }
        return headers
    }

    // 加载历史会话（只在 store 没有该会话数据时拉一次）
    const loadSession = async (sessionId: string) => {
        if (loadedSessions.has(sessionId) || loadingSessions.has(sessionId)) return
        if (sdk.store.message[sessionId] !== undefined) {
            loadedSessions.add(sessionId)
            return
        }
        loadingSessions.add(sessionId)
        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const [messagesResponse, permissions, questions] = await Promise.all([
                fetch(`${serverInfo.url}/session/${sessionId}/message?limit=50`, { headers }),
                sdk.client.permission.list(undefined, { throwOnError: false }).catch(() => undefined),
                sdk.client.question.list(undefined, { throwOnError: false }).catch(() => undefined),
            ])

            if (messagesResponse.ok) {
                const data = await messagesResponse.json() as Array<{ info: Message; parts?: Part[] }>
                batch(() => {
                    const nextMessages: Message[] = []
                    const nextParts: Record<string, Part[]> = {}
                    for (const item of data) {
                        if (!item?.info?.id) continue
                        nextMessages.push(item.info)
                        if (item.parts && item.parts.length > 0) {
                            nextParts[item.info.id] = item.parts
                        }
                    }
                    nextMessages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                    sdk.setStore("message", sessionId, reconcile(nextMessages, { key: "id" }))
                    for (const [messageID, parts] of Object.entries(nextParts)) {
                        sdk.setStore("part", messageID, reconcile(parts, { key: "id" }))
                    }
                })
            }

            if (permissions?.data) {
                const list = permissions.data.filter((request) => request.sessionID === sessionId)
                sdk.setStore("permission", sessionId, reconcile(list, { key: "id" }))
            }
            if (questions?.data) {
                const list = questions.data.filter((request) => request.sessionID === sessionId)
                sdk.setStore("question", sessionId, reconcile(list, { key: "id" }))
            }

            loadedSessions.add(sessionId)
        } catch (error) {
            console.error("加载会话消息失败:", error)
        } finally {
            loadingSessions.delete(sessionId)
        }
    }

    // 切换到一个未加载过的会话时按需拉一次历史
    createEffect(() => {
        const sid = currentSessionId()
        if (!sid) return
        if (sdk.store.message[sid] === undefined) {
            void loadSession(sid)
        }
        // 切换会话清理之前的发送错误提示
        setSendError(null)
    })

    // 当有讨论问题传入时，自动填充输入框
    createEffect(() => {
        const issue = sdk.discussIssue()
        if (issue) {
            const context = buildIssueContext(issue)
            setInputText(context)
            console.log("讨论问题:", issue.title)
            sdk.setDiscussIssue(null)
        }
    })

    // 为当前文件夹创建新会话
    const createNewSessionForFolder = async (title?: string) => {
        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(`${serverInfo.url}/session`, {
                method: "POST",
                headers,
                body: JSON.stringify(title ? { title } : {}),
            })

            if (response.ok) {
                const data = await response.json()
                loadedSessions.add(data.id)
                if (newSessionPermissionMode() !== "default") setSessionPermissionMode(data.id, newSessionPermissionMode())
                sdk.setSelectedSession(data)
                sdk.refreshSessionList()
                console.log(`为文件夹 ${sdk.directory()} 创建新会话: ${data.id}`)
                return data.id as string
            }
            console.error("创建会话失败:", await response.text())
        } catch (error) {
            console.error("创建会话失败:", error)
        }
        return null
    }

    const ensureInitialSessionTitle = async (sid: string, text: string) => {
        const session = sdk.selectedSession()
        if (session?.id === sid && !isDefaultSessionTitle(session.title)) return
        const userMessageCount = messages().filter((message) => message.role === "user").length
        if (userMessageCount > 1) return

        const result = await sdk.client.session.update({
            sessionID: sid,
            title: createInitialSessionTitle(text),
        }, { throwOnError: false })
        if (!result.data) return
        sdk.setSelectedSession(result.data)
    }

    const addOptimisticPrompt = (prompt: QueuedPrompt) => {
        const message: Message = {
            id: prompt.id,
            sessionID: prompt.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: prompt.agent,
            model: prompt.model,
        }
        const parts = prompt.parts.map((part): Part => ({
            ...part,
            id: part.id ?? createAscendingID("prt"),
            sessionID: prompt.sessionID,
            messageID: prompt.id,
        } as Part))

        batch(() => {
            const current = sdk.store.message[prompt.sessionID] ?? []
            if (!current.some((item) => item.id === prompt.id)) {
                sdk.setStore("message", prompt.sessionID, reconcile([...current, message].sort((a, b) => a.id.localeCompare(b.id)), { key: "id" }))
            }
            sdk.setStore("part", prompt.id, reconcile(parts, { key: "id" }))
        })
    }

    const removeOptimisticPrompt = (prompt: QueuedPrompt) => {
        batch(() => {
            sdk.setStore("message", prompt.sessionID, (items) => items?.filter((message) => message.id !== prompt.id) ?? [])
            sdk.setStore("part", prompt.id, [])
        })
    }

    const submitPrompt = async (prompt: QueuedPrompt) => {
        const { serverInfo } = sdk
        const response = await fetch(`${serverInfo.url}/session/${prompt.sessionID}/prompt_async`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                messageID: prompt.id,
                agent: prompt.agent,
                model: prompt.model,
                parts: prompt.parts,
            }),
        })

        if (!response.ok) {
            const errorData = await response.text()
            console.error("发送异步消息错误:", errorData)
            throw new Error(`发送失败: ${response.status}`)
        }
    }

    const sendQueuedPrompt = async (prompt: QueuedPrompt) => {
        if (sendingQueuedPrompt()) return
        setSendingQueuedPrompt(prompt.id)
        setSendError(null)

        try {
            await submitPrompt(prompt)
            setQueuedPrompts((items) => items.filter((item) => item.id !== prompt.id))
            setFailedQueuedPrompt((id) => id === prompt.id ? null : id)
        } catch (error) {
            console.error("发送排队消息失败:", error)
            removeOptimisticPrompt(prompt)
            setFailedQueuedPrompt(prompt.id)
            setSendError(`发送排队消息失败: ${error instanceof Error ? error.message : "未知错误"}`)
        } finally {
            setSendingQueuedPrompt((id) => id === prompt.id ? null : id)
        }
    }

    createEffect(() => {
        const sid = currentSessionId()
        if (!sid || isBusy() || hasPendingRequest() || sendingQueuedPrompt()) return
        const prompt = queuedPrompts().find((item) => item.sessionID === sid)
        if (!prompt || failedQueuedPrompt() === prompt.id) return
        void sendQueuedPrompt(prompt)
    })

    const respondToPermissionRequest = async (request: PermissionRequest, reply: "once" | "always" | "reject") => {
        if (!request || requestResponding()) return
        setRequestResponding(request.id)
        try {
            await sdk.client.permission.respond({
                sessionID: request.sessionID,
                permissionID: request.id,
                response: reply,
            }, { throwOnError: true })
        } catch (error) {
            console.error("权限回复失败:", error)
        } finally {
            setRequestResponding((current) => current === request.id ? null : current)
        }
    }

    const handlePermissionDecision = async (reply: "once" | "always" | "reject") => {
        const request = activePermissionRequest()
        if (!request) return
        await respondToPermissionRequest(request, reply)
    }

    createEffect(() => {
        const request = activePermissionRequest()
        const reply = permissionModeReply(currentPermissionMode())
        if (!request || !reply || autoRespondingPermissions.has(request.id)) return
        autoRespondingPermissions.add(request.id)
        void respondToPermissionRequest(request, reply).finally(() => {
            setTimeout(() => autoRespondingPermissions.delete(request.id), 1000)
        })
    })

    const handleQuestionSubmit = async (answers: QuestionAnswer[]) => {
        const request = activeQuestionRequest()
        if (!request || requestResponding()) return
        setRequestResponding(request.id)
        try {
            await sdk.client.question.reply({ requestID: request.id, answers }, { throwOnError: true })
        } catch (error) {
            console.error("询问回复失败:", error)
        } finally {
            setRequestResponding((current) => current === request.id ? null : current)
        }
    }

    const handleQuestionReject = async () => {
        const request = activeQuestionRequest()
        if (!request || requestResponding()) return
        setRequestResponding(request.id)
        try {
            await sdk.client.question.reject({ requestID: request.id }, { throwOnError: true })
        } catch (error) {
            console.error("询问忽略失败:", error)
        } finally {
            setRequestResponding((current) => current === request.id ? null : current)
        }
    }

    const handleSend = async () => {
        const text = inputText().trim()
        if (!text || hasPendingRequest()) return

        if (!sdk.directory()) {
            setSendError("请先在左侧选择一个文件夹。")
            return
        }

        setInputText("")
        setSendError(null)

        let optimisticPrompt: QueuedPrompt | undefined
        try {
            const { serverInfo } = sdk
            const model = currentModel()
            if (!model) throw new Error("请选择模型后再发送")
            let sid = currentSessionId()
            if (!sid) {
                sid = await createNewSessionForFolder(createInitialSessionTitle(text))
            }
            if (!sid) throw new Error("创建会话失败")

            await ensureInitialSessionTitle(sid, text)
            console.log("发送异步消息到:", `${serverInfo.url}/session/${sid}/prompt_async`)

            const prompt: QueuedPrompt = {
                id: createAscendingID("msg"),
                sessionID: sid,
                text,
                parts: promptParts(text),
                agent: currentAgent(),
                model: toModelSelection(model),
            }

            if (isBusy()) {
                addOptimisticPrompt(prompt)
                setQueuedPrompts((items) => [...items, prompt])
                setFailedQueuedPrompt(null)
                return
            }

            addOptimisticPrompt(prompt)
            optimisticPrompt = prompt
            await submitPrompt(prompt)

            console.log("消息已提交，等待 SSE 事件...")
        } catch (error) {
            if (optimisticPrompt) removeOptimisticPrompt(optimisticPrompt)
            console.error("发送消息失败:", error)
            const errorMessage = error instanceof Error ? error.message : "未知错误"
            setSendError(`发送失败: ${errorMessage}`)
        }
    }

    const handleChatInputCompositionStart = () => {
        if (chatInputCompositionEndTimer) clearTimeout(chatInputCompositionEndTimer)
        chatInputComposing = true
    }

    const handleChatInputCompositionEnd = () => {
        if (chatInputCompositionEndTimer) clearTimeout(chatInputCompositionEndTimer)
        chatInputCompositionEndTimer = setTimeout(() => {
            chatInputComposing = false
        }, 0)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
        if (chatInputComposing || isIMECompositionEvent(e)) return
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    const handleAbort = async () => {
        const sid = currentSessionId()
        if (!sid) return

        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(`${serverInfo.url}/session/${sid}/abort`, {
                method: "POST",
                headers,
            })

            if (response.ok) {
                console.log("会话已中止")
            } else {
                console.error("中止会话失败:", response.status)
            }
        } catch (error) {
            console.error("中止会话失败:", error)
        }
    }

    // 清空当前选中会话，进入草稿态；发送第一条消息时再创建真实会话。
    const handleClearMessages = () => {
        if (!sdk.directory() || isLoading()) return

        const keepPermissionMode = currentPermissionMode()
        batch(() => {
            setNewSessionPermissionMode(keepPermissionMode)
            sdk.setSelectedSession(null)
            setInputText("")
            setSendError(null)
        })
    }

    // 拼接用户消息中所有 text part（用户消息按整段渲染，不按 part 分块）
    const userMessageText = (parts: Part[]): string => {
        return parts
            .filter((part): part is Part & { type: "text"; text: string; synthetic?: boolean } => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n")
    }

    // 一个 part 是否应该在 chat-turn 中被渲染（与 reducer 的 SKIP_PARTS 一致）
    const isVisiblePart = (part: Part) => part.type === "text" || part.type === "reasoning" || part.type === "tool"

    // 当前会话中，最后一个可被流式展示（text 或 reasoning）的 part 的 id。
    // streaming 标记只落到这一个 id 命中的行上，其余行的属性不变 → DOM 不重建。
    const lastStreamablePartId = createMemo<string | null>(() => {
        if (!isBusy()) return null
        const list = messages()
        for (let i = list.length - 1; i >= 0; i--) {
            const message = list[i]
            if (message.role !== "assistant") continue
            const parts = sdk.store.part[message.id] ?? []
            for (let j = parts.length - 1; j >= 0; j--) {
                const part = parts[j]
                if (part.type === "text" || part.type === "reasoning") return part.id
            }
        }
        return null
    })

    // 是否显示底部"思考中…"占位：busy 且当前会话没有任何可流式 part（用户刚发完、还没有 assistant 输出）
    const showThinkingPlaceholder = createMemo(() => {
        if (!isBusy()) return false
        return lastStreamablePartId() === null
    })

    const emptyConversation = createMemo(() => messages().length === 0 && !isLoading() && !sendError() && !hasPendingRequest())

    return (
        <div class="chat-panel" classList={{ "chat-panel-empty": emptyConversation() }}>
            <div class="chat-header">
                <div class="chat-header-main">
                    <div class="chat-title-row">
                        <Show when={isLoading()}>
                            <span class="chat-working-spinner" aria-hidden="true"></span>
                        </Show>
                        <div class="chat-title">{sessionTitle()}</div>
                    </div>
                    <div class="chat-context-line">
                        <span class={sdk.selectedFiles().length ? "chat-file-mark" : "chat-folder-mark"} aria-hidden="true"></span>
                        <span class="chat-context-name">{contextLabel()}</span>
                    </div>
                </div>
                <div class="chat-header-actions">
                    <Show when={currentSessionId()}>
                        <div class="status-indicator">
                            <span class={`status-dot ${isBusy() ? "busy" : "online"}`}></span>
                            <span>{isBusy() ? "处理中" : "就绪"}</span>
                        </div>
                    </Show>
                    <Show when={sdk.directory() && !isLoading()}>
                        <button class="chat-header-btn" onClick={handleClearMessages} title="清空对话" aria-label="清空对话">
                            <span class="chat-trash-icon" aria-hidden="true"></span>
                        </button>
                    </Show>
                </div>
            </div>

            <div class="chat-messages" ref={messagesContainer}>
                <Show
                    when={messages().length > 0 || isLoading() || sendError()}
                    fallback={
                        <div class="chat-empty">
                            <div class="chat-empty-icon" aria-hidden="true"></div>
                            <div class="chat-empty-title">开始对话</div>
                            <div class="chat-empty-subtitle">输入问题后按 Enter 发送</div>
                        </div>
                    }
                >
                    <div class="chat-timeline">
                        <For each={messages()}>
                            {(message) => (
                                <Show
                                    when={message.role === "assistant"}
                                    fallback={
                                        <div class="chat-turn user">
                                            <div class="chat-message user">
                                                <div class="chat-message-role">You</div>
                                                <Markdown
                                                    class="chat-message-content"
                                                    text={userMessageText(partsOf(message.id))}
                                                    cacheKey={message.id}
                                                    streaming={false}
                                                />
                                            </div>
                                        </div>
                                    }
                                >
                                    <For each={partsOf(message.id)}>
                                        {(part) => (
                                            <Show when={isVisiblePart(part)}>
                                                <Show when={part.type === "text"}>
                                                    {(() => {
                                                        const textPart = part as Part & { type: "text"; text: string }
                                                        const streaming = createMemo(() => lastStreamablePartId() === textPart.id)
                                                        return (
                                                            <div class="chat-turn assistant">
                                                                <div class={`chat-message assistant${streaming() ? " streaming" : ""}`}>
                                                                    <div class="chat-message-role">Assistant</div>
                                                                    <Markdown
                                                                        class="chat-message-content"
                                                                        text={textPart.text}
                                                                        cacheKey={textPart.id}
                                                                        streaming={streaming()}
                                                                    />
                                                                </div>
                                                            </div>
                                                        )
                                                    })()}
                                                </Show>
                                                <Show when={part.type === "reasoning"}>
                                                    {(() => {
                                                        const reasoningPart = part as Part & { type: "reasoning"; text: string }
                                                        const streaming = createMemo(() => lastStreamablePartId() === reasoningPart.id)
                                                        return (
                                                            <div class="chat-turn assistant">
                                                                <ReasoningBlock
                                                                    text={reasoningPart.text}
                                                                    cacheKey={reasoningPart.id}
                                                                    streaming={streaming()}
                                                                />
                                                            </div>
                                                        )
                                                    })()}
                                                </Show>
                                                <Show when={part.type === "tool"}>
                                                    {(() => {
                                                        const tool = part as Part & { type: "tool" }
                                                        return (
                                                            <div class="chat-turn assistant">
                                                                <div class="tool-calls">
                                                                    <div class={`tool-call ${tool.state.status}`}>
                                                                        <span class="tool-icon">{getToolStatusIcon(tool.state.status)}</span>
                                                                        <span class="tool-body">
                                                                            <span class="tool-name">
                                                                                {"title" in tool.state && tool.state.title ? tool.state.title : tool.tool}
                                                                            </span>
                                                                            <Show when={tool.state.status === "error" && "error" in tool.state ? tool.state.error : undefined}>
                                                                                {(error) => <span class="tool-error-text">{cleanToolError(error())}</span>}
                                                                            </Show>
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )
                                                    })()}
                                                </Show>
                                            </Show>
                                        )}
                                    </For>
                                </Show>
                            )}
                        </For>

                        <Show when={showThinkingPlaceholder()}>
                            <div class="chat-turn assistant">
                                <div class="chat-thinking">
                                    <span class="chat-thinking-spinner" aria-hidden="true"></span>
                                    <span class="chat-thinking-label">思考中</span>
                                </div>
                            </div>
                        </Show>

                        <Show when={sendError()}>
                            {(error) => (
                                <div class="chat-turn assistant">
                                    <div class="chat-message assistant">
                                        <div class="chat-message-role">Assistant</div>
                                        <div class="chat-message-content">{error()}</div>
                                    </div>
                                </div>
                            )}
                        </Show>
                    </div>
                </Show>
            </div>

            <Show when={activeQuestionRequest()}>
                {(request) => (
                    <div class="chat-prompt-dock">
                        <SessionQuestionDock
                            request={request()}
                            responding={requestResponding() === request().id}
                            onSubmit={handleQuestionSubmit}
                            onReject={handleQuestionReject}
                        />
                    </div>
                )}
            </Show>

            <Show when={activePermissionRequest()}>
                {(request) => (
                    <div class="chat-prompt-dock">
                        <SessionPermissionDock
                            request={request()}
                            responding={requestResponding() === request().id}
                            onDecide={handlePermissionDecision}
                        />
                    </div>
                )}
            </Show>

            <div class="chat-composer-wrap">
                <Show when={emptyConversation()}>
                    <div class="chat-empty-hero">
                        <div class="chat-empty-hero-title">我能为你做什么？</div>
                    </div>
                </Show>
                <div class="chat-input-container">
                    <textarea
                        class="chat-input"
                        placeholder={hasPendingRequest() ? "请先处理上方询问或权限请求" : sdk.directory() ? "输入消息..." : "请先选择一个文件夹"}
                        value={inputText()}
                        onInput={(e) => setInputText(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={handleChatInputCompositionStart}
                        onCompositionEnd={handleChatInputCompositionEnd}
                        disabled={hasPendingRequest() || !sdk.directory()}
                        rows={1}
                    />
                    <div class="chat-toolbar">
                        <div class="agent-selector">
                            <button
                                class="toolbar-btn"
                                title="添加附件"
                                aria-label="添加附件"
                            >
                                <Plus class="lucide-control-icon" size={16} strokeWidth={1.8} />
                            </button>
                            <DropdownMenu
                                gutter={8}
                                placement="top-start"
                                open={showPermissionMenu()}
                                onOpenChange={setPermissionMenuOpen}
                            >
                                <DropdownMenu.Trigger
                                    as={Button}
                                    variant="ghost"
                                    size="small"
                                    class="permission-mode-toggle"
                                    data-active={currentPermissionMode() !== "default"}
                                    data-open={showPermissionMenu() ? "true" : "false"}
                                    title={currentPermissionModeInfo().description}
                                    aria-label={`权限模式：${currentPermissionModeInfo().label}`}
                                >
                                    <PermissionModeIcon mode={currentPermissionMode()} />
                                    <span data-slot="permission-mode-label">{currentPermissionModeInfo().label}</span>
                                    <ChevronDown class="lucide-chevron-icon" size={14} strokeWidth={1.8} />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content class="permission-mode-menu">
                                        <DropdownMenu.RadioGroup
                                            value={currentPermissionMode()}
                                            onChange={(mode) => {
                                                if (mode === "default" || mode === "auto") handlePermissionModeSelect(mode)
                                            }}
                                        >
                                            <For each={PERMISSION_MODE_OPTIONS}>
                                                {(option) => (
                                                    <DropdownMenu.RadioItem
                                                        value={option.mode}
                                                        class="permission-mode-item"
                                                        classList={{ active: currentPermissionMode() === option.mode }}
                                                    >
                                                        <PermissionModeIcon mode={option.mode} />
                                                        <span data-slot="permission-mode-option-main">
                                                            <span data-slot="permission-mode-option-label">{option.label}</span>
                                                            <span data-slot="permission-mode-option-description">{option.description}</span>
                                                        </span>
                                                        <DropdownMenu.ItemIndicator>
                                                            <Check class="check-icon" size={14} strokeWidth={2} />
                                                        </DropdownMenu.ItemIndicator>
                                                    </DropdownMenu.RadioItem>
                                                )}
                                            </For>
                                        </DropdownMenu.RadioGroup>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu>
                            <DropdownMenu
                                gutter={8}
                                placement="top-start"
                                open={showAgentMenu()}
                                onOpenChange={setAgentMenuOpen}
                            >
                                <DropdownMenu.Trigger
                                    as={Button}
                                    variant="ghost"
                                    size="small"
                                    class="agent-toggle"
                                    data-agent={currentAgent()}
                                    data-open={showAgentMenu() ? "true" : "false"}
                                    title="切换模式"
                                >
                                    <AgentModeIcon name={currentAgent()} />
                                    <span>{agentLabel(currentAgentInfo()?.name ?? currentAgent())}</span>
                                    <ChevronDown class="lucide-chevron-icon" size={14} strokeWidth={1.8} />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content class="agent-menu">
                                        <For each={agents()}>
                                            {(agent) => (
                                                <DropdownMenu.Item
                                                    class="agent-menu-item"
                                                    classList={{ active: currentAgent() === agent.name }}
                                                    data-agent={agent.name}
                                                    onSelect={() => applyAgent(agent)}
                                                    title={agent.description}
                                                >
                                                    <AgentModeIcon name={agent.name} class="menu-icon lucide-control-icon" />
                                                    <DropdownMenu.ItemLabel>{agentLabel(agent.name)}</DropdownMenu.ItemLabel>
                                                    <Show when={currentAgent() === agent.name}>
                                                        <Check class="check-icon" size={14} strokeWidth={2} />
                                                    </Show>
                                                </DropdownMenu.Item>
                                            )}
                                        </For>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu>
                            <DropdownMenu
                                gutter={8}
                                placement="top-start"
                                open={showModelMenu()}
                                onOpenChange={setModelMenuOpen}
                            >
                                <DropdownMenu.Trigger
                                    as={Button}
                                    variant="ghost"
                                    size="small"
                                    class="model-toggle"
                                    data-open={showModelMenu() ? "true" : "false"}
                                    title={currentModelInfo() ? `${currentModelInfo()?.providerName || currentModelInfo()?.providerID}/${currentModelInfo()?.modelID}` : "选择模型"}
                                >
                                    <Cpu class="lucide-control-icon" size={16} strokeWidth={1.8} />
                                    <span>{modelLabel()}</span>
                                    <ChevronDown class="lucide-chevron-icon" size={14} strokeWidth={1.8} />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content class="model-menu">
                                        <Show
                                            when={modelOptions().length > 0}
                                            fallback={<div class="model-menu-empty">暂无可用模型</div>}
                                        >
                                            <DropdownMenu.RadioGroup
                                                value={currentModelKey()}
                                                onChange={(value) => {
                                                    const model = modelOptions().find((option) => modelKey(option) === value)
                                                    if (!model) return
                                                    setCurrentModel(toModelSelection(model))
                                                    setShowModelMenu(false)
                                                }}
                                            >
                                                <For each={modelOptions()}>
                                                    {(model) => (
                                                        <DropdownMenu.RadioItem
                                                            value={modelKey(model)}
                                                            class="model-menu-item"
                                                            classList={{ active: currentModel() ? sameModel(model, currentModel()!) : false }}
                                                        >
                                                            <span class="model-menu-main">{model.modelName || model.modelID}</span>
                                                            <span class="model-menu-meta">{model.providerName || model.providerID}{model.isDefault ? " · 默认" : ""}</span>
                                                            <DropdownMenu.ItemIndicator>
                                                                <Check class="check-icon" size={14} strokeWidth={2} />
                                                            </DropdownMenu.ItemIndicator>
                                                        </DropdownMenu.RadioItem>
                                                    )}
                                                </For>
                                            </DropdownMenu.RadioGroup>
                                        </Show>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu>
                        </div>
                        <Show
                            when={isLoading() && !canSend()}
                            fallback={
                                <button
                                    class="send-btn"
                                    onClick={handleSend}
                                    disabled={!canSend()}
                                    title="发送消息"
                                    aria-label="发送消息"
                                >
                                    <ArrowUp class="lucide-send-icon" size={16} strokeWidth={2.2} />
                                </button>
                            }
                        >
                            <button class="stop-btn" onClick={handleAbort} title="停止执行" aria-label="停止执行">
                                <Square class="lucide-stop-icon" size={13} fill="currentColor" strokeWidth={0} />
                            </button>
                        </Show>
                    </div>
                    <Show when={emptyConversation()}>
                        <div class="chat-empty-project-row">
                            <DropdownMenu
                                gutter={8}
                                placement="bottom-start"
                                open={showProjectMenu()}
                                onOpenChange={setProjectMenuOpen}
                            >
                                <DropdownMenu.Trigger
                                    as={Button}
                                    variant="ghost"
                                    size="small"
                                    class="empty-project-toggle"
                                    data-open={showProjectMenu() ? "true" : "false"}
                                    title={sdk.directory() || "选择项目"}
                                    aria-label={`当前项目：${currentProjectName()}`}
                                >
                                    <Folder class="lucide-control-icon" size={15} strokeWidth={1.8} />
                                    <span>{currentProjectName()}</span>
                                    <ChevronDown class="lucide-chevron-icon" size={14} strokeWidth={1.8} />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content class="empty-project-menu">
                                        <div class="empty-project-search">
                                            <Search class="lucide-control-icon" size={14} strokeWidth={1.8} />
                                            <input
                                                value={projectSearch()}
                                                placeholder="搜索项目"
                                                onInput={(event) => setProjectSearch(event.currentTarget.value)}
                                                onKeyDown={(event) => event.stopPropagation()}
                                            />
                                        </div>
                                        <div class="empty-project-list">
                                            <Show
                                                when={filteredProjectOptions().length > 0}
                                                fallback={<div class="empty-project-menu-empty">没有匹配项目</div>}
                                            >
                                                <For each={filteredProjectOptions()}>
                                                    {(project) => (
                                                        <DropdownMenu.Item
                                                            class="empty-project-item"
                                                            classList={{ active: sdk.directory() === project.worktree }}
                                                            onSelect={() => selectProject(project)}
                                                            title={project.worktree}
                                                        >
                                                            <Folder class="lucide-control-icon" size={15} strokeWidth={1.8} />
                                                            <span class="empty-project-item-name">{getFolderName(project.worktree)}</span>
                                                            <Show when={sdk.directory() === project.worktree}>
                                                                <Check class="check-icon" size={14} strokeWidth={2} />
                                                            </Show>
                                                        </DropdownMenu.Item>
                                                    )}
                                                </For>
                                            </Show>
                                        </div>
                                        <button class="empty-project-add" type="button" onClick={() => void addProjectFolder()}>
                                            <FolderPlus class="lucide-control-icon" size={15} strokeWidth={1.8} />
                                            <span>添加新文件夹</span>
                                        </button>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu>
                        </div>
                    </Show>
                </div>
            </div>
        </div>
    )
}
