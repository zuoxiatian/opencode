# Desktop Forge 浏览器与对话绑定改造方案

## 1. 结论

本次改造的核心目标是把浏览器页面从“窗口级全局资源”改为“对话级资源”，并把页面归属与 Agent 临时控制权拆开。

第一阶段只需要修改 `packages/desktop-forge`，不需要修改 `packages/opencode`，也不需要升级 `@opencode-ai/browser-protocol`。现有 Agent 浏览器请求已经把 `ctx.sessionID` 写入 `BrowserCommandRequest.sessionId`，可以直接把这个值作为 Agent 侧的对话命名空间。

目标模型：

```text
conversationId（稳定归属）
  ├── browserTabId A
  ├── browserTabId B
  ├── activeTabId
  └── visible

Agent BrowserCommandRequest.sessionId
  └── 解析为 conversationId

用户 Renderer 命令
  └── 显式携带当前 selectedSession.id

ownerSessionId
  └── 只表示 Agent 当前是否 claim/control 页面，不再表示页面属于哪个对话
```

完成后应满足：

1. 用户在会话 A 打开的页面只属于会话 A。
2. Agent A 调用常用的 `tabs.list` 即可自动接管并发现会话 A 的用户页面；显式 `openTabs/claimTab` 仍可用。
3. Agent B 无法枚举、claim 或操作会话 A 的页面。
4. 从会话 A 切到 B 时只展示 B 的浏览器状态；切回 A 后恢复 A 原来的标签页和选中页。
5. 后台 Agent 操作其他会话时不能抢占用户当前浏览器面板。
6. Agent 临时页面的 finalize 行为保持不变，但 finalize 不能移除页面的对话归属。

---

## 2. 当前问题

### 2.1 用户命令没有对话身份

Renderer 当前直接调用：

```ts
window.electronAPI.browserCommand(command)
```

主进程调用：

```ts
state.browserRuntime.command(command)
```

因为没有传 identity，`BrowserRuntime` 最终使用：

```ts
sessionId: "renderer"
```

因此用户创建的页面只有 `createdBy: "user"`，没有稳定的对话归属。

### 2.2 页面状态是窗口级全局状态

`EmbeddedTabStore` 当前只有：

```ts
tabs: EmbeddedTab[]
activeTabId: string | null
visible: boolean
```

所有对话共享同一个 `activeTabId` 和 `visible`。切换会话不会切换浏览器状态。

### 2.3 `ownerSessionId` 同时承担了两个职责

当前 Agent 可见性逻辑近似为：

```ts
tab.ownership.ownerSessionId === request.sessionId
```

这把以下两个概念混在了一起：

- 页面稳定属于哪个对话；
- 页面当前是否被 Agent claim。

用户页面的 `ownerSessionId` 是 `undefined`，因此不能作为 Agent 的普通 tab 使用；而一旦 claim，又缺少独立字段记录它原本属于哪个对话。

### 2.4 事件和 UI 状态也是全局广播

浏览器事件发生后，主进程总是向 Renderer 发送整个 backend 的全局状态。即使给 tab 增加对话字段，如果不修改广播逻辑，后台会话的 Agent 操作仍可能覆盖当前 UI。

---

## 3. 设计原则

### 3.1 稳定归属与临时控制分离

`conversationId` 在页面创建时确定，页面整个生命周期内保持不变。claim、finalize、Agent 退出都不得清空或修改它。

`ownerSessionId` 暂时保留现有字段名以避免协议升级，但只表示控制租约：

- `undefined`：用户控制或当前没有 Agent 控制；
- 等于 Agent session ID：该 Agent 已 claim 页面；
- 其他值：其他 Agent 正在控制，当前请求拒绝。

未来升级 browser protocol 时，再将其重命名为 `controllerSessionId`。

### 3.2 Renderer 身份与 Agent 身份分开解析

不要把用户命令伪装成 Agent 请求，也不要把 `selectedSession.id` 直接塞进现有 `sessionId` 后继续用 `sessionId === "renderer"` 判断用户来源。

推荐内部使用：

```ts
interface BrowserDispatchContext {
    actor: "agent" | "renderer"
    conversationId: string
    signal?: AbortSignal
}
```

HTTP transport 入口：

```ts
actor = "agent"
conversationId = request.sessionId
```

Renderer IPC 入口：

```ts
actor = "renderer"
conversationId = selectedSession.id
```

