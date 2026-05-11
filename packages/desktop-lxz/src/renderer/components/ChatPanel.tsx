import { createSignal, For, Show, createMemo, createEffect, onCleanup, onMount, batch } from "solid-js"
import { reconcile } from "solid-js/store"
import { useSDK, type DiscussIssue } from "../context/sdk"
import type {
    Agent,
    Message,
    Part,
    PermissionRequest,
    Provider,
    QuestionAnswer,
    QuestionRequest,
    SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { Markdown } from "@opencode-ai/ui/markdown"
import { SessionPermissionDock, SessionQuestionDock } from "./SessionRequestDock"

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
                providerName: provider.name,
                modelName: model.name,
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
                    providerName: provider.name,
                    modelName: model.name,
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

export function ChatPanel() {
    const sdk = useSDK()
    const [inputText, setInputText] = createSignal("")
    const [agents, setAgents] = createSignal<AgentOption[]>([])
    const [modelOptions, setModelOptions] = createSignal<ModelOption[]>([])
    const [currentAgent, setCurrentAgent] = createSignal("build")
    const [currentModel, setCurrentModel] = createSignal<ModelSelection | null>(null)
    const [showAgentMenu, setShowAgentMenu] = createSignal(false)
    const [showModelMenu, setShowModelMenu] = createSignal(false)
    const [requestResponding, setRequestResponding] = createSignal<string | null>(null)
    const [sendError, setSendError] = createSignal<string | null>(null)
    const loadedSessions = new Set<string>()
    const loadingSessions = new Set<string>()
    let messagesContainer: HTMLDivElement | undefined
    let agentDropdownRef: HTMLDivElement | undefined
    let modelDropdownRef: HTMLDivElement | undefined

    // 当前选中的会话 ID 派生自 SDK 的 selectedSession
    const currentSessionId = createMemo<string | null>(() => sdk.selectedSession()?.id ?? null)

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

    // 点击外部关闭菜单
    const handleClickOutside = (e: MouseEvent) => {
        if (showAgentMenu() && agentDropdownRef && !agentDropdownRef.contains(e.target as Node)) {
            setShowAgentMenu(false)
        }
        if (showModelMenu() && modelDropdownRef && !modelDropdownRef.contains(e.target as Node)) {
            setShowModelMenu(false)
        }
    }

    onMount(() => {
        document.addEventListener("click", handleClickOutside)
    })

    onCleanup(() => {
        document.removeEventListener("click", handleClickOutside)
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
        return model.modelName
    })

    const sessionTitle = createMemo(() => formatSessionTitle(sdk.selectedSession()?.title))

    const contextLabel = createMemo(() => {
        const directory = sdk.directory()
        if (!directory) return "未选择文件夹"
        return sdk.selectedFile()?.name ?? directory.split(/[/\\]/).pop() ?? directory
    })

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
                if (prev && nextModels.some((model) => sameModel(model, prev))) return prev
                return pickDefaultModel(nextModels, defaults) ?? null
            })
        } catch (error) {
            console.error("加载模型和模式失败:", error)
        }
    }

    const applyAgent = (agent: AgentOption) => {
        setCurrentAgent(agent.name)
        if (agent.model && modelOptions().some((model) => sameModel(model, agent.model!))) {
            setCurrentModel(agent.model)
        }
        setShowAgentMenu(false)
    }

    onMount(() => {
        void loadChatOptions()
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
                sdk.setSelectedSession(data)
                sdk.refreshSessionList()
                console.log(`为文件夹 ${sdk.directory()} 创建新会话: ${data.id}`)
                return data.id as string
            }
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
        sdk.refreshSessionList()
    }

    const handlePermissionDecision = async (reply: "once" | "always" | "reject") => {
        const request = activePermissionRequest()
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
        if (!text || isLoading() || hasPendingRequest()) return

        if (!sdk.directory()) {
            setSendError("请先在左侧选择一个文件夹。")
            return
        }

        setInputText("")
        setSendError(null)

        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            let sid = currentSessionId()
            if (!sid) {
                sid = await createNewSessionForFolder(createInitialSessionTitle(text))
            }
            if (!sid) throw new Error("创建会话失败")

            const selectedFile = sdk.selectedFile()
            await ensureInitialSessionTitle(sid, text)
            const messageWithContext = selectedFile && !selectedFile.isDirectory
                ? `[当前文件夹: ${sdk.directory()}]\n[当前文件: ${selectedFile.path}]\n\n${text}`
                : `[当前文件夹: ${sdk.directory()}]\n\n${text}`
            console.log("发送异步消息到:", `${serverInfo.url}/session/${sid}/prompt_async`)

            const messageResponse = await fetch(`${serverInfo.url}/session/${sid}/prompt_async`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    agent: currentAgent(),
                    ...(currentModel() ? { model: currentModel() } : {}),
                    parts: [{ type: "text", text: messageWithContext }],
                }),
            })

            if (!messageResponse.ok) {
                const errorData = await messageResponse.text()
                console.error("发送异步消息错误:", errorData)
                throw new Error(`发送失败: ${messageResponse.status}`)
            }

            console.log("消息已提交，等待 SSE 事件...")
        } catch (error) {
            console.error("发送消息失败:", error)
            const errorMessage = error instanceof Error ? error.message : "未知错误"
            setSendError(`发送失败: ${errorMessage}`)
        }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
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

    // 清空对话 - 创建当前文件夹下的新会话
    const handleClearMessages = async () => {
        if (!sdk.directory() || isLoading()) return

        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(`${serverInfo.url}/session`, {
                method: "POST",
                headers,
                body: JSON.stringify({}),
            })

            if (response.ok) {
                const newSession = await response.json()
                loadedSessions.add(newSession.id)
                sdk.setSelectedSession(newSession)
                sdk.refreshSessionList()
                console.log(`已清空对话，新会话 ID: ${newSession.id}`)
            } else {
                console.error("创建新会话失败:", response.status)
            }
        } catch (error) {
            console.error("清空对话失败:", error)
        }
    }

    // 拼接用户消息中所有 text part（用户消息按整段渲染，不按 part 分块）
    const userMessageText = (parts: Part[]): string => {
        return parts
            .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
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

    return (
        <div class="chat-panel">
            <div class="chat-header">
                <div class="chat-header-main">
                    <div class="chat-title-row">
                        <Show when={isLoading()}>
                            <span class="chat-working-spinner" aria-hidden="true"></span>
                        </Show>
                        <div class="chat-title">{sessionTitle()}</div>
                    </div>
                    <div class="chat-context-line">
                        <span class={sdk.selectedFile() ? "chat-file-mark" : "chat-folder-mark"} aria-hidden="true"></span>
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
                <div class="chat-input-container">
                    <textarea
                        class="chat-input"
                        placeholder={hasPendingRequest() ? "请先处理上方询问或权限请求" : sdk.directory() ? "输入消息..." : "请先选择一个文件夹"}
                        value={inputText()}
                        onInput={(e) => setInputText(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        disabled={isLoading() || hasPendingRequest() || !sdk.directory()}
                        rows={1}
                    />
                    <div class="chat-toolbar">
                        <div class="agent-selector">
                            <button class="toolbar-btn" title="添加附件" aria-label="添加附件">
                                <span class="toolbar-icon attachment-icon">+</span>
                            </button>
                            <div class="agent-dropdown" ref={agentDropdownRef}>
                                <button
                                    class="agent-toggle"
                                    onClick={() => setShowAgentMenu(!showAgentMenu())}
                                    title="切换模式"
                                >
                                    <span class="toggle-icon mode-icon">◇</span>
                                    <span>{currentAgentInfo()?.name ?? currentAgent()}</span>
                                </button>
                                <Show when={showAgentMenu()}>
                                    <div class="agent-menu">
                                        <For each={agents()}>
                                            {(agent) => (
                                                <button
                                                    class={`agent-menu-item ${currentAgent() === agent.name ? "active" : ""}`}
                                                    onClick={() => applyAgent(agent)}
                                                    title={agent.description}
                                                >
                                                    <span class="menu-icon">{agent.name === "plan" ? "◇" : "▣"}</span>
                                                    <span>{agent.name}</span>
                                                    <Show when={currentAgent() === agent.name}>
                                                        <span class="check-icon">✓</span>
                                                    </Show>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </div>
                            <div class="model-dropdown" ref={modelDropdownRef}>
                                <button
                                    class="model-toggle"
                                    onClick={() => setShowModelMenu(!showModelMenu())}
                                    title={currentModelInfo() ? `${currentModelInfo()?.providerName}/${currentModelInfo()?.modelID}` : "选择模型"}
                                >
                                    <span class="toggle-icon model-icon">⌄</span>
                                    <span>{modelLabel()}</span>
                                </button>
                                <Show when={showModelMenu()}>
                                    <div class="model-menu">
                                        <For each={modelOptions()}>
                                            {(model) => (
                                                <button
                                                    class={`model-menu-item ${currentModel() && sameModel(model, currentModel()!) ? "active" : ""}`}
                                                    onClick={() => { setCurrentModel(model); setShowModelMenu(false); }}
                                                >
                                                    <span class="model-menu-main">{model.modelName}</span>
                                                    <span class="model-menu-meta">{model.providerName}{model.isDefault ? " · 默认" : ""}</span>
                                                    <Show when={currentModel() && sameModel(model, currentModel()!)}>
                                                        <span class="check-icon">✓</span>
                                                    </Show>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </div>
                        </div>
                        <Show
                            when={isLoading()}
                            fallback={
                                <button
                                    class="send-btn"
                                    onClick={handleSend}
                                    disabled={!inputText().trim() || hasPendingRequest() || !sdk.directory()}
                                    title="发送消息"
                                    aria-label="发送消息"
                                >
                                    <span class="send-icon">↑</span>
                                </button>
                            }
                        >
                            <button class="stop-btn" onClick={handleAbort} title="停止执行" aria-label="停止执行">
                                <span class="stop-icon">■</span>
                            </button>
                        </Show>
                    </div>
                </div>
            </div>
        </div>
    )
}
