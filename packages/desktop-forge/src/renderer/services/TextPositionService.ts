/**
 * TextPositionService - 文本位置服务
 * 用于处理 PDF 中文本位置的查找和高亮定位
 */

export interface TextRect {
    x1: number
    y1: number
    x2: number
    y2: number
}

export interface TextPosition {
    page: number
    text: string
    rects: TextRect[]
    confidence: number  // 匹配置信度 0-1
}

export interface SearchResult {
    positions: TextPosition[]
    totalMatches: number
}

export interface SearchOptions {
    caseSensitive?: boolean
    wholeWord?: boolean
    fuzzyMatch?: boolean           // 启用模糊匹配
    fuzzyThreshold?: number        // 模糊匹配阈值 (0-1)
    normalizeWhitespace?: boolean  // 规范化空白字符
}

/**
 * 文本位置服务类
 * 提供文本搜索、位置计算和高亮坐标转换功能
 */
export class TextPositionService {
    private static instance: TextPositionService | null = null

    private constructor() { }

    /**
     * 获取单例实例
     */
    static getInstance(): TextPositionService {
        if (!TextPositionService.instance) {
            TextPositionService.instance = new TextPositionService()
        }
        return TextPositionService.instance
    }

    /**
     * 规范化文本 - 移除多余空白、统一字符
     */
    private normalizeText(text: string): string {
        return text
            .replace(/\s+/g, ' ')           // 多个空白字符合并为一个空格
            .replace(/[\u00A0\u2000-\u200B\u2028\u2029\u3000]/g, ' ')  // 特殊空格字符
            .replace(/[\u2018\u2019]/g, "'") // 智能引号
            .replace(/[\u201C\u201D]/g, '"') // 智能双引号
            .replace(/[\u2013\u2014]/g, '-') // 破折号
            .replace(/\r\n|\r/g, '\n')       // 换行符统一
            .trim()
    }

    /**
     * 计算两个字符串的相似度 (Levenshtein 距离)
     * 返回 0-1 之间的值，1 表示完全匹配
     */
    private calculateSimilarity(str1: string, str2: string): number {
        const s1 = str1.toLowerCase()
        const s2 = str2.toLowerCase()

        if (s1 === s2) return 1
        if (s1.length === 0 || s2.length === 0) return 0

        const len1 = s1.length
        const len2 = s2.length

        // 使用滚动数组优化空间
        let prev = Array.from({ length: len2 + 1 }, (_, i) => i)
        let curr = new Array(len2 + 1)

        for (let i = 1; i <= len1; i++) {
            curr[0] = i
            for (let j = 1; j <= len2; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
                curr[j] = Math.min(
                    prev[j] + 1,      // 删除
                    curr[j - 1] + 1,   // 插入
                    prev[j - 1] + cost // 替换
                )
            }
            [prev, curr] = [curr, prev]
        }

        const distance = prev[len2]
        const maxLen = Math.max(len1, len2)
        return 1 - distance / maxLen
    }

    /**
     * 在 PDF 页面中搜索文本
     * @param pdfDocument PDF 文档对象
     * @param searchText 要搜索的文本
     * @param options 搜索选项
     */
    async searchText(
        pdfDocument: any,
        searchText: string,
        options: SearchOptions = {}
    ): Promise<SearchResult> {
        const positions: TextPosition[] = []
        const numPages = pdfDocument.numPages

        // 设置默认选项
        const opts: SearchOptions = {
            caseSensitive: false,
            wholeWord: false,
            fuzzyMatch: true,           // 默认启用模糊匹配
            fuzzyThreshold: 0.7,        // 默认阈值 70%
            normalizeWhitespace: true,  // 默认规范化空白
            ...options
        }

        console.log(`[TextPositionService] 搜索文本: "${searchText.substring(0, 50)}..."`, opts)

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdfDocument.getPage(pageNum)
            const textContent = await page.getTextContent()
            const pagePositions = this.findTextInPage(textContent, searchText, pageNum, opts)
            positions.push(...pagePositions)
        }

        // 按置信度排序
        positions.sort((a, b) => b.confidence - a.confidence)

        console.log(`[TextPositionService] 找到 ${positions.length} 个匹配`)