`BrowserCommandRequest.sessionId` 在 Phase 1 保持不变，避免 browser protocol v3 变更。

### 3.3 Chromium 登录态与对话归属解耦

继续使用共享 partition：

```text
persist:desktop-forge-browser
```

这样不同对话仍共享用户登录态、Cookie 和站点授权。对话隔离由应用层的 `conversationId`、命令过滤和 WebContentsView attach 规则保证，不把 Chromium partition 当作对话 ID。

### 3.4 后台 Agent 不抢占当前 UI

Agent 对非当前对话执行 `browser.show`、`tabs.new` 或 `tab.activate` 时，只更新目标对话的状态，不允许修改 Renderer 当前的 `activeConversationId`。

用户切换到该对话后，才根据该对话的 `visible` 和 `activeTabId` 展示页面。

### 3.5 跨会话访问返回“不存在”

当 Agent 使用其他会话的 tab ID 时，统一返回 `TAB_NOT_FOUND`，不要返回 `TAB_NOT_OWNED`。这样不会向请求方泄露另一个会话中确实存在该 tab。

同一会话内、尚未 claim 的用户页面在直接执行 tab 命令时返回 `TAB_NOT_OWNED`；调用
`tabs.list` 会自动 claim 当前会话内所有尚未被控制的页面，避免依赖模型正确执行两步 claim 流程。

---

## 4. 目标数据模型

### 4.1 EmbeddedTab

在 `EmbeddedTab` 增加稳定字段：

```ts
export interface EmbeddedTab {
    conversationId: string
    // 现有字段保持不变
    id: string
    ownership: BrowserTabOwnership
    view: WebContentsView
    webContents: WebContents
}
```

页面唯一键概念上为：

```ts
`${conversationId}\0${tabId}`
```

当前 `tabId` 使用 UUID，进程内本身已近似全局唯一，因此 Phase 1 可以继续用数组或 `Map<tabId, EmbeddedTab>` 存储；所有查找仍必须同时校验 `conversationId`。

### 4.2 ConversationBrowserState

新增内部状态：

```ts
interface ConversationBrowserState {
    activeTabId: string | null
    lastSelectedAt: number
    visible: boolean
}
```

`EmbeddedTabStore` 调整为：

```ts
private readonly tabs = new Map<string, EmbeddedTab>()
private readonly conversations = new Map<string, ConversationBrowserState>()
private activeConversationId: string | null = null
private attachedTabId: string | null = null
```

`layoutBounds` 和拖拽期间的 `suspended` 仍然是窗口级状态。

### 4.3 状态投影

对外返回的 `BrowserState` 不新增字段，而是变为某个对话的投影：

```ts
getState(conversationId: string): BrowserState
```

返回值规则：

```ts
{
    activeTabId: conversations.get(conversationId)?.activeTabId ?? null,
    tabs: tabs.filter((tab) => tab.conversationId === conversationId),
    visible: conversations.get(conversationId)?.visible ?? false,
    viewport: layoutBounds,
    browserId: "embedded",
}
```

Agent 响应可以在这个投影上继续做“已控制 tab”过滤；Renderer 获得当前对话的全部 tab。

---

## 5. 关键业务规则

### 5.1 用户创建页面

输入：

```text
actor = renderer
conversationId = 当前 selectedSession.id
```

创建结果：

```ts
{
    conversationId,
    ownership: {
        createdBy: "user",
        disposition: "deliverable",
        ownerSessionId: undefined,
    },
}
```

如果是尚未发送消息的新对话，右上角浏览器按钮必须先通过现有 session create API
创建真实会话，再以该 session id 执行 `syncBrowserOwner` 和 `browser.show`。第一页和随后
发送的第一条消息必须复用同一个 session id；不创建临时 draft id 或全局未绑定 tab。

### 5.2 Agent 创建页面

输入：

```text
actor = agent
conversationId = request.sessionId
```

创建结果：

```ts
{
    conversationId: request.sessionId,
    ownership: {
        createdBy: "agent",
        disposition: "temporary",
        ownerSessionId: request.sessionId,
    },
}
```

创建或激活页面时，只更新该 conversation 的 `activeTabId`，不能调用 `syncOwner`，也不能切换 `activeConversationId`。

### 5.3 Agent 发现并读取用户页面

保留现有显式 claim 流程：

