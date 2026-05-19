# Bundled runtimes

Place optional bundled Python and Node.js runtimes here. The Electron main
process detects the current platform directory and prepends its runtime
directories to `PATH` when starting the opencode backend.

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
