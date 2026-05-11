import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
    Event,
    Message,
    Part,
    PermissionRequest,
    QuestionRequest,
    SessionStatus,
    SnapshotFileDiff,
    Todo,
} from "@opencode-ai/sdk/v2/client"
import type { SessionState } from "./types"
import { Binary } from "./binary"
import { diffs as toDiffList, cleanMessage } from "./diffs"

const SKIP_PARTS = new Set<Part["type"]>(["patch", "step-start", "step-finish"])

export function applySessionEvent(input: {
    event: Event
    store: Store<SessionState>
    setStore: SetStoreFunction<SessionState>
}) {
    const { event, store, setStore } = input

    switch (event.type) {
        case "session.diff": {
            const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
            setStore("session_diff", props.sessionID, reconcile(toDiffList(props.diff), { key: "file" }))
            break
        }

        case "todo.updated": {
            const props = event.properties as { sessionID: string; todos: Todo[] }
            setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
            break
        }

        case "session.status": {
            const props = event.properties as { sessionID: string; status: SessionStatus }
            setStore("session_status", props.sessionID, reconcile(props.status))
            break
        }

        case "session.idle": {
            const props = event.properties as { sessionID: string }
            setStore("session_status", props.sessionID, reconcile({ type: "idle" } as SessionStatus))
            break
        }

        case "message.updated": {
            const info = cleanMessage((event.properties as { info: Message }).info)
            const messages = store.message[info.sessionID]
            if (!messages) {
                setStore("message", info.sessionID, [info])
                break
            }
            const result = Binary.search(messages, info.id, (m) => m.id)
            if (result.found) {
                setStore("message", info.sessionID, result.index, reconcile(info))
                break
            }
            setStore(
                "message",
                info.sessionID,
                produce((draft) => {
                    draft.splice(result.index, 0, info)
                }),
            )
            break
        }

        case "message.removed": {
            const props = event.properties as { sessionID: string; messageID: string }
            setStore(
                produce((draft) => {
                    const messages = draft.message[props.sessionID]
                    if (messages) {
                        const result = Binary.search(messages, props.messageID, (m) => m.id)
                        if (result.found) messages.splice(result.index, 1)
                    }
                    delete draft.part[props.messageID]
                }),
            )
            break
        }

        case "message.part.updated": {
            const part = (event.properties as { part: Part }).part
            if (SKIP_PARTS.has(part.type)) break
            const parts = store.part[part.messageID]
            if (!parts) {
                setStore("part", part.messageID, [part])
                break
            }
            const result = Binary.search(parts, part.id, (p) => p.id)
            if (result.found) {
                setStore("part", part.messageID, result.index, reconcile(part))
                break
            }
            setStore(
                "part",
                part.messageID,
                produce((draft) => {
                    draft.splice(result.index, 0, part)
                }),
            )
            break
        }

        case "message.part.removed": {
            const props = event.properties as { messageID: string; partID: string }
            const parts = store.part[props.messageID]
            if (!parts) break
            const result = Binary.search(parts, props.partID, (p) => p.id)
            if (result.found) {
                setStore(
                    produce((draft) => {
                        const list = draft.part[props.messageID]
                        if (!list) return
                        const next = Binary.search(list, props.partID, (p) => p.id)
                        if (!next.found) return
                        list.splice(next.index, 1)
                        if (list.length === 0) delete draft.part[props.messageID]
                    }),
                )
            }
            break
        }

        case "message.part.delta": {
            const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
            const parts = store.part[props.messageID]
            if (!parts) break
            const result = Binary.search(parts, props.partID, (p) => p.id)
            if (!result.found) break
            setStore(
                "part",
                props.messageID,
                produce((draft) => {
                    const part = draft[result.index] as Record<string, unknown>
                    const existing = part[props.field] as string | undefined
                    part[props.field] = (existing ?? "") + props.delta
                }),
            )
            break
        }

        case "permission.asked": {
            const permission = event.properties as PermissionRequest
            const permissions = store.permission[permission.sessionID]
            if (!permissions) {
                setStore("permission", permission.sessionID, [permission])
                break
            }
            const result = Binary.search(permissions, permission.id, (p) => p.id)
            if (result.found) {
                setStore("permission", permission.sessionID, result.index, reconcile(permission))
                break
            }
            setStore(
                "permission",
                permission.sessionID,
                produce((draft) => {
                    draft.splice(result.index, 0, permission)
                }),
            )
            break
        }

        case "permission.replied": {
            const props = event.properties as { sessionID: string; requestID: string }
            const permissions = store.permission[props.sessionID]
            if (!permissions) break
            const result = Binary.search(permissions, props.requestID, (p) => p.id)
            if (!result.found) break
            setStore(
                "permission",
                props.sessionID,
                produce((draft) => {
                    draft.splice(result.index, 1)
                }),
            )
            break
        }

        case "question.asked": {
            const question = event.properties as QuestionRequest
            const questions = store.question[question.sessionID]
            if (!questions) {
                setStore("question", question.sessionID, [question])
                break
            }
            const result = Binary.search(questions, question.id, (q) => q.id)
            if (result.found) {
                setStore("question", question.sessionID, result.index, reconcile(question))
                break
            }
            setStore(
                "question",
                question.sessionID,
                produce((draft) => {
                    draft.splice(result.index, 0, question)
                }),
            )
            break
        }

        case "question.replied":
        case "question.rejected": {
            const props = event.properties as { sessionID: string; requestID: string }
            const questions = store.question[props.sessionID]
            if (!questions) break
            const result = Binary.search(questions, props.requestID, (q) => q.id)
            if (!result.found) break
            setStore(
                "question",
                props.sessionID,
                produce((draft) => {
                    draft.splice(result.index, 1)
                }),
            )
            break
        }

        case "session.deleted": {
            const info = (event.properties as { info: { id: string } }).info
            setStore(
                produce((draft) => {
                    delete draft.message[info.id]
                    delete draft.todo[info.id]
                    delete draft.session_diff[info.id]
                    delete draft.session_status[info.id]
                    delete draft.permission[info.id]
                    delete draft.question[info.id]
                    for (const key of Object.keys(draft.part)) {
                        const parts = draft.part[key]
                        if (!parts?.some((part) => part?.sessionID === info.id)) continue
                        delete draft.part[key]
                    }
                }),
            )
            break
        }
    }
}
