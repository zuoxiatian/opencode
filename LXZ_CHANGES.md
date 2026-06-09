# LXZ local path changes

This fork mounts opencode's persistent local files under `~/.lxz` and limits external skill discovery to that tree.

## Modified files

- `packages/core/src/global.ts`
  - Removed the XDG base directory mapping for opencode paths.
  - Added `Global.Path.root` as `~/.lxz`.
  - Changed derived paths to:
    - `Global.Path.data`: `~/.lxz/data`
    - `Global.Path.config`: `~/.lxz/config`
    - `Global.Path.cache`: `~/.lxz/cache`
    - `Global.Path.state`: `~/.lxz/state`
    - `Global.Path.bin`: `~/.lxz/cache/bin`
    - `Global.Path.log`: `~/.lxz/data/log`
  - `OPENCODE_TEST_HOME` still overrides the home directory used to build `~/.lxz`.

- `packages/core/src/flag/flag.ts`
  - Added `OPENCODE_DISABLE_GLOBAL_CONFIG`.
  - `OPENCODE_DISABLE_GLOBAL_CONFIG` and `OPENCODE_CONFIG_CONTENT` are evaluated at access time so tests and desktop startup code can set or clear them before loading config.

- `packages/core/test/fixture/effect-flock-worker.ts`
  - Added the new `root` field to the test `Global.Service` fixture.

- `packages/core/test/util/effect-flock.test.ts`
  - Added the new `root` field to the test `Global.Service` fixture.

- `packages/opencode/src/skill/index.ts`
  - Removed external skill discovery from `~/.claude` and `~/.agents`.
  - Removed upward project scanning for external `.claude` and `.agents` folders.
  - External skills now scan only `~/.lxz/skills/**/SKILL.md`.
  - Restored project-local agent skill compatibility for `.agent/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md`.
  - This project-local compatibility is implemented only in the skill service, so `.opencode` config discovery remains unchanged.

- `packages/opencode/src/config/config.ts`
  - Added support for `OPENCODE_DISABLE_GLOBAL_CONFIG`.
  - When the flag is true, global config files under `Global.Path.config` are skipped.
  - `OPENCODE_CONFIG_CONTENT` is captured into the config service at startup and then removed from `process.env` and the internal Env state.
  - `Flag.OPENCODE_CONFIG_CONTENT` is dynamic, so clearing `process.env.OPENCODE_CONFIG_CONTENT` does not leave a stale cached copy in the flag object.
  - This keeps in-memory config loading available while preventing later shell, terminal, and tool child processes from inheriting the full config content.

- `packages/opencode/test/config/config.test.ts`
  - Added coverage for skipping global config files while still applying `OPENCODE_CONFIG_CONTENT`.
  - Verifies `OPENCODE_CONFIG_CONTENT` is removed from `process.env` after the config service captures it.

- `packages/opencode/src/server/routes/instance/middleware.ts`
  - Added a default project directory for instance requests that do not include `directory` or `x-opencode-directory`.
  - The default directory is `~/Documents/LongwiseTechAgent`.
  - The directory is created before the instance is initialized, so the first no-directory request registers this folder instead of the server process working directory.

- `packages/opencode/src/session/prompt/*.txt`
  - Changed model-facing identity prompt lines from `opencode` / `OpenCode` to `朗小知`.
  - Updated only identity declarations such as `You are ...` and `Your name is ...`.
  - Left product references, command names, docs URLs, issue URLs, and other non-identity `opencode` references unchanged.
  - Affected prompt files:
    - `anthropic.txt`
    - `beast.txt`
    - `codex.txt`
    - `copilot-gpt-5.txt`
    - `default.txt`
    - `gemini.txt`
    - `gpt.txt`
    - `kimi.txt`
    - `trinity.txt`

- `packages/opencode/src/tool/bash.ts`
  - Added a Windows PowerShell command prelude for shell tool calls.
  - The prelude switches the console code page to UTF-8 and sets PowerShell input/output encodings to UTF-8 before running the requested command.
  - Replaced direct `Stream.decodeText(handle.all)` decoding with explicit command-output decoding.
  - Output is decoded as UTF-8 first.
  - On Windows, if UTF-8 decoding produces replacement characters, output falls back to `gb18030` when that reduces decoding damage.
  - This addresses garbled Chinese output from Windows shell commands and `cmd`/`npx` wrappers that emit GBK/CP936 bytes.
  - Verification: `packages/opencode`: `bun typecheck` passed.

## Existing code paths affected by the new root

- Session database remains defined in `packages/opencode/src/storage/db.ts`, but `Global.Path.data` now points to `~/.lxz/data`, so the default database becomes `~/.lxz/data/opencode.db`.
- Recent model selection remains defined in `packages/opencode/src/provider/provider.ts`, but `Global.Path.state` now points to `~/.lxz/state`, so the recent model file becomes `~/.lxz/state/model.json`.
- Global config loading remains defined in `packages/opencode/src/config/config.ts` and `packages/opencode/src/config/paths.ts`, but `Global.Path.config` now points to `~/.lxz/config`.
- Instance route requests without an explicit directory now default to `~/Documents/LongwiseTechAgent`, created by `packages/opencode/src/server/routes/instance/middleware.ts`.
- Main session prompts are selected by `packages/opencode/src/session/system.ts` and assembled in `packages/opencode/src/session/llm.ts`; after these local prompt edits, assistant self-identification should use `朗小知`.

