import type { BrowserLoadError } from "./browser"

export function browserErrorHost(error: BrowserLoadError) {
    try {
        return new URL(error.url).hostname
    } catch {
        return ""
    }
}

export function browserErrorContent(error: BrowserLoadError) {
    const code = error.description.replace(/^net::/i, "").toUpperCase() || `ERR_FAILED (${error.code})`
    const host = browserErrorHost(error)
    if (error.kind === "crash" || code.includes("OUT_OF_MEMORY") || code.includes("PROCESS_CRASHED")) {
        return {
            code,
            message: "页面进程意外终止，重新加载通常可以恢复。",
            suggestions: ["关闭暂时不需要的标签页", "重新加载此页面"],
            title: "页面出了点问题",
        }
    }
    if (code.includes("NAME_NOT_RESOLVED") || code.includes("DNS_PROBE")) {
        return {
            code,
            message: `无法找到 ${host || "该网站"} 的服务器地址。`,
            suggestions: ["检查网址是否正确", "检查 DNS 和网络连接"],
            title: "找不到此网站",
        }
    }
    if (code.includes("INTERNET_DISCONNECTED")) {
        return {
            code,
            message: "设备当前没有连接到互联网。",
            suggestions: ["检查网络连接", "重新连接后再试"],
            title: "未连接到互联网",
        }
    }
    if (code.includes("CONNECTION_REFUSED")) {
        return {
            code,
            message: `${host || "该网站"} 拒绝了连接。`,
            suggestions: ["确认服务是否正在运行", "检查防火墙或代理设置"],
            title: "无法连接到此网站",
        }
    }
    if (code.includes("TIMED_OUT")) {
        return {
            code,
            message: `${host || "该网站"} 的响应时间过长。`,
            suggestions: ["检查网络连接", "稍后重新加载"],
            title: "网站响应时间过长",
        }
    }
    if (code.includes("CERT_")) {
        return {
            code,
            message: `${host || "该网站"} 返回的安全证书无法验证。`,
            suggestions: ["检查电脑的日期和时间", "确认网络环境安全后重试"],
            title: "你的连接不是私密连接",
        }
    }
    return {
        code,
        message: `${host || "该页面"} 暂时无法访问。`,
        suggestions: ["检查网络连接", "确认网址是否正确，或稍后重试"],
        title: "无法打开此页面",
    }
}
