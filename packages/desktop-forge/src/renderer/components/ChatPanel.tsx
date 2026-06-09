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
    Session,
    SessionStatus,
    TextPartInput,
} from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Markdown } from "@opencode-ai/ui/markdown"
import type { LucideIcon } from "lucide-solid"
import ArrowUp from "lucide-solid/icons/arrow-up"
import Brain from "lucide-solid/icons/brain"
import Check from "lucide-solid/icons/check"
import ChevronRight from "lucide-solid/icons/chevron-right"
import ChevronDown from "lucide-solid/icons/chevron-down"
import CircleAlert from "lucide-solid/icons/circle-alert"
import CircleCheck from "lucide-solid/icons/circle-check"
import CircleQuestionMark from "lucide-solid/icons/circle-question-mark"
import ClipboardCopy from "lucide-solid/icons/clipboard-copy"
import FileText from "lucide-solid/icons/file-text"
import Folder from "lucide-solid/icons/folder"
import FolderPlus from "lucide-solid/icons/folder-plus"
import Globe from "lucide-solid/icons/globe"
import ListChecks from "lucide-solid/icons/list-checks"
import MonitorCheck from "lucide-solid/icons/monitor-check"
import Package from "lucide-solid/icons/package"
import PanelLeftOpen from "lucide-solid/icons/panel-left-open"
import Pencil from "lucide-solid/icons/pencil"
import Plus from "lucide-solid/icons/plus"
import Puzzle from "lucide-solid/icons/puzzle"
import Search from "lucide-solid/icons/search"
import ShieldCheck from "lucide-solid/icons/shield-check"
import Square from "lucide-solid/icons/square"
import SquareTerminal from "lucide-solid/icons/square-terminal"
import Wrench from "lucide-solid/icons/wrench"
import { SessionPermissionDock, SessionQuestionDock } from "./SessionRequestDock"
import { isIMECompositionEvent } from "../lib/ime"
import type { ChatVisibilitySettings } from "../settings"

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

interface SkillOption {
    name: string
    description?: string
    location: string
}

interface ChatPanelProps {
    sidebarCollapsed?: boolean
    onOpenSidebar?: () => void
    chatVisibility: ChatVisibilitySettings
}

type PermissionMode = "default" | "auto"
type PermissionModeMap = Record<string, PermissionMode>
type MessagePageItem = { info?: Message; parts?: Part[] }
type MessagePage = { data: MessagePageItem[]; cursor?: string }

const LAST_PROJECT_STORAGE_KEY = "desktop-lxz.lastProjectFolder"
const PERMISSION_MODE_STORAGE_KEY = "desktop-lxz.permissionAutoAccept"
const PROJECT_ADDED_EVENT = "desktop-lxz.project-added"
const MESSAGE_HISTORY_PAGE_SIZE = 50
const MESSAGE_HISTORY_SCROLL_THRESHOLD = 48
const MESSAGE_AUTO_SCROLL_DESKTOP_VH = 0.1
const MESSAGE_AUTO_SCROLL_MIN_THRESHOLD = 48
const MESSAGE_PROGRAMMATIC_SCROLL_MS = 200
const MESSAGE_AUTO_FOLLOW_LERP = 0.18
const MESSAGE_AUTO_FOLLOW_SETTLE_EPSILON = 0.5
const MESSAGE_AUTO_FOLLOW_SETTLE_FRAMES = 4
const MESSAGE_AUTO_FOLLOW_SETTLE_BURST_MS = 280
const MESSAGE_AUTO_FOLLOW_REPIN_GRACE_MS = 1200
const MESSAGE_TOUCH_FINGER_DOWN_THRESHOLD = 2
const SKILL_MENTION_PATTERN = /(?:^|\s)\/(\S+)/g
const PERMISSION_MODE_OPTIONS = [
    { mode: "default", label: "默认权限", description: "遇到权限请求时手动确认" },
    { mode: "auto", label: "自动获取权限", description: "自动允许每次请求" },
] as const
type ToolPartView = Part & { type: "tool" }
type ToolStateView = ToolPartView["state"]
type QuestionInputOption = { label: string; description?: string }
type QuestionInputItem = {
    header?: string
    question: string
    options: QuestionInputOption[]
    multiple: boolean
}

const agentLabel = (name: string) => {
    if (name === "plan") return "计划"
    if (name === "build") return "执行"
    return name
}

const agentDescription = (agent: AgentOption) => {
    if (agent.name === "plan") return "先给方案，不执行操作"
    if (agent.name === "build") return "直接处理并执行操作"
    return agent.description || "使用此模式处理消息"
}

const agentIcon = (name: string): LucideIcon => {
    if (name === "plan") return ListChecks
    return MonitorCheck
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

const cleanSkillToken = (value: string) => value.replace(/[.,;:!?)]$/, "")

const collectInlineSkillMentions = (text: string, skillNames: Set<string>) => {
    SKILL_MENTION_PATTERN.lastIndex = 0
    return Array.from(text.matchAll(SKILL_MENTION_PATTERN))
        .map((match) => cleanSkillToken(match[1] ?? ""))
        .filter((name, index, items) => skillNames.has(name) && items.indexOf(name) === index)
}

const buildSkillMentionInstruction = (skillNames: string[]) => {
    if (skillNames.length === 0) return
    return `The user explicitly selected these skills in their message: ${skillNames.map((name) => `/${name}`).join(", ")}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`
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

function ReasoningBlock(props: { text: string; heading?: string; streaming?: boolean; cacheKey: string; time?: { start?: number; end?: number } }) {
    const [open, setOpen] = createSignal(false)
    const heading = createMemo(() => props.heading || reasoningHeading(props.text) || "")

    return (
        <div class="tool-calls chat-reasoning">
            <div class="tool-call-card" data-status={props.streaming ? "running" : "completed"} data-open={open() ? "true" : "false"}>
                <button
                    class="tool-call-summary"
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open()}
                    title={heading()}
                >
                    <span class="tool-call-leading">
                        <span class="tool-call-icon" aria-hidden="true">
                            <Brain class="tool-call-lucide" size={15} strokeWidth={1.9} />
                        </span>
                        <span class="tool-call-title">{props.streaming ? "思考中" : "思考"}</span>
                    </span>
                    <span class="tool-call-description">{heading()}</span>
                    <ToolDuration time={props.time} active={props.streaming === true} />
                    <ChevronRight class="tool-call-chevron" size={14} strokeWidth={1.9} />
                </button>
                <Show when={open()}>
                    <div class="tool-call-details chat-reasoning-details">
                        <Markdown
                            class="chat-reasoning-content"
                            text={props.text}
                            cacheKey={`${props.cacheKey}:reasoning`}
                            streaming={props.streaming}
                        />
                    </div>
                </Show>
            </div>
        </div>
    )
}

function cleanToolError(error: string) {
    return error.replace(/^Error:\s*/, "").trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)

const normalizeToolName = (tool: string) => {
    const value = tool.trim().toLowerCase()
    if (!value.includes(".")) return value
    return value.split(".").filter(Boolean).slice(-1)[0] ?? value
}

