# desktop-forge packaging

This package uses Electron Forge for local packaging and publishing.

## Common commands

Run these commands from the repository root.

```powershell
# Build Windows installer and zip
bun run forge:make:win

# Build Windows zip only
bun run forge:make:win:zip

# Build all configured platforms
bun run forge:make
```

Equivalent commands from this directory:

```powershell
cd packages\desktop-forge

# Build Windows installer and zip
bun run make:win

# Build Windows zip only
bun run make:win:zip

# Build all configured platforms
bun run make:all
```

## Publish

```powershell
cd packages\desktop-forge
bun run publish
```

`publish` runs `electron-forge publish`. Publishing depends on the publisher,
signing, and environment variable configuration in `forge.config.ts`.

## Script notes

- `make:win` runs `script/prepare-assets.ts win`, then `electron-forge make --platform win32 --arch x64 --targets squirrel,zip`.
- `make:win:zip` runs `script/prepare-assets.ts win-zip`, then `electron-forge make --platform win32 --arch x64 --targets zip`.
- `make:all` prepares all assets, prepares native DMG dependencies, then builds macOS DMG, Windows Squirrel/zip, and Linux packages.
