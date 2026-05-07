/* @refresh reload */
import { render } from "solid-js/web"
import { createSignal, onMount, Show } from "solid-js"
import "@opencode-ai/ui/styles"
import "./index.css"
import { App } from "./components/App"

// 服务器信息类型
interface ServerInfo {
    url: string
    password: string | null
}

function Root() {
    const [serverInfo, setServerInfo] = createSignal<ServerInfo | null>(null)
    const [isLoading, setIsLoading] = createSignal(true)

    onMount(async () => {
        // 监听服务器就绪事件
        window.electronAPI.onServerReady((info) => {
            console.log("服务器就绪:", info)
            setServerInfo(info)
            setIsLoading(false)
        })

        // 尝试获取已有的服务器信息
        const existingInfo = await window.electronAPI.getServerInfo()
        if (existingInfo) {
            setServerInfo(existingInfo)
            setIsLoading(false)
        }
    })

    return (
        <Show
            when={!isLoading()}
            fallback={
                <div class="welcome-screen">
                    <div class="welcome-title">LongwiseTechAgent</div>
                    <div class="welcome-subtitle">正在启动后端服务...</div>
                    <div class="status-indicator">
                        <span class="status-dot connecting"></span>
                        <span>连接中</span>
                    </div>
                </div>
            }
        >
            <Show
                when={serverInfo()}
                fallback={
                    <div class="welcome-screen">
                        <div class="welcome-title">连接失败</div>
                        <div class="welcome-subtitle">无法连接到后端服务</div>
                        <button class="btn btn-primary" onClick={() => window.electronAPI.restart()}>
                            重新启动
                        </button>
                    </div>
                }
            >
                {(info) => <App serverInfo={info()} />}
            </Show>
        </Show>
    )
}

const rootElement = document.getElementById("root")
if (rootElement) {
    render(() => <Root />, rootElement)
}
