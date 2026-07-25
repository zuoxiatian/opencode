// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import { ReadonlyEvaluationService } from "../src/electron/browser/embedded/automation/readonly-evaluate"
import { execute } from "../../desktop-lxz/skills/read-web-content/scripts/execute"

type Page = {
    html: string
    title?: string
}

function browserFixture(
    pages: Record<string, Page>,
    options: {
        abort?: AbortSignal
        existing?: { id: string; url: string }
        evaluateFailure?: string[]
        fail?: string[]
        navigationDelayMs?: number
        stall?: string[]
    } = {},
) {
    const evaluator = new ReadonlyEvaluationService()
    const tabs = new Map<string, { temporary: boolean; url: string }>()
    if (options.existing) {
        tabs.set(options.existing.id, { temporary: false, url: options.existing.url })
    }
    const commands: string[] = []
    let activeNavigations = 0
    let finalized = 0
    let maximumNavigations = 0
    let sequence = 0

    return {
        commands,
        context: {
            abort: options.abort ?? AbortSignal.any([]),
            browser: {
                execute: async (
                    input: {
                        command: string
                        arg?: unknown
                        expression?: string
                        tabId?: string
                        timeout?: number
                        url?: string
                    },
                    execution?: { abort?: AbortSignal },
                ) => {
                    commands.push(input.command)
                    execution?.abort?.throwIfAborted()
                    if (input.command === "tabs.new") {
                        const tabId = `temporary-${sequence++}`
                        tabs.set(tabId, { temporary: true, url: "" })
                        return { tabId }
                    }
                    if (!input.tabId) throw new Error(`${input.command} requires tabId`)
                    const tab = tabs.get(input.tabId)
                    if (!tab) throw new Error(`Unknown tab ${input.tabId}`)

                    if (input.command === "tab.goto") {
                        if (!input.url) throw new Error("tab.goto requires url")
                        activeNavigations += 1
                        maximumNavigations = Math.max(maximumNavigations, activeNavigations)
                        await navigate(input.url, execution?.abort).finally(() => {
                            activeNavigations -= 1
                        })
                        if (options.fail?.includes(input.url)) {
                            return {
                                navigation: {
                                    error: {
                                        code: "NAVIGATION_FAILED",
                                        message: "fixture navigation failed",
                                        retryable: true,
                                    },
                                    finalUrl: input.url,
                                    status: "failed",
                                },
                            }
                        }
                        tab.url = input.url
                        return {
                            navigation: {
                                finalUrl: input.url,
                                generation: 1,
                                status: "committed",
                            },
                        }
                    }

                    const page = pages[tab.url]
                    if (!page) throw new Error(`Missing fixture for ${tab.url}`)
                    if (input.command === "tab.state") {
                        return {
                            tab: {
                                title: page.title ?? "",
                                url: tab.url,
                            },
                        }
                    }
                    if (input.command === "tab.playwright.evaluate") {
                        if (options.evaluateFailure?.includes(tab.url)) throw new Error("fixture evaluate failed")
                        if (!input.expression) throw new Error("Missing fixture expression")
                        return {
                            value: evaluator.evaluate({
                                arg: input.arg,
                                expression: input.expression,
                                html: page.html,
                                url: tab.url,
                            }),
                        }
                    }
                    if (input.command === "tab.playwright.html") return { html: page.html }
                    throw new Error(`Unsupported fixture command ${input.command}`)
                },
                finalize: async () => {
                    finalized += 1
                    Array.from(tabs.entries())
                        .filter((entry) => entry[1].temporary)
                        .forEach(([id]) => tabs.delete(id))
                },
            },
        },
        finalized: () => finalized,
        maximumNavigations: () => maximumNavigations,
        openTemporaryTabs: () => Array.from(tabs.values()).filter((tab) => tab.temporary).length,
    }

    async function navigate(url: string, abort?: AbortSignal) {
        if (options.stall?.includes(url)) {
            await new Promise<never>((_resolve, reject) => {
                abort?.addEventListener("abort", () => reject(abort.reason), { once: true })
            })
        }
        if (options.navigationDelayMs) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, options.navigationDelayMs)
                abort?.addEventListener("abort", () => {
                    clearTimeout(timer)
                    reject(abort.reason)
                }, { once: true })
            })
        }
    }
}

