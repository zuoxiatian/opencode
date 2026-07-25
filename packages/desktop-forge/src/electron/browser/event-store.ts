import type { BrowserEvent, BrowserEventType } from "@opencode-ai/browser-protocol"

type BrowserEventInput = Omit<BrowserEvent, "eventId" | "timestamp">

export class BrowserEventStore {
    private base = 0
    private readonly events: BrowserEvent[] = []
    private readonly listeners = new Set<(event: BrowserEvent) => void>()

    cursor() {
        return this.base + this.events.length
    }

    emit(input: BrowserEventInput) {
        const event: BrowserEvent = {
            ...input,
            eventId: crypto.randomUUID(),
            timestamp: Date.now(),
        }
        this.events.push(event)
        if (this.events.length > 1_000) {
            const removed = this.events.length - 1_000
            this.events.splice(0, removed)
            this.base += removed
        }
        this.listeners.forEach((listener) => listener(event))
        return event
    }

    publish(
        type: BrowserEventType,
        input: Omit<BrowserEventInput, "type">,
    ) {
        return this.emit({ ...input, type })
    }

    since(cursor: number) {
        return this.events.slice(Math.max(0, cursor - this.base))
    }

    subscribe(listener: (event: BrowserEvent) => void) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }
}
