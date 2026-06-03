declare module "*.ico" {
    const src: string
    export default src
}

declare module "*.png" {
    const src: string
    export default src
}

declare module "@opencode-ai/app" {
    export interface Platform {
        platform: "desktop"
        os?: "windows" | "macos" | "linux"
        version: string
        openDirectoryPickerDialog: (opts?: unknown) => Promise<string | null>
        openFilePickerDialog: (opts?: { multiple?: boolean }) => Promise<string | string[] | null>
        saveFilePickerDialog: (opts?: { defaultPath?: string }) => Promise<string | null>
        openLink: (url: string) => void
        restart: () => Promise<void>
        notify: (title: string, description?: string, href?: string) => Promise<void>
        fetch: typeof fetch
    }
}
