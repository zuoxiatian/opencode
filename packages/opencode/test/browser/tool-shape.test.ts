import { describe, expect, test } from "bun:test"
import { BROWSER_COMMAND_NAMES } from "@opencode-ai/browser-protocol"
import { Schema } from "effect"
import { toJsonSchema } from "../../src/util/effect-zod"
import {
  BROWSER_TOOL_COMMANDS,
  BROWSER_TOOLS,
  BrowserCdpParametersSchema,
  BrowserReadParametersSchema,
  BrowserWaitParametersSchema,
} from "../../src/tool/browser"

describe("browser tool facade", () => {
  test("registers seven capability tools and assigns every protocol command exactly once", () => {
    const commands = Object.values(BROWSER_TOOL_COMMANDS).flat()

    expect(BROWSER_TOOLS.map((tool) => tool.id)).toEqual([
      "browser_tabs",
      "browser_navigate",
      "browser_snapshot",
      "browser_read",
      "browser_action",
      "browser_wait",
      "browser_cdp",
    ])
    expect(new Set(commands).size).toBe(commands.length)
    expect(commands.toSorted()).toEqual([...BROWSER_COMMAND_NAMES].toSorted())
    expect(commands).not.toContain("browser.viewport.set")
    expect(commands).not.toContain("browser.viewport.reset")
  })

  test("keeps the model-facing schema root as an object", () => {
    const schema = toJsonSchema(BrowserWaitParametersSchema)

    expect(schema.type).toBe("object")
    expect(schema.properties).toHaveProperty("operation")
    expect(schema.required).toEqual(["operation"])
  })

  test("waitFor accepts exactly one condition", () => {
    const decode = Schema.decodeUnknownSync(BrowserWaitParametersSchema)

    expect(
      decode({
        operation: {
          command: "tab.automation.waitFor",
          state: "visible",
          target: { advanced: true, css: "button.publish" },
          timeout: 5_000,
        },
      }),
    ).toMatchObject({
      operation: {
        command: "tab.automation.waitFor",
        state: "visible",
        target: { advanced: true, css: "button.publish" },
      },
    })
    expect(
      ["domcontentloaded", "load", "networkidle"].map(
        (loadState) =>
          decode({
            operation: {
              command: "tab.automation.waitFor",
              loadState,
              timeout: 5_000,
            },
          }).operation,
      ),
    ).toEqual([
      { command: "tab.automation.waitFor", loadState: "domcontentloaded", timeout: 5_000 },
      { command: "tab.automation.waitFor", loadState: "load", timeout: 5_000 },
      { command: "tab.automation.waitFor", loadState: "networkidle", timeout: 5_000 },
    ])
    expect(
      decode({
        operation: {
          command: "tab.automation.waitFor",
          expression: "window.appReady === true",
        },
      }).operation,
    ).toMatchObject({
      command: "tab.automation.waitFor",
      expression: "window.appReady === true",
    })
    expect(
      decode({
        operation: {
          command: "tab.automation.waitFor",
          milliseconds: 250,
        },
      }).operation,
    ).toMatchObject({
      command: "tab.automation.waitFor",
      milliseconds: 250,
    })
    expect(() =>
      decode({
        operation: {
          command: "tab.automation.waitFor",
          loadState: "load",
          text: "Publish",
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        operation: {
          command: "tab.automation.waitFor",
          timeout: 5_000,
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        operation: {
          command: "tab.automation.waitFor",
          milliseconds: -1,
        },
      }),
    ).toThrow()
  })

  test("read operations require their command-specific target", () => {
    const decode = Schema.decodeUnknownSync(BrowserReadParametersSchema)

    expect(() =>
      decode({
        operation: { command: "tab.automation.getText" },
      }),
    ).toThrow()
    expect(
      decode({
        operation: {
          command: "tab.automation.getText",
          target: { advanced: true, css: "h1" },
        },
      }),
    ).toMatchObject({
      operation: {
        command: "tab.automation.getText",
        target: { advanced: true, css: "h1" },
      },
    })
  })

  test("CDP requires a top-level method", () => {
    const decode = Schema.decodeUnknownSync(BrowserCdpParametersSchema)

    expect(() =>
      decode({
        operation: {
          command: "tab.dev.cdp",
          params: {
            expression: "document.title",
            returnByValue: true,
          },
        },
      }),
    ).toThrow()
    expect(
      decode({
        operation: {
          command: "tab.dev.cdp",
          method: "Runtime.evaluate",
          params: {
            expression: "document.title",
            returnByValue: true,
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: "tab.dev.cdp",
        method: "Runtime.evaluate",
      },
    })
  })
})