```text
browser.user.openTabs
  → 只返回 conversationId === request.sessionId
  → 只返回 ownerSessionId 为空、可被当前会话接管的页面
  → 包括用户页面，以及 finalize 后保留的 agent deliverable/handoff 页面

browser.user.claimTab
  → 原子校验 claim token、conversationId、title、url 和 ownerSessionId
  → ownerSessionId = request.sessionId

browser_read / browser_snapshot / browser_action
  → 允许读取或操作已 claim 页面
```

claim 不修改 `conversationId`，也不需要把用户页面改成 Agent 页面。

同时提供兼容发现路径：

```text
tabs.list
  → 仅在 actor === agent 时执行
  → 自动 claim 当前 conversation 内 ownerSessionId 为空的页面
  → 清理这些页面尚未使用的 claim token
  → 返回当前 Agent 已控制的 tab 列表
```

这使 Agent 即使没有按提示调用 `openTabs → claimTab`，也能读取用户在当前对话手动打开的页面。
自动 claim 绝不跨 conversation，已由其他 owner 控制的页面也不会被抢占。

### 5.4 finalize

`tabs.finalize` 只处理：

```ts
tab.conversationId === request.sessionId
&& tab.ownership.ownerSessionId === request.sessionId
```

规则：

| 页面来源 | disposition | finalize 结果 |
|---|---|---|
| agent | temporary | 关闭 |
| agent | deliverable | 保留，释放 ownerSessionId |
| agent | handoff | 保留，释放 ownerSessionId |
| user | 任意 | 保留，释放 ownerSessionId |

用户页面 claim 时不再强制把 disposition 改为 `temporary`。页面归属始终保留。

### 5.5 会话切换

Renderer 监听 `sdk.selectedSession()?.id`：

```text
A → B
  1. browser:sync-owner(B)
  2. 主进程 activeConversationId = B
  3. detach A 当前 WebContentsView
  4. 读取 B 的 BrowserState
  5. 如果 B.visible 且 B.activeTabId 有有效页面，attach B 页面
  6. Renderer 只渲染 B 的标签页
```

切回 A 时执行同一流程，A 的 WebContents 和页面状态仍然存在，因此不重新加载。

`selectedSession` 为空时：

- `activeConversationId = null`；
- detach 当前页面；
- 浏览器面板隐藏；
- 不销毁任何已有对话页面。

### 5.6 关闭标签页

关闭当前 tab 后，只在同一 conversation 内选择相邻 tab：

```ts
const remaining = tabsForConversation(conversationId)
conversation.activeTabId = remaining[nextIndex]?.id ?? null
```

不能回退到其他会话的最近 tab。

### 5.7 browser.show / browser.hide

`visible` 改为 per-conversation：

- Renderer 操作当前对话时立即反映到 UI；
- Agent 操作当前对话时可以显示或隐藏；
- Agent 操作后台对话时只更新后台状态，不抢占 UI；
- 用户切换到后台对话后再应用其 `visible` 状态。

### 5.8 window.open 和应用内链接

所有隐式创建 tab 的入口都必须传递父页面或当前 UI 的 `conversationId`：

- 页面 `window.open`：继承 opener tab 的 `conversationId`；
- `_blank`：继承 opener tab；
- 主窗口 `setWindowOpenHandler`：使用当前 `activeConversationId`；
- 当前没有 active conversation：拒绝创建内嵌 tab，可按现有产品策略改为外部浏览器打开。

### 5.9 History

浏览历史内部记录增加 `conversationId`：

```ts
{
    conversationId,
    entry: BrowserHistoryEntry,
}
```

Agent 的 `browser.user.history` 只返回当前 conversation 的记录，避免通过历史接口推断其他会话浏览内容。若未来 UI 需要全局历史，应增加独立的 Renderer-only 查询入口。

---

## 6. Renderer 与 IPC 改造

### 6.1 App 组件调整

当前 `App` 自己创建 `SDKProvider`，因此不能在 Provider 外直接调用 `useSDK()`。建议拆为：

```tsx
export function App(props: AppProps) {
    return (
        <MarkedProvider>
            <SDKProvider serverInfo={props.serverInfo}>
                <AppContent {...props} />
            </SDKProvider>
        </MarkedProvider>
    )
}

function AppContent(props: AppProps) {
    const sdk = useSDK()
    const conversationId = createMemo(() => sdk.selectedSession()?.id ?? null)
    // 现有 App 主体
}
```

在 `AppContent` 中监听会话变化：