const toolLabel = (part: ToolPartView) => {
    if ("title" in part.state && typeof part.state.title === "string" && part.state.title.trim()) return part.state.title.trim()
    const labels: Record<string, string> = {
        apply_patch: "应用补丁",
        bash: "Shell 执行",
        codesearch: "代码搜索",
        create: "创建文件",
        edit: "编辑文件",
        file_read: "读取文件",
        file_write: "写入文件",
        glob: "查找文件",
        grep: "搜索文件",
        list: "列出目录",
        multiedit: "批量编辑",
        question: "问题",
        read: "读取文件",
        shell: "Shell 执行",
        task: "子任务",
        todoread: "读取待办",
        todowrite: "更新待办",
        webfetch: "访问网页",
        websearch: "网络搜索",
        write: "写入文件",
    }
    const normalized = normalizeToolName(part.tool)
    return labels[normalized] ?? part.tool
}

const toolIcon = (part: ToolPartView): LucideIcon => {
    const normalized = normalizeToolName(part.tool)
    const title = "title" in part.state && typeof part.state.title === "string" ? part.state.title.toLowerCase() : ""
    if (normalized === "bash" || normalized === "shell") return SquareTerminal
    if (normalized === "question") return CircleQuestionMark
    if (normalized === "skill" || title.includes("技能") || title.includes("skill")) return Puzzle
    if (normalized === "task") return Brain
    if (normalized === "edit" || normalized === "multiedit" || normalized === "apply_patch") return Pencil
    if (normalized === "write" || normalized === "create" || normalized === "file_write") return Pencil
    if (normalized === "read" || normalized === "file_read") return FileText
    if (normalized === "grep" || normalized === "glob" || normalized === "codesearch") return Search
    if (normalized === "webfetch" || normalized === "websearch") return Globe
    if (normalized === "todowrite" || normalized === "todoread") return ListChecks
    return Wrench
}

function ToolIcon(props: { part: ToolPartView; class?: string }) {
    return <Dynamic component={toolIcon(props.part)} class={props.class ?? "tool-call-lucide"} size={15} strokeWidth={1.9} />
}

const stringField = (record: Record<string, unknown> | undefined, keys: string[]) =>
    keys
        .map((key) => record?.[key])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?.trim()

const stateMetadata = (state: ToolStateView) => "metadata" in state ? state.metadata : undefined
const stateOutput = (state: ToolStateView) => "output" in state ? state.output : ""
const stateError = (state: ToolStateView) => "error" in state ? state.error : ""
const stateTime = (state: ToolStateView) => "time" in state ? state.time : undefined

const formatToolStatus = (status: ToolStateView["status"]) => {
    if (status === "pending") return "等待中"
    if (status === "running") return "执行中"
    if (status === "completed") return "已完成"
    return "出错"
}

const isToolActive = (state: ToolStateView) => state.status === "pending" || state.status === "running"

const isShellToolPart = (part: ToolPartView) => {
    const normalized = normalizeToolName(part.tool)
    return normalized === "bash" || normalized === "shell"
}

const isQuestionToolPart = (part: ToolPartView) => normalizeToolName(part.tool) === "question"

const activeToolStatusLabel = (part: ToolPartView) => {
    const label = toolLabel(part)
    if (label.endsWith("中")) return label
    return `${label}中`
}

const compactPath = (value: string) => {
    const parts = value.replace(/\\/g, "/").split("/").filter(Boolean)
    if (parts.length <= 3) return value
    return parts.slice(-3).join("/")
}

const metadataFileSummary = (metadata?: Record<string, unknown>) => {
    const files = Array.isArray(metadata?.files) ? metadata.files : []
    const paths = files
        .filter(isRecord)
        .map((file) => stringField(file, ["relativePath", "filePath", "path"]))
        .filter((path): path is string => Boolean(path))
    if (paths.length === 1) return compactPath(paths[0])
    if (paths.length > 1) return `${paths.length} 个文件`
}

const shellCommand = (input: Record<string, unknown>) => {
    if (typeof input.command === "string") return input.command
    return stringField(input, ["cmd", "command_line"])
}

const toolDescription = (part: ToolPartView) => {
    const input = part.state.input
    const metadata = stateMetadata(part.state)
    const normalized = normalizeToolName(part.tool)
    const file = metadataFileSummary(metadata) ?? stringField(input, ["filePath", "file_path", "path", "sourcePath", "targetPath"])
    if (file) return compactPath(file)
    if (normalized === "question" && Array.isArray(input.questions)) return `${input.questions.length} 个问题`
    if ((normalized === "bash" || normalized === "shell") && shellCommand(input)) return shellCommand(input)?.split("\n")[0].slice(0, 120)
    if (normalized === "task") return stringField(input, ["description", "prompt"])?.slice(0, 120)
    if (normalized === "webfetch") return stringField(input, ["url"])
    if (normalized === "websearch" || normalized === "codesearch") return stringField(input, ["query"])
    if (normalized === "grep") return stringField(input, ["pattern"])
    if (normalized === "glob") return stringField(input, ["pattern"])
    return stringField(input, ["description", "title"]) ?? stringField(metadata, ["description", "title"])
}

const formatDuration = (start: number, end = Date.now()) => {
    const seconds = Math.max(0, (end - start) / 1000)
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

const partScrollSignature = (part: Part) => {
    if (part.type === "text" || part.type === "reasoning") return `${part.id}:${part.type}:${part.text.length}:${part.time?.end ?? ""}`
    if (part.type === "tool") {
        return `${part.id}:${part.type}:${part.state.status}:${stateOutput(part.state).length}:${stateError(part.state).length}`
    }
    return `${part.id}:${part.type}`
}

const messagesBottomThreshold = (element: HTMLElement) =>
    Math.max(MESSAGE_AUTO_SCROLL_MIN_THRESHOLD, element.clientHeight * MESSAGE_AUTO_SCROLL_DESKTOP_VH)

const nestedScrollableTarget = (root: HTMLElement, target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const nested = target.closest("[data-scrollable]")
    if (!nested || nested === root || !(nested instanceof HTMLElement)) return null
    return nested
}

const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null) => {
    const nested = nestedScrollableTarget(root, target)
    return Boolean(nested && nested.scrollTop > 0)
}

const isReleaseKey = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return false
    return event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home"
}

function ToolDuration(props: { time?: { start?: number; end?: number }; active: boolean }) {
    const [now, setNow] = createSignal(Date.now())
    createEffect(() => {
        if (!props.active) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(timer))
    })
    const text = createMemo(() => typeof props.time?.start === "number" ? formatDuration(props.time.start, props.time.end ?? now()) : "")
    return <Show when={text()}>{(value) => <span class="tool-call-duration">{value()}</span>}</Show>
}

const formatToolInput = (input: Record<string, unknown>, tool: string) => {
    const normalized = normalizeToolName(tool)
    if (normalized === "bash" || normalized === "shell") return shellCommand(input) ?? ""
    if (typeof input.content === "string") return input.content
    const entries = Object.entries(input).filter((entry) => entry[1] !== undefined)
    if (entries.length === 0) return ""
    return JSON.stringify(Object.fromEntries(entries), null, 2) ?? ""
}

