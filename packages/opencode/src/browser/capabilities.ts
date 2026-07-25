import type {
  BrowserBounds,
  BrowserCapabilityInfo,
  BrowserCdpEvents,
  BrowserCdpTarget,
  BrowserCommandData,
} from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"
import { requireBrowserResult } from "./result"

type BrowserCapability = {
  documentation(): Promise<string>
}

export class CapabilityCollection {
  constructor(
    private readonly values: ReadonlyMap<string, {
      capability: BrowserCapability
      info: BrowserCapabilityInfo
    }>,
  ) {}

  async get(id: string): Promise<unknown> {
    const value = this.values.get(id)
    if (!value) throw new Error(`Capability is not available: ${id}`)
    return value.capability
  }

  async list() {
    return [...this.values.values()].map((value) => ({ ...value.info }))
  }
}

export function browserCapabilities(
  transport: BrowserTransport,
  browserId: string,
  infos: BrowserCapabilityInfo[] = [],
) {
  return new CapabilityCollection(new Map(infos.flatMap((info) => {
    if (info.id === "visibility") {
      return [[info.id, {
        capability: new VisibilityCapability(transport, browserId, info),
        info,
      }] as const]
    }
    if (info.id === "viewport") {
      return [[info.id, {
        capability: new ViewportCapability(transport, browserId, info),
        info,
      }] as const]
    }
    return [[info.id, {
      capability: new DescribedCapability(info),
      info,
    }] as const]
  })))
}

export function tabCapabilities(
  transport: BrowserTransport,
  browserId: string,
  tabId: string,
  infos: BrowserCapabilityInfo[] = [],
) {
  return new CapabilityCollection(new Map(infos.map((info) => [info.id, {
    capability: info.id === "cdp"
      ? new CdpCapability(transport, browserId, tabId, info)
      : new DescribedCapability(info),
    info,
  }])))
}

class DescribedCapability {
  constructor(private readonly info: BrowserCapabilityInfo) {}

  get id() {
    return this.info.id
  }

  async documentation() {
    return `# ${this.info.id}\n\n${this.info.description}`
  }
}

export class CdpCapability extends DescribedCapability {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
    info: BrowserCapabilityInfo,
  ) {
    super(info)
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    options: { target?: BrowserCdpTarget; timeoutMs?: number } = {},
  ) {
    if (!method.trim()) throw new Error("tab.capabilities.cdp.send requires a method")
    validateCdpTarget(options.target)
    if (
      options.timeoutMs !== undefined
      && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new Error("tab.capabilities.cdp.send timeoutMs must be a positive integer")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        method,
        name: "tab.dev.cdp",
        params,
        target: options.target,
        timeout: options.timeoutMs,
      },
      tabId: this.tabId,
    }).then((result) => result.data.cdp)
  }

  readEvents(options: {
    afterSequence?: number
    limit?: number
    methods?: string[]
    target?: BrowserCdpTarget
    timeoutMs?: number
  } = {}): Promise<BrowserCdpEvents> {
    validateCdpTarget(options.target)
    if (
      options.afterSequence !== undefined
      && (!Number.isInteger(options.afterSequence) || options.afterSequence < 0)
    ) {
      throw new Error("tab.capabilities.cdp.readEvents afterSequence must be a non-negative integer")
    }
    if (
      options.limit !== undefined
      && (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 1_000)
    ) {
      throw new Error("tab.capabilities.cdp.readEvents limit must be an integer between 1 and 1000")
    }
    if (options.methods !== undefined && (
      !options.methods.length
      || options.methods.some((method) => !method)
    )) {
      throw new Error("tab.capabilities.cdp.readEvents methods must be a non-empty string array")
    }
    if (
      options.timeoutMs !== undefined
      && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0)
    ) {
      throw new Error("tab.capabilities.cdp.readEvents timeoutMs must be a non-negative integer")
    }
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        afterSequence: options.afterSequence,
        limit: options.limit,
        methods: options.methods,
        name: "tab.dev.cdp.events",
        target: options.target,
        timeout: options.timeoutMs,
      },
      tabId: this.tabId,
    }).then((result) => requireBrowserResult(result.data.cdpEvents, "CDP events"))
  }
}

function validateCdpTarget(target?: BrowserCdpTarget) {
  if (!target) return
  if (Boolean(target.sessionId) === Boolean(target.targetId)) {
    throw new Error("CDP target must provide exactly one of sessionId or targetId")
  }
}

class VisibilityCapability extends DescribedCapability {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    info: BrowserCapabilityInfo,
  ) {
    super(info)
  }

  get() {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: { name: "browser.state" },
    }).then((result) => requireBrowserResult(result.state, "browser state").visible)
  }

  set(visible: boolean) {
    return this.transport.command({
      browserId: this.browserId,
      command: { name: visible ? "browser.show" : "browser.hide" },
    }).then(() => undefined)
  }
}

class ViewportCapability extends DescribedCapability {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    info: BrowserCapabilityInfo,
  ) {
    super(info)
  }

  reset() {
    return this.transport.command({
      browserId: this.browserId,
      command: { name: "browser.viewport.reset" },
    }).then(() => undefined)
  }

  set(input: Pick<BrowserBounds, "height" | "width">) {
    if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
      throw new Error("viewport.set requires positive integer width and height")
    }
    return this.transport.command({
      browserId: this.browserId,
      command: {
        bounds: { height: input.height, width: input.width, x: 0, y: 0 },
        name: "browser.viewport.set",
      },
    }).then(() => undefined)
  }
}
