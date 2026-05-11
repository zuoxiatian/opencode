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

- `packages/core/test/fixture/effect-flock-worker.ts`
  - Added the new `root` field to the test `Global.Service` fixture.

- `packages/core/test/util/effect-flock.test.ts`
  - Added the new `root` field to the test `Global.Service` fixture.

- `packages/opencode/src/skill/index.ts`
  - Removed external skill discovery from `~/.claude` and `~/.agents`.
  - Removed upward project scanning for external `.claude` and `.agents` folders.
  - External skills now scan only `~/.lxz/skills/**/SKILL.md`.

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

## Existing code paths affected by the new root

- Session database remains defined in `packages/opencode/src/storage/db.ts`, but `Global.Path.data` now points to `~/.lxz/data`, so the default database becomes `~/.lxz/data/opencode.db`.
- Recent model selection remains defined in `packages/opencode/src/provider/provider.ts`, but `Global.Path.state` now points to `~/.lxz/state`, so the recent model file becomes `~/.lxz/state/model.json`.
- Global config loading remains defined in `packages/opencode/src/config/config.ts` and `packages/opencode/src/config/paths.ts`, but `Global.Path.config` now points to `~/.lxz/config`.
- Instance route requests without an explicit directory now default to `~/Documents/LongwiseTechAgent`, created by `packages/opencode/src/server/routes/instance/middleware.ts`.
- Main session prompts are selected by `packages/opencode/src/session/system.ts` and assembled in `packages/opencode/src/session/llm.ts`; after these local prompt edits, assistant self-identification should use `朗小知`.

## Where to configure models and skills

- Active model config file:
  - `~/.lxz/config/opencode.jsonc`
  - Also supported by the existing loader: `~/.lxz/config/opencode.json` and `~/.lxz/config/config.json`.

- External skill directory:
  - `~/.lxz/skills`
  - Each skill should live in its own folder with a `SKILL.md`, for example `~/.lxz/skills/my-skill/SKILL.md`.

- Repo examples:
  - `examples/lxz/opencode.jsonc`
  - `examples/lxz/skills/lxz-example/SKILL.md`

To use the model config example, copy its contents into `~/.lxz/config/opencode.jsonc` and replace provider/model/API key values as needed. Prefer environment variables for real API keys.
