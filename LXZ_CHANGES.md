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

## Existing code paths affected by the new root

- Session database remains defined in `packages/opencode/src/storage/db.ts`, but `Global.Path.data` now points to `~/.lxz/data`, so the default database becomes `~/.lxz/data/opencode.db`.
- Recent model selection remains defined in `packages/opencode/src/provider/provider.ts`, but `Global.Path.state` now points to `~/.lxz/state`, so the recent model file becomes `~/.lxz/state/model.json`.
- Global config loading remains defined in `packages/opencode/src/config/config.ts` and `packages/opencode/src/config/paths.ts`, but `Global.Path.config` now points to `~/.lxz/config`.

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
