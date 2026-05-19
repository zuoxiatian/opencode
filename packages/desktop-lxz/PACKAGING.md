# Desktop LXZ Packaging Notes

This package is local integration code. Treat `packages/opencode` as an upstream
dependency: build it first, copy only the generated binary into this package, and
do not edit upstream source to fix desktop packaging issues.

## Environment

- Node: `22.13.1` via nvm-windows
- Bun: `1.3.13`
- Electron: `33.0.0`
- Build target: Windows x64 installer/portable exe/zip directory package; macOS x64/arm64 dmg and zip

Before running Electron or packaging, clear Electron's Node mode flag:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

## Problems Encountered

1. `bun install --frozen-lockfile` wanted to update `bun.lock`.
   - Cause: the newly added `packages/desktop-lxz` workspace is picked up by root `packages/*`.
   - Workaround used for local setup: install with `--no-save` and avoid committing lockfile changes unless explicitly intended.

2. Native install failed on Node 24.
   - Error path involved `tree-sitter-powershell` and `node-gyp`.
   - Cause: Node 24 triggered a native rebuild and the machine lacked a Windows SDK.
   - Fix: use Node `22.13.1`, matching the repo's Node 22 tooling.

3. `electron-vite dev` reported `Electron uninstall`.
   - Cause: Electron's postinstall script had been skipped, so the Electron binary was not present.
   - Fix: run Electron's install script with a mirror if needed:

```powershell
Set-Location packages\desktop-lxz\node_modules\electron
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:npm_config_electron_mirror = "https://npmmirror.com/mirrors/electron/"
node install.js
```

4. Electron started as Node and `ipcMain` was `undefined`.
   - Symptom: `TypeError: Cannot read properties of undefined (reading 'handle')`.
   - Cause: `ELECTRON_RUN_AS_NODE=1` was inherited.
   - Fix: `script/dev.ts` removes that env var and sets `ELECTRON_EXEC_PATH`.

5. `electron-builder` failed downloading GitHub-hosted tools.
   - Tools involved: `winCodeSign`, `nsis`, `nsis-resources`.
   - Fixes:
     - Use `ELECTRON_BUILDER_BINARIES_MIRROR`.
     - Disable Windows sign/resource editing with `win.signAndEditExecutable=false` to avoid `winCodeSign` symlink extraction issues.

## Build Steps

Run from the repo root unless a command changes directory.

1. Use Node 22 and clear Electron Node mode:

```powershell
nvm use 22.13.1
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

2. Build `packages/opencode` first:

```powershell
Set-Location C:\Users\LZ-DSJ-01\Desktop\work\git_work\opencode\opencode\packages\opencode
$env:OPENCODE_CHANNEL = "latest"
$env:OPENCODE_VERSION = "1.14.29"
bun run script/build.ts --single --skip-install
```

Expected output:

```text
dist/opencode-windows-x64/bin/opencode.exe
Smoke test passed: 1.14.29
```

3. Copy the `opencode` binary into this package:

```powershell
Set-Location C:\Users\LZ-DSJ-01\Desktop\work\git_work\opencode\opencode
New-Item -ItemType Directory -Force -Path packages\desktop-lxz\bin | Out-Null
Copy-Item packages\opencode\dist\opencode-windows-x64\bin\opencode.exe packages\desktop-lxz\bin\opencode.exe -Force
```

4. Build the Electron app:

```powershell
Set-Location packages\desktop-lxz
bun run build
```

5. Package the Windows installer and portable exe:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:npm_config_electron_mirror = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:npm_config_electron_builder_binaries_mirror = "https://npmmirror.com/mirrors/electron-builder-binaries/"
bun run dist
```

Expected final artifacts:

```text
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-win-x64-Installer.exe
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-win-x64-Portable.exe
```

To build a Windows zip package instead of a single-file portable exe, run:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:npm_config_electron_mirror = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:npm_config_electron_builder_binaries_mirror = "https://npmmirror.com/mirrors/electron-builder-binaries/"
bun run dist:win:zip
```

Expected zip artifact:

```text
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-win-x64.zip
```

This zip is the recommended "green" package for large bundled resources. Users should extract the zip directory and run `LongwiseTechAgent.exe` from the extracted folder; unlike `Portable.exe`, it does not need to unpack the whole app into a temporary directory on every launch.

## macOS Build

Create macOS artifacts on a macOS host. The app packages one `opencode` backend
binary per Electron architecture, so prepare both resource directories before
running `dist:mac`.

```bash
cd packages/opencode
OPENCODE_CHANNEL=latest OPENCODE_VERSION=1.14.29 bun run script/build.ts --skip-install

cd ../desktop-lxz
mkdir -p bin/mac/x64 bin/mac/arm64
cp ../opencode/dist/opencode-darwin-x64/bin/opencode bin/mac/x64/opencode
cp ../opencode/dist/opencode-darwin-arm64/bin/opencode bin/mac/arm64/opencode
chmod +x bin/mac/x64/opencode bin/mac/arm64/opencode

bun run build
bun run dist:mac
```

Expected macOS artifacts:

```text
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-mac-x64.dmg
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-mac-arm64.dmg
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-mac-x64.zip
packages/desktop-lxz/release/LongwiseTechAgent-1.0.0-mac-arm64.zip
```

## Cleanup

After a successful package, keep only the final artifacts:

```powershell
Set-Location C:\Users\LZ-DSJ-01\Desktop\work\git_work\opencode\opencode
Remove-Item packages\desktop-lxz\release\win-unpacked -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item packages\desktop-lxz\bin -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item packages\desktop-lxz\dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item packages\opencode\dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item packages\app\dist -Recurse -Force -ErrorAction SilentlyContinue
```

`packages/desktop-lxz/release` should contain only the artifacts you intend to distribute, for example:

```text
LongwiseTechAgent-1.0.0-win-x64-Installer.exe
LongwiseTechAgent-1.0.0-win-x64-Portable.exe
LongwiseTechAgent-1.0.0-win-x64.zip
```

