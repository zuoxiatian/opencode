# Agent-browser release verification

`AGENT_BROWSER_TARGET_ARCHITECTURE.md` is the architectural and acceptance
baseline. This runbook covers repeatable artifact preparation, packaged smoke
testing, upgrades, and rollback.

## Prepare and package

Run commands from `packages/desktop-forge`.

```sh
bun run agent-browser:prepare -- darwin-arm64
DESKTOP_FORGE_AD_HOC_SIGNING=1 \
DESKTOP_FORGE_SKIP_NOTARIZATION=1 \
bun run package:prepared -- --platform darwin --arch arm64
bun run packaged:smoke -- --target darwin-arm64
```

For local architecture verification where signing is intentionally outside the
test scope, append `--skip-signature`. This only skips `codesign` assertions;
all helper, direct-page, Runtime, startup, isolation, and cleanup checks still
run. It cannot be combined with `--formal-mac`.

Use the matching target on each native release runner:

| Runner | Target | Package arguments |
| --- | --- | --- |
| macOS Apple Silicon | `darwin-arm64` | `--platform darwin --arch arm64` |
| macOS Intel | `darwin-x64` | `--platform darwin --arch x64` |
| Windows x64 | `win32-x64` | `--platform win32 --arch x64` |
| Linux x64 | `linux-x64` | `--platform linux --arch x64` |

The live smoke command verifies:

- the app, ASAR, pinned agent-browser binary, manifest, and compiled provider
  are in the expected ASAR-external paths;
- helper executability, the pinned version, and the provider direct-page wire
  contract without a global `PATH`;
- the real Electron Browser Runtime against the helpers copied into the
  packaged app;
- application startup using isolated writable `userData`, graceful shutdown,
  and absence of daemon sidecars after exit;
- strict code-sign verification for the macOS app and both helpers unless
  `--skip-signature` was explicitly selected.

The pinned `0.33.0` direct-page implementation establishes the production
session with the first real page command (normally `snapshot`). Its standalone
no-URL `open` contract is tested separately because using it as a primer
consumes the one-time lease and causes the next direct-page command to reconnect.

## Latest macOS acceptance record

On 2026-07-29, the architecture checklist was verified from branch `2.0`
against commit `fc12cfff8ab8e04385fce486c0b7fe3fc2e79799` plus the working-tree
implementation:

- browser-protocol, desktop-forge, opencode, and JavaScript SDK package
  typechecks passed;
- 54 desktop runtime/Gateway tests and 10 OpenCode browser protocol/permission
  tests passed;
- the pinned `0.33.0` direct-page PoC passed snapshot, ref actions, the
  Baidu-style `.s_ipt`/`.quickdelete` flow, OOPIF, no-URL `open`, close, and
  idle-timeout checks;
- the real Electron Runtime integration passed semantic locators, OOPIF
  coordinate normalization, debugger reconnect, screenshot, dialogs, file
  chooser, download, navigation, two-tab isolation, cancellation, renderer
  loss, finalize, and shutdown cleanup;
- freshly generated `darwin-arm64` and `darwin-x64` packages both passed live
  packaged smoke; the x64 result ran through Rosetta;
- both packaged smoke runs used `--skip-signature` by explicit product scope.
  No signing or notarization conclusion is included in this record.

Cross-built packages can receive a static layout and checksum check:

```sh
bun run packaged:smoke -- --target win32-x64 --static
```

Static verification does not replace a live smoke on the target operating
system.

## Formal macOS release

Provide a Developer ID Application identity with its matching private key and
one supported notarization credential set to Electron Forge. Do not commit
`signing.local.env`.

After the formal package finishes, require the stronger release gate:

```sh
bun run packaged:smoke -- --target darwin-arm64 --formal-mac
```

This additionally requires a Developer ID Application authority, successful
Gatekeeper assessment, and a valid stapled notarization ticket. Ad-hoc signing
and skipped notarization are only valid for local smoke tests.

## Upgrade

Treat the agent-browser version as a reviewed supply-chain change:

1. Update `resources/agent-browser/manifest.json` with the exact npm archive
   URL, integrity, archive SHA-256, and every supported platform artifact
   SHA-256.
2. Review the pinned upstream direct-page and provider contracts before
   accepting the new version.
3. Run `agent-browser:prepare` for every target. Preparation verifies the
   archive and binary checksums, rebuilds the provider for each target, and
   records both provider source and executable fingerprints.
4. Run unit, direct-page, real Electron Runtime, and native packaged smoke
   suites on all four release targets.
5. Complete formal macOS signing and notarization verification before
   publishing.

Never accept a checksum from the downloaded file itself as the review source.

## Rollback

Rollback is the complete agent-browser architecture change set or a complete
reviewed version pin. Do not add a runtime fallback to the removed Playwright
or read-only-evaluate implementation. A rollback must keep protocol, OpenCode
client/tool, Electron adapter/controller/Gateway, packaged resources, and SDK
generation mutually consistent.
