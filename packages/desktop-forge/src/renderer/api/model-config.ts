import { clientFetch } from "./client"

export interface ClientModelConfig {
    templateId: number
    templateName: string
    config: Record<string, unknown>
}

export async function getClientModelConfig() {
    const response = await clientFetch("/api/client/model-config")
    const data = await response.json().catch(() => undefined) as unknown

    if (!response.ok) {
        throw new Error(responseMessage(data) ?? `读取模型配置失败：HTTP ${response.status}`)
    }

    return parseClientModelConfigResponse(data)
}

function parseClientModelConfigResponse(input: unknown): ClientModelConfig {
    if (!isRecord(input)) throw new Error("模型配置响应不是 JSON 对象")
    if (input.ok !== true) throw new Error(responseMessage(input) ?? "读取模型配置失败")
    if (typeof input.templateId !== "number") throw new Error("模型配置响应缺少 templateId")
    if (typeof input.templateName !== "string") throw new Error("模型配置响应缺少 templateName")
    if (!isRecord(input.config)) throw new Error("模型配置响应缺少 config")

    return {
        config: input.config,
        templateId: input.templateId,
        templateName: input.templateName,
    }
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
}

function responseMessage(input: unknown) {
    if (!isRecord(input)) return undefined
    const message = input.message
    return typeof message === "string" && message.trim() ? message : undefined
}
