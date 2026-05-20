export const REASONING_VISIBILITY_STORAGE_KEY = "desktop-lxz.showReasoningTraces"
export const SHELL_CALLS_VISIBILITY_STORAGE_KEY = "desktop-lxz.showShellCalls"
export const TOOL_CALLS_VISIBILITY_STORAGE_KEY = "desktop-lxz.showToolCalls"
export const ANSWERS_VISIBILITY_STORAGE_KEY = "desktop-lxz.showAnswers"

export interface ChatVisibilitySettings {
    reasoning: boolean
    shellCalls: boolean
    toolCalls: boolean
    answers: boolean
}

export const readChatVisibility = (): ChatVisibilitySettings => ({
    reasoning: localStorage.getItem(REASONING_VISIBILITY_STORAGE_KEY) === "true",
    shellCalls: localStorage.getItem(SHELL_CALLS_VISIBILITY_STORAGE_KEY) === "true",
    toolCalls: localStorage.getItem(TOOL_CALLS_VISIBILITY_STORAGE_KEY) === "true",
    answers: localStorage.getItem(ANSWERS_VISIBILITY_STORAGE_KEY) !== "false",
})

export const writeChatVisibility = (settings: ChatVisibilitySettings) => {
    localStorage.setItem(REASONING_VISIBILITY_STORAGE_KEY, settings.reasoning ? "true" : "false")
    localStorage.setItem(SHELL_CALLS_VISIBILITY_STORAGE_KEY, settings.shellCalls ? "true" : "false")
    localStorage.setItem(TOOL_CALLS_VISIBILITY_STORAGE_KEY, settings.toolCalls ? "true" : "false")
    localStorage.setItem(ANSWERS_VISIBILITY_STORAGE_KEY, settings.answers ? "true" : "false")
}
