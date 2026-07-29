# Browser Read Skill 化执行方案

> 历史文档：其中 Browser Protocol v2、只读 evaluate 与 `tab.playwright.*`
> 设计已由 `AGENT_BROWSER_TARGET_ARCHITECTURE.md` 的 Protocol v3 typed getter
> 架构取代，不再作为当前实现或验收依据。

## 1. 结论

Browser Core 只提供通用浏览器能力，不再提供文章、账号、发布时间、平台识别或批量内容读取等业务接口。

最终边界：

- Browser Core 保留标签页、导航、DOM snapshot、序列化 HTML、只读 evaluate、locator、截图、下载、弹窗、上传、CDP 和 CUA。
- `read-web-content` Skill 负责正文选择、JSON-LD、元数据、站点识别、字段归一化、批量读取和截断。
- `skill_execute` 只执行用户 `~/.lxz/skills` 目录中的可信可执行 Skill。
- Skill 只能调用注入的 `browser.execute()` / `browser.finalize()`，不能读取浏览器 endpoint、token 或原始 transport。
- Browser wire protocol 为 v2；v1 请求和所有旧 `content` 命令直接失败。

## 2. 强制迁移门槛

删除旧 read 必须遵守以下顺序：

1. 先实现 `tab.playwright.html` 和共享 `AuthorizedBrowserCapability`。
2. 再实现可信可执行 Skill Runtime 和 `read-web-content`。
3. 用固定 HTML 与生命周期测试验证字段、截断、并发、失败、超时、取消和标签页所有权。
4. 只有替代测试全部通过，才能删除旧 `content` API。
5. 删除后再次运行协议、Skill、Browser 回归和分包静态检查。

任何一步失败都不得提前删除旧 read。本次实际切换时，替代测试已先通过。

## 3. Browser Core

### 3.1 共享授权能力

`packages/opencode/src/tool/browser.ts` 暴露：

```ts
AuthorizedBrowserCapability.execute(params, ctx)
```

Browser Tool 与可执行 Skill 共用这个入口，因此权限语义不会分叉：

| 行为 | 权限 |
| --- | --- |
| `tab.goto` | `webfetch` |
| click、fill、press、check、select 等交互 | `browser_interaction` |
| `tab.dev.cdp` / `tab.dev.cdp.events` | `browser_cdp` |
| `tab.fileChooser.setFiles` | `read` |

交互和 CDP 在执行前读取当前页面 origin，把获批 origin 作为 `expectedOrigin` 下发；页面在授权后换源时由 Runtime 返回 `ORIGIN_CHANGED`。

Capability 只返回 `{ data, events }` 结构。连接地址和 token 仍由 `browser/config.ts` 私有持有。

### 3.2 通用 HTML

协议新增：

```text
tab.playwright.html
```

客户端新增：

```ts
await tab.playwright.html()
```

该命令公开现有 `PlaywrightRuntime.html()` 的主页面序列化结果，包括表单运行态同步，不包含文章选择器或站点规则。

## 4. 可执行 Skill Runtime

新增 `skill_execute` Tool：

```ts
{
  name: string
  input: unknown
}
```

现有 `skill` Tool 仍只加载 `SKILL.md` 说明；执行前仍请求 `skill` 权限。

可信 Skill 使用 `agents/opencode.json` 声明：

```json
{
  "version": 1,
  "entry": "scripts/execute.ts",
  "capabilities": ["browser"]
}
```

Runtime 注入：

- `abort`
- `sessionID` / `callID`
- `directory` / `worktree`
- 受控 `browser.execute()` / `browser.finalize()`

安全约束：

- 可信根只由 desktop-forge 启动 opencode 时通过 `OPENCODE_TRUSTED_SKILLS_DIR` 设置。
- 开发和打包环境的可信根均为 `${OPENCODE_TEST_HOME:-$HOME}/.lxz/skills`。
- 只有该用户目录下的 Skill 可以声明 runtime manifest 并执行；项目 Skill 和其他扫描来源不能执行。
- Skill 名必须是 kebab-case。
- manifest 和执行入口的 realpath 必须位于可信 Skill 目录内。
- 拒绝目录穿越、软链接越界、未知 manifest 字段和未声明 capability。
- 同名普通 Skill 不影响执行入口；可信根内版本优先加载。

