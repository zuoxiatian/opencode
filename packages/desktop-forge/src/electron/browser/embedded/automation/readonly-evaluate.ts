import { parseExpressionAt } from "acorn"
import { Window } from "happy-dom"
import { BrowserRuntimeException } from "../../errors"

const MAX_SOURCE_LENGTH = 20_000
const MAX_STEPS = 20_000
const MAX_RESULT_DEPTH = 12
const MAX_RESULT_ITEMS = 500
const MAX_RESULT_KEYS = 200
const MAX_RESULT_STRING = 100_000

const safeMethods = new Set([
    "at",
    "closest",
    "endsWith",
    "entries",
    "every",
    "filter",
    "find",
    "findIndex",
    "from",
    "getAttribute",
    "getElementById",
    "getElementsByClassName",
    "getElementsByName",
    "getElementsByTagName",
    "hasAttribute",
    "includes",
    "indexOf",
    "isArray",
    "isFinite",
    "isInteger",
    "join",
    "keys",
    "map",
    "match",
    "max",
    "min",
    "parse",
    "matches",
    "querySelector",
    "querySelectorAll",
    "replace",
    "slice",
    "some",
    "startsWith",
    "stringify",
    "substring",
    "toLocaleLowerCase",
    "toLocaleUpperCase",
    "toLowerCase",
    "toString",
    "toUpperCase",
    "trim",
    "values",
])

const blockedProperties = new Set([
    "__proto__",
    "constructor",
    "cookie",
    "defaultView",
    "eval",
    "Function",
    "innerHTML",
    "outerHTML",
    "prototype",
])

const functionMarker = Symbol("readonly-evaluate-function")
const returnMarker = Symbol("readonly-evaluate-return")

type Scope = Map<string, unknown>
type FunctionValue = {
    [functionMarker]: true
    node: Record<string, unknown>
    scope: Scope
}
type ReturnValue = {
    [returnMarker]: true
    value: unknown
}

export class ReadonlyEvaluationService {
    evaluate(input: {
        arg?: unknown
        elementHtml?: string
        expression: string
        html: string
        url: string
    }) {
        if (!input.expression.trim() || input.expression.length > MAX_SOURCE_LENGTH) {
            throw new BrowserRuntimeException(
                "INVALID_COMMAND",
                `Read-only evaluate source must contain between 1 and ${MAX_SOURCE_LENGTH} characters`,
            )
        }
        const window = new Window({
            url: safeUrl(input.url),
            settings: {
                disableCSSFileLoading: true,
                disableComputedStyleRendering: true,
                disableIframePageLoading: true,
                disableJavaScriptFileLoading: true,
                enableJavaScriptEvaluation: false,
                handleDisabledFileLoadingAsSuccess: true,
                navigation: {
                    disableChildFrameNavigation: true,
                    disableChildPageNavigation: true,
                    disableFallbackToSetURL: true,
                    disableMainFrameNavigation: true,
                },
                timer: {
                    maxIntervalIterations: 0,
                    maxIntervalTime: 0,
                    maxTimeout: 0,
                    preventTimerLoops: true,
                },
            },
        })
        try {
            Object.defineProperties(window, {
                Error: { configurable: true, value: Error },
                RangeError: { configurable: true, value: RangeError },
                SyntaxError: { configurable: true, value: SyntaxError },
                TypeError: { configurable: true, value: TypeError },
            })
            window.document.write(input.html)
            const element = input.elementHtml
                ? new window.DOMParser().parseFromString(input.elementHtml, "text/html").body.firstElementChild
                : undefined
            return sanitizeResult(new Interpreter().run(
                input.expression,
                element ? [element, structuredClone(input.arg)] : [structuredClone(input.arg)],
                window.document,
            ))
        } catch (error) {
            if (error instanceof BrowserRuntimeException) throw error
            throw new BrowserRuntimeException(
                "INVALID_COMMAND",
                `Read-only evaluate failed: ${error instanceof Error ? error.message : String(error)}`,
            )
        } finally {
            window.happyDOM.close()
        }
    }
}

class Interpreter {
    private steps = 0

