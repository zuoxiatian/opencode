# Bundled runtimes

Place optional bundled Python and Node.js runtimes here. Do not copy Python from
a local Homebrew installation; Homebrew's CPython keeps absolute sysconfig paths
such as `/opt/homebrew`, which breaks after packaging. Use the download script to
install relocatable runtimes into this directory.

```bash
# All supported targets
bun run runtime:install

# Specific targets
bun run runtime:install -- darwin-arm64 darwin-x64
bun run runtime:install -- win32-x64

# Explicit all-target form
bun run runtime:install -- --all
```

`bun run build` runs `runtime:install` automatically for every supported target
before `electron-vite build`. Pass explicit targets to `runtime:install` only
when preparing a smaller subset manually.

The script downloads Node.js from `nodejs.org` and Python from Astral's
`python-build-standalone` release assets, verifies checksums when the upstream
metadata provides them, and generates the `bin/` launchers. It does not run
`pip` or install any Python packages.

If a target already has a matching runtime, the script skips that download. A
target's `.runtime.json` records the downloaded Node/Python versions; when that
file is missing for the current host, the script falls back to executing the
local runtime to check its version.

Packaging copies only the runtime for the target architecture:

```text
mac arm64 -> runtimes/darwin-arm64
mac x64   -> runtimes/darwin-x64
win x64   -> runtimes/win32-x64
linux x64 -> runtimes/linux-x64
```

Default versions are pinned in `script/install-runtimes.ts`:

```text
Node.js: 22.22.3
Python: 3.14.5
python-build-standalone release: 20260510
```

Override them with `OPENCODE_DESKTOP_NODE_VERSION`,
`OPENCODE_DESKTOP_PYTHON_VERSION`, and
`OPENCODE_DESKTOP_PYTHON_STANDALONE_RELEASE` when a runtime refresh is needed.

Expected layout:

```text
runtimes/
  win32-x64/
    python/
      python.exe
      Lib/
      Scripts/
      DLLs/
    node/
      node.exe
    bin/
      python.cmd
      pip.cmd
      node.cmd
  darwin-arm64/
    python/bin/python3
    node/bin/node
    bin/python
    bin/python3
    bin/node
  darwin-x64/
    python/bin/python3
    node/bin/node
    bin/python
    bin/python3
    bin/node
  linux-x64/
    python/bin/python3
    node/bin/node
    bin/python
    bin/python3
    bin/node
```

Injected environment variables:

```text
OPENCODE_RUNTIME_DIR
OPENCODE_PYTHON
OPENCODE_NODE
PYTHONHOME
PYTHONPATH=
PYTHONNOUSERSITE=1
PATH=<bundled runtime dirs first>
```

For zip builds, these files stay unpacked in the extracted application
directory, so startup is much faster than the single-file portable package.
