import { createContext, useContext, createSignal, type ParentProps, type Accessor, type Setter, onCleanup, batch } from "solid-js"
import { createOpencodeClient, type OpencodeClient, type Event, type Session } from "@opencode-ai/sdk/v2/client"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

// 选中的文件信息
interface SelectedFile {
    name: string
    path: string
    isDirectory: boolean
}

// 讨论的审核问题类型
export interface DiscussIssue {
    id: string
    type: string
    severity: string
    title: string
    description: string
    matchedText?: string
    suggestion?: string
    position?: {
        page: number
        paragraph: number
        charStart: number
        charEnd: number
    }
}

// 事件监听器类型 - 接收目录和事件
type EventListener = (event: Event, directory?: string) => void

// SDK 上下文类型
interface SDKContextType {
    client: OpencodeClient
    serverInfo: ServerInfo
    directory: Accessor<string>
    setDirectory: (dir: string) => void
    selectedFile: Accessor<SelectedFile | null>
    setSelectedFile: (file: SelectedFile | null) => void
    selectedSession: Accessor<Session | null>
    setSelectedSession: Setter<Session | null>
    sessionListVersion: Accessor<number>
    refreshSessionList: () => void
    subscribeToEvents: (callback: EventListener) => () => void
    // 讨论审核问题相关
    discussIssue: Accessor<DiscussIssue | null>
    setDiscussIssue: Setter<DiscussIssue | null>
}

const SDKContext = createContext<SDKContextType>()

export function useSDK() {
    const context = useContext(SDKContext)
    if (!context) {
        throw new Error("useSDK 必须在 SDKProvider 内部使用")
    }
    return context
}

interface SDKProviderProps extends ParentProps {
    serverInfo: ServerInfo
}

export function SDKProvider(props: SDKProviderProps) {
    const [directory, setDirectory] = createSignal("")
    const [selectedFile, setSelectedFile] = createSignal<SelectedFile | null>(null)
    const [selectedSession, setSelectedSession] = createSignal<Session | null>(null)
    const [sessionListVersion, setSessionListVersion] = createSignal(0)
    const [discussIssue, setDiscussIssue] = createSignal<DiscussIssue | null>(null)

    const eventListeners = new Set<EventListener>()
    const abortController = new AbortController()

    const updateDirectory = (dir: string) => {
        setDirectory(dir)
        setSelectedFile(null)
        setSelectedSession(null)
    }

    // 创建带认证的 fetch 函数
    const authenticatedFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers)

        if (props.serverInfo.password) {
            const credentials = btoa(`opencode:${props.serverInfo.password}`)
            headers.set("Authorization", `Basic ${credentials}`)
        }

        const dir = directory()
        if (dir) {
            headers.set("x-opencode-directory", encodeURIComponent(dir))
        }

        return fetch(input, {
            ...init,
            headers,
        })
    }

    // 创建 SDK 客户端（用于 API 请求）
    const client = createOpencodeClient({
        baseUrl: props.serverInfo.url,
        fetch: authenticatedFetch,
        throwOnError: true,
    })

    // 创建用于 SSE 的独立客户端（参考 global-sdk.tsx）
    const eventClient = createOpencodeClient({
        baseUrl: props.serverInfo.url,
        fetch: authenticatedFetch,
        signal: abortController.signal,
    })

    // 事件队列（用于合并高频事件，参考 global-sdk.tsx）
    type Queued = { directory: string; payload: Event }
    let queue: Array<Queued | undefined> = []
    const coalesced = new Map<string, number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    // 生成合并键
    const key = (dir: string, payload: Event): string | undefined => {
        if (payload.type === "session.status") return `session.status:${dir}:${(payload as any).properties?.sessionID}`
        if (payload.type === "lsp.updated") return `lsp.updated:${dir}`
        if (payload.type === "message.part.updated") {
            const part = (payload as any).properties?.part
            return `message.part.updated:${dir}:${part?.messageID}:${part?.id}`
        }
        return undefined
    }

    // 刷新事件队列
    const flush = () => {
        if (timer) clearTimeout(timer)
        timer = undefined

        const events = queue
        queue = []
        coalesced.clear()
        if (events.length === 0) return

        last = Date.now()
        batch(() => {
            for (const event of events) {
                if (!event) continue
                for (const listener of eventListeners) {
                    try {
                        listener(event.payload, event.directory)
                    } catch (e) {
                        console.error("事件处理器错误:", e)
                    }
                }
            }
        })
    }

    // 调度刷新
    const schedule = () => {
        if (timer) return
        const elapsed = Date.now() - last
        timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    // 停止事件流
    const stop = () => {
        flush()
    }

    // 使用 SDK 内置的 SSE 客户端（参考 global-sdk.tsx）
    console.log("正在连接 SSE:", `${props.serverInfo.url}/global/event`)

    void (async () => {
        try {
            const events = await eventClient.global.event()
            console.log("SSE 连接成功!")

            let yielded = Date.now()
            for await (const event of events.stream) {
                console.log("=== SSE 原始事件 ===")
                console.log("  原始 event:", JSON.stringify(event, null, 2))

                const eventDirectory = event.directory ?? "global"
                const payload = event.payload as Event

                console.log("  解析后 directory:", eventDirectory)
                console.log("  解析后 payload.type:", payload?.type)
                console.log("  解析后 payload:", JSON.stringify(payload, null, 2))

                // 事件合并（高频事件优化）
                const k = key(eventDirectory, payload)
                if (k) {
                    const i = coalesced.get(k)
                    if (i !== undefined) {
                        queue[i] = undefined
                    }
                    coalesced.set(k, queue.length)
                }
                queue.push({ directory: eventDirectory, payload })
                schedule()

                // 让出执行权（避免阻塞 UI）
                if (Date.now() - yielded < 8) continue
                yielded = Date.now()
                await new Promise<void>((resolve) => setTimeout(resolve, 0))
            }
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                console.log("SSE 连接已被中断")
                return
            }
            console.error("SSE 连接错误:", error)
        }
    })()
        .finally(stop)
        .catch(() => undefined)

    const subscribeToEvents = (callback: EventListener): (() => void) => {
        eventListeners.add(callback)
        return () => {
            eventListeners.delete(callback)
        }
    }

    onCleanup(() => {
        abortController.abort()
        stop()
        eventListeners.clear()
    })

    const contextValue: SDKContextType = {
        client,
        serverInfo: props.serverInfo,
        directory,
        setDirectory: updateDirectory,
        selectedFile,
        setSelectedFile,
        selectedSession,
        setSelectedSession,
        sessionListVersion,
        refreshSessionList: () => setSessionListVersion((value) => value + 1),
        subscribeToEvents,
        discussIssue,
        setDiscussIssue,
    }

    return (
        <SDKContext.Provider value={contextValue}>
            {props.children}
        </SDKContext.Provider>
    )
}
