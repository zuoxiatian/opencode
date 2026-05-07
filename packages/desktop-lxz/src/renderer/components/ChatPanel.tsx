import { createSignal, For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { useSDK, type DiscussIssue } from "../context/sdk"
import type { Agent, Event, Part, Provider } from "@opencode-ai/sdk/v2/client"
import { Markdown } from "@opencode-ai/ui/markdown"

interface Message {
    id: string
    role: "user" | "assistant"
    content: string
    timestamp: number
}

interface SessionMessage {
    info: {
        id: string
        role: "user" | "assistant"
        time?: {
            created?: number
        }
    }
    parts?: Part[]
}

// 工具调用状态
interface ToolCall {
    id: string
    tool: string
    status: "pending" | "running" | "completed" | "error"
    title?: string
    output?: string
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
    if (options.length) return options
    return providers.flatMap((provider) =>
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
    )
}

function pickDefaultAgent(agents: AgentOption[]) {
    return agents.find((agent) => agent.name === "plan")?.name ?? agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? "build"
}

function pickDefaultModel(models: ModelOption[], defaults: Record<string, string>) {
    return models.find((model) => defaults[model.providerID] === model.modelID) ?? models[0]
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
    const [messages, setMessages] = createSignal<Message[]>([])
    const [inputText, setInputText] = createSignal("")
    const [isLoading, setIsLoading] = createSignal(false)
    const [sessionId, setSessionId] = createSignal<string | null>(null)
    const [streamingContent, setStreamingContent] = createSignal("")
    const [toolCalls, setToolCalls] = createSignal<ToolCall[]>([])
    const [sessionStatus, setSessionStatus] = createSignal<"idle" | "busy" | "retry">("idle")
    const [agents, setAgents] = createSignal<AgentOption[]>([])
    const [modelOptions, setModelOptions] = createSignal<ModelOption[]>([])
    const [currentAgent, setCurrentAgent] = createSignal("plan")
    const [currentModel, setCurrentModel] = createSignal<ModelSelection | null>(null)
    const [showAgentMenu, setShowAgentMenu] = createSignal(false)
    const [showModelMenu, setShowModelMenu] = createSignal(false)
    // 跟踪消息角色（messageID -> role）
    const messageRoles = new Map<string, "user" | "assistant">()
    let messagesContainer: HTMLDivElement | undefined
    let agentDropdownRef: HTMLDivElement | undefined
    let modelDropdownRef: HTMLDivElement | undefined
    let unsubscribe: (() => void) | null = null
    let loadedSelectedSessionId: string | null = null
    let finalizedStreamingContent = ""

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

    const resetConversation = () => {
        messageRoles.clear()
        finalizedStreamingContent = ""
        setSessionId(null)
        setMessages([])
        setStreamingContent("")
        setToolCalls([])
        setSessionStatus("idle")
        setIsLoading(false)
    }

    // 当消息更新时滚动到底部
    createEffect(() => {
        messages()
        streamingContent()
        toolCalls()
        scrollToBottom()
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

    // 处理 SSE 事件
    const handleSSEEvent = (event: Event, eventDirectory?: string) => {
        const currentSessionId = sessionId()

        // 打印所有收到的事件（即使没有 sessionId）
        console.log("=== 收到 SSE 事件 ===")
        console.log("  类型:", event.type)
        console.log("  目录:", eventDirectory)
        console.log("  完整事件:", JSON.stringify(event, null, 2))
        console.log("  当前 sessionId:", currentSessionId)

        if (!currentSessionId) {
            console.log("  跳过: 没有当前 sessionId")
            return
        }

        switch (event.type) {
            case "session.created":
            case "session.updated": {
                break
            }

            // message.updated 用于记录消息的角色
            case "message.updated": {
                const { info } = event.properties
                if (info.sessionID !== currentSessionId) return

                // 记录消息的角色
                messageRoles.set(info.id, info.role as "user" | "assistant")
                console.log(`记录消息角色: ${info.id} -> ${info.role}`)

                // 处理错误
                if (info.role === "assistant" && 'error' in info && info.error) {
                    const errorMsg = info.error.data?.message || "未知错误"
                    addMessage("assistant", `错误: ${errorMsg}`)
                    setIsLoading(false)
                    setStreamingContent("")
                    setToolCalls([])
                }
                break
            }

            case "message.part.updated": {
                const { part } = event.properties

                // 检查是否是当前会话的消息
                if (part.sessionID !== currentSessionId) {
                    return
                }

                // 获取消息角色，如果未知则假设是 assistant（因为用户消息通常先收到 message.updated）
                const role = messageRoles.get(part.messageID) || "assistant"
                console.log(`message.part.updated - messageID: ${part.messageID}, role: ${role}, type: ${part.type}`)

                // 只处理 assistant 的消息
                if (role !== "assistant") {
                    console.log("跳过用户消息的 part.updated")
                    return
                }

                if (part.type === "text") {
                    console.log("处理 AI 文本消息:", `full: ${part.text}`)
                    setStreamingContent(part.text)
                } else if (part.type === "tool") {
                    console.log("处理工具调用:", part.tool, part.state?.status)
                    const { callID, tool, state } = part
                    setToolCalls(prev => {
                        const existing = prev.find(t => t.id === callID)
                        if (existing) {
                            return prev.map(t =>
                                t.id === callID
                                    ? {
                                        ...t,
                                        status: state.status,
                                        title: 'title' in state ? state.title : t.title,
                                        output: 'output' in state ? state.output : t.output,
                                    }
                                    : t
                            )
                        } else {
                            return [...prev, {
                                id: callID,
                                tool,
                                status: state.status,
                                title: 'title' in state ? state.title : undefined,
                                output: 'output' in state ? state.output : undefined,
                            }]
                        }
                    })
                } else {
                    console.log("其他 part 类型:", part.type)
                }
                break
            }

            case "message.part.delta": {
                const { sessionID, messageID, field, delta } = event.properties
                if (sessionID !== currentSessionId) return

                const role = messageRoles.get(messageID) || "assistant"
                if (role !== "assistant") return

                if (field === "text") {
                    console.log("处理 AI 文本增量:", delta)
                    setStreamingContent(prev => prev + delta)
                }
                break
            }

            case "session.status": {
                const { sessionID, status } = event.properties
                if (sessionID !== currentSessionId) return

                console.log("会话状态变更:", status.type)
                setSessionStatus(status.type)
                if (status.type === "idle") {
                    finalizeMessage()
                }
                break
            }

            case "session.idle": {
                const { sessionID } = event.properties
                if (sessionID !== currentSessionId) return
                console.log("会话空闲")
                finalizeMessage()
                break
            }
        }
    }

    // 完成消息
    const finalizeMessage = () => {
        const content = streamingContent()
        if (content && content !== finalizedStreamingContent) {
            finalizedStreamingContent = content
            addMessage("assistant", content)
        }
        setStreamingContent("")
        setToolCalls([])
        setIsLoading(false)
    }

    // 订阅 SSE 事件
    const subscribeEvents = () => {
        if (unsubscribe) {
            unsubscribe()
        }
        unsubscribe = sdk.subscribeToEvents(handleSSEEvent)
    }

    // 取消订阅
    const unsubscribeEvents = () => {
        if (unsubscribe) {
            unsubscribe()
            unsubscribe = null
        }
    }

    // 组件卸载时取消订阅
    onCleanup(() => {
        unsubscribeEvents()
    })

    // 组件挂载时立即订阅事件
    onMount(() => {
        console.log("ChatPanel 挂载，开始订阅 SSE 事件")
        subscribeEvents()
    })

    // 当目录变化时重置会话状态（不取消订阅）
    createEffect(() => {
        const dir = sdk.directory()
        if (dir) {
            resetConversation()
        }
    })

    // 当选中历史对话变化时，恢复会话
    createEffect(() => {
        const session = sdk.selectedSession()
        if (!session || session.id === loadedSelectedSessionId) return
        loadedSelectedSessionId = session.id
        void loadSession(session.id)
    })

    // 当有讨论问题传入时，自动填充输入框
    createEffect(() => {
        const issue = sdk.discussIssue()
        if (issue) {
            const context = buildIssueContext(issue)
            setInputText(context)
            console.log("讨论问题:", issue.title)
            // 清除讨论问题状态，避免重复触发
            sdk.setDiscussIssue(null)
        }
    })

    const isTextPart = (part: Part): part is Part & { type: "text"; text: string } => part.type === "text"

    const loadSession = async (nextSessionId: string) => {
        resetConversation()
        loadedSelectedSessionId = nextSessionId
        setSessionId(nextSessionId)
        await loadSessionMessages(nextSessionId)
    }

    // 加载会话历史消息
    const loadSessionMessages = async (sessionId: string) => {
        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(
                `${serverInfo.url}/session/${sessionId}/message?limit=50`,
                { headers }
            )

            if (response.ok) {
                const messagesData = await response.json() as SessionMessage[]
                setMessages(messagesData
                    .map((msg) => ({
                        info: msg.info,
                        content: msg.parts?.filter(isTextPart).map((part) => part.text).join("\n") ?? "",
                    }))
                    .filter((msg): msg is { info: SessionMessage["info"]; content: string } => Boolean(msg.content))
                    .map((msg) => ({
                        id: msg.info.id,
                        role: msg.info.role,
                        content: msg.content,
                        timestamp: msg.info.time?.created || Date.now(),
                    })))
            }
        } catch (error) {
            console.error("加载会话消息失败:", error)
        }
    }

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
                const newSessionId = data.id
                loadedSelectedSessionId = newSessionId
                setSessionId(newSessionId)
                sdk.setSelectedSession(data)
                sdk.refreshSessionList()
                console.log(`为文件夹 ${sdk.directory()} 创建新会话: ${newSessionId}`)
                return newSessionId
            }
        } catch (error) {
            console.error("创建会话失败:", error)
        }
        return null
    }

    const ensureInitialSessionTitle = async (currentSessionId: string, text: string) => {
        const session = sdk.selectedSession()
        if (session?.id === currentSessionId && !isDefaultSessionTitle(session.title)) return
        if (messages().filter((message) => message.role === "user").length > 1) return

        const result = await sdk.client.session.update({
            sessionID: currentSessionId,
            title: createInitialSessionTitle(text),
        }, { throwOnError: false })
        if (!result.data) return
        sdk.setSelectedSession(result.data)
        sdk.refreshSessionList()
    }

    const handleSend = async () => {
        const text = inputText().trim()
        if (!text || isLoading()) return

        if (!sdk.directory()) {
            addMessage("assistant", "请先在左侧选择一个文件夹。")
            return
        }

        addMessage("user", text)
        setInputText("")
        setIsLoading(true)
        setStreamingContent("")
        setToolCalls([])

        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            let currentSessionId = sessionId()
            if (!currentSessionId) {
                currentSessionId = await createNewSessionForFolder(createInitialSessionTitle(text))
            }
            if (!currentSessionId) throw new Error("创建会话失败")

            // 发送消息 - 使用 message 端点（可以正常触发 SSE 事件）
            const selectedFile = sdk.selectedFile()
            await ensureInitialSessionTitle(currentSessionId, text)
            const messageWithContext = selectedFile && !selectedFile.isDirectory
                ? `[当前文件夹: ${sdk.directory()}]\n[当前文件: ${selectedFile.path}]\n\n${text}`
                : `[当前文件夹: ${sdk.directory()}]\n\n${text}`
            console.log("发送异步消息到:", `${serverInfo.url}/session/${currentSessionId}/prompt_async`)
            console.log("请求内容:", { parts: [{ type: "text", text: messageWithContext }] })
            console.log("请求头:", headers)

            const messageResponse = await fetch(`${serverInfo.url}/session/${currentSessionId}/prompt_async`, {
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
            addMessage("assistant", `发送失败: ${errorMessage}`)
            setIsLoading(false)
            setStreamingContent("")
            setToolCalls([])
        }
    }

    const addMessage = (role: "user" | "assistant", content: string) => {
        setMessages((prev) => [
            ...prev,
            {
                id: Date.now().toString(),
                role,
                content,
                timestamp: Date.now(),
            },
        ])
    }

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    // 停止执行
    const handleAbort = async () => {
        const currentSessionId = sessionId()
        if (!currentSessionId) return

        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(`${serverInfo.url}/session/${currentSessionId}/abort`, {
                method: "POST",
                headers,
            })

            if (response.ok) {
                console.log("会话已中止")
                setIsLoading(false)
                setStreamingContent("")
                setToolCalls([])
            } else {
                console.error("中止会话失败:", response.status)
            }
        } catch (error) {
            console.error("中止会话失败:", error)
        }
    }

    // 格式化工具状态显示
    const getToolStatusIcon = (status: string) => {
        switch (status) {
            case "pending": return "..."
            case "running": return ">"
            case "completed": return "✓"
            case "error": return "!"
            default: return "-"
        }
    }

    // 清空对话 - 创建当前文件夹下的新会话
    const handleClearMessages = async () => {
        if (!sdk.directory() || isLoading()) return

        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            // 创建新会话
            const response = await fetch(`${serverInfo.url}/session`, {
                method: "POST",
                headers,
                body: JSON.stringify({}),
            })

            if (response.ok) {
                const newSession = await response.json()
                const newSessionId = newSession.id

                setSessionId(newSessionId)
                sdk.setSelectedSession(newSession)
                sdk.refreshSessionList()

                // 清空 UI 上的消息
                setMessages([])
                setStreamingContent("")
                setToolCalls([])

                console.log(`已清空对话，新会话 ID: ${newSessionId}`)
            } else {
                console.error("创建新会话失败:", response.status)
            }
        } catch (error) {
            console.error("清空对话失败:", error)
        }
    }

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
                    <Show when={sessionId()}>
                        <div class="status-indicator">
                            <span class={`status-dot ${sessionStatus() === "busy" ? "busy" : "online"}`}></span>
                            <span>{sessionStatus() === "busy" ? "处理中" : "就绪"}</span>
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
                    when={messages().length > 0 || streamingContent() || toolCalls().length > 0}
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
                                <div class={`chat-turn ${message.role}`}>
                                    <div class={`chat-message ${message.role}`}>
                                        <div class="chat-message-role">{message.role === "user" ? "You" : "Assistant"}</div>
                                        <Markdown
                                            class="chat-message-content"
                                            text={message.content}
                                            cacheKey={message.id}
                                            streaming={false}
                                        />
                                    </div>
                                </div>
                            )}
                        </For>

                        <Show when={toolCalls().length > 0}>
                            <div class="chat-turn assistant">
                                <div class="tool-calls">
                                    <For each={toolCalls()}>
                                        {(tool) => (
                                            <div class={`tool-call ${tool.status}`}>
                                                <span class="tool-icon">{getToolStatusIcon(tool.status)}</span>
                                                <span class="tool-name">{tool.title || tool.tool}</span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </div>
                        </Show>

                        <Show when={streamingContent()}>
                            <div class="chat-turn assistant">
                                <div class="chat-message assistant streaming">
                                    <div class="chat-message-role">Assistant</div>
                                    <Markdown
                                        class="chat-message-content"
                                        text={streamingContent()}
                                        cacheKey={`${sessionId() ?? "streaming"}:streaming`}
                                        streaming
                                    />
                                </div>
                            </div>
                        </Show>
                    </div>
                </Show>
            </div>

            <div class="chat-composer-wrap">
                <div class="chat-input-container">
                    <textarea
                        class="chat-input"
                        placeholder={sdk.directory() ? "输入消息..." : "请先选择一个文件夹"}
                        value={inputText()}
                        onInput={(e) => setInputText(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        disabled={isLoading() || !sdk.directory()}
                        rows={1}
                    />
                    <div class="chat-toolbar">
                        <div class="agent-selector">
                            <button class="toolbar-btn" title="添加附件" aria-label="添加附件">
                                <span>+</span>
                            </button>
                            <div class="agent-dropdown" ref={agentDropdownRef}>
                                <button
                                    class="agent-toggle"
                                    onClick={() => setShowAgentMenu(!showAgentMenu())}
                                    title="切换模式"
                                >
                                    <span class="toggle-icon">◇</span>
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
                                    <span class="toggle-icon">⌄</span>
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
                                    disabled={!inputText().trim() || !sdk.directory()}
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
