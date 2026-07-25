import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import * as SkillRuntime from "../../src/skill/runtime"
import { tmpdir } from "../fixture/fixture"

const previousRoot = process.env.OPENCODE_TRUSTED_SKILLS_DIR

afterEach(() => {
  if (previousRoot === undefined) {
    delete process.env.OPENCODE_TRUSTED_SKILLS_DIR
    return
  }
  process.env.OPENCODE_TRUSTED_SKILLS_DIR = previousRoot
})

describe("trusted executable skill runtime", () => {
  test("executes only the entry selected from the trusted root", async () => {
    await using tmp = await tmpdir()
    const trusted = path.join(tmp.path, "trusted")
    const thirdParty = path.join(tmp.path, "third-party")
    await writeSkill(trusted, "read-web-content", {
      code: `export async function execute(input, context) {
        return {
          browserKeys: Object.keys(context.browser).sort(),
          directory: context.directory,
          input,
          source: "trusted",
        }
      }`,
    })
    await writeSkill(thirdParty, "read-web-content", {
      code: `export async function execute() { return { source: "third-party" } }`,
    })
    process.env.OPENCODE_TRUSTED_SKILLS_DIR = trusted

    await expect(SkillRuntime.validateLocation(
      "read-web-content",
      path.join(trusted, "read-web-content", "SKILL.md"),
    )).resolves.toBeUndefined()
    await expect(SkillRuntime.validateLocation(
      "read-web-content",
      path.join(thirdParty, "read-web-content", "SKILL.md"),
    )).rejects.toThrow("was not loaded from its trusted directory")

    const result = await SkillRuntime.execute(
      "read-web-content",
      { format: "metadata" },
      context(tmp.path),
    )

    expect(result).toEqual({
      browserKeys: ["execute", "finalize"],
      directory: tmp.path,
      input: { format: "metadata" },
      source: "trusted",
    })
  })

  test("rejects unavailable roots, invalid names, and undeclared capabilities", async () => {
    await using tmp = await tmpdir()
    delete process.env.OPENCODE_TRUSTED_SKILLS_DIR
    await expect(SkillRuntime.execute("read-web-content", {}, context(tmp.path)))
      .rejects.toThrow("not available")

    const trusted = path.join(tmp.path, "trusted")
    await writeSkill(trusted, "read-web-content", {
      capabilities: ["filesystem"],
      code: "export async function execute() { return true }",
    })
    process.env.OPENCODE_TRUSTED_SKILLS_DIR = trusted

    await expect(SkillRuntime.execute("../read-web-content", {}, context(tmp.path)))
      .rejects.toThrow("Invalid executable skill name")
    await expect(SkillRuntime.execute("read-web-content", {}, context(tmp.path)))
      .rejects.toThrow()
  })

  test("rejects traversal and directory or entry symlinks outside the trusted root", async () => {
    await using tmp = await tmpdir()
    const trusted = path.join(tmp.path, "trusted")
    const outside = path.join(tmp.path, "outside.ts")
    await Bun.write(outside, "export async function execute() { return 'outside' }")
    await writeSkill(trusted, "traversal", {
      code: "export async function execute() { return 'inside' }",
      entry: "../../outside.ts",
    })
    await writeSkill(trusted, "symlink", {
      code: "export async function execute() { return 'inside' }",
    })
    await writeSkill(tmp.path, "outside-directory", {
      code: "export async function execute() { return 'outside' }",
    })
    await fs.rm(path.join(trusted, "symlink", "scripts", "execute.ts"))
    await fs.symlink(outside, path.join(trusted, "symlink", "scripts", "execute.ts"))
    await fs.symlink(path.join(tmp.path, "outside-directory"), path.join(trusted, "linked-directory"))
    process.env.OPENCODE_TRUSTED_SKILLS_DIR = trusted

    await expect(SkillRuntime.execute("traversal", {}, context(tmp.path)))
      .rejects.toThrow("outside its skill directory")
    await expect(SkillRuntime.execute("symlink", {}, context(tmp.path)))
      .rejects.toThrow("outside its skill directory")
    await expect(SkillRuntime.execute("linked-directory", {}, context(tmp.path)))
      .rejects.toThrow("outside the trusted skill root")
  })

  test("rejects a manifest symlink outside the trusted skill directory", async () => {
    await using tmp = await tmpdir()
    const trusted = path.join(tmp.path, "trusted")
    const outside = path.join(tmp.path, "manifest.json")
    await writeSkill(trusted, "linked-manifest", {
      code: "export async function execute() { return true }",
    })
    await Bun.write(outside, JSON.stringify({
      capabilities: ["browser"],
      entry: "scripts/execute.ts",
      version: 1,
    }))
    await fs.rm(path.join(trusted, "linked-manifest", "agents", "opencode.json"))
    await fs.symlink(outside, path.join(trusted, "linked-manifest", "agents", "opencode.json"))
    process.env.OPENCODE_TRUSTED_SKILLS_DIR = trusted

    await expect(SkillRuntime.execute("linked-manifest", {}, context(tmp.path)))
      .rejects.toThrow("manifest is outside")
  })
})

function context(directory: string): SkillRuntime.Context {
  return {
    abort: AbortSignal.any([]),
    callID: "call-test",
    directory,
    sessionID: "session-test",
    worktree: directory,
    browser: {
      execute: async () => ({}),
      finalize: async () => undefined,
    },
  }
}

async function writeSkill(
  root: string,
  name: string,
  options: {
    capabilities?: string[]
    code: string
    entry?: string
  },
) {
  const directory = path.join(root, name)
  await fs.mkdir(path.join(directory, "agents"), { recursive: true })
  await fs.mkdir(path.join(directory, "scripts"), { recursive: true })
  await Bun.write(path.join(directory, "SKILL.md"), `---
name: ${name}
description: Runtime test fixture.
---
`)
  await Bun.write(path.join(directory, "agents", "opencode.json"), JSON.stringify({
    capabilities: options.capabilities ?? ["browser"],
    entry: options.entry ?? "scripts/execute.ts",
    version: 1,
  }))
  await Bun.write(path.join(directory, "scripts", "execute.ts"), options.code)
}