```ts
createEffect(() => {
    const id = conversationId()
    void window.electronAPI.syncBrowserOwner(id).then(setBrowserState)
})
```

使用 revision 防止 A→B 快速切换时 A 的异步响应覆盖 B：

```ts
const revision = ++browserOwnerRevision
const state = await syncBrowserOwner(id)
if (revision !== browserOwnerRevision) return
setBrowserState(state)
```

### 6.2 BrowserPanel

新增必需 prop：

```ts
interface BrowserPanelProps {
    conversationId: string
    layoutRevision: number
    state: BrowserState
}
```

所有用户命令都显式携带 `conversationId`：

```ts
window.electronAPI.browserCommand(props.conversationId, command)
```

当没有选中会话时不渲染 `BrowserPanel`。如果用户点击浏览器按钮，则由 `ChatPanel`
先静默创建真实会话并选中它，随后才挂载对应会话的 `BrowserPanel`。

### 6.3 Preload API

调整为：

```ts
interface ElectronAPI {
    browserCommand: (
        conversationId: string,
        command: BrowserCommandInput,
    ) => Promise<BrowserCommandResponse>

    getBrowserState: (conversationId: string) => Promise<BrowserState>

    syncBrowserOwner: (
        conversationId: string | null,
    ) => Promise<BrowserState | null>

    onBrowserStateChanged: (
        callback: (payload: {
            conversationId: string
            state: BrowserState
        }) => void,
    ) => () => void
}
```

不允许 Renderer 自己提交 `actor` 或 `ownerSessionId`。

### 6.4 IPC 校验

新增 helper：

```ts
function requireConversationId(value: unknown) {
    if (typeof value === "string" && value.trim()) return value
    throw new Error("浏览器命令缺少会话 ID")
}
```

IPC 处理：

```text
browser:sync-owner
  → 校验 sender
  → runtime.syncOwner(conversationId)

browser:get-state
  → 校验 sender + conversationId
  → runtime.getState(conversationId)

browser:command
  → 校验 sender + conversationId
  → runtime.command(command, {
        actor: renderer,
        conversationId,
        sessionId: renderer,
     })
```

Renderer 命令如果携带的 conversationId 与主进程当前 owner 不一致，应返回 `STALE_BROWSER_OWNER` 或普通错误，防止旧组件在切换过程中误操作新会话。

---

## 7. Main Process 与 Backend 改造

### 7.1 BrowserRuntime

新增内部 identity：

```ts
interface BrowserCommandIdentity {
    actor: "agent" | "renderer"
    callId?: string
    conversationId: string
    sessionId: string
}
```

接口调整：

```ts
interface BrowserRuntime {
    command(input, identity, signal?): Promise<BrowserCommandResponse>
    dispatch(request, signal?): Promise<BrowserCommandResponse>
    getState(conversationId, browserId?): BrowserState
    syncOwner(conversationId: string | null): BrowserState | null
}
```

HTTP `dispatch` 自动构造：

```ts
{
    actor: "agent",
    conversationId: request.sessionId,
}
```

### 7.2 BrowserDispatchContext

从只有 `signal` 扩展为：

```ts
interface BrowserDispatchContext {
    actor: "agent" | "renderer"
    conversationId: string
    signal?: AbortSignal
}
```

Dispatcher、SecurityGate 和 Backend 都使用 context 中的稳定 conversationId，不从 `ownerSessionId` 反推。

### 7.3 BrowserBackend

接口调整：

```ts
interface BrowserBackend {
    dispatch(request, context): Promise<BrowserCommandData>
    getState(conversationId: string): BrowserState
    syncOwner(conversationId: string | null): BrowserState | null
}
```

### 7.4 EmbeddedTabStore API

建议把所有可能隐式使用全局 active tab 的方法改为显式 conversation：

```ts
create(conversationId, ownership, request?, activate?): EmbeddedTab
activate(conversationId, tabId, request?): EmbeddedTab
close(conversationId, tabId, request?): void
get(conversationId, tabId?): EmbeddedTab | undefined
require(conversationId, tabId?): EmbeddedTab
list(conversationId): EmbeddedTab[]
show(conversationId, request?): void
hide(conversationId, request?): void
getState(conversationId): BrowserState
syncOwner(conversationId: string | null): BrowserState | null
```

禁止保留不带 conversationId 的重载，避免后续代码重新引入全局 tab 语义。

### 7.5 View attach

`syncView()` 只考虑当前 UI owner：

