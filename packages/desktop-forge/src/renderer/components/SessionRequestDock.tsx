import { For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { isIMECompositionEvent } from "../lib/ime"

const permissionDescription = (request: PermissionRequest) => {
    const descriptions: Record<string, string> = {
        bash: "需要执行终端命令",
        edit: "需要修改文件内容",
        write: "需要写入文件内容",
        read: "需要读取文件内容",
        list: "需要列出目录内容",
        glob: "需要按模式查找文件",
        grep: "需要搜索文件内容",
        webfetch: "需要访问网页内容",
        websearch: "需要执行网络搜索",
    }
    return descriptions[request.permission] ?? `需要使用 ${request.permission} 权限`
}

export function SessionPermissionDock(props: {
    request: PermissionRequest
    responding: boolean
    onDecide: (reply: "once" | "always" | "reject") => void
}) {
    return (
        <DockPrompt
            kind="permission"
            header={
                <div data-slot="permission-row" data-variant="header">
                    <span data-slot="permission-icon">
                        <Icon name="warning" size="normal" />
                    </span>
                    <div data-slot="permission-header-title">需要权限确认</div>
                </div>
            }
            footer={
                <>
                    <div />
                    <div data-slot="permission-footer-actions">
                        <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
                            拒绝
                        </Button>
                        <Button variant="secondary" size="normal" onClick={() => props.onDecide("always")} disabled={props.responding}>
                            总是允许
                        </Button>
                        <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
                            允许一次
                        </Button>
                    </div>
                </>
            }
        >
            <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-hint">{permissionDescription(props.request)}</div>
            </div>

            <Show when={props.request.patterns.length > 0}>
                <div data-slot="permission-row">
                    <span data-slot="permission-spacer" aria-hidden="true" />
                    <div data-slot="permission-patterns">
                        <For each={props.request.patterns}>
                            {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
                        </For>
                    </div>
                </div>
            </Show>
        </DockPrompt>
    )
}

function QuestionOption(props: {
    multi: boolean
    picked: boolean
    label: string
    description?: string
    disabled: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            data-slot="question-option"
            data-picked={props.picked}
            role={props.multi ? "checkbox" : "radio"}
            aria-checked={props.picked}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <span data-slot="question-option-check" aria-hidden="true">
                <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
                    <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
                        <Icon name="check-small" size="small" />
                    </Show>
                </span>
            </span>
            <span data-slot="question-option-main">
                <span data-slot="option-label">{props.label}</span>
                <Show when={props.description}>
                    <span data-slot="option-description">{props.description}</span>
                </Show>
            </span>
        </button>
    )
}

export function SessionQuestionDock(props: {
    request: QuestionRequest
    responding: boolean
    onSubmit: (answers: QuestionAnswer[]) => void
    onReject: () => void
}) {
    const [store, setStore] = createStore({
        tab: 0,
        answers: [] as QuestionAnswer[],
        custom: [] as string[],
        customOn: [] as boolean[],
    })
    const [editingCustom, setEditingCustom] = createSignal(false)

    const questions = createMemo(() => props.request.questions)
    const question = createMemo(() => questions()[store.tab])
    const options = createMemo(() => question()?.options ?? [])
    const multi = createMemo(() => question()?.multiple === true)
    const allowCustom = createMemo(() => question()?.custom !== false)
    const customValue = createMemo(() => store.custom[store.tab] ?? "")
    const customSelected = createMemo(() => store.customOn[store.tab] === true)
    const last = createMemo(() => store.tab >= questions().length - 1)

    const answered = (index: number) => {
        if ((store.answers[index]?.length ?? 0) > 0) return true
        return store.customOn[index] === true && (store.custom[index] ?? "").trim().length > 0
    }

    const picked = (label: string) => store.answers[store.tab]?.includes(label) ?? false

    const setAnswer = (answer: string) => {
        setStore("answers", store.tab, [answer])
        setStore("customOn", store.tab, false)
        setEditingCustom(false)
    }

    const toggleAnswer = (answer: string) => {
        setStore("answers", store.tab, (current = []) => {
            if (current.includes(answer)) return current.filter((item) => item !== answer)
            return [...current, answer]
        })
        setEditingCustom(false)
    }

    const updateCustom = (value: string) => {
        const previous = customValue().trim()
        const next = value.trim()
        setStore("custom", store.tab, value)
        if (!customSelected()) return
        if (!multi()) {
            setStore("answers", store.tab, next ? [next] : [])
            return
        }
        setStore("answers", store.tab, (current = []) => {
            const removed = previous ? current.filter((item) => item.trim() !== previous) : current
            if (!next) return removed
            if (removed.some((item) => item.trim() === next)) return removed
            return [...removed, next]
        })
    }

    const toggleCustom = () => {
        if (props.responding) return
        const next = !customSelected()
        setStore("customOn", store.tab, next)
        setEditingCustom(next)
        if (!next) {
            const value = customValue().trim()
            if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
            return
        }
        if (!multi()) setStore("answers", store.tab, customValue().trim() ? [customValue().trim()] : [])
        updateCustom(customValue())
    }

    const openCustom = () => {
        if (props.responding) return
        if (!customSelected()) {
            setStore("customOn", store.tab, true)
            if (!multi()) setStore("answers", store.tab, customValue().trim() ? [customValue().trim()] : [])
            updateCustom(customValue())
        }
        setEditingCustom(true)
    }

    const selectOption = (label: string) => {
        if (props.responding) return
        if (multi()) {
            toggleAnswer(label)
            return
        }
        setAnswer(label)
    }

    const answers = () => questions().map((_, index) => store.answers[index] ?? [])

    const next = () => {
        if (props.responding) return
        if (!last()) {
            setStore("tab", store.tab + 1)
            setEditingCustom(false)
            return
        }
        props.onSubmit(answers())
    }

    const back = () => {
        if (props.responding || store.tab <= 0) return
        setStore("tab", store.tab - 1)
        setEditingCustom(false)
    }

    return (
        <DockPrompt
            kind="question"
            header={
                <>
                    <div data-slot="question-header-title">
                        询问 {Math.min(store.tab + 1, questions().length)} / {questions().length}
                    </div>
                    <div data-slot="question-progress">
                        <For each={questions()}>
                            {(_, index) => (
                                <button
                                    type="button"
                                    data-slot="question-progress-segment"
                                    data-active={index() === store.tab}
                                    data-answered={answered(index())}
                                    disabled={props.responding}
                                    onClick={() => {
                                        setStore("tab", index())
                                        setEditingCustom(false)
                                    }}
                                    aria-label={`询问 ${index() + 1}`}
                                />
                            )}
                        </For>
                    </div>
                </>
            }
            footer={
                <>
                    <Button variant="ghost" size="large" disabled={props.responding} onClick={props.onReject}>
                        忽略
                    </Button>
                    <div data-slot="question-footer-actions">
                        <Show when={store.tab > 0}>
                            <Button variant="secondary" size="large" disabled={props.responding} onClick={back}>
                                上一步
                            </Button>
                        </Show>
                        <Button variant={last() ? "primary" : "secondary"} size="large" disabled={props.responding} onClick={next}>
                            {last() ? "提交" : "下一步"}
                        </Button>
                    </div>
                </>
            }
        >
            <div data-slot="question-text">{question()?.question}</div>
            <Show
                when={multi()}
                fallback={<div data-slot="question-hint">{allowCustom() ? "请选择一个选项，或输入自定义回答。" : "请选择一个选项。"}</div>}
            >
                <div data-slot="question-hint">{allowCustom() ? "可选择多个选项，也可以输入自定义回答。" : "可选择多个选项。"}</div>
            </Show>
            <div data-slot="question-options">
                <For each={options()}>
                    {(option) => (
                        <QuestionOption
                            multi={multi()}
                            picked={picked(option.label)}
                            label={option.label}
                            description={option.description}
                            disabled={props.responding}
                            onClick={() => selectOption(option.label)}
                        />
                    )}
                </For>

                <Show when={allowCustom()}>
                    <Show
                        when={editingCustom()}
                        fallback={
                            <button
                                type="button"
                                data-slot="question-option"
                                data-custom="true"
                                data-picked={customSelected()}
                                role={multi() ? "checkbox" : "radio"}
                                aria-checked={customSelected()}
                                disabled={props.responding}
                                onClick={openCustom}
                            >
                                <span data-slot="question-option-check" aria-hidden="true">
                                    <span data-slot="question-option-box" data-type={multi() ? "checkbox" : "radio"} data-picked={customSelected()}>
                                        <Show when={multi()} fallback={<span data-slot="question-option-radio-dot" />}>
                                            <Icon name="check-small" size="small" />
                                        </Show>
                                    </span>
                                </span>
                                <span data-slot="question-option-main">
                                    <span data-slot="option-label">输入自己的回答</span>
                                    <span data-slot="option-description">{customValue().trim() || "点击输入自定义回答"}</span>
                                </span>
                            </button>
                        }
                    >
                        <form
                            data-slot="question-option"
                            data-custom="true"
                            data-picked={customSelected()}
                            role={multi() ? "checkbox" : "radio"}
                            aria-checked={customSelected()}
                            onSubmit={(event) => {
                                event.preventDefault()
                                setEditingCustom(false)
                            }}
                        >
                            <span data-slot="question-option-check" aria-hidden="true" onClick={toggleCustom}>
                                <span data-slot="question-option-box" data-type={multi() ? "checkbox" : "radio"} data-picked={customSelected()}>
                                    <Show when={multi()} fallback={<span data-slot="question-option-radio-dot" />}>
                                        <Icon name="check-small" size="small" />
                                    </Show>
                                </span>
                            </span>
                            <span data-slot="question-option-main">
                                <span data-slot="option-label">输入自己的回答</span>
                                <textarea
                                    data-slot="question-custom-input"
                                    placeholder="输入回答"
                                    value={customValue()}
                                    rows={1}
                                    ref={(element) => {
                                        queueMicrotask(() => {
                                            if (!editingCustom()) return
                                            element.focus()
                                            element.setSelectionRange(element.value.length, element.value.length)
                                        })
                                    }}
                                    disabled={props.responding}
                                    onInput={(event) => updateCustom(event.currentTarget.value)}
                                    onKeyDown={(event) => {
                                        if (isIMECompositionEvent(event)) return
                                        if (event.key !== "Enter" || event.shiftKey) return
                                        event.preventDefault()
                                        setEditingCustom(false)
                                    }}
                                />
                            </span>
                        </form>
                    </Show>
                </Show>
            </div>
        </DockPrompt>
    )
}
