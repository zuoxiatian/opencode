import { createSignal, For, Show, createEffect, on } from "solid-js"
import { useSDK } from "../context/sdk"

// 审核结果类型
export interface AuditIssue {
    id: string
    documentId: string
    type: string
    severity: "critical" | "major" | "minor" | "info"
    title: string
    description: string
    matchedText?: string
    position?: {
        page: number
        paragraph: number
        charStart: number
        charEnd: number
    }
    suggestion?: string
    confidence: number
    status: "pending" | "resolved" | "ignored"
    discoveredAt: number
}

interface ResultsPanelProps {
    onIssueClick?: (issue: AuditIssue) => void
    onDiscussIssue?: (issue: AuditIssue) => void
}

export function ResultsPanel(props: ResultsPanelProps) {
    const sdk = useSDK()
    const [issues, setIssues] = createSignal<AuditIssue[]>([])
    const [isLoading, setIsLoading] = createSignal(false)
    const [expanded, setExpanded] = createSignal(true)
    const [selectedIssueId, setSelectedIssueId] = createSignal<string | null>(null)

    // 当选中文件变化时加载审核结果
    createEffect(on(() => sdk.selectedFile(), async (file) => {
        if (file && !file.isDirectory && file.path.endsWith('.pdf')) {
            await loadAuditResults(file.path)
        } else {
            setIssues([])
        }
    }))

    const loadAuditResults = async (filePath: string) => {
        setIsLoading(true)
        try {
            // 构建审核结果目录路径: {filePath}.audit/issues/
            const auditDir = `${filePath}.audit/issues`

            // 读取目录中的所有 JSON 文件
            const fileList = await window.electronAPI.readDirectory(auditDir)

            const loadedIssues: AuditIssue[] = []

            for (const file of fileList) {
                if (file.name.endsWith('.json')) {
                    const result = await window.electronAPI.readFile(file.path)
                    if (result.success && result.content) {
                        try {
                            const issue = JSON.parse(result.content) as AuditIssue
                            loadedIssues.push(issue)
                        } catch (e) {
                            console.error("解析审核结果失败:", file.path, e)
                        }
                    }
                }
            }

            // 按页码排序
            loadedIssues.sort((a, b) => {
                const pageA = a.position?.page || 0
                const pageB = b.position?.page || 0
                return pageA - pageB
            })

            setIssues(loadedIssues)
        } catch (error) {
            console.error("加载审核结果失败:", error)
            setIssues([])
        } finally {
            setIsLoading(false)
        }
    }

    const getSeverityIcon = (severity: string) => {
        switch (severity) {
            case "critical": return "🔴"
            case "major": return "🟠"
            case "minor": return "🟡"
            case "info": return "🔵"
            default: return "⚪"
        }
    }

    const getSeverityLabel = (severity: string) => {
        switch (severity) {
            case "critical": return "严重"
            case "major": return "重要"
            case "minor": return "轻微"
            case "info": return "提示"
            default: return "未知"
        }
    }

    const getTypeLabel = (type: string) => {
        const types: Record<string, string> = {
            "typo": "错别字",
            "grammar": "语法",
            "format": "格式",
            "content": "内容",
            "style": "样式",
            "missing": "缺失",
            "duplicate": "重复",
        }
        return types[type] || type
    }

    const handleIssueClick = (issue: AuditIssue) => {
        setSelectedIssueId(issue.id)
        props.onIssueClick?.(issue)
    }

    // 采用按钮（占位）
    const handleAccept = async (e: MouseEvent, issue: AuditIssue) => {
        e.stopPropagation() // 阻止触发点击事件
        console.log("采用审核结果:", issue.id)
        // TODO: 实现采用功能
    }

    // 讨论按钮 - 与 AI 助手讨论此问题
    const handleDiscuss = (e: MouseEvent, issue: AuditIssue) => {
        e.stopPropagation() // 阻止触发点击事件
        // 使用 SDK Context 设置讨论问题
        sdk.setDiscussIssue({
            id: issue.id,
            type: issue.type,
            severity: issue.severity,
            title: issue.title,
            description: issue.description,
            matchedText: issue.matchedText,
            suggestion: issue.suggestion,
            position: issue.position,
        })
    }

    // 删除审核结果
    const handleDelete = async (e: MouseEvent, issue: AuditIssue) => {
        e.stopPropagation() // 阻止触发点击事件

        const selectedFile = sdk.selectedFile()
        if (!selectedFile) return

        try {
            // 构建文件路径: {pdfPath}.audit/issues/{issueId}.json
            const issueFilePath = `${selectedFile.path}.audit/issues/${issue.id}.json`

            // 删除文件
            const result = await window.electronAPI.deleteFile(issueFilePath)

            if (result.success) {
                // 从列表中移除
                setIssues(prev => prev.filter(i => i.id !== issue.id))
                console.log("删除审核结果成功:", issue.id)
            } else {
                console.error("删除失败:", result.error)
            }
        } catch (error) {
            console.error("删除审核结果失败:", error)
        }
    }

    const getStatsSummary = () => {
        const stats = {
            critical: 0,
            major: 0,
            minor: 0,
            info: 0
        }
        issues().forEach(issue => {
            if (issue.severity in stats) {
                stats[issue.severity as keyof typeof stats]++
            }
        })
        return stats
    }

    return (
        <div class="results-panel">
            {/* 头部 */}
            <div class="results-header" onClick={() => setExpanded(!expanded())}>
                <div class="results-title">
                    <span class="results-icon">📋</span>
                    <span>审核结果</span>
                    <Show when={issues().length > 0}>
                        <span class="results-count">{issues().length}</span>
                    </Show>
                </div>
                <button class="expand-btn" title={expanded() ? "收起" : "展开"}>
                    <span class={`expand-icon ${expanded() ? "expanded" : ""}`}>▼</span>
                </button>
            </div>

            {/* 内容 */}
            <Show when={expanded()}>
                <div class="results-content">
                    <Show when={isLoading()}>
                        <div class="results-loading">
                            <span>加载中...</span>
                        </div>
                    </Show>

                    <Show when={!isLoading() && issues().length === 0}>
                        <div class="results-empty">
                            <div class="empty-icon">✅</div>
                            <div class="empty-text">暂无审核问题</div>
                            <div class="empty-hint">选择一个 PDF 文件查看审核结果</div>
                        </div>
                    </Show>

                    <Show when={!isLoading() && issues().length > 0}>
                        {/* 统计摘要 */}
                        <div class="results-summary">
                            {(() => {
                                const stats = getStatsSummary()
                                return (
                                    <>
                                        <Show when={stats.critical > 0}>
                                            <span class="stat-item critical">🔴 {stats.critical}</span>
                                        </Show>
                                        <Show when={stats.major > 0}>
                                            <span class="stat-item major">🟠 {stats.major}</span>
                                        </Show>
                                        <Show when={stats.minor > 0}>
                                            <span class="stat-item minor">🟡 {stats.minor}</span>
                                        </Show>
                                        <Show when={stats.info > 0}>
                                            <span class="stat-item info">🔵 {stats.info}</span>
                                        </Show>
                                    </>
                                )
                            })()}
                        </div>

                        {/* 问题列表 */}
                        <div class="results-list">
                            <For each={issues()}>
                                {(issue) => (
                                    <div
                                        class={`result-item ${issue.severity} ${selectedIssueId() === issue.id ? "selected" : ""}`}
                                        onClick={() => handleIssueClick(issue)}
                                    >
                                        <div class="result-item-header">
                                            <span class="severity-icon">{getSeverityIcon(issue.severity)}</span>
                                            <span class="result-title">{issue.title}</span>
                                            <Show when={issue.position?.page}>
                                                <span class="result-page">P{issue.position?.page}</span>
                                            </Show>
                                        </div>
                                        <div class="result-item-body">
                                            {/* 原文显示 */}
                                            <Show when={issue.matchedText}>
                                                <div class="result-matched-text">
                                                    <span class="matched-text-icon">📝</span>
                                                    <span class="matched-text-content">"{issue.matchedText}"</span>
                                                </div>
                                            </Show>
                                            <div class="result-description">{issue.description}</div>
                                            <div class="result-meta">
                                                <span class="result-type">{getTypeLabel(issue.type)}</span>
                                                <span class="result-severity">{getSeverityLabel(issue.severity)}</span>
                                            </div>
                                        </div>
                                        <Show when={issue.suggestion}>
                                            <div class="result-suggestion">
                                                <span class="suggestion-icon">💡</span>
                                                <span>{issue.suggestion}</span>
                                            </div>
                                        </Show>
                                        {/* 操作按钮 */}
                                        <div class="result-actions">
                                            <button
                                                class="result-action-btn accept"
                                                onClick={(e) => handleAccept(e, issue)}
                                                title="采用此建议"
                                            >
                                                ✅ 采用
                                            </button>
                                            <button
                                                class="result-action-btn delete"
                                                onClick={(e) => handleDelete(e, issue)}
                                                title="删除此结果"
                                            >
                                                🗑️ 删除
                                            </button>
                                            <button
                                                class="result-action-btn discuss"
                                                onClick={(e) => handleDiscuss(e, issue)}
                                                title="与 AI 讨论此问题"
                                            >
                                                💬 讨论
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
            </Show>
        </div>
    )
}
