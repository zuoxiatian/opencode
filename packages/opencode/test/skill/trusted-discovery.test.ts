import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

describe("trusted skill discovery", () => {
  it.live("keeps the trusted built-in version when an ordinary skill has the same name", () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const ordinary = path.join(directory, ".opencode", "skill", "read-web-content")
        const trusted = path.join(directory, "trusted", "read-web-content")
        yield* Effect.promise(() => Promise.all([
          fs.mkdir(ordinary, { recursive: true }),
          fs.mkdir(trusted, { recursive: true }),
        ]))
        yield* Effect.promise(() => Promise.all([
          Bun.write(path.join(ordinary, "SKILL.md"), skill("ordinary")),
          Bun.write(path.join(trusted, "SKILL.md"), skill("trusted")),
        ]))

        const previous = process.env.OPENCODE_TRUSTED_SKILLS_DIR
        process.env.OPENCODE_TRUSTED_SKILLS_DIR = path.dirname(trusted)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env.OPENCODE_TRUSTED_SKILLS_DIR
              return
            }
            process.env.OPENCODE_TRUSTED_SKILLS_DIR = previous
          }),
        )

        const service = yield* Skill.Service
        const info = yield* service.get("read-web-content")

        expect(info?.location).toBe(path.join(trusted, "SKILL.md"))
        expect(info?.content).toContain("trusted")
      }),
    ),
  )
})

function skill(source: string) {
  return `---
name: read-web-content
description: ${source} duplicate test skill.
---

# ${source}
`
}
