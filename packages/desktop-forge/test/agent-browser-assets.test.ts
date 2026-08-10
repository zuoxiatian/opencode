// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import { providerBuildFlags } from "../script/lib/agent-browser"

describe("agent-browser asset preparation", () => {
    test("uses the Windows console flag only for native Windows builds", () => {
        expect(providerBuildFlags("win32-x64", "win32")).toEqual(["--windows-hide-console"])
        expect(providerBuildFlags("win32-x64", "darwin")).toEqual([])
        expect(providerBuildFlags("win32-x64", "linux")).toEqual([])
        expect(providerBuildFlags("linux-x64", "win32")).toEqual([])
    })
})
