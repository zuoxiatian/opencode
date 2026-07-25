import { BrowserRuntimeException } from "../../errors"

export interface RegisteredBrowserNode {
    backendDOMNodeId?: number
    frameId: string
    generation: number
    nodeId: string
    snapshotId: string
    targetId?: string
}

export class BrowserNodeRegistry {
    private readonly snapshots = new Map<string, Map<string, RegisteredBrowserNode>>()

    replace(snapshotId: string, nodes: RegisteredBrowserNode[]) {
        this.snapshots.clear()
        this.snapshots.set(snapshotId, new Map(nodes.map((node) => [node.nodeId, node])))
    }

    resolve(snapshotId: string, nodeId: string, generation: number) {
        const node = this.snapshots.get(snapshotId)?.get(nodeId)
        if (!node || node.generation !== generation) {
            throw new BrowserRuntimeException("STALE_NODE", "DOM node is missing or belongs to an old page", true)
        }
        if (!node.backendDOMNodeId) {
            throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "Accessibility node has no DOM target")
        }
        return node
    }

    resolveLatest(nodeId: string, generation: number) {
        const snapshot = Array.from(this.snapshots.values()).at(-1)
        const node = snapshot?.get(nodeId)
        if (!node || node.generation !== generation) {
            throw new BrowserRuntimeException("STALE_NODE", "DOM node is missing or belongs to an old page", true)
        }
        if (!node.backendDOMNodeId) {
            throw new BrowserRuntimeException("ELEMENT_NOT_ACTIONABLE", "Accessibility node has no DOM target")
        }
        return node
    }

    clear() {
        this.snapshots.clear()
    }
}
