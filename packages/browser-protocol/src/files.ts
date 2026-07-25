export interface BrowserDialog {
  defaultPrompt?: string
  generation: number
  id: string
  message: string
  type: "alert" | "beforeunload" | "confirm" | "prompt"
}

export interface BrowserDownload {
  error?: string
  filename: string
  id: string
  path?: string
  receivedBytes: number
  sessionId: string
  state: "cancelled" | "completed" | "failed" | "in-progress" | "pending"
  tabId: string
  totalBytes: number
  url: string
}

export interface BrowserFileChooser {
  generation: number
  id: string
  multiple: boolean
}

export interface BrowserClipboardEntry {
  base64?: string
  mimeType: string
  text?: string
}

export interface BrowserClipboardItem {
  entries: BrowserClipboardEntry[]
  presentationStyle?: "attachment" | "inline" | "unspecified"
}