    run(source: string, args: unknown[], document: unknown) {
        const node = asNode(parseExpressionAt(source, 0, {
            ecmaVersion: "latest",
        }))
        if (node.end !== source.trimEnd().length) {
            throw new Error("Evaluate source must contain exactly one function expression")
        }
        if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
            throw new Error("Evaluate source must be an arrow function or function expression")
        }
        const scope = new Map<string, unknown>([
            ["Array", safeStatic("Array")],
            ["Boolean", safeStatic("Boolean")],
            ["document", document],
            ["Math", Math],
            ["Number", safeStatic("Number")],
            ["Object", safeStatic("Object")],
            ["JSON", JSON],
            ["String", safeStatic("String")],
            ["undefined", undefined],
        ])
        return this.invoke({ [functionMarker]: true, node, scope }, args)
    }

    private evaluate(node: unknown, scope: Scope): unknown {
        this.steps += 1
        if (this.steps > MAX_STEPS) throw new Error("Evaluate exceeded its operation limit")
        const expression = asNode(node)
        if (expression.type === "Literal") return expression.value
        if (expression.type === "Identifier") {
            const name = readString(expression.name, "identifier")
            if (scope.has(name)) return scope.get(name)
            throw new Error(`Unsupported identifier: ${name}`)
        }
        if (expression.type === "ArrayExpression") {
            return readArray(expression.elements).map((item) => item === null ? undefined : this.evaluate(item, scope))
        }
        if (expression.type === "ObjectExpression") {
            return Object.fromEntries(readArray(expression.properties).map((property) => {
                const entry = asNode(property)
                if (entry.type !== "Property" || entry.kind !== "init" || entry.method || entry.computed) {
                    throw new Error("Only plain object properties are supported")
                }
                return [
                    propertyName(entry.key),
                    this.evaluate(entry.value, scope),
                ]
            }))
        }
        if (expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression") {
            return { [functionMarker]: true, node: expression, scope: new Map(scope) } satisfies FunctionValue
        }
        if (expression.type === "MemberExpression") {
            return this.readMember(
                this.evaluate(expression.object, scope),
                expression.computed
                    ? this.evaluate(expression.property, scope)
                    : propertyName(expression.property),
            )
        }
        if (expression.type === "ChainExpression") return this.evaluate(expression.expression, scope)
        if (expression.type === "CallExpression") return this.call(expression, scope)
        if (expression.type === "UnaryExpression") {
            const value = this.evaluate(expression.argument, scope)
            if (expression.operator === "!") return !value
            if (expression.operator === "+") return Number(value)
            if (expression.operator === "-") return -Number(value)
            if (expression.operator === "typeof") return typeof value
            throw new Error(`Unsupported unary operator: ${String(expression.operator)}`)
        }
        if (expression.type === "BinaryExpression") {
            return binary(
                String(expression.operator),
                this.evaluate(expression.left, scope),
                this.evaluate(expression.right, scope),
            )
        }
        if (expression.type === "LogicalExpression") {
            const left = this.evaluate(expression.left, scope)
            if (expression.operator === "&&") return left && this.evaluate(expression.right, scope)
            if (expression.operator === "||") return left || this.evaluate(expression.right, scope)
            if (expression.operator === "??") return left ?? this.evaluate(expression.right, scope)
            throw new Error(`Unsupported logical operator: ${String(expression.operator)}`)
        }
        if (expression.type === "ConditionalExpression") {
            return this.evaluate(expression.test, scope)
                ? this.evaluate(expression.consequent, scope)
                : this.evaluate(expression.alternate, scope)
        }
        if (expression.type === "TemplateLiteral") {
            const expressions = readArray(expression.expressions)
            return readArray(expression.quasis)
                .map((quasi, index) => {
                    const text = asNode(asNode(quasi).value).cooked
                    return `${typeof text === "string" ? text : ""}${
                        index < expressions.length ? String(this.evaluate(expressions[index], scope)) : ""
                    }`
                })
                .join("")
        }
        throw new Error(`Unsupported evaluate syntax: ${expression.type}`)
    }

    private call(node: Record<string, unknown>, scope: Scope) {
        const callee = asNode(node.callee)
        const args = readArray(node.arguments).map((argument) => {
            const value = asNode(argument)
            if (value.type === "SpreadElement") {
                throw new Error("Spread arguments are not supported")
            }
            return this.evaluate(value, scope)
        })
        if (callee.type !== "MemberExpression") {
            const fn = this.evaluate(callee, scope)
            if (isStatic(fn)) return callStatic(fn.name, "", args)
            if (!isFunctionValue(fn)) throw new Error("Only declared read-only callbacks can be called directly")
            return this.invoke(fn, args)
        }
        const owner = this.evaluate(callee.object, scope)
        const name = String(callee.computed
            ? this.evaluate(callee.property, scope)
            : propertyName(callee.property))
        if (blockedProperties.has(name) || !safeMethods.has(name)) {
            throw new Error(`Method is unavailable in read-only evaluate: ${name}`)
        }
        if (isStatic(owner)) return callStatic(owner.name, name, args)
        const method = this.readMember(owner, name)
        if (typeof method !== "function") throw new Error(`Property is not callable: ${name}`)
        const values = args.map((arg) => isFunctionValue(arg)
            ? (...callbackArgs: unknown[]) => this.invoke(arg, callbackArgs)
            : arg)
        return Reflect.apply(method, owner, values)
    }

    private invoke(fn: FunctionValue, args: unknown[]) {
        const scope = new Map(fn.scope)
        readArray(fn.node.params).forEach((parameter, index) => {
            const node = asNode(parameter)
            if (node.type !== "Identifier") throw new Error("Only identifier parameters are supported")
            scope.set(readString(node.name, "parameter"), args[index])
        })
        const body = asNode(fn.node.body)
        if (body.type !== "BlockStatement") return this.evaluate(body, scope)
        const result = this.executeStatements(readArray(body.body), scope)
        return isReturnValue(result) ? result.value : undefined
    }

    private executeStatements(statements: unknown[], scope: Scope): ReturnValue | undefined {
        for (const statement of statements) {
            const node = asNode(statement)
            if (node.type === "ReturnStatement") {
                return { [returnMarker]: true, value: node.argument ? this.evaluate(node.argument, scope) : undefined }
            }
            if (node.type === "VariableDeclaration") {
                readArray(node.declarations).forEach((declaration) => {
                    const value = asNode(declaration)
                    const id = asNode(value.id)
                    if (id.type !== "Identifier") throw new Error("Only identifier variables are supported")
                    scope.set(
                        readString(id.name, "variable"),
                        value.init ? this.evaluate(value.init, scope) : undefined,
                    )
                })
                continue
            }
            if (node.type === "ExpressionStatement") {
                this.evaluate(node.expression, scope)
                continue
            }
            if (node.type === "IfStatement") {
                const branch = this.evaluate(node.test, scope) ? node.consequent : node.alternate
                if (!branch) continue
                const branchNode = asNode(branch)
                const result = branchNode.type === "BlockStatement"
                    ? this.executeStatements(readArray(branchNode.body), new Map(scope))
                    : this.executeStatements([branchNode], new Map(scope))
                if (result) return result
                continue
            }
            throw new Error(`Unsupported evaluate statement: ${node.type}`)
        }
        return undefined
    }

    private readMember(owner: unknown, property: unknown) {
        if (owner === null || owner === undefined) return undefined
        const name = String(property)
        if (blockedProperties.has(name)) {
            throw new Error(`Property is unavailable in read-only evaluate: ${name}`)
        }
        if (typeof owner !== "object") {
            return Reflect.get(Object(owner), name)
        }
        return Reflect.get(owner, name)
    }
}

