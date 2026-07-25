import type { BrowserInfo } from "@opencode-ai/browser-protocol"
import type { BrowserBackend } from "./backend"
import { BrowserRuntimeException } from "./errors"

export class BrowserRegistry {
    private readonly backends = new Map<string, BrowserBackend>()

    add(backend: BrowserBackend) {
        if (this.backends.has(backend.info.id)) {
            throw new BrowserRuntimeException("INVALID_COMMAND", `Browser backend already exists: ${backend.info.id}`)
        }
        this.backends.set(backend.info.id, backend)
    }

    get(browserId: string) {
        const backend = this.backends.get(browserId)
        if (!backend) throw new BrowserRuntimeException("BROWSER_NOT_FOUND", `Browser not found: ${browserId}`)
        return backend
    }

    list(): BrowserInfo[] {
        return [...this.backends.values()].map((backend) => backend.info)
    }

    async destroy() {
        await Promise.all([...this.backends.values()].map((backend) => backend.destroy()))
        this.backends.clear()
    }
}