describe("read-web-content skill", () => {
    test("extracts JSON-LD, itemprop metadata, canonical URL, and article text", async () => {
        const url = "https://example.com/posts/one"
        const fixture = browserFixture({
            [url]: {
                html: `
                    <html>
                      <head>
                        <title>Document title</title>
                        <link rel="canonical" href="/canonical">
                        <meta itemprop="description" content=" Itemprop description ">
                        <script type="application/ld+json">{broken json</script>
                        <script type="application/ld+json">
                          {"@graph":[{"@type":"WebSite","name":"Site"},{"@type":"NewsArticle","headline":"JSON headline","author":{"name":"JSON author"},"datePublished":"2026-07-24"}]}
                        </script>
                      </head>
                      <body><article> First   article <span>body</span> </article></body>
                    </html>
                `,
            },
        })

        const output = await execute({ urls: [url], format: "text" }, fixture.context)

        expect(output).toEqual({
            results: [{
                ok: true,
                account: "JSON author",
                canonicalUrl: "https://example.com/canonical",
                description: "Itemprop description",
                platform: "example.com",
                publishedAt: "2026-07-24",
                text: "First article body",
                title: "JSON headline",
                url,
            }],
        })
        expect(fixture.openTemporaryTabs()).toBe(0)
        expect(fixture.finalized()).toBe(1)
    })

    test("preserves WeChat selectors and ignores malformed JSON-LD", async () => {
        const url = "https://mp.weixin.qq.com/s/example"
        const fixture = browserFixture({
            [url]: {
                html: `
                    <html>
                      <head>
                        <meta property="og:title" content="WeChat title">
                        <meta name="description" content="WeChat description">
                        <script type="application/ld+json">not json</script>
                      </head>
                      <body>
                        <div id="js_name">Publisher account</div>
                        <div id="js_content">Line one <strong>line two</strong></div>
                      </body>
                    </html>
                `,
            },
        })

        const output = await execute({ urls: [url], format: "text" }, fixture.context)

        expect(output.results[0]).toMatchObject({
            ok: true,
            account: "Publisher account",
            description: "WeChat description",
            platform: "微信公众号",
            text: "Line one line two",
            title: "WeChat title",
            url,
        })
    })

    test("supports empty-body metadata and exact text/html truncation limits", async () => {
        const metadataUrl = "https://empty.example/page"
        const fallbackUrl = "https://fallback.example/page"
        const textUrl = "https://text.example/page"
        const htmlUrl = "https://html.example/page"
        const metadata = browserFixture({
            [metadataUrl]: { html: "<html><head><title>Empty</title></head></html>" },
        })
        const text = browserFixture({
            [textUrl]: { html: `<html><body><main>${"x".repeat(31_000)}</main></body></html>` },
        })
        const fallback = browserFixture({
            [fallbackUrl]: { html: "<html><body><main></main><footer>Fallback body</footer></body></html>" },
        })
        const html = browserFixture({
            [htmlUrl]: { html: "h".repeat(1_000_100) },
        })

        const metadataOutput = await execute({ urls: [metadataUrl], format: "metadata" }, metadata.context)
        const fallbackOutput = await execute({ urls: [fallbackUrl], format: "text" }, fallback.context)
        const textOutput = await execute({ urls: [textUrl], format: "text" }, text.context)
        const htmlOutput = await execute({ urls: [htmlUrl], format: "html" }, html.context)

        expect(metadataOutput.results[0]).not.toHaveProperty("text")
        expect(metadataOutput.results[0]).not.toHaveProperty("html")
        expect(fallbackOutput.results[0]).toMatchObject({ ok: true, text: "Fallback body" })
        expect(textOutput.results[0]).toMatchObject({ ok: true })
        expect((textOutput.results[0] as { text: string }).text).toHaveLength(30_000)
        expect((htmlOutput.results[0] as { html: string }).html).toHaveLength(1_000_000)
    })

    test("keeps batch order, limits concurrency to four, and isolates failures", async () => {
        const urls = Array.from({ length: 6 }, (_value, index) => `https://batch.example/${index}`)
        const fixture = browserFixture(
            Object.fromEntries(urls.map((url, index) => [
                url,
                { html: `<html><head><title>Page ${index}</title></head><body>Body ${index}</body></html>` },
            ])),
            {
                fail: [urls[2]],
                navigationDelayMs: 5,
            },
        )

        const output = await execute({ urls, format: "metadata" }, fixture.context)

        expect(output.results.map((result) => result.url)).toEqual(urls)
        expect(output.results[2]).toEqual({
            ok: false,
            error: {
                code: "NAVIGATION_FAILED",
                message: "fixture navigation failed",
                retryable: true,
            },
            url: urls[2],
        })
        expect(output.results.filter((result) => result.ok)).toHaveLength(5)
        expect(fixture.maximumNavigations()).toBe(4)
        expect(fixture.finalized()).toBe(2)
        expect(fixture.openTemporaryTabs()).toBe(0)
    })

    test("cleans up temporary tabs after timeout and cancellation", async () => {
        const timeoutUrl = "https://timeout.example/page"
        const timeout = browserFixture(
            { [timeoutUrl]: { html: "<html></html>" } },
            { stall: [timeoutUrl] },
        )
        const cancelledController = new AbortController()
        cancelledController.abort()
        const cancelledUrl = "https://cancelled.example/page"
        const cancelled = browserFixture(
            { [cancelledUrl]: { html: "<html></html>" } },
            { abort: cancelledController.signal },
        )

        const timeoutOutput = await execute({ urls: [timeoutUrl], timeoutMs: 5 }, timeout.context)
        const cancelledOutput = await execute({ urls: [cancelledUrl] }, cancelled.context)

        expect(timeoutOutput.results[0]).toMatchObject({
            ok: false,
            error: { code: "TIMEOUT", retryable: true },
            url: timeoutUrl,
        })
        expect(cancelledOutput.results[0]).toMatchObject({
            ok: false,
            error: { code: "CANCELLED", retryable: false },
            url: cancelledUrl,
        })
        expect(timeout.finalized()).toBe(1)
        expect(cancelled.finalized()).toBe(1)
        expect(timeout.openTemporaryTabs()).toBe(0)
        expect(cancelled.openTemporaryTabs()).toBe(0)
    })

    test("reads an existing tab without closing or finalizing it", async () => {
        const url = "https://existing.example/page"
        const fixture = browserFixture(
            { [url]: { html: "<html><head><title>Existing</title></head><body>Existing body</body></html>" } },
            { existing: { id: "existing-tab", url } },
        )

        const output = await execute({ tabId: "existing-tab", format: "text" }, fixture.context)

        expect(output.results[0]).toMatchObject({
            ok: true,
            text: "Existing body",
            title: "Existing",
            url,
        })
        expect(fixture.finalized()).toBe(0)
        expect(fixture.commands).not.toContain("tabs.new")
    })

    test("reports the page URL when an existing tab fails after state is read", async () => {
        const url = "https://existing.example/failure"
        const fixture = browserFixture(
            { [url]: { html: "<html><head><title>Existing</title></head></html>" } },
            {
                evaluateFailure: [url],
                existing: { id: "existing-tab", url },
            },
        )

        const output = await execute({ tabId: "existing-tab" }, fixture.context)

        expect(output.results[0]).toMatchObject({
            ok: false,
            url,
        })
        expect(fixture.finalized()).toBe(0)
    })

    test("rejects ambiguous or empty source input", async () => {
        const fixture = browserFixture({})

        await expect(execute({}, fixture.context)).rejects.toThrow("Provide exactly one")
        await expect(execute({ tabId: "one", urls: ["https://example.com"] }, fixture.context))
            .rejects.toThrow("Provide exactly one")
        await expect(execute({ urls: [] }, fixture.context)).rejects.toThrow("Provide exactly one")
    })
})
