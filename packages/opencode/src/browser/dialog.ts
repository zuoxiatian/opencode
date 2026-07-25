import type { BrowserCommandData, BrowserDialog } from "@opencode-ai/browser-protocol"
import type { BrowserTransport } from "./transport"

class BaseDialog {
  constructor(
    private readonly transport: BrowserTransport,
    private readonly browserId: string,
    private readonly tabId: string,
    private readonly dialogId: string,
    readonly type: BrowserDialog["type"],
  ) {}

  dismiss() {
    return this.handle(false)
  }

  protected handle(accept: boolean, promptText?: string) {
    return this.transport.command<BrowserCommandData>({
      browserId: this.browserId,
      command: {
        accept,
        dialogId: this.dialogId,
        name: "tab.dialog.handle",
        promptText,
      },
      tabId: this.tabId,
    }).then(() => undefined)
  }
}

export class AlertDialog extends BaseDialog {
  constructor(transport: BrowserTransport, browserId: string, tabId: string, dialogId: string) {
    super(transport, browserId, tabId, dialogId, "alert")
  }
}

export class BeforeUnloadDialog extends BaseDialog {
  constructor(transport: BrowserTransport, browserId: string, tabId: string, dialogId: string) {
    super(transport, browserId, tabId, dialogId, "beforeunload")
  }
}

export class ConfirmDialog extends BaseDialog {
  constructor(transport: BrowserTransport, browserId: string, tabId: string, dialogId: string) {
    super(transport, browserId, tabId, dialogId, "confirm")
  }

  accept() {
    return this.handle(true)
  }
}

export class PromptDialog extends BaseDialog {
  constructor(transport: BrowserTransport, browserId: string, tabId: string, dialogId: string) {
    super(transport, browserId, tabId, dialogId, "prompt")
  }

  accept(text: string) {
    if (typeof text !== "string") throw new Error("prompt.accept requires text")
    return this.handle(true, text)
  }
}

export type Dialog = AlertDialog | BeforeUnloadDialog | ConfirmDialog | PromptDialog

export function createDialog(
  transport: BrowserTransport,
  browserId: string,
  tabId: string,
  dialog: BrowserDialog,
): Dialog {
  if (dialog.type === "alert") return new AlertDialog(transport, browserId, tabId, dialog.id)
  if (dialog.type === "beforeunload") return new BeforeUnloadDialog(transport, browserId, tabId, dialog.id)
  if (dialog.type === "confirm") return new ConfirmDialog(transport, browserId, tabId, dialog.id)
  return new PromptDialog(transport, browserId, tabId, dialog.id)
}
