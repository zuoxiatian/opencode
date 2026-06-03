import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { bundledRuntimeDir } from "../resources/paths"

export function runtimeEnv(env: NodeJS.ProcessEnv) {
    const dir = bundledRuntimeDir()
    if (!existsSync(dir)) return {}

    return {
        OPENCODE_RUNTIME_DIR: dir,
        OPENCODE_NODE: runtimeExecutable(dir, "node"),
        OPENCODE_PYTHON: runtimeExecutable(dir, "python"),
        PYTHONHOME: process.platform === "win32"
            ? undefined
            : existsSync(join(dir, "python"))
                ? join(dir, "python")
                : undefined,
        PIP_INDEX_URL: process.env.PIP_INDEX_URL ?? "https://pypi.tuna.tsinghua.edu.cn/simple",
        PIP_TRUSTED_HOST: process.env.PIP_TRUSTED_HOST ?? "pypi.tuna.tsinghua.edu.cn",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        npm_config_registry: process.env.npm_config_registry ?? "https://registry.npmmirror.com",
        BUN_CONFIG_REGISTRY: process.env.BUN_CONFIG_REGISTRY ?? "https://registry.npmmirror.com",
        NoDefaultCurrentDirectoryInExePath: process.platform === "win32" ? "1" : undefined,
        PYTHONUTF8: process.platform === "win32" ? "1" : undefined,
        PYTHONIOENCODING: process.platform === "win32" ? "utf-8" : undefined,
        npm_config_unicode: process.platform === "win32" ? "true" : undefined,
        PYTHONPATH: "",
        PYTHONNOUSERSITE: "1",
        PATH: [...runtimePathDirs(dir), env.PATH ?? process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    }
}

function runtimeExecutable(dir: string, name: "node" | "python") {
    return (
        process.platform === "win32"
            ? [
                join(dir, name, `${name}.exe`),
                join(dir, "bin", `${name}.exe`),
                join(dir, "bin", `${name}.cmd`),
            ]
            : [
                join(dir, name, "bin", name),
                ...(name === "python" ? [join(dir, "python", "bin", "python3")] : []),
                join(dir, "bin", name),
            ]
    ).find((item) => existsSync(item))
}

function runtimePathDirs(dir: string) {
    return [
        join(dir, "bin"),
        join(dir, "node"),
        join(dir, "node", "bin"),
        join(dir, "python"),
        join(dir, "python", "bin"),
        process.platform === "win32" ? join(dir, "python", "Scripts") : undefined,
    ].filter((item): item is string => !!item && existsSync(item))
}
