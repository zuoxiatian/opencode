export type ClientApiRequest = {
    body?: string
    headers?: Array<[string, string]>
    method?: string
    url: string
}

export type ClientApiResponse = {
    body: string | null
    headers: Array<[string, string]>
    ok: boolean
    status: number
    statusText: string
}
