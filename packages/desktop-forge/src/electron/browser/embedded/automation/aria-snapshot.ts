import type {
    BrowserDomNode,
    BrowserDomSnapshot,
    BrowserFrameRef,
} from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "../tab"
import { BrowserRuntimeException } from "../../errors"
import { asRecord, withDebugger } from "./cdp"
import { BrowserNodeRegistry, type RegisteredBrowserNode } from "./node-registry"

const MAX_NODES = 750

export class AriaSnapshotService {
    private readonly registries = new Map<string, BrowserNodeRegistry>()

    snapshot(tab: EmbeddedTab) {
        const generation = tab.generation
        return withDebugger(tab, async (send) => {
            await send("Accessibility.enable")
            const snapshotId = crypto.randomUUID()
            const main = readAxNodes(await send("Accessibility.getFullAXTree"))
            const targets = readTargetInfos(await send("Target.getTargets"))
            const frameIds = readFrameIds(await send("Page.getFrameTree"))
            const inaccessibleFrames: BrowserFrameRef[] = []
            const frames: Array<{ nodes: Record<string, unknown>[]; targetId?: string }> = [{ nodes: main }]

            for (const target of targets.filter((item) => item.type === "iframe" && frameIds.has(item.targetId))) {
                const attached = await send("Target.attachToTarget", { flatten: true, targetId: target.targetId })
                    .then(asRecord)
                    .catch((): Record<string, unknown> => ({}))
                if (typeof attached.sessionId !== "string") {
                    inaccessibleFrames.push({ frameId: target.targetId, url: target.url })
                    continue
                }
                const nodes = await send("Accessibility.getFullAXTree", {}, attached.sessionId)
                    .then(readAxNodes)
                    .catch(() => undefined)
                await send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => undefined)
                if (!nodes) {
                    inaccessibleFrames.push({ frameId: target.targetId, url: target.url })
                    continue
                }
                frames.push({ nodes, targetId: target.targetId })
            }

            const compact = frames.flatMap((frame) => frame.nodes.map((node) => ({ frame, node })))
                .filter(({ node }) => includeAxNode(node))
                .slice(0, MAX_NODES)
            const nodes: BrowserDomNode[] = []
            const registered: RegisteredBrowserNode[] = []
            if (tab.webContents.isDestroyed()) {
                throw new BrowserRuntimeException("TAB_CLOSED", "Browser tab closed during accessibility snapshot")
            }
            if (tab.generation !== generation) {
                throw new BrowserRuntimeException("NAVIGATION_REPLACED", "Page changed during accessibility snapshot", true)
            }
            compact.forEach(({ frame, node }, index) => {
                const id = `n${index + 1}`
                const role = axValue(node.role) || "generic"
                const name = axValue(node.name)
                const frameId = typeof node.frameId === "string" ? node.frameId : frame.targetId ?? "main"
                const backendDOMNodeId = typeof node.backendDOMNodeId === "number"
                    ? node.backendDOMNodeId
                    : undefined
                nodes.push({
                    backendDOMNodeId,
                    checked: axBooleanOrMixed(node, "checked"),
                    description: axValue(node.description) || undefined,
                    disabled: axBoolean(node, "disabled"),
                    expanded: axBoolean(node, "expanded"),
                    frameId,
                    id,
                    name,
                    placeholder: axString(node, "placeholder"),
                    role,
                    selected: axBoolean(node, "selected"),
                    text: role === "StaticText" || role === "InlineTextBox" ? name : undefined,
                    value: axValue(node.value) || undefined,
                })
                registered.push({
                    backendDOMNodeId,
                    frameId,
                    generation,
                    nodeId: id,
                    snapshotId,
                    targetId: frame.targetId,
                })
            })

            this.registry(tab).replace(snapshotId, registered)
            const snapshot: BrowserDomSnapshot = {
                generation,
                inaccessibleFrames,
                nodes,
                snapshotId,
                text: nodes
                    .map((node) => `${node.id} ${node.role}${node.name ? ` "${node.name}"` : ""}${node.value ? ` value="${node.value}"` : ""}`)
                    .join("\n"),
                title: tab.webContents.getTitle(),
                truncated: compact.length >= MAX_NODES,
                url: tab.error?.url || tab.webContents.getURL(),
            }
            return snapshot
        })
    }

    resolve(tab: EmbeddedTab, snapshotId: string, nodeId: string) {
        return this.registry(tab).resolve(snapshotId, nodeId, tab.generation)
    }

    resolveLatest(tab: EmbeddedTab, nodeId: string) {
        return this.registry(tab).resolveLatest(nodeId, tab.generation)
    }

    clear(tabId: string) {
        this.registries.get(tabId)?.clear()
        this.registries.delete(tabId)
    }

    private registry(tab: EmbeddedTab) {
        const existing = this.registries.get(tab.id)
        if (existing) return existing
        const registry = new BrowserNodeRegistry()
        this.registries.set(tab.id, registry)
        return registry
    }
}

function readAxNodes(input: unknown) {
    const result = asRecord(input)
    return Array.isArray(result.nodes)
        ? result.nodes.filter((node): node is Record<string, unknown> => typeof node === "object" && node !== null)
        : []
}

function readFrameIds(input: unknown) {
    const ids = new Set<string>()
    const visit = (value: unknown) => {
        const tree = asRecord(value)
        const frame = asRecord(tree.frame)
        if (typeof frame.id === "string") ids.add(frame.id)
        if (Array.isArray(tree.childFrames)) tree.childFrames.forEach(visit)
    }
    visit(asRecord(input).frameTree)
    return ids
}

function readTargetInfos(input: unknown) {
    const result = asRecord(input)
    if (!Array.isArray(result.targetInfos)) return []
    return result.targetInfos.flatMap((value) => {
        const target = asRecord(value)
        if (
            typeof target.targetId !== "string"
            || typeof target.type !== "string"
            || typeof target.url !== "string"
        ) return []
        return [{ targetId: target.targetId, type: target.type, url: target.url }]
    })
}

function includeAxNode(node: Record<string, unknown>) {
    if (node.ignored === true) return false
    const role = axValue(node.role)
    const name = axValue(node.name)
    return Boolean(name)
        || !["generic", "none", "RootWebArea", "StaticText", "InlineTextBox"].includes(role)
}

function axValue(input: unknown) {
    const value = asRecord(input).value
    return typeof value === "string" || typeof value === "number" ? String(value) : ""
}

function axBoolean(node: Record<string, unknown>, name: string) {
    const value = axProperty(node, name)
    return typeof value === "boolean" ? value : undefined
}

function axString(node: Record<string, unknown>, name: string) {
    const value = axProperty(node, name)
    return typeof value === "string" ? value : undefined
}

function axBooleanOrMixed(node: Record<string, unknown>, name: string) {
    const value = axProperty(node, name)
    return typeof value === "boolean" || value === "mixed" ? value : undefined
}

function axProperty(node: Record<string, unknown>, name: string) {
    if (!Array.isArray(node.properties)) return undefined
    const property = node.properties
        .map(asRecord)
        .find((item) => item.name === name)
    return asRecord(property?.value).value
}