```ts
const conversationId = this.activeConversationId
const state = conversationId ? this.conversations.get(conversationId) : undefined
const active = conversationId && state?.activeTabId
    ? this.get(conversationId, state.activeTabId)
    : undefined

const shouldAttach =
    !this.suspended
    && state?.visible === true
    && active != null
    && !active.closed
    && !active.error
    && Boolean(active.webContents.getURL())
```

后台 Agent 更新 tab 时可以更新事件和 snapshot，但不能改变 `activeConversationId`，所以不会被 attach。

### 7.6 Dispatcher 状态过滤

Dispatcher 先获取：

```ts
const state = backend.getState(context.conversationId)
```

Renderer 返回这个 conversation 的全部 tabs。

Agent 返回：

```ts
const tabs = state.tabs.filter(
    (tab) => tab.ownership.ownerSessionId === request.sessionId,
)
```

用户未 claim 的页面通过 `browser.user.openTabs` 暴露，不直接作为 Agent controlled tabs 返回。

### 7.7 SecurityGate

检查顺序必须是：

1. request identity 完整；
2. tab 是否存在于 `context.conversationId`；
3. Agent 是否持有控制权；
4. origin、dialog、file path 等现有安全检查。

伪代码：

```ts
const tab = request.tabId
    ? backend.findTab(context.conversationId, request.tabId)
    : undefined

if (request.tabId && !tab) throw TAB_NOT_FOUND

if (
    context.actor === "agent"
    && tab
    && tab.ownership.ownerSessionId !== request.sessionId
) throw TAB_NOT_OWNED
```

Renderer 也只能操作 IPC 指定 conversation 中的 tab，不能因为 actor 是 renderer 就跨对话查找。

### 7.8 UserTabClaims

claim record 增加 conversationId：

```ts
{
    claimId,
    conversationId,
    createdAt,
    sessionId,
    tabId,
    title,
    url,
}
```

`openTabs(conversationId, sessionId)` 只枚举当前对话；`claimTab` 重新校验 claim record 的 conversationId 与当前 request 一致。

### 7.9 Events

事件中的 `sessionId` 改为页面所属 `conversationId`，而不是用户命令使用的 `"renderer"`：

```ts
this.events.publish(type, {
    sessionId: tab.conversationId,
    requestId: request?.requestId,
    tabId: tab.id,
})
```

无 tab 的 `browser.shown/hidden` 由调用方显式传 conversationId。

向 Renderer 广播时发送：

```ts
{
    conversationId: event.sessionId,
    state: backend.getState(event.sessionId),
}
```

Renderer 只接收或应用当前 `selectedSession.id` 对应的 payload。这样后台 Agent 事件不会覆盖当前页面。

### 7.10 所有隐式 tab 创建入口审计

必须逐一修改：

- `tabs.new`；
- `browser.show` 自动创建空 tab；
- 页面 `window.open`；
- 主窗口 `setWindowOpenHandler`；
- popup/adopted child；
- 导航过程中创建 child tab 的逻辑；
- 测试和内部 `internalRequest`。

原则是优先继承父 tab 的 `conversationId`，没有父 tab 时使用显式 dispatch context，绝不回退到全局默认值。

---

## 8. 文件修改清单

### 必须修改：desktop-forge

| 文件 | 修改内容 |
|---|---|
| `src/renderer/components/App.tsx` | 拆 `AppContent`、读取 selectedSession、同步 browser owner、过滤状态事件 |
| `src/renderer/components/BrowserPanel.tsx` | 增加 conversationId prop，所有命令显式携带会话 |
| `src/preload.ts` | 增加 syncOwner API，调整 command/state/event 参数 |
| `src/electron/ipc/index.ts` | 校验 conversationId，增加 sync-owner IPC |
| `src/electron/browser/runtime.ts` | 区分 actor、传递 dispatch context、按 conversation 获取状态 |
| `src/electron/browser/backend.ts` | 扩展 BrowserDispatchContext 和 backend 接口 |
| `src/electron/browser/command-dispatcher.ts` | 用 conversation state 做安全检查和响应投影 |
| `src/electron/browser/security.ts` | 先校验 scope，再校验 claim/control |
| `src/electron/browser/embedded/tab.ts` | EmbeddedTab 增加 conversationId |
| `src/electron/browser/embedded/tab-store.ts` | per-conversation active/visible、显式 scope API、attach/detach |
| `src/electron/browser/embedded/state.ts` | 按 conversation 生成 BrowserState |
| `src/electron/browser/embedded/backend.ts` | 所有命令和隐式创建入口传递 conversationId |
| `src/electron/browser/embedded/user-tabs.ts` | claim token 绑定 conversationId |
| `src/electron/browser/lifecycle.ts` | finalize 同时校验 conversation 和 owner |
| `src/electron/window/create-window.ts` | 应用链接新开 tab 绑定 active conversation |