        return {
            positions,
            totalMatches: positions.length
        }
    }

    /**
     * 在单个页面中查找文本位置 - 优化版本
     */
    private findTextInPage(
        textContent: any,
        searchText: string,
        pageNum: number,
        options: SearchOptions
    ): TextPosition[] {
        const positions: TextPosition[] = []
        const items = textContent.items

        // 规范化搜索文本
        let normalizedSearch = options.normalizeWhitespace
            ? this.normalizeText(searchText)
            : searchText

        if (!options.caseSensitive) {
            normalizedSearch = normalizedSearch.toLowerCase()
        }

        // 方法1: 单个文本元素内查找（精确匹配）
        for (const item of items) {
            let str = item.str
            if (options.normalizeWhitespace) {
                str = this.normalizeText(str)
            }
            let normalizedStr = options.caseSensitive ? str : str.toLowerCase()

            let index = normalizedStr.indexOf(normalizedSearch)
            while (index !== -1) {
                if (this.checkWholeWord(normalizedStr, index, normalizedSearch, options)) {
                    const rect = this.calculateTextRect(item, index, searchText.length)
                    positions.push({
                        page: pageNum,
                        text: str.substring(index, index + searchText.length),
                        rects: [rect],
                        confidence: 1.0  // 精确匹配
                    })
                }
                index = normalizedStr.indexOf(normalizedSearch, index + 1)
            }
        }

        // 方法2: 跨元素拼接查找（处理跨行/跨元素）
        if (positions.length === 0) {
            const crossMatch = this.findTextAcrossItems(items, normalizedSearch, pageNum, options)
            positions.push(...crossMatch)
        }

        // 方法3: 模糊匹配（如果启用且没找到精确匹配）
        if (positions.length === 0 && options.fuzzyMatch) {
            const fuzzyMatches = this.findFuzzyMatches(items, normalizedSearch, pageNum, options)
            positions.push(...fuzzyMatches)
        }

        return positions
    }

    /**
     * 跨多个文本元素查找
     */
    private findTextAcrossItems(
        items: any[],
        searchText: string,
        pageNum: number,
        options: SearchOptions
    ): TextPosition[] {
        const positions: TextPosition[] = []

        // 构建完整页面文本和位置映射
        let fullText = ''
        const itemMap: Array<{ startIdx: number; endIdx: number; item: any }> = []

        for (const item of items) {
            let str = options.normalizeWhitespace ? this.normalizeText(item.str) : item.str
            if (!options.caseSensitive) {
                str = str.toLowerCase()
            }

            const startIdx = fullText.length
            fullText += str + ' '  // 添加空格连接
            itemMap.push({
                startIdx,
                endIdx: startIdx + str.length,
                item
            })
        }

        // 处理搜索文本中可能的空格问题
        const searchVariants = [
            searchText,
            searchText.replace(/\s+/g, ''),     // 无空格
            searchText.replace(/\s+/g, ' '),    // 单空格
        ]

        for (const variant of searchVariants) {
            let index = fullText.indexOf(variant)
            while (index !== -1) {
                const rects = this.getRectsForRange(itemMap, index, index + variant.length)
                if (rects.length > 0) {
                    positions.push({
                        page: pageNum,
                        text: variant,
                        rects,
                        confidence: 0.95  // 跨元素匹配略低于精确匹配
                    })
                }
                index = fullText.indexOf(variant, index + 1)
            }
            if (positions.length > 0) break
        }

        return positions
    }

    /**
     * 模糊匹配
     */
    private findFuzzyMatches(
        items: any[],
        searchText: string,
        pageNum: number,
        options: SearchOptions
    ): TextPosition[] {
        const positions: TextPosition[] = []
        const threshold = options.fuzzyThreshold || 0.7

        // 将搜索文本分割成关键词
        const keywords = searchText.split(/\s+/).filter(k => k.length > 2)

        if (keywords.length === 0) return positions

        // 查找包含最多关键词的文本区域
        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            let str = options.normalizeWhitespace ? this.normalizeText(item.str) : item.str
            if (!options.caseSensitive) {
                str = str.toLowerCase()
            }

            // 计算与各关键词的相似度
            let matchedKeywords = 0
            for (const keyword of keywords) {
                if (str.includes(keyword)) {
                    matchedKeywords++
                } else {
                    // 检查相似度
                    const words = str.split(/\s+/)
                    for (const word of words) {
                        if (this.calculateSimilarity(word, keyword) >= threshold) {
                            matchedKeywords++
                            break
                        }
                    }
                }
            }

            // 如果匹配了足够多的关键词
            const matchRatio = matchedKeywords / keywords.length
            if (matchRatio >= threshold) {
                const rect = this.calculateTextRect(item, 0, item.str.length)
                positions.push({
                    page: pageNum,
                    text: item.str,
                    rects: [rect],
                    confidence: matchRatio * 0.8  // 模糊匹配置信度较低
                })
            }
        }

        // 如果还是没找到，尝试整体相似度匹配
        if (positions.length === 0) {
            // 构建连续文本窗口进行滑动匹配
            const windowSize = Math.min(5, items.length)  // 最多5个元素的窗口
            for (let i = 0; i <= items.length - windowSize; i++) {
                const windowItems = items.slice(i, i + windowSize)
                const windowText = windowItems.map(it =>
                    options.normalizeWhitespace ? this.normalizeText(it.str) : it.str
                ).join(' ')

                const similarity = this.calculateSimilarity(
                    options.caseSensitive ? windowText : windowText.toLowerCase(),
                    searchText
                )

                if (similarity >= threshold) {
                    const rects = windowItems.map(it => this.calculateTextRect(it, 0, it.str.length))
                    positions.push({
                        page: pageNum,
                        text: windowText,
                        rects,
                        confidence: similarity * 0.7  // 窗口匹配置信度更低
                    })
                }
            }
        }

        return positions
    }

    /**
     * 获取范围内所有文本项的矩形
     */
    private getRectsForRange(
        itemMap: Array<{ startIdx: number; endIdx: number; item: any }>,
        startPos: number,
        endPos: number
    ): TextRect[] {
        const rects: TextRect[] = []

        for (const { startIdx, endIdx, item } of itemMap) {
            if (endIdx <= startPos || startIdx >= endPos) continue

            const itemStart = Math.max(0, startPos - startIdx)
            const itemEnd = Math.min(item.str.length, endPos - startIdx)

            const rect = this.calculateTextRect(item, itemStart, itemEnd - itemStart)
            rects.push(rect)
        }

        return rects
    }

    /**
     * 检查是否为完整单词
     */
    private checkWholeWord(
        text: string,
        index: number,
        searchText: string,
        options: SearchOptions
    ): boolean {
        if (!options.wholeWord) return true

        const before = index > 0 ? text[index - 1] : ' '
        const after = index + searchText.length < text.length
            ? text[index + searchText.length]
            : ' '

        return !/\w/.test(before) && !/\w/.test(after)
    }

    /**
     * 计算文本在页面中的矩形坐标
     */
    private calculateTextRect(item: any, startIndex: number, length: number): TextRect {
        const transform = item.transform
        const width = item.width || 0
        const height = item.height || 10

        // 简化的坐标计算 - 实际实现可能需要更精确的字符宽度计算
        const charWidth = width / (item.str.length || 1)
        const x1 = transform[4] + startIndex * charWidth
        const y1 = transform[5]
        const x2 = x1 + length * charWidth
        const y2 = y1 + height

        return { x1, y1, x2, y2 }
    }

    /**
     * 将 PDF 坐标转换为视口坐标
     * @param rect PDF 坐标系中的矩形
     * @param viewport PDF.js 视口对象
     */
    convertToViewportCoordinates(rect: TextRect, viewport: any): TextRect {
        const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle([
            rect.x1, rect.y1, rect.x2, rect.y2
        ])

        return {
            x1: Math.min(vx1, vx2),
            y1: Math.min(vy1, vy2),
            x2: Math.max(vx1, vx2),
            y2: Math.max(vy1, vy2)
        }
    }

    /**
     * 合并相邻的文本矩形
     */
    mergeAdjacentRects(rects: TextRect[], threshold: number = 5): TextRect[] {
        if (rects.length === 0) return []

        const sorted = [...rects].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
        const merged: TextRect[] = [sorted[0]]

        for (let i = 1; i < sorted.length; i++) {
            const current = sorted[i]
            const last = merged[merged.length - 1]

            // 检查是否在同一行且相邻
            const sameRow = Math.abs(current.y1 - last.y1) < threshold
            const adjacent = current.x1 - last.x2 < threshold

            if (sameRow && adjacent) {
                // 合并矩形
                last.x2 = Math.max(last.x2, current.x2)
                last.y2 = Math.max(last.y2, current.y2)
            } else {
                merged.push(current)
            }
        }

        return merged
    }

    /**
     * 计算滚动到指定位置所需的偏移量
     */
    calculateScrollOffset(
        rect: TextRect,
        containerHeight: number,
        padding: number = 100
    ): number {
        return Math.max(0, rect.y1 - padding)
    }
}

// 导出默认实例
export const textPositionService = TextPositionService.getInstance()