## Where to configure models and skills

- Active model config file for normal opencode CLI usage:
  - `~/.lxz/config/opencode.jsonc`
  - Also supported by the existing loader: `~/.lxz/config/opencode.json` and `~/.lxz/config/config.json`.

- Desktop-forge startup can bypass the local model config file:
  - The desktop client passes API-synced config through `OPENCODE_CONFIG_CONTENT`.
  - It also sets `OPENCODE_DISABLE_GLOBAL_CONFIG=true`, so `~/.lxz/config/opencode.jsonc` does not participate in that desktop-launched opencode process.
  - The config content is removed from `process.env` after opencode captures it, limiting child-process environment leakage.

- External skill directory:
  - `~/.lxz/skills`
  - Each skill should live in its own folder with a `SKILL.md`, for example `~/.lxz/skills/my-skill/SKILL.md`.

- Repo examples:
  - `examples/lxz/opencode.jsonc`
  - `examples/lxz/skills/lxz-example/SKILL.md`

To use the model config example, copy its contents into `~/.lxz/config/opencode.jsonc` and replace provider/model/API key values as needed. Prefer environment variables for real API keys.

## Project delete API and SDK generation

This change adds backend support for deleting an OpenCode project record and its related sessions, then regenerates the JavaScript v2 SDK so `desktop-lxz` can call the API.

## Modified files

- `packages/opencode/src/project/project.ts`
  - Added `Project.Event.Deleted` as the `project.deleted` bus event.
  - Added `Project.Service.remove(projectID)`.
  - `remove` looks up the project row and throws when the project does not exist.
  - Deletes the project record from `ProjectTable`.
  - Collects associated session IDs from `SessionTable`.
  - Removes related sync state with `SyncEvent.remove(session.id)`.
  - Emits `project.deleted` after deletion.
  - Exposes `remove` from the project service layer.

- `packages/opencode/src/server/routes/instance/project.ts`
  - Added `DELETE /project/:projectID` to the Hono instance routes.
  - The route uses operation id `project.delete`.
  - The route deletes only the OpenCode project record and associated sessions; it does not delete files on disk.
  - Returns `true` on successful deletion.
  - If the deleted project is the current instance project, the route disposes the current instance.

- `packages/opencode/src/server/routes/instance/httpapi/project.ts`
  - Added `ProjectPaths` constants for project route paths:
    - `list`
    - `current`
    - `initGit`
    - `update`
    - `remove`
  - Updated existing HttpApi endpoints to use `ProjectPaths`.
  - Added the HttpApi `remove` endpoint as `DELETE /project/:projectID`.
  - The endpoint uses OpenAPI identifier `project.delete`.
  - The endpoint returns `boolean`.
  - The handler calls `Project.Service.remove`.
  - If the removed project is the current instance project, it marks the instance for disposal with `markInstanceForDisposal`.

- `packages/opencode/test/project/project.test.ts`
  - Added a `Project.remove` test.
  - The test creates a project and a session.
  - The test verifies that deleting the project removes the project record.
  - The test verifies that the associated session row is also removed from the database.

- `packages/opencode/test/server/httpapi-instance.test.ts`
  - Added `ProjectPaths` and `Session` imports.
  - Added a `pathFor` helper for replacing route params in path constants.
  - Added an HttpApi bridge test for project deletion.
  - The test creates the current project and a session through HTTP.
  - The test calls `DELETE /project/:projectID`.
  - The test verifies the response is `true`.
  - The test verifies the deleted project is no longer returned by project list.
  - The test verifies the session associated with the deleted project is no longer returned by session list.

- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
  - Regenerated by `bun ./packages/sdk/js/script/build.ts`.
  - Added `Project.delete(...)`.
  - The generated client sends `DELETE /project/{projectID}`.
  - The generated method accepts:
    - `projectID`
    - optional `directory`
    - optional `workspace`
  - The generated response type is `ProjectDeleteResponses`.
  - The generated error type is `ProjectDeleteErrors`.

- `packages/sdk/js/src/v2/gen/types.gen.ts`
  - Regenerated by `bun ./packages/sdk/js/script/build.ts`.
  - Added `EventProjectDeleted`.
  - Added `project.deleted` to `GlobalEvent.payload`.
  - Added `project.deleted` to the top-level `Event` union.
  - Added generated request/response/error types for `project.delete`:
    - `ProjectDeleteData`
    - `ProjectDeleteErrors`
    - `ProjectDeleteError`
    - `ProjectDeleteResponses`
    - `ProjectDeleteResponse`

## Notes

- `packages/sdk` may show many files as modified in `git status` on Windows because Git reports LF to CRLF working tree warnings after SDK generation.
- The actual content changes under `packages/sdk` are only:
  - `packages/sdk/js/src/v2/gen/sdk.gen.ts`
  - `packages/sdk/js/src/v2/gen/types.gen.ts`

## Verification

- `packages/opencode`: `bun typecheck` passed.
- `packages/sdk/js`: `bun typecheck` passed.
- `packages/opencode/test/server/httpapi-instance.test.ts` passed.
- Targeted `Project.remove` test passed.
- Full `packages/opencode/test/project/project.test.ts` still has one unrelated existing failure around non-git directory project ID behavior: expected `ProjectID.global`, current implementation returns `local:<hash>`.