根据编译错误继续审计以下服务调用，它们持有 tab 引用，一般无需改变业务逻辑，但事件必须使用 `tab.conversationId`：

- navigation；
- downloads；
- dialogs；
- file chooser；
- permissions；
- clipboard；
- agent-browser controller/gateway。

### Phase 1 不修改

- `packages/opencode/src/tool/browser/*`；
- `packages/opencode/src/browser/transport.ts`；
- `packages/browser-protocol`。

现有 `request.sessionId`、`callId`、claim API 和 finalize API 已足够完成基础会话绑定。

---

## 9. 持久化与资源预算

建议拆成独立阶段，不与基础 session binding 同时上线。

### 9.1 Phase 1：进程内保活

- 切换会话时仅 detach，不销毁 WebContentsView；
- 切回时直接 attach；
- 应用退出后页面不恢复；
- 先解决正确性，避免一次引入序列化复杂度。

### 9.2 Phase 2：页面元数据持久化

在 `app.getPath("userData")` 下保存版本化文件，例如：

```json
{
  "version": 1,
  "conversations": {
    "session-id": {
      "activeTabId": "browser-tab-id",
      "visible": true,
      "tabs": [
        {
          "id": "browser-tab-id",
          "url": "https://example.com/",
          "title": "Example",
          "order": 0,
          "lastTouchedAt": 0,
          "disposition": "deliverable"
        }
      ]
    }
  }
}
```

写入要求：

- 临时文件 + rename 原子替换；
- debounce；
- schema version；
- 解析失败时忽略并重建，不能阻止应用启动；
- 不持久化 `ownerSessionId`、claim token、dialog、file chooser、clipboard 或 debugger session。

### 9.3 Phase 3：cold restore 和 WebContents 预算

引入 `LiveTab | ColdTab` 内部状态：

- 当前对话 active tab 保持 live；
- 正在 Agent 操作、播放音频、下载、弹窗或加载中的 tab 不回收；
- 超过 live tab 上限时，将最久未使用的 detached tab 保存导航状态后销毁 WebContents；
- 切回时重新创建 WebContents 并恢复 URL/导航状态；
- 恢复期间标记 `restoring`，防止 Agent 在页面尚未完成 materialize 时操作。

共享 partition 保证重新创建 WebContents 后登录 Cookie 仍可复用。

---

## 10. 并发与竞态处理

### 10.1 快速切换会话

Renderer 使用 owner revision；主进程的 `syncOwner` 同步执行 detach/attach 并返回对应状态。旧 revision 的 Promise 结果不得覆盖新会话。

### 10.2 后台 Agent 与用户同时操作

- `activeConversationId` 只能由 Renderer `syncOwner` 修改；
- Agent 只能修改自己 conversation 的 activeTabId/visible；
- claim 在主进程事件循环内完成校验和写入，必须是一个同步临界步骤；
- 用户主动操作已被 claim 的页面时，可以触发“用户接管”策略：立即释放 owner，或拒绝直到 finalize。Phase 1 建议用户操作优先并释放 owner，同时发布控制权变化事件。

### 10.3 stale tab command

Renderer 命令必须同时提供 conversationId 和 tabId。即使 tabId 仍存在，只要不属于指定 conversation，就返回 `TAB_NOT_FOUND`。

### 10.4 Agent 请求幂等

继续保留当前 `requestId + sessionId` 的去重逻辑。不要把 Renderer owner revision 当作 BrowserCommandRequest requestId。

---

## 11. 会话删除与 fork

### 11.1 删除会话

收到确认成功的 `session.deleted` 后调用：

```ts
runtime.disposeConversation(sessionId)
```

行为：

- 关闭该 conversation 的所有 WebContents；
- 清除 active/visible 状态；
- 删除 claim token；
- 删除持久化 snapshot；
- 如果它是当前 active conversation，则 detach 并将 owner 设为 null。

只有服务端确认删除后才执行，避免删除失败造成浏览器状态丢失。

