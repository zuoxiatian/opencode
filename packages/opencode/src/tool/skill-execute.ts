import { Effect, Schema } from "effect"
import { Instance } from "@/project/instance"
import { Skill } from "@/skill"
import * as SkillRuntime from "@/skill/runtime"
import { DESKTOP_BROWSER_AVAILABLE } from "@/browser/config"
import { AuthorizedBrowserCapability } from "./browser"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Trusted executable skill name" }),
  input: Schema.Unknown.annotate({ description: "Structured input documented by the loaded skill" }),
})

export const SkillExecuteTool = Tool.define(
  "skill_execute",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    return {
      description: [
        "Execute a trusted user skill after loading its instructions with the skill tool.",
        "Only skills from the desktop-configured trusted user skill directory with an agents/opencode.json runtime manifest can run.",
        "The skill receives declared capabilities through an authorized context and never receives raw credentials.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill.get(params.name)
          if (!info) {
            throw new Error(`Executable skill "${params.name}" was not found`)
          }
          yield* Effect.promise(() => SkillRuntime.validateLocation(params.name, info.location))
          if (!DESKTOP_BROWSER_AVAILABLE) {
            throw new Error("The desktop embedded browser is not available")
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: { executable: true },
          })

          const result = yield* Effect.promise(() =>
            SkillRuntime.execute(params.name, params.input, {
              abort: ctx.abort,
              callID: ctx.callID,
              directory: Instance.directory,
              sessionID: ctx.sessionID,
              worktree: Instance.worktree,
              browser: {
                execute: (input, options) =>
                  Effect.runPromise(AuthorizedBrowserCapability.execute(
                    input,
                    options?.abort ? { ...ctx, abort: options.abort } : ctx,
                  ))
                    .then((response) => response.data),
                finalize: () =>
                  Effect.runPromise(AuthorizedBrowserCapability.execute(
                    { command: "tabs.finalize" },
                    { ...ctx, abort: AbortSignal.timeout(10_000) },
                  )).then(() => undefined),
              },
            }),
          )

          return {
            title: `Executed skill: ${params.name}`,
            output: JSON.stringify(result ?? null, null, 2),
            metadata: { name: params.name },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