const parseQuestionInput = (input: Record<string, unknown>): QuestionInputItem[] => {
    if (!Array.isArray(input.questions)) return []
    return input.questions
        .filter(isRecord)
        .map((question) => ({
            header: stringField(question, ["header"]),
            question: stringField(question, ["question"]) ?? stringField(question, ["header"]) ?? "问题",
            options: Array.isArray(question.options)
                ? question.options
                    .filter(isRecord)
                    .map((option) => ({
                        label: stringField(option, ["label"]) ?? "",
                        description: stringField(option, ["description"]),
                    }))
                    .filter((option) => option.label.length > 0)
                : [],
            multiple: question.multiple === true,
        }))
}

const parseQuestionOutput = (output: string) => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s)
    if (!match?.[1]) return []
    return Array.from(match[1].matchAll(/"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g)).map((item) => ({
        question: item[1],
        answer: item[2],
    }))
}

const hasToolDetails = (part: ToolPartView) => {
    const output = stateOutput(part.state)
    const error = stateError(part.state)
    if (normalizeToolName(part.tool) === "question") return true
    if (normalizeToolName(part.tool) === "bash" || normalizeToolName(part.tool) === "shell") return true
    if (error.trim().length > 0 || output.trim().length > 0) return true
    return Object.keys(part.state.input).length > 0
}

function CopyToolTextButton(props: { text: string }) {
    const [copied, setCopied] = createSignal(false)
    let resetTimer: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => {
        if (resetTimer) clearTimeout(resetTimer)
    })
    const copy = (event: MouseEvent) => {
        event.stopPropagation()
        if (!props.text || !navigator.clipboard) return
        void navigator.clipboard.writeText(props.text).then(() => {
            if (resetTimer) clearTimeout(resetTimer)
            setCopied(true)
            resetTimer = setTimeout(() => setCopied(false), 1600)
        }).catch(() => undefined)
    }
    return (
        <button class="tool-copy-btn" type="button" onClick={copy} title={copied() ? "已复制" : "复制"}>
            <Show when={copied()} fallback={<ClipboardCopy class="tool-copy-icon" size={14} strokeWidth={1.9} />}>
                <Check class="tool-copy-icon" size={14} strokeWidth={2.1} />
            </Show>
        </button>
    )
}

function ToolCodeBlock(props: { children: string; tone?: "default" | "error" }) {
    return <pre class="tool-code-block" data-scrollable data-tone={props.tone ?? "default"}>{props.children}</pre>
}

function ShellToolDetails(props: { part: ToolPartView }) {
    const [outputOpen, setOutputOpen] = createSignal(false)
    const command = createMemo(() => shellCommand(props.part.state.input) ?? "")
    const output = createMemo(() => stateOutput(props.part.state))
    const error = createMemo(() => stateError(props.part.state))
    return (
        <div class="tool-detail-stack">
            <Show when={command()}>
                {(value) => (
                    <section class="tool-detail-section">
                        <div class="tool-detail-heading">命令</div>
                        <ToolCodeBlock>{value()}</ToolCodeBlock>
                    </section>
                )}
            </Show>
            <Show when={output().trim().length > 0}>
                <section class="tool-detail-section">
                    <div class="tool-output-header">
                        <span class="tool-detail-heading">输出</span>
                        <div class="tool-output-actions">
                            <button class="tool-output-toggle" type="button" onClick={() => setOutputOpen((value) => !value)}>
                                {outputOpen() ? "隐藏输出" : "显示输出"}
                            </button>
                            <CopyToolTextButton text={output()} />
                        </div>
                    </div>
                    <Show when={outputOpen()}>
                        <ToolCodeBlock>{output()}</ToolCodeBlock>
                    </Show>
                </section>
            </Show>
            <Show when={error().trim()}>
                {(value) => (
                    <section class="tool-detail-section">
                        <div class="tool-detail-heading">错误</div>
                        <ToolCodeBlock tone="error">{cleanToolError(value())}</ToolCodeBlock>
                    </section>
                )}
            </Show>
        </div>
    )
}

function QuestionToolDetails(props: { part: ToolPartView }) {
    const questions = createMemo(() => parseQuestionInput(props.part.state.input))
    const answers = createMemo(() => parseQuestionOutput(stateOutput(props.part.state)))
    const error = createMemo(() => stateError(props.part.state))
    return (
        <div class="tool-detail-stack">
            <Show when={answers().length > 0}>
                <section class="tool-detail-section">
                    <div class="tool-detail-heading">已回答</div>
                    <div class="tool-question-list">
                        <For each={answers()}>
                            {(answer) => (
                                <div class="tool-question-item">
                                    <div class="tool-question-text">{answer.question}</div>
                                    <div class="tool-answer-text">{answer.answer}</div>
                                </div>
                            )}
                        </For>
                    </div>
                </section>
            </Show>
            <Show when={questions().length > 0}>
                <section class="tool-detail-section">
                    <div class="tool-detail-heading">问题</div>
                    <div class="tool-question-list">
                        <For each={questions()}>
                            {(question) => (
                                <div class="tool-question-item">
                                    <Show when={question.header}>
                                        {(value) => <div class="tool-question-header">{value()}</div>}
                                    </Show>
                                    <div class="tool-question-text">{question.question}</div>
                                    <Show when={question.options.length > 0}>
                                        <div class="tool-question-options">
                                            <For each={question.options}>
                                                {(option) => <span class="tool-question-option">{option.label}</span>}
                                            </For>
                                            <Show when={question.multiple}>
                                                <span class="tool-question-option" data-muted="true">多选</span>
                                            </Show>
                                        </div>
                                    </Show>
                                </div>
                            )}
                        </For>
                    </div>
                </section>
            </Show>
            <Show when={error().trim()}>
                {(value) => (
                    <section class="tool-detail-section">
                        <div class="tool-detail-heading">错误</div>
                        <ToolCodeBlock tone="error">{cleanToolError(value())}</ToolCodeBlock>
                    </section>
                )}
            </Show>
            <Show when={questions().length === 0 && answers().length === 0 && !error()}>
                <div class="tool-empty-detail">等待用户回答</div>
            </Show>
        </div>
    )
}

function GenericToolDetails(props: { part: ToolPartView }) {
    const inputText = createMemo(() => formatToolInput(props.part.state.input, props.part.tool))
    const output = createMemo(() => stateOutput(props.part.state))
    const error = createMemo(() => stateError(props.part.state))
    return (
        <div class="tool-detail-stack">
            <Show when={inputText().trim().length > 0}>
                <section class="tool-detail-section">
                    <div class="tool-detail-heading">输入</div>
                    <ToolCodeBlock>{inputText()}</ToolCodeBlock>
                </section>
            </Show>
            <Show when={output().trim().length > 0}>
                <section class="tool-detail-section">
                    <div class="tool-output-header">
                        <span class="tool-detail-heading">输出</span>
                        <CopyToolTextButton text={output()} />
                    </div>
                    <ToolCodeBlock>{output()}</ToolCodeBlock>
                </section>
            </Show>
            <Show when={error().trim()}>
                {(value) => (
                    <section class="tool-detail-section">
                        <div class="tool-detail-heading">错误</div>
                        <ToolCodeBlock tone="error">{cleanToolError(value())}</ToolCodeBlock>
                    </section>
                )}
            </Show>
            <Show when={!inputText().trim() && !output().trim() && !error().trim()}>
                <div class="tool-empty-detail">暂无可展示内容</div>
            </Show>
        </div>
    )
}