### 11.2 fork

Phase 1 默认 fork 后浏览器为空，不隐式共享父会话页面。

后续如需要 Codex 风格 fork，可增加显式操作：

```ts
cloneConversationBrowserState(sourceConversationId, targetConversationId)
```

默认只复制 tab 描述和 URL，创建独立 WebContents，不让两个 conversation 引用同一个 live tab。

---

## 12. 测试方案

### 12.1 TabStore 单元测试

优先把以下场景加入 `test/browser-runtime.integration.poc.ts`，使用真实 Electron
`WebContentsView` 覆盖，避免用 mock 重复 TabStore 的实现逻辑：

1. A/B 创建 tab 后 `getState(A)`、`getState(B)` 互不包含对方页面；
2. A/B 分别保存 activeTabId；
3. A→B→A 后恢复同一 tab 和同一 WebContents；
4. 关闭 A active tab 只在 A 内选择相邻 tab；
5. `visible` 为 per-conversation；
6. `syncOwner(null)` detach 但不销毁；
7. 后台 Agent activate/show 不改变 activeConversationId；
8. `window.open` child 继承父 tab conversationId。

### 12.2 claim 和 lifecycle 测试

覆盖：

1. Agent A 的 openTabs 只返回 A 中未被控制的用户页面和已保留页面；
2. Agent B 无法使用 A 的 claim ID；
3. claim 后 Agent A 可以 read/snapshot/action；
4. Agent B 对 A tab 获得 `TAB_NOT_FOUND`；
5. 同会话未 claim 的 user tab 获得 `TAB_NOT_OWNED`；
6. finalize 释放 user tab 控制权但保留 conversationId；
7. finalize 关闭 Agent temporary tab；
8. deliverable/handoff 页面保留并释放 owner；
9. claim TTL 过期后不能使用；
10. stale title/url/owner 校验仍生效；
11. Agent 调用 `tabs.list` 会自动 claim 并返回当前对话的用户页面；
12. `tabs.list` 不会返回或 claim 其他对话的页面。

### 12.3 Dispatcher 与事件测试

覆盖：

1. Agent response state 只包含已控制的当前 conversation tabs；
2. Renderer state 包含当前 conversation 的全部 tabs；
3. 用户页面事件的 event.sessionId 等于 conversationId，而不是 `renderer`；
4. A 的后台事件不会更新 B 的 Renderer state；
5. requestId 在不同 session 下仍不能复用。

### 12.4 IPC 测试

覆盖：

1. 缺少 conversationId 拒绝；
2. 非主窗口 sender 拒绝；
3. stale owner 的 Renderer 命令拒绝；
4. selectedSession 为空时，浏览器按钮先创建真实 session，再用该 id 新建 tab；
5. 快速 A→B 切换不应用 A 的迟到状态。

### 12.5 集成验收

人工或 POC 流程：

```text
1. 新建空白对话，不发送消息，点击右上角浏览器按钮并打开百度。
2. 发送第一条消息让 Agent 调用 `tabs.list`，确认能读取百度页面及 URL。
3. 在会话 A 新建页面并登录网站。
4. 让 Agent A 直接调用 tabs.list → read，确认可读取用户页面。
5. 再验证 openTabs → claimTab → read 显式流程仍可用。
6. 切换会话 B，确认 A 页面不显示。
7. 在 B 新建不同页面。
8. 让 Agent B 枚举页面，确认看不到 A。
9. 切回 A，确认 URL、页面内容、滚动/登录状态仍在。
10. Agent B 在后台导航，确认 UI 不跳到 B。
11. finalize Agent A，确认用户页面保留、临时 Agent 页面关闭。
```

### 12.6 回归命令

遵循仓库要求，从各 package 目录执行：

```bash
cd packages/desktop-forge
bun typecheck
bun test test/browser-security.test.ts test/browser-session-binding.test.ts

cd ../opencode
bun typecheck
bun test test/browser
```

如果 Phase 1 不修改 opencode，opencode 测试属于协议兼容回归，不应出现快照或行为变化。

---

## 13. 分阶段实施顺序

### Phase 1A：内部 scope 基础

1. `EmbeddedTab` 增加 conversationId；
2. TabStore 引入 conversation state map；
3. 所有 store API 显式要求 conversationId；
4. 完成 per-conversation state 和 attach/detach 测试。

这一阶段先不接 Renderer，确保主进程模型正确。