function binary(operator: string, left: unknown, right: unknown) {
    if (operator === "===") return left === right
    if (operator === "!==") return left !== right
    if (operator === "==") return left == right
    if (operator === "!=") return left != right
    if (operator === "<") return Number(left) < Number(right)
    if (operator === "<=") return Number(left) <= Number(right)
    if (operator === ">") return Number(left) > Number(right)
    if (operator === ">=") return Number(left) >= Number(right)
    if (operator === "+") return typeof left === "string" || typeof right === "string"
        ? String(left) + String(right)
        : Number(left) + Number(right)
    if (operator === "-") return Number(left) - Number(right)
    if (operator === "*") return Number(left) * Number(right)
    if (operator === "/") return Number(left) / Number(right)
    if (operator === "%") return Number(left) % Number(right)
    throw new Error(`Unsupported binary operator: ${operator}`)
}

function sanitizeResult(value: unknown, depth = 0, seen = new Set<unknown>()): unknown {
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value
    if (typeof value === "string") return value.slice(0, MAX_RESULT_STRING)
    if (typeof value !== "object" || depth >= MAX_RESULT_DEPTH || seen.has(value)) return undefined
    seen.add(value)
    if (Array.isArray(value) || isArrayLike(value)) {
        return Array.from(value as ArrayLike<unknown>)
            .slice(0, MAX_RESULT_ITEMS)
            .map((item) => sanitizeResult(item, depth + 1, seen))
    }
    if (isDomNode(value)) {
        return {
            attributes: value.nodeType === 1
                ? Object.fromEntries(Array.from((value as Element).attributes).slice(0, MAX_RESULT_KEYS).map((item) => [
                    item.name,
                    item.value.slice(0, MAX_RESULT_STRING),
                ]))
                : undefined,
            nodeName: value.nodeName,
            textContent: value.textContent?.slice(0, MAX_RESULT_STRING) ?? null,
        }
    }
    return Object.fromEntries(Object.keys(value)
        .filter((key) => !blockedProperties.has(key))
        .slice(0, MAX_RESULT_KEYS)
        .map((key) => [key, sanitizeResult(Reflect.get(value, key), depth + 1, seen)]))
}

