import type { BrowserReadFormat, BrowserSnapshot } from "@opencode-ai/browser-protocol"
import type { EmbeddedTab } from "./tab"
import { BrowserRuntimeException } from "../errors"

export function readPage(tab: EmbeddedTab, format: BrowserReadFormat = "text") {
    if (!tab.view.webContents.getURL()) {
        throw new BrowserRuntimeException("NAVIGATION_FAILED", "Browser tab has not opened a page")
    }
    if (tab.error) {
        throw new BrowserRuntimeException("NAVIGATION_FAILED", `Page failed to load: ${tab.error.description}`, true)
    }
    return tab.view.webContents.executeJavaScript(snapshotScript(format), true) as Promise<BrowserSnapshot>
}

function snapshotScript(format: BrowserReadFormat) {
    return `(() => {
        const compact = (value) => typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : ""
        const first = (values) => values.map(compact).find(Boolean) || null
        const meta = (...names) => first(names.flatMap((name) => [
            document.querySelector('meta[name="' + name + '"]')?.content,
            document.querySelector('meta[property="' + name + '"]')?.content,
            document.querySelector('meta[itemprop="' + name + '"]')?.content,
        ]))
        const selectorText = (...selectors) => first(selectors.map((selector) => document.querySelector(selector)?.textContent))
        const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).flatMap((node) => {
            try {
                const parsed = JSON.parse(node.textContent || "null")
                const values = Array.isArray(parsed) ? parsed : [parsed]
                return values.flatMap((value) => value && Array.isArray(value["@graph"]) ? value["@graph"] : value)
            } catch {
                return []
            }
        }).filter((value) => value && typeof value === "object")
        const article = jsonLd.find((value) => {
            const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : value["@type"]
            return typeof type === "string" && /article|posting|news/i.test(type)
        }) || jsonLd[0] || {}
        const authorName = (author) => {
            const value = Array.isArray(author) ? author[0] : author
            if (typeof value === "string") return value
            return value && typeof value.name === "string" ? value.name : ""
        }
        const host = location.hostname.replace(/^www\\./, "").toLowerCase()
        const platform = host.includes("weixin.qq.com") ? "微信公众号"
            : host.includes("weibo.com") ? "微博"
            : host.includes("toutiao.com") ? "今日头条"
            : host.includes("baijiahao.baidu.com") ? "百家号"
            : host.includes("sohu.com") ? "搜狐号"
            : host.includes("163.com") ? "网易号"
            : host.includes("qq.com") ? "腾讯新闻"
            : host.includes("xiaohongshu.com") ? "小红书"
            : host.includes("douyin.com") ? "抖音"
            : host
        const result = {
            account: first([
                authorName(article.author),
                meta("author", "article:author", "byl"),
                selectorText("#js_name", ".profile_nickname", ".author-name", "[rel=author]", "[itemprop=author]"),
            ]),
            canonicalUrl: first([
                document.querySelector('link[rel="canonical"]')?.href,
                meta("og:url"),
            ]),
            description: meta("description", "og:description", "twitter:description"),
            platform,
            publishedAt: first([
                article.datePublished,
                article.dateCreated,
                meta("article:published_time", "publishdate", "pubdate", "date"),
                document.querySelector("time[datetime]")?.getAttribute("datetime"),
            ]),
            title: first([
                article.headline,
                article.name,
                meta("og:title", "twitter:title"),
                selectorText("h1"),
                document.title,
            ]) || "",
            url: location.href,
        }
        if (${JSON.stringify(format)} === "text") {
            const main = document.querySelector("article, main, [role=main], #js_content, .article-content, .article")
            result.text = compact(main?.innerText || document.body?.innerText || "").slice(0, 30000)
        }
        if (${JSON.stringify(format)} === "html") {
            result.html = (document.documentElement?.outerHTML || "").slice(0, 1000000)
        }
        return result
    })()`
}