## 5. `read-web-content`

目录：

```text
~/.lxz/skills/read-web-content/
├── SKILL.md
├── agents/
│   ├── openai.yaml
│   └── opencode.json
├── references/
│   └── output-schema.json
└── scripts/
    └── execute.ts
```

输入：

```ts
{
  tabId?: string
  urls?: string[]
  format?: "metadata" | "text" | "html"
  timeoutMs?: number
}
```

`tabId` 与非空 `urls` 必须且只能提供一个。

### 5.1 标签页与批量行为

- `tabId` 读取现有标签页，不关闭标签页，也不调用 finalize 改变 ownership。
- `urls` 为每个 URL 创建 temporary tab。
- 最大并发为 4，输出保持输入顺序。
- 单项失败不会终止其他 URL。
- 每批在成功、失败、超时或取消后调用带独立清理 signal 的 finalize，避免 temporary tab 泄漏。
- 每个 URL 的 timeout signal 与会话取消 signal 合并，并传入所有 Browser Capability 调用。

### 5.2 成功与失败输出

成功：

```ts
{
  ok: true
  account: string | null
  canonicalUrl: string | null
  description: string | null
  platform: string
  publishedAt: string | null
  title: string
  url: string
  text?: string
  html?: string
}
```

失败：

```ts
{
  ok: false
  url: string
  error: {
    code: string
    message: string
    retryable: boolean
  }
}
```

限制：

- `text` 最多 30,000 字符。
- `html` 最多 1,000,000 字符。
- `metadata` 不返回正文。

旧 desktop-forge `content.ts` 中的 JSON-LD article 选择、author、canonical、description、published time、标题优先级、微信选择器和平台映射已经迁入 Skill。

## 6. 删除范围

协议 v2 删除：

```text
tabs.content
tab.content.read
tab.content.export
tab.content.exportGsuite
```

同时删除：

- `BrowserSnapshot`
- `BrowserReadFormat`
- `BrowserTabsContentType`
- `BrowserTabsContentInput`
- `BrowserTabsContentResult`
- `BrowserCommandData.contentResults`
- `BrowserCommandData.snapshot`
- 仅服务旧导出的 `BrowserCommandData.path`
- opencode `ContentAPI`、`Tabs.content()` 及 Browser Tool 的相关参数和 dispatch
- desktop-forge `embedded/content.ts`、`embedded/export.ts`、backend 和 security 分支

MHTML 与 Google Workspace 导出不迁移，因为仓库内没有调用方；未来如有需求，应设计独立的通用保存能力或独立 Skill，不恢复 `ContentAPI`。

## 7. 为什么删除 `BrowserSnapshot`

`BrowserSnapshot` 的字段本身就是文章业务模型，而不是浏览器原语。`tab.content.read` 删除后它没有通用生产者，保留它会让 Core 继续承担正文选择、平台识别和元数据归一化责任。

它不同于：

- `BrowserDomSnapshot`：通用可交互 DOM/无障碍结构。
- Playwright DOM snapshot：通用页面结构文本。
- `BrowserScreenshot`：通用视觉结果。

业务字段没有消失，而是由 `read-web-content` 以字段等价结果继续输出。

## 8. 验证清单

- 固定 HTML：JSON-LD graph、非法 JSON-LD、itemprop、普通 article/main、微信选择器和无正文页面。
- 限制：text 30,000、HTML 1,000,000、metadata 无正文。
- 生命周期：批量顺序、最大并发 4、单项失败、超时、取消、temporary tab 清理、existing tab 不 finalize。
- Runtime：用户可信根、未知 capability、目录穿越、entry/manifest 软链接越界、项目目录同名 Skill。
- 协议：v2 接受 `tab.playwright.html`，拒绝 v1 与全部旧 `content` 命令。
- 回归：DOM snapshot、locator、evaluate、screenshot、下载、弹窗、claim/finalize。
- 校验：`quick_validate.py`、各包 typecheck、desktop-forge lint 与定向测试。