function safeStatic(name: "Array" | "Boolean" | "Number" | "Object" | "String") {
    return Object.freeze({ __safeStatic: true, name })
}

function isStatic(value: unknown): value is { __safeStatic: true; name: string } {
    return typeof value === "object" && value !== null && Reflect.get(value, "__safeStatic") === true
}

function callStatic(name: string, method: string, args: unknown[]) {
    if (!method && name === "Boolean") return Boolean(args[0])
    if (!method && name === "Number") return Number(args[0])
    if (!method && name === "String") return String(args[0])
    if (name === "Array" && method === "from") return Array.from(args[0] as ArrayLike<unknown>)
    if (name === "Array" && method === "isArray") return Array.isArray(args[0])
    if (name === "Number" && method === "isFinite") return Number.isFinite(args[0])
    if (name === "Number" && method === "isInteger") return Number.isInteger(args[0])
    if (name === "Object" && method === "entries") return Object.entries(Object(args[0]))
    if (name === "Object" && method === "keys") return Object.keys(Object(args[0]))
    if (name === "Object" && method === "values") return Object.values(Object(args[0]))
    throw new Error(`Static method is unavailable in read-only evaluate: ${name}.${method}`)
}

function asNode(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string") {
        return value as Record<string, unknown>
    }
    throw new Error("Invalid evaluate syntax")
}

function readArray(value: unknown) {
    if (Array.isArray(value)) return value
    throw new Error("Invalid evaluate syntax")
}

function readString(value: unknown, name: string) {
    if (typeof value === "string") return value
    throw new Error(`Invalid ${name}`)
}

function propertyName(value: unknown) {
    const node = asNode(value)
    if (node.type === "Identifier") return readString(node.name, "property")
    if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
        return String(node.value)
    }
    throw new Error("Unsupported property")
}

function isFunctionValue(value: unknown): value is FunctionValue {
    return typeof value === "object" && value !== null && Reflect.get(value, functionMarker) === true
}

function isReturnValue(value: unknown): value is ReturnValue {
    return typeof value === "object" && value !== null && Reflect.get(value, returnMarker) === true
}

function isArrayLike(value: object): value is ArrayLike<unknown> {
    return typeof Reflect.get(value, "length") === "number"
        && typeof Reflect.get(value, "item") === "function"
}

function isDomNode(value: object): value is Node {
    return typeof Reflect.get(value, "nodeType") === "number"
        && typeof Reflect.get(value, "nodeName") === "string"
}

function safeUrl(value: string) {
    try {
        const url = new URL(value)
        if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
    } catch {
        // Fall through to an inert origin.
    }
    return "https://readonly.invalid/"
}
