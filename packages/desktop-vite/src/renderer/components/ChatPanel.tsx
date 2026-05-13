import { createSignal, For, Show, createEffect, onCleanup, onMount } from "solid-js"
import { useSDK, type DiscussIssue } from "../context/sdk"
import type { Event } from "@opencode-ai/sdk/v2/client"

interface Message {
    id: string
    role: "user" | "assistant"
    content: string
    timestamp: number
}

// 工具调用状态
interface ToolCall {
    id: string
    tool: string
    status: "pending" | "running" | "completed" | "error"
    title?: string
    output?: string
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
    const [currentAgent, setCurrentAgent] = createSignal<"pdf-audit" | "build">("pdf-audit") // Agent 模式
    const [showAgentMenu, setShowAgentMenu] = createSignal(false) // Agent 选择菜单
    // 跟踪消息角色（messageID -> role）
    const messageRoles = new Map<string, "user" | "assistant">()
    let messagesContainer: HTMLDivElement | undefined
    let agentDropdownRef: HTMLDivElement | undefined
    let unsubscribe: (() => void) | null = null

    // 点击外部关闭菜单
    const handleClickOutside = (e: MouseEvent) => {
        if (showAgentMenu() && agentDropdownRef && !agentDropdownRef.contains(e.target as Node)) {
            setShowAgentMenu(false)
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

    // 当消息更新时滚动到底部
    createEffect(() => {
        messages()
        streamingContent()
        toolCalls()
        scrollToBottom()
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
                const { part, delta } = event.properties

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
                    console.log("处理 AI 文本消息:", delta ? `delta: ${delta}` : `full: ${part.text}`)
                    // 更新流式文本内容
                    if (delta) {
                        setStreamingContent(prev => prev + delta)
                    } else {
                        setStreamingContent(part.text)
                    }
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
        if (content) {
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
            // 只清除状态，不取消订阅
            setSessionId(null)
            setMessages([])
            setStreamingContent("")
            setToolCalls([])
        }
    })

    // 当选中文件变化时，创建或恢复会话
    createEffect(() => {
        const file = sdk.selectedFile()
        if (file && !file.isDirectory) {
            initSessionForFile(file.path)
        }
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

    // 初始化文件对应的会话
    const initSessionForFile = async (filePath: string) => {
        // 重置消息状态，但不取消订阅（通过 sessionId 过滤事件）
        setMessages([])
        setStreamingContent("")
        setToolCalls([])

        // 检查是否有已存在的会话 ID
        const existingSessionId = sdk.getSessionForFile(filePath)
        if (existingSessionId) {
            const sessionExists = await verifySessionExists(existingSessionId)
            if (sessionExists) {
                setSessionId(existingSessionId)
                await loadSessionMessages(existingSessionId)
                console.log(`已恢复文件 ${filePath} 的会话: ${existingSessionId}`)
                return
            } else {
                console.log(`会话 ${existingSessionId} 在服务器上不存在，将创建新会话`)
            }
        }
        await createNewSessionForFile(filePath)
    }

    // 验证会话是否在服务器上存在
    const verifySessionExists = async (sessionId: string): Promise<boolean> => {
        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(
                `${serverInfo.url}/session/${sessionId}/message?limit=1`,
                { headers }
            )
            return response.ok
        } catch (error) {
            console.error("验证会话失败:", error)
            return false
        }
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
                const messagesData = await response.json()
                const loadedMessages: Message[] = []

                for (const msg of messagesData) {
                    if (msg.parts) {
                        const textContent = msg.parts
                            .filter((p: any) => p.type === "text")
                            .map((p: any) => p.text)
                            .join("\n")

                        if (textContent) {
                            loadedMessages.push({
                                id: msg.info.id,
                                role: msg.info.role,
                                content: textContent,
                                timestamp: msg.info.time?.created || Date.now(),
                            })
                        }
                    }
                }

                setMessages(loadedMessages)
            }
        } catch (error) {
            console.error("加载会话消息失败:", error)
        }
    }

    // 为文件创建新会话
    const createNewSessionForFile = async (filePath: string) => {
        try {
            const { serverInfo } = sdk
            const headers = getHeaders()

            const response = await fetch(`${serverInfo.url}/session`, {
                method: "POST",
                headers,
                body: JSON.stringify({}),
            })

            if (response.ok) {
                const data = await response.json()
                const newSessionId = data.id
                setSessionId(newSessionId)
                sdk.setSessionForFile(filePath, newSessionId)
                console.log(`为文件 ${filePath} 创建新会话: ${newSessionId}`)
            }
        } catch (error) {
            console.error("创建会话失败:", error)
        }
    }

    const handleSend = async () => {
        const text = inputText().trim()
        if (!text || isLoading()) return

        const selectedFile = sdk.selectedFile()
        if (!selectedFile) {
            addMessage("assistant", "请先在左侧选择一个文件。")
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
                await createNewSessionForFile(selectedFile.path)
                currentSessionId = sessionId()
                // 不需要再次订阅，组件挂载时已经订阅过了
            }

            // 发送消息 - 使用 message 端点（可以正常触发 SSE 事件）
            const messageWithFile = `[当前文件: ${selectedFile.path}]\n\n${text}`
            console.log("发送消息到:", `${serverInfo.url}/session/${currentSessionId}/message`)
            console.log("请求内容:", { parts: [{ type: "text", text: messageWithFile }] })
            console.log("请求头:", headers)

            const messageResponse = await fetch(`${serverInfo.url}/session/${currentSessionId}/message`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    agent: currentAgent(), // 使用选中的 Agent
                    parts: [{ type: "text", text: messageWithFile }],
                }),
            })

            console.log("message 响应状态:", messageResponse.status, messageResponse.statusText)

            if (!messageResponse.ok) {
                const errorData = await messageResponse.text()
                console.error("发送消息错误:", errorData)
                throw new Error(`发送失败: ${messageResponse.status}`)
            }

            console.log("消息发送成功，等待 SSE 事件...")

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
            case "pending": return "⏳"
            case "running": return "⚙️"
            case "completed": return "✅"
            case "error": return "❌"
            default: return "❓"
        }
    }

    return (
        <div class="chat-panel">
            <div class="chat-header">
                {/* 左侧区域 - 标题和文件名，flex: 1 占据剩余空间 */}
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px", flex: 1, "min-width": 0 }}>
                    <div class="chat-title">AI 助手</div>
                    <Show when={sdk.selectedFile()}>
                        <div style={{
                            "font-size": "12px",
                            color: "var(--text-secondary)",
                            display: "flex",
                            "align-items": "center",
                            gap: "6px"
                        }}>
                            <span style={{ opacity: 0.7 }}>📄</span>
                            <span style={{
                                overflow: "hidden",
                                "text-overflow": "ellipsis",
                                "white-space": "nowrap"
                            }}>
                                {sdk.selectedFile()?.name}
                            </span>
                        </div>
                    </Show>
                </div>
                {/* 右侧区域 - 状态指示器，固定位置 */}
                <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-shrink": 0 }}>
                    <Show when={sessionId()}>
                        <div class="status-indicator">
                            <span class={`status-dot ${sessionStatus() === "busy" ? "busy" : "online"}`}></span>
                            <span>{sessionStatus() === "busy" ? "处理中" : "就绪"}</span>
                        </div>
                    </Show>
                </div>
            </div>

            <div class="chat-messages" ref={messagesContainer}>
                <Show
                    when={messages().length > 0 || streamingContent() || toolCalls().length > 0}
                    fallback={
                        <div style={{
                            display: "flex",
                            "flex-direction": "column",
                            "align-items": "center",
                            "justify-content": "center",
                            height: "100%",
                            color: "var(--text-tertiary)",
                            "text-align": "center"
                        }}>
                            <div style={{ "font-size": "48px", "margin-bottom": "16px", opacity: 0.3 }}>
                                💬
                            </div>
                            <div>开始对话</div>
                            <div style={{ "font-size": "12px", "margin-top": "8px" }}>
                                在下方输入消息，按 Enter 发送
                            </div>
                        </div>
                    }
                >
                    <For each={messages()}>
                        {(message) => (
                            <div class={`message ${message.role}`}>
                                <div class="message-role">
                                    {message.role === "user" ? "你" : "AI"}
                                </div>
                                <div class="message-content">{message.content}</div>
                            </div>
                        )}
                    </For>

                    {/* 工具调用显示 */}
                    <Show when={toolCalls().length > 0}>
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
                    </Show>

                    {/* 流式内容显示 */}
                    <Show when={streamingContent()}>
                        <div class="message assistant streaming">
                            <div class="message-role">AI</div>
                            <div class="message-content">{streamingContent()}</div>
                        </div>
                    </Show>
                </Show>
            </div>

            <div class="chat-input-container">
                {/* 输入框 */}
                <textarea
                    class="chat-input"
                    placeholder={sdk.selectedFile() ? "输入消息..." : "请先选择一个文件"}
                    value={inputText()}
                    onInput={(e) => setInputText(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isLoading() || !sdk.selectedFile()}
                    rows={1}
                />
                {/* 工具栏：模式选择器 + 发送按钮 */}
                <div class="chat-toolbar">
                    <div class="agent-selector">
                        <button class="toolbar-btn" title="添加附件">
                            <span>+</span>
                        </button>
                        <div class="agent-dropdown" ref={agentDropdownRef}>
                            <button
                                class="agent-toggle"
                                onClick={() => setShowAgentMenu(!showAgentMenu())}
                                title="切换模式"
                            >
                                <span class="toggle-icon">∧</span>
                                <span>{currentAgent() === "pdf-audit" ? "PDF审核" : "通用"}</span>
                            </button>
                            <Show when={showAgentMenu()}>
                                <div class="agent-menu">
                                    <button
                                        class={`agent-menu-item ${currentAgent() === "pdf-audit" ? "active" : ""}`}
                                        onClick={() => { setCurrentAgent("pdf-audit"); setShowAgentMenu(false); }}
                                    >
                                        <span class="menu-icon">📕</span>
                                        <span>PDF审核</span>
                                        <Show when={currentAgent() === "pdf-audit"}>
                                            <span class="check-icon">✓</span>
                                        </Show>
                                    </button>
                                    <button
                                        class={`agent-menu-item ${currentAgent() === "build" ? "active" : ""}`}
                                        onClick={() => { setCurrentAgent("build"); setShowAgentMenu(false); }}
                                    >
                                        <span class="menu-icon">🔧</span>
                                        <span>通用</span>
                                        <Show when={currentAgent() === "build"}>
                                            <span class="check-icon">✓</span>
                                        </Show>
                                    </button>
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
                                disabled={!inputText().trim() || !sdk.selectedFile()}
                                title="发送消息"
                            >
                                <span class="send-icon">→</span>
                            </button>
                        }
                    >
                        <button
                            class="stop-btn"
                            onClick={handleAbort}
                            title="停止执行"
                        >
                            <span class="stop-icon">■</span>
                        </button>
                    </Show>
                </div>
            </div>
        </div>
    )
}