### Phase 1B：Renderer owner 同步

1. 拆分 `AppContent`；
2. preload/IPC 增加 syncBrowserOwner；
3. BrowserPanel 命令携带 selectedSession.id；
4. 状态广播增加 conversationId envelope；
5. 验证 A/B 切换展示。

### Phase 1C：Agent claim 和安全收口

1. HTTP request sessionId 映射为 conversationId；
2. openTabs/claim token 增加 scope；
3. SecurityGate 改为 scope-first；
4. finalize 不再清除稳定归属；
5. 补齐跨会话不可见测试。

### Phase 1D：隐式入口和回归

1. 审计 window.open、child tab、browser.show、应用链接；
2. history 增加 scope；
3. 完成集成 POC；
4. 运行 desktop-forge 和 opencode 回归。

### Phase 2：持久化

增加 metadata snapshot、应用重启恢复和 session 删除清理。

### Phase 3：资源预算

增加 cold restore、live WebContents 上限和恢复状态机。

### Phase 4：可选 opencode 增强

仅在需要完整 Codex 生命周期时实施：

1. 增加整轮级 `turnId`，而不是复用 per-tool `callId`；
2. 在 turn 结束或取消时自动 finalize；
3. 支持 parent/subagent/fork 到 browserConversationId 的 route 映射；
4. 在用户消息中注入明确的 Browser tab mention，降低 Agent 忘记 openTabs/claim 的概率；
5. 如需公开 `conversationId/controllerSessionId`，升级 browser protocol 版本并提供兼容解析。

---

## 14. 验收标准

Phase 1 合并前必须全部满足：

- [x] 用户 tab 创建时一定有非空 conversationId；
- [x] 未发消息的新对话点击浏览器时会先创建真实 session，第一条消息复用同一 id；
- [x] 主进程不存在不带 conversationId 的 tab 查找和创建 API；
- [x] A/B 的 tab 列表、activeTabId、visible 完全隔离；
- [x] 切换对话只 detach/attach，不销毁页面；
- [x] Agent 能通过 tabs.list 自动 claim/read 同会话用户页面，显式 openTabs/claim/read 仍可用；
- [x] Agent 无法发现其他会话的 tab 或 claim token；
- [x] 后台 Agent 不能改变当前 Renderer owner；
- [x] finalize 不修改 tab.conversationId；
- [x] 用户页面 finalize 后仍保留；
- [x] 临时 Agent 页面 finalize 后关闭；
- [x] 跨会话 tabId 请求返回 TAB_NOT_FOUND；
- [x] 快速切换不会出现迟到状态覆盖；
- [x] 共享浏览器登录态保持可用；
- [x] desktop-forge typecheck 和浏览器测试通过；
- [x] opencode browser 回归测试通过。

---

## 15. 风险与回滚

### 主要风险

1. 某个隐式 tab 创建入口遗漏 conversationId，产生无法展示的孤儿页面；
2. 事件仍广播全局状态，导致后台 Agent 污染当前 UI；
3. Renderer 快速切换产生 stale command；
4. SecurityGate 先判断 owner 后判断 scope，泄露跨会话 tab 存在性；
5. finalize 继续清空页面归属；
6. 过早引入持久化和 cold restore，扩大首轮改造范围。

### 控制措施

- 主进程创建 tab 时强制要求非空 conversationId；
- 不提供默认 conversation 或 `"renderer"` scope fallback；
- 所有状态事件带 conversationId envelope；
- Phase 1 只做进程内保活；
- 使用功能开关保留旧 BrowserPanel 展示路径，出现严重问题时可关闭 session-scoped UI，但不回退安全过滤；
- 在调试日志中记录 `conversationId/tabId/actor/requestId`，不记录页面正文、Cookie 或 token。

## 16. 推荐最终决策

推荐先实施 Phase 1A～1D，保持 browser protocol v3 和 opencode 不变。这样可以最小范围解决当前两个问题，同时建立后续持久化和 turn 生命周期需要的正确边界。

不要在第一版实现中：

- 为每个对话创建独立 Chromium partition；
- 复制 Codex 的完整 cold restore；
- 用 `ownerSessionId` 继续充当 conversationId；
- 让后台 Agent 自动切换用户当前浏览器面板；
- 为了传 conversationId 立即升级公共 browser protocol。

先完成稳定的对话命名空间、显式 Renderer owner 和 scoped claim，收益最大、风险最低。
