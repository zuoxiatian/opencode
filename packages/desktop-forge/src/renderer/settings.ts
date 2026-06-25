export const REASONING_VISIBILITY_STORAGE_KEY = "desktop-lxz.showReasoningTraces"
export const SHELL_CALLS_VISIBILITY_STORAGE_KEY = "desktop-lxz.showShellCalls"
export const TOOL_CALLS_VISIBILITY_STORAGE_KEY = "desktop-lxz.showToolCalls"
export const QUESTION_ANSWERS_VISIBILITY_STORAGE_KEY = "desktop-lxz.showQuestionAnswers"
export const LINK_OPEN_MODE_STORAGE_KEY = "desktop-lxz.linkOpenMode"

export interface ChatVisibilitySettings {
    reasoning: boolean
    shellCalls: boolean
    toolCalls: boolean
    questionAnswers: boolean
}

export type LinkOpenMode = "direct" | "browser"

export const readChatVisibility = (): ChatVisibilitySettings => ({
    reasoning: localStorage.getItem(REASONING_VISIBILITY_STORAGE_KEY) === "true",
    shellCalls: localStorage.getItem(SHELL_CALLS_VISIBILITY_STORAGE_KEY) === "true",
    toolCalls: localStorage.getItem(TOOL_CALLS_VISIBILITY_STORAGE_KEY) === "true",
    questionAnswers: localStorage.getItem(QUESTION_ANSWERS_VISIBILITY_STORAGE_KEY) !== "false",
})

export const writeChatVisibility = (settings: ChatVisibilitySettings) => {
    localStorage.setItem(REASONING_VISIBILITY_STORAGE_KEY, settings.reasoning ? "true" : "false")
    localStorage.setItem(SHELL_CALLS_VISIBILITY_STORAGE_KEY, settings.shellCalls ? "true" : "false")
    localStorage.setItem(TOOL_CALLS_VISIBILITY_STORAGE_KEY, settings.toolCalls ? "true" : "false")
    localStorage.setItem(QUESTION_ANSWERS_VISIBILITY_STORAGE_KEY, settings.questionAnswers ? "true" : "false")
}

export const readLinkOpenMode = (): LinkOpenMode =>
    localStorage.getItem(LINK_OPEN_MODE_STORAGE_KEY) === "browser" ? "browser" : "direct"

export const writeLinkOpenMode = (mode: LinkOpenMode) => {
    localStorage.setItem(LINK_OPEN_MODE_STORAGE_KEY, mode)
}