function ToolCallDetails(props: { part: ToolPartView }) {
    const normalized = createMemo(() => normalizeToolName(props.part.tool))
    return (
        <Show
            when={normalized() === "question"}
            fallback={
                <Show when={normalized() === "bash" || normalized() === "shell"} fallback={<GenericToolDetails part={props.part} />}>
                    <ShellToolDetails part={props.part} />
                </Show>
            }
        >
            <QuestionToolDetails part={props.part} />
        </Show>
    )
}

function ToolCallBlock(props: { part: ToolPartView }) {
    const [open, setOpen] = createSignal(false)
    const status = createMemo(() => props.part.state.status)
    const active = createMemo(() => isToolActive(props.part.state))
    const details = createMemo(() => hasToolDetails(props.part))
    const description = createMemo(() => toolDescription(props.part))
    const toggle = () => {
        if (!details()) return
        setOpen((value) => !value)
    }
    return (
        <div class="tool-call-card" data-status={status()} data-open={open() ? "true" : "false"}>
            <button
                class="tool-call-summary"
                type="button"
                onClick={toggle}
                aria-expanded={details() ? open() : undefined}
                aria-disabled={!details()}
                title={description() ?? ""}
            >
                <span class="tool-call-leading">
                    <span class="tool-call-icon" aria-hidden="true">
                        <ToolIcon part={props.part} />
                    </span>
                    <span class="tool-call-title">{toolLabel(props.part)}</span>
                </span>
                <span class="tool-call-description">{description() ?? ""}</span>
                <ToolDuration time={stateTime(props.part.state)} active={active()} />
                <span class="tool-call-status">
                    <Show when={status() === "error"} fallback={formatToolStatus(status())}>
                        <CircleAlert class="tool-call-status-icon" size={13} strokeWidth={2} />
                        <span>{formatToolStatus(status())}</span>
                    </Show>
                </span>
                <Show when={details()}>
                    <ChevronRight class="tool-call-chevron" size={14} strokeWidth={1.9} />
                </Show>
            </button>
            <Show when={details() && open()}>
                <div class="tool-call-details">
                    <ToolCallDetails part={props.part} />
                </div>
            </Show>
        </div>
    )
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

export function ChatPanel(props: ChatPanelProps) {
    const sdk = useSDK()
    const [inputText, setInputText] = createSignal("")
    const [agents, setAgents] = createSignal<AgentOption[]>([])
    const [modelOptions, setModelOptions] = createSignal<ModelOption[]>([])
    const [skillOptions, setSkillOptions] = createSignal<SkillOption[]>([])
    const [skillsLoading, setSkillsLoading] = createSignal(false)
    let skillOptionsRequest = 0
    const [projectOptions, setProjectOptions] = createSignal<Project[]>([])
    const [projectSearch, setProjectSearch] = createSignal("")
    const [currentAgent, setCurrentAgent] = createSignal("build")
    const [currentModel, setCurrentModel] = createSignal<ModelSelection | null>(null)
    const [showAddMenu, setShowAddMenu] = createSignal(false)
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
    const [historyCursors, setHistoryCursors] = createSignal<Record<string, string | undefined>>({})
    const [historyLoadingSessions, setHistoryLoadingSessions] = createSignal<Set<string>>(new Set())
    const loadedSessions = new Set<string>()
    const loadingSessions = new Set<string>()
    const autoRespondingPermissions = new Set<string>()
    let messagesContainer: HTMLDivElement | undefined
    let messagesTimeline: HTMLDivElement | undefined
    let preservingHistoryScroll = false
    let historyScrollFrame: number | undefined
    let autoScrollFrame: number | undefined
    let autoFollowFrame: number | undefined
    let autoSettleFrame: number | undefined
    let autoFollowSettledFrames = 0
    let messagesResizeObserver: ResizeObserver | undefined
    let shouldAutoFollowMessages = true
    let lastMessagesScrollTop = 0
    let lastUserReleaseAt = 0
    let programmaticScrollUntil = 0
    let detachMessagesIntentListeners: (() => void) | undefined
    let chatInputComposing = false
    let chatInputCompositionEndTimer: ReturnType<typeof setTimeout> | undefined
    let chatInputElement: HTMLTextAreaElement | undefined

    const resizeChatInput = (element = chatInputElement) => {
        if (!element) return
        element.style.height = "0px"
        const maxHeight = Number.parseFloat(getComputedStyle(element).maxHeight)
        const height = Math.min(element.scrollHeight, Number.isFinite(maxHeight) ? maxHeight : element.scrollHeight)
        element.style.height = `${height}px`
        element.style.overflowY = element.scrollHeight > height ? "auto" : "hidden"
    }

    // 当前选中的会话 ID 派生自 SDK 的 selectedSession
    const currentSessionId = createMemo<string | null>(() => sdk.selectedSession()?.id ?? null)

    const currentPermissionMode = createMemo<PermissionMode>(() => {
        const sid = currentSessionId()
        return sid ? permissionModes()[sid] ?? "default" : newSessionPermissionMode()
    })

    const currentPermissionModeInfo = createMemo(() => permissionModeInfo(currentPermissionMode()))

    const historyMore = createMemo(() => {
        const sid = currentSessionId()
        return sid ? Boolean(historyCursors()[sid]) : false
    })

    const historyLoading = createMemo(() => {
        const sid = currentSessionId()
        return sid ? historyLoadingSessions().has(sid) : false
    })

    const setHistoryLoading = (sessionId: string, loading: boolean) => {
        setHistoryLoadingSessions((prev) => {
            if (loading) return prev.has(sessionId) ? prev : new Set(prev).add(sessionId)
            if (!prev.has(sessionId)) return prev
            return new Set([...prev].filter((item) => item !== sessionId))
        })
    }

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
            setShowAddMenu(false)
            setShowProjectMenu(false)
            setShowAgentMenu(false)
            setShowModelMenu(false)
        }
        setShowPermissionMenu(open)
    }

    const setProjectMenuOpen = (open: boolean) => {
        if (open) {
            setShowAddMenu(false)
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
            setShowAddMenu(false)
            setShowProjectMenu(false)
            setShowPermissionMenu(false)
            setShowModelMenu(false)
        }
        setShowAgentMenu(open)
    }

    const setModelMenuOpen = (open: boolean) => {
        if (modelOptions().length <= 1) {
            setShowModelMenu(false)
            return
        }
        if (open) {
            setShowAddMenu(false)
            setShowProjectMenu(false)
            setShowPermissionMenu(false)
            setShowAgentMenu(false)
        }
        setShowModelMenu(open)
    }

    const setAddMenuOpen = (open: boolean) => {
        if (open) {
            setShowProjectMenu(false)
            setShowPermissionMenu(false)
            setShowAgentMenu(false)
            setShowModelMenu(false)
            void loadSkillOptions()
        }
        setShowAddMenu(open)
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

    const scrollNow = () => typeof performance !== "undefined" ? performance.now() : Date.now()

    const markProgrammaticScroll = () => {
        programmaticScrollUntil = scrollNow() + MESSAGE_PROGRAMMATIC_SCROLL_MS
    }

    const isProgrammaticScroll = () => scrollNow() < programmaticScrollUntil

    const canRepinMessagesAutoFollow = () => scrollNow() - lastUserReleaseAt >= MESSAGE_AUTO_FOLLOW_REPIN_GRACE_MS

    const stopAutoFollowLoop = () => {
        if (autoFollowFrame !== undefined) cancelAnimationFrame(autoFollowFrame)
        autoFollowFrame = undefined
        autoFollowSettledFrames = 0
    }

    const stopAutoSettleBurst = () => {
        if (autoSettleFrame !== undefined) cancelAnimationFrame(autoSettleFrame)
        autoSettleFrame = undefined
    }

    const messagesMaxScrollTop = () => {
        if (!messagesContainer) return 0
        return Math.max(0, messagesContainer.scrollHeight - messagesContainer.clientHeight)
    }

    const writeMessagesScrollTop = (target: number) => {
        if (!messagesContainer) return
        markProgrammaticScroll()
        messagesContainer.scrollTop = Math.max(0, Math.min(target, messagesMaxScrollTop()))
        lastMessagesScrollTop = messagesContainer.scrollTop
    }

    // 滚动到底部
    const scrollToBottom = () => {
        shouldAutoFollowMessages = true
        lastUserReleaseAt = 0
        writeMessagesScrollTop(messagesMaxScrollTop())
    }

    const isNearBottom = () => {
        if (!messagesContainer) return true
        return messagesMaxScrollTop() - messagesContainer.scrollTop <= messagesBottomThreshold(messagesContainer)
    }

    const startAutoSettleBurst = () => {
        if (!messagesContainer) return
        stopAutoSettleBurst()
        const until = scrollNow() + MESSAGE_AUTO_FOLLOW_SETTLE_BURST_MS
        const tick = () => {
            autoSettleFrame = undefined
            if (!messagesContainer || preservingHistoryScroll || !shouldAutoFollowMessages) return
            writeMessagesScrollTop(messagesMaxScrollTop())
            if (scrollNow() < until) autoSettleFrame = requestAnimationFrame(tick)
        }
        autoSettleFrame = requestAnimationFrame(tick)
    }

    const tickAutoFollow = () => {
        autoFollowFrame = undefined
        if (!messagesContainer || preservingHistoryScroll || !shouldAutoFollowMessages || !isBusy()) {
            stopAutoFollowLoop()
            return
        }
        const target = messagesMaxScrollTop()
        const delta = target - messagesContainer.scrollTop
        if (Math.abs(delta) <= MESSAGE_AUTO_FOLLOW_SETTLE_EPSILON) {
            if (messagesContainer.scrollTop !== target) writeMessagesScrollTop(target)
            autoFollowSettledFrames += 1
            if (autoFollowSettledFrames >= MESSAGE_AUTO_FOLLOW_SETTLE_FRAMES) {
                stopAutoFollowLoop()
                return
            }
            autoFollowFrame = requestAnimationFrame(tickAutoFollow)
            return
        }
        autoFollowSettledFrames = 0
        writeMessagesScrollTop(messagesContainer.scrollTop + delta * MESSAGE_AUTO_FOLLOW_LERP)
        autoFollowFrame = requestAnimationFrame(tickAutoFollow)
    }

    const startAutoFollowLoop = () => {
        if (!messagesContainer || preservingHistoryScroll || !shouldAutoFollowMessages) return
        if (!isBusy()) {
            startAutoSettleBurst()
            return
        }
        if (autoFollowFrame !== undefined) return
        autoFollowSettledFrames = 0
        autoFollowFrame = requestAnimationFrame(tickAutoFollow)
    }

    const releaseMessagesAutoFollow = () => {
        lastUserReleaseAt = scrollNow()
        shouldAutoFollowMessages = false
        stopAutoFollowLoop()
        stopAutoSettleBurst()
    }

    const releaseFromMessagesIntent = () => {
        if (shouldAutoFollowMessages) {
            releaseMessagesAutoFollow()
            return
        }
        lastUserReleaseAt = scrollNow()
    }

    const resumeMessagesAutoFollow = () => {
        shouldAutoFollowMessages = true
        lastUserReleaseAt = 0
        scheduleScrollToBottom()
    }

    const scheduleScrollToBottom = () => {
        if (!messagesContainer || preservingHistoryScroll || !shouldAutoFollowMessages) return
        if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame)
        autoScrollFrame = requestAnimationFrame(() => {
            autoScrollFrame = undefined
            if (!messagesContainer || preservingHistoryScroll || !shouldAutoFollowMessages) return
            if (isBusy()) {
                startAutoFollowLoop()
                return
            }
            scrollToBottom()
            startAutoSettleBurst()
        })
    }

    const resetMessagesResizeObserver = () => {
        messagesResizeObserver?.disconnect()
        messagesResizeObserver = undefined
        if (typeof ResizeObserver === "undefined") return
        messagesResizeObserver = new ResizeObserver(() => {
            if (preservingHistoryScroll || !shouldAutoFollowMessages) return
            scheduleScrollToBottom()
        })
        if (messagesContainer) messagesResizeObserver.observe(messagesContainer)
        if (messagesTimeline) messagesResizeObserver.observe(messagesTimeline)
    }

    const bindMessagesIntentListeners = (element: HTMLDivElement) => {
        detachMessagesIntentListeners?.()
        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY >= 0) return
            if (nestedScrollableCanConsumeUp(element, event.target)) return
            releaseFromMessagesIntent()
        }
        let touchLastY: number | null = null
        const handleTouchStart = (event: TouchEvent) => {
            touchLastY = event.touches.item(0)?.clientY ?? null
        }
        const handleTouchMove = (event: TouchEvent) => {
            const touch = event.touches.item(0)
            if (!touch) {
                touchLastY = null
                return
            }
            const previousY = touchLastY
            touchLastY = touch.clientY
            if (previousY === null) return
            if (touch.clientY - previousY <= MESSAGE_TOUCH_FINGER_DOWN_THRESHOLD) return
            if (nestedScrollableCanConsumeUp(element, event.target)) return
            releaseFromMessagesIntent()
        }
        const handleTouchEnd = () => {
            touchLastY = null
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isReleaseKey(event)) releaseFromMessagesIntent()
        }
        element.addEventListener("wheel", handleWheel, { passive: true })
        element.addEventListener("touchstart", handleTouchStart, { passive: true })
        element.addEventListener("touchmove", handleTouchMove, { passive: true })
        element.addEventListener("touchend", handleTouchEnd, { passive: true })
        element.addEventListener("touchcancel", handleTouchEnd, { passive: true })
        element.addEventListener("keydown", handleKeyDown)
        detachMessagesIntentListeners = () => {
            element.removeEventListener("wheel", handleWheel)
            element.removeEventListener("touchstart", handleTouchStart)
            element.removeEventListener("touchmove", handleTouchMove)
            element.removeEventListener("touchend", handleTouchEnd)
            element.removeEventListener("touchcancel", handleTouchEnd)
            element.removeEventListener("keydown", handleKeyDown)
        }
    }

    const setMessagesContainerRef = (element: HTMLDivElement) => {
        if (messagesContainer === element) return
        messagesContainer = element
        lastMessagesScrollTop = element.scrollTop
        bindMessagesIntentListeners(element)
        resetMessagesResizeObserver()
        if (shouldAutoFollowMessages) scheduleScrollToBottom()
    }

    const setMessagesTimelineRef = (element: HTMLDivElement) => {
        messagesTimeline = element
        resetMessagesResizeObserver()
        if (shouldAutoFollowMessages) scheduleScrollToBottom()
    }

    onCleanup(() => {
        if (historyScrollFrame !== undefined) cancelAnimationFrame(historyScrollFrame)
        if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame)
        stopAutoFollowLoop()
        stopAutoSettleBurst()
        messagesResizeObserver?.disconnect()
        detachMessagesIntentListeners?.()
        if (chatInputCompositionEndTimer) clearTimeout(chatInputCompositionEndTimer)
    })

    const preserveMessagesScroll = (update: () => void) => {
        if (!messagesContainer) {
            update()
            return
        }
        const element = messagesContainer
        const scrollTop = element.scrollTop
        const scrollHeight = element.scrollHeight
        preservingHistoryScroll = true
        update()
        if (historyScrollFrame !== undefined) cancelAnimationFrame(historyScrollFrame)
        historyScrollFrame = requestAnimationFrame(() => {
            historyScrollFrame = undefined
            markProgrammaticScroll()
            element.scrollTop = scrollTop + element.scrollHeight - scrollHeight
            lastMessagesScrollTop = element.scrollTop
            preservingHistoryScroll = false
        })
    }

    const messageScrollSignature = createMemo(() =>
        messages()
            .map((message) => `${message.id}:${partsOf(message.id).map(partScrollSignature).join(",")}`)
            .join("|"),
    )

    // 消息列表或当前会话流式状态变化时滚动到底部
    createEffect(() => {
        messageScrollSignature()
        workingStatusText()
        if (preservingHistoryScroll) return
        if (!shouldAutoFollowMessages) {
            if (!isNearBottom() || !canRepinMessagesAutoFollow()) return
            shouldAutoFollowMessages = true
            lastUserReleaseAt = 0
        }
        scheduleScrollToBottom()
    })

    createEffect(() => {
        currentSessionId()
        queueMicrotask(resumeMessagesAutoFollow)
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

    const modelMenuAvailable = createMemo(() => modelOptions().length > 1)

    const skillNameSet = createMemo(() => new Set(skillOptions().map((skill) => skill.name)))

    const selectedSkillNames = createMemo(() => new Set(collectInlineSkillMentions(inputText(), skillNameSet())))

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
        const selectedSkills = collectInlineSkillMentions(text, skillNameSet())
        const skillInstruction = buildSkillMentionInstruction(selectedSkills)
        return [
            { id: createAscendingID("prt"), type: "text", text },
            ...(selectedFiles.length === 0 ? [] : [{
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
            } satisfies TextPartInput]),
            ...(skillInstruction ? [{
                id: createAscendingID("prt"),
                type: "text",
                text: skillInstruction,
                synthetic: true,
                metadata: { selectedSkills },
            } satisfies TextPartInput] : []),
        ]
    }

    const loadSkillOptions = async () => {
        const directory = sdk.directory()
        const request = ++skillOptionsRequest
        if (!directory) {
            setSkillOptions([])
            setSkillsLoading(false)
            return
        }

        setSkillsLoading(true)
        const result = await sdk.client.app.skills(undefined, { throwOnError: false })
            .catch((error) => {
                console.error("加载技能列表失败:", error)
                return undefined
            })
        if (request !== skillOptionsRequest || sdk.directory() !== directory) return
        setSkillsLoading(false)
        if (!result?.data) return

        setSkillOptions(
            result.data
                .filter((skill) => skill.location !== "<built-in>")
                .map((skill): SkillOption => ({
                    name: skill.name,
                    location: skill.location,
                    description: skill.description.replace(/\s+/g, " ").trim(),
                }))
                .filter((skill, index, items) => items.findIndex((item) => item.name === skill.name) === index)
                .toSorted((a, b) => a.name.localeCompare(b.name)),
        )
    }

    const handleSkillSelect = (skill: SkillOption) => {
        const text = inputText()
        const mention = `/${skill.name} `
        const selectionStart = chatInputElement?.selectionStart ?? text.length
        const selectionEnd = chatInputElement?.selectionEnd ?? text.length
        const before = text.slice(0, selectionStart)
        const after = text.slice(selectionEnd)
        const leadingSpace = before && !/\s$/.test(before) ? " " : ""
        const trailingSpace = after && !/^\s/.test(after) ? " " : ""
        const nextText = selectedSkillNames().has(skill.name)
            ? text
            : `${before}${leadingSpace}${mention}${trailingSpace}${after}`
        const nextCursor = selectedSkillNames().has(skill.name)
            ? selectionEnd
            : before.length + leadingSpace.length + mention.length

        setInputText(nextText)
        setShowAddMenu(false)
        requestAnimationFrame(() => {
            chatInputElement?.focus()
            chatInputElement?.setSelectionRange(nextCursor, nextCursor)
        })
    }

    const loadProjectOptions = async () => {
        try {
            const result = await sdk.client.project.list({ directory: sdk.directory() }, { throwOnError: true })
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

    const openProjectInFileManagerLabel = () => {
        const platform = navigator.platform.toLowerCase()
        if (platform.includes("mac")) return "在访达中打开"
        if (platform.includes("win")) return "在资源管理器中打开"
        return "在文件管理器中打开"
    }

    const openCurrentProjectInFileManager = async () => {
        const directory = sdk.directory()
        if (!directory) return
        const result = await window.electronAPI.openPath(directory)
        if (result.success) return
        console.error("打开项目目录失败:", result.error)
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
                sdk.client.config.providers({ directory: sdk.directory() }, { throwOnError: true }),
                sdk.client.app.agents({ directory: sdk.directory() }, { throwOnError: true }),
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
        void loadSkillOptions()
    })

    createEffect(() => {
        inputText()
        queueMicrotask(() => resizeChatInput())
    })

    createEffect(() => {
        sdk.sessionListVersion()
        void loadProjectOptions()
    })

    createEffect(() => {
        sdk.directory()
        void loadSkillOptions()
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

    const sortMessages = (items: Message[]) => items.toSorted((a, b) => a.id.localeCompare(b.id))

    const mergeMessages = (loaded: Message[], cached: Message[]) =>
        sortMessages(Array.from(new Map([...loaded, ...cached].map((message) => [message.id, message])).values()))

    const parseMessagePage = (data: MessagePageItem[]) => {
        const items = data.filter((item): item is { info: Message; parts?: Part[] } => Boolean(item.info?.id))
        return {
            messages: sortMessages(items.map((item) => item.info)),
            parts: Object.fromEntries(items.flatMap((item) => item.parts?.length ? [[item.info.id, item.parts]] : [])),
        }
    }

    const fetchMessagePage = async (sessionId: string, before?: string): Promise<MessagePage | undefined> => {
        const url = new URL(`${sdk.serverInfo.url}/session/${encodeURIComponent(sessionId)}/message`)
        url.searchParams.set("limit", MESSAGE_HISTORY_PAGE_SIZE.toString())
        if (before) url.searchParams.set("before", before)

        const response = await fetch(url, { headers: getHeaders() })
        if (!response.ok) return
        return {
            data: await response.json() as MessagePageItem[],
            cursor: response.headers.get("x-next-cursor") ?? undefined,
        }
    }

    const applyMessagePage = (sessionId: string, page: MessagePage, mode: "replace" | "prepend") => {
        const parsed = parseMessagePage(page.data)
        batch(() => {
            sdk.setStore(
                "message",
                sessionId,
                reconcile(
                    mergeMessages(parsed.messages, sdk.store.message[sessionId] ?? []),
                    { key: "id" },
                ),
            )
            Object.entries(parsed.parts).forEach(([messageID, parts]) => {
                sdk.setStore("part", messageID, reconcile(parts, { key: "id" }))
            })
            setHistoryCursors((prev) => ({ ...prev, [sessionId]: page.cursor }))
        })
        if (mode === "replace") queueMicrotask(resumeMessagesAutoFollow)
    }

    const loadOlderMessages = async (sessionId = currentSessionId()) => {
        if (!sessionId) return
        const before = historyCursors()[sessionId]
        if (!before || historyLoadingSessions().has(sessionId)) return

        setHistoryLoading(sessionId, true)
        try {
            const page = await fetchMessagePage(sessionId, before)
            if (!page || currentSessionId() !== sessionId) return
            preserveMessagesScroll(() => applyMessagePage(sessionId, page, "prepend"))
        } catch (error) {
            console.error("加载更早会话消息失败:", error)
        } finally {
            setHistoryLoading(sessionId, false)
        }
    }

    const handleMessagesScroll = () => {
        if (messagesContainer && !preservingHistoryScroll) {
            const currentTop = messagesContainer.scrollTop
            const previousTop = lastMessagesScrollTop
            lastMessagesScrollTop = currentTop
            if (!isProgrammaticScroll()) {
                if (currentTop < previousTop && shouldAutoFollowMessages) releaseMessagesAutoFollow()
                if (!shouldAutoFollowMessages && isNearBottom() && canRepinMessagesAutoFollow()) {
                    shouldAutoFollowMessages = true
                    lastUserReleaseAt = 0
                    startAutoFollowLoop()
                }
            }
        }
        const sessionId = currentSessionId()
        if (!sessionId || !historyCursors()[sessionId] || historyLoadingSessions().has(sessionId)) return
        if (!messagesContainer || messagesContainer.scrollTop > MESSAGE_HISTORY_SCROLL_THRESHOLD) return
        void loadOlderMessages(sessionId)
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
            const [messagePage, permissions, questions] = await Promise.all([
                fetchMessagePage(sessionId),
                sdk.client.permission.list(undefined, { throwOnError: false }).catch(() => undefined),
                sdk.client.question.list(undefined, { throwOnError: false }).catch(() => undefined),
            ])

            if (messagePage) applyMessagePage(sessionId, messagePage, "replace")

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
                const data = await response.json() as Session
                if (newSessionPermissionMode() !== "default") setSessionPermissionMode(data.id, newSessionPermissionMode())
                sdk.setSelectedSession(data)
                sdk.refreshSessionList()
                console.log(`为文件夹 ${sdk.directory()} 创建新会话: ${data.id}`)
                return data.id as string
            }
            const body = await response.text()
            console.error("创建会话失败:", body)
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
        try {
            await sdk.client.session.promptAsync({
                directory: sdk.directory() || undefined,
                sessionID: prompt.sessionID,
                messageID: prompt.id,
                agent: prompt.agent,
                model: prompt.model,
                parts: prompt.parts,
            }, { throwOnError: true })
        } catch (error) {
            console.error("发送异步消息错误:", error)
            throw error
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
            const model = currentModel()
            if (!model) throw new Error("请选择模型后再发送")
            const existingSessionId = currentSessionId()
            let sid = existingSessionId
            if (!sid) {
                sid = await createNewSessionForFolder(createInitialSessionTitle(text))
            }
            if (!sid) throw new Error("创建会话失败")

            await ensureInitialSessionTitle(sid, text)

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

    // 拼接用户消息中所有 text part（用户消息按整段渲染，不按 part 分块）
    const userMessageText = (parts: Part[]): string => {
        return parts
            .filter((part): part is Part & { type: "text"; text: string; synthetic?: boolean } => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n")
    }

    // 一个 part 是否应该在 chat-turn 中被渲染（与 reducer 的 SKIP_PARTS 一致）
    const isVisiblePart = (part: Part) => {
        if (part.type === "text") return true
        if (part.type === "reasoning") return props.chatVisibility.reasoning
        if (part.type !== "tool") return false
        const tool = part as ToolPartView
        if (isQuestionToolPart(tool)) return props.chatVisibility.questionAnswers
        return isShellToolPart(tool) ? props.chatVisibility.shellCalls : props.chatVisibility.toolCalls
    }

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
                if (part.type === "text") return part.id
                if (part.type === "reasoning" && props.chatVisibility.reasoning) return part.id
            }
        }
        return null
    })

    const workingStatusText = createMemo(() => {
        if (!isBusy()) return ""
        if (activePermissionRequest()) return "等待权限确认"
        if (activeQuestionRequest()) return "等待回答"
        const list = messages()
        for (let i = list.length - 1; i >= 0; i--) {
            const message = list[i]
            if (message.role !== "assistant") continue
            const parts = sdk.store.part[message.id] ?? []
            for (let j = parts.length - 1; j >= 0; j--) {
                const part = parts[j]
                if (part.type === "tool" && isToolActive(part.state)) return activeToolStatusLabel(part as ToolPartView)
                if (part.type === "reasoning") return "正在思考"
                if (part.type === "text") return "生成回复中"
            }
        }
        return "正在思考"
    })

    const emptyConversation = createMemo(() => messages().length === 0 && !isLoading() && !sendError() && !hasPendingRequest())

    return (
        <div class="chat-panel" classList={{ "chat-panel-empty": emptyConversation() }}>
            <div class="chat-header">
                <Show when={props.sidebarCollapsed}>
                    <button
                        class="chat-sidebar-toggle"
                        type="button"
                        onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            props.onOpenSidebar?.()
                        }}
                        onMouseDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            props.onOpenSidebar?.()
                        }}
                        onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            props.onOpenSidebar?.()
                        }}
                        title="展开侧边栏"
                        aria-label="展开侧边栏"
                    >
                        <PanelLeftOpen class="lucide-control-icon" size={17} strokeWidth={1.8} />
                    </button>
                </Show>
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
                </div>
            </div>

            <div class="chat-messages" ref={setMessagesContainerRef} onScroll={handleMessagesScroll}>
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
                    <div class="chat-timeline" ref={setMessagesTimelineRef}>
                        <Show when={historyMore()}>
                            <div class="chat-history-loader">
                                <button
                                    class="chat-history-button"
                                    type="button"
                                    disabled={historyLoading()}
                                    onClick={() => void loadOlderMessages()}
                                >
                                    {historyLoading() ? "加载中..." : "加载更早对话"}
                                </button>
                            </div>
                        </Show>
                        <For each={messages()}>
                            {(message) => (
                                <Show
                                    when={message.role === "assistant"}
                                    fallback={
                                        <div class="chat-turn user">
                                            <div class="chat-message user">
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
                                                                    time={reasoningPart.time}
                                                                />
                                                            </div>
                                                        )
                                                    })()}
                                                </Show>
                                                <Show when={part.type === "tool"}>
                                                    {(() => {
                                                        const tool = part as ToolPartView
                                                        return (
                                                            <div class="chat-turn assistant">
                                                                <div class="tool-calls">
                                                                    <ToolCallBlock part={tool} />
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

                        <Show when={workingStatusText()}>
                            <div class="chat-turn assistant">
                                <div class="chat-thinking">
                                    <span class="chat-thinking-label" data-text={workingStatusText()}>{workingStatusText()}</span>
                                </div>
                            </div>
                        </Show>

                        <Show when={sendError()}>
                            {(error) => (
                                <div class="chat-turn assistant">
                                    <div class="chat-message assistant">
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
                    <div class="chat-prompt-dock chat-prompt-dock-question">
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
                        ref={(element) => {
                            chatInputElement = element
                            resizeChatInput(element)
                        }}
                        class="chat-input"
                        placeholder={hasPendingRequest() ? "请先处理上方询问或权限请求" : sdk.directory() ? "输入消息..." : "请先选择一个文件夹"}
                        value={inputText()}
                        onInput={(event) => {
                            setInputText(event.currentTarget.value)
                            resizeChatInput(event.currentTarget)
                        }}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={handleChatInputCompositionStart}
                        onCompositionEnd={handleChatInputCompositionEnd}
                        disabled={hasPendingRequest() || !sdk.directory()}
                        rows={1}
                    />
                    <div class="chat-toolbar">
                        <div class="agent-selector">
                            <DropdownMenu
                                gutter={8}
                                placement="top-start"
                                open={showAddMenu()}
                                onOpenChange={setAddMenuOpen}
                            >
                                <DropdownMenu.Trigger
                                    as={Button}
                                    variant="ghost"
                                    size="small"
                                    class="toolbar-btn composer-add-trigger"
                                    data-open={showAddMenu() ? "true" : "false"}
                                    title="添加"
                                    aria-label="添加"
                                >
                                    <Plus class="lucide-control-icon" size={16} strokeWidth={1.8} />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content class="composer-add-menu">
                                        <DropdownMenu.Sub>
                                            <DropdownMenu.SubTrigger class="composer-add-menu-item">
                                                <Puzzle class="lucide-control-icon" size={15} strokeWidth={1.8} />
                                                <span data-slot="composer-add-menu-label">使用技能</span>
                                                <ChevronRight class="lucide-chevron-icon" size={14} strokeWidth={1.8} />
                                            </DropdownMenu.SubTrigger>
                                            <DropdownMenu.SubContent class="composer-skill-menu">
                                                <div class="composer-skill-menu-header">
                                                    {skillsLoading() ? "正在加载技能" : `${skillOptions().length} 个已安装技能`}
                                                </div>
                                                <Show
                                                    when={!skillsLoading()}
                                                    fallback={<div class="composer-skill-menu-empty">正在加载技能...</div>}
                                                >
                                                    <Show
                                                        when={skillOptions().length > 0}
                                                        fallback={<div class="composer-skill-menu-empty">暂无已安装技能</div>}
                                                    >
                                                        <For each={skillOptions()}>
                                                            {(skill) => (
                                                                <DropdownMenu.Item
                                                                    class="composer-skill-menu-item"
                                                                    classList={{ active: selectedSkillNames().has(skill.name) }}
                                                                    onSelect={() => handleSkillSelect(skill)}
                                                                    title={skill.description || skill.location}
                                                                >
                                                                    <Puzzle class="lucide-control-icon" size={15} strokeWidth={1.8} />
                                                                    <span class="composer-skill-menu-main">{skill.name}</span>
                                                                    <Show when={selectedSkillNames().has(skill.name)}>
                                                                        <Check class="check-icon" size={14} strokeWidth={2} />
                                                                    </Show>
                                                                </DropdownMenu.Item>
                                                            )}
                                                        </For>
                                                    </Show>
                                                </Show>
                                            </DropdownMenu.SubContent>
                                        </DropdownMenu.Sub>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu>
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
                                                    title={agentDescription(agent)}
                                                >
                                                    <AgentModeIcon name={agent.name} class="menu-icon lucide-control-icon" />
                                                    <span data-slot="agent-menu-main">
                                                        <DropdownMenu.ItemLabel>{agentLabel(agent.name)}</DropdownMenu.ItemLabel>
                                                        <span data-slot="agent-menu-description">{agentDescription(agent)}</span>
                                                    </span>
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
                                open={modelMenuAvailable() && showModelMenu()}
                                onOpenChange={setModelMenuOpen}
                            >
                                <DropdownMenu.Trigger
                                    as={Button}
                                    variant="ghost"
                                    size="small"
                                    class="model-toggle"
                                    data-open={modelMenuAvailable() && showModelMenu() ? "true" : "false"}
                                    data-single={modelMenuAvailable() ? "false" : "true"}
                                    title={currentModelInfo() ? `${currentModelInfo()?.providerName || currentModelInfo()?.providerID}/${currentModelInfo()?.modelID}` : "选择模型"}
                                >
                                    <Package class="lucide-control-icon" size={16} strokeWidth={1.8} />
                                    <span>{modelLabel()}</span>
                                    <Show when={modelMenuAvailable()}>
                                        <ChevronDown class="lucide-chevron-icon" size={14} strokeWidth={1.8} />
                                    </Show>
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
                        <button
                            type="button"
                            class="toolbar-btn composer-open-folder-btn"
                            onClick={() => void openCurrentProjectInFileManager()}
                            disabled={!sdk.directory()}
                            title={openProjectInFileManagerLabel()}
                            aria-label={openProjectInFileManagerLabel()}
                        >
                            <span>{openProjectInFileManagerLabel()}</span>
                        </button>
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
