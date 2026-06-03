import type {
    Message,
    Part,
    PermissionRequest,
    QuestionRequest,
    SessionStatus,
    SnapshotFileDiff,
    Todo,
} from "@opencode-ai/sdk/v2/client"

export type SessionState = {
    session_status: {
        [sessionID: string]: SessionStatus
    }
    session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
    }
    todo: {
        [sessionID: string]: Todo[]
    }
    permission: {
        [sessionID: string]: PermissionRequest[]
    }
    question: {
        [sessionID: string]: QuestionRequest[]
    }
    message: {
        [sessionID: string]: Message[]
    }
    part: {
        [messageID: string]: Part[]
    }
}

export function createInitialSessionState(): SessionState {
    return {
        session_status: {},
        session_diff: {},
        todo: {},
        permission: {},
        question: {},
        message: {},
        part: {},
    }
}
